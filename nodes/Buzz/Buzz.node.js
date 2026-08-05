const crypto = require('crypto');
const stream = require('stream');
const { Transform } = stream;
const { finalizeEvent, getPublicKey } = require('nostr-tools');

// Every helper below comes from ../shared. This file used to carry its own copies, and they
// DIVERGED: shared's shapeMessage() grew `attachments` (parsed from imeta) while this copy did
// not, so Get Many / Search silently omitted attachments and their output could not feed
// File: Download. One definition each, from here on.
const {
	KIND_MESSAGE,
	KIND_CHANNEL_METADATA,
	decodeSecretKey,
	normaliseRelayUrl,
	normaliseChannelId,
	assertContentWithinLimit,
	parseAuthTag,
	authTagHeader,
	MAX_DIFF_CONTENT_BYTES,
	authHeader,
	queryEvents,
	tagValue,
	newestFirst,
	shapeMessage,
} = require('../shared');

const KIND_DELETE = 5;
const KIND_PROFILE = 0;

// Channel operations are NIP-29 group events. Every shape below was CAPTURED from the real
// `buzz` CLI against a local listener (2026-08-04), not derived — see the capture note in
// the reference. Do not "tidy" a tag name here without re-capturing.
const KIND_CHANNEL_ADD_MEMBER = 9000;
const KIND_CHANNEL_REMOVE_MEMBER = 9001;
const KIND_CHANNEL_EDIT_METADATA = 9002; // name/about/topic/purpose/archived all ride this
const KIND_CHANNEL_CREATE = 9007;
const KIND_CHANNEL_DELETE = 9008;
const KIND_CHANNEL_JOIN = 9021;
const KIND_CHANNEL_LEAVE = 9022;
const KIND_CHANNEL_MEMBERS = 39002;

// Captured from `buzz messages thread` — the exact kind set it asks for. 40002 is the v2 stream
// message, 40003 an edit, 40008 a diff, 45003 whatever the relay threads alongside them. Sending
// only kind 9 would silently miss replies posted by newer clients.
const THREAD_KINDS = [9, 40002, 40003, 40008, 45003];

const KIND_VOTE = 45002;        // forum up/down vote — content "+" or "-"
const KIND_DIFF = 40008;        // code diff / patch message
const KIND_FORUM_POST = 45001;    // forum thread root — the only valid target for a vote
const KIND_FORUM_COMMENT = 45003; // reply within a forum thread
const MENTION_CAP = 50;           // buzz-sdk/src/mentions.rs
const KIND_USER_STATUS = 30315;      // NIP-38 status line
const KIND_PRESENCE_SNAPSHOT = 40902; // the READ side of presence (writes are kind 20001)
const KIND_REACTION = 7;
const KIND_MESSAGE_EDIT = 40003;
const KIND_CANVAS = 40100;

// Blossom upload — captured from the buzz CLI against a local listener, because the
// scheme is undocumented and five reasonable guesses all returned 401. The exact wire
// format the relay expects:
//
//   PUT {relay}/upload            <- NOT /media/upload, which exists but rejects
//   Authorization: Nostr <unpadded base64 of a kind 24242 event>
//   X-SHA-256: <sha256 hex of the body>
//   Content-Type: <real mime type>
//
// with tags t=upload, x=<sha256>, expiration=<unix>, server=<host, no scheme>
// and content "Upload file".
function uploadAuthHeader(secretKey, host, sha256) {
	const nowSec = Math.floor(Date.now() / 1000);

	const event = finalizeEvent(
		{
			kind: 24242,
			created_at: nowSec,
			tags: [
				['t', 'upload'],
				['x', sha256],
				['expiration', String(nowSec + 600)],
				['server', host],
			],
			content: 'Upload file',
		},
		secretKey,
	);

	const encoded = Buffer.from(JSON.stringify(event), 'utf8')
		.toString('base64')
		.replace(/=+$/, '');

	return `Nostr ${encoded}`;
}

async function uploadBlob(ctx, relayUrl, secretKey, buffer, mimeType, fileName, authTag) {
	const url = `${relayUrl}/upload`;
	const host = new URL(relayUrl).host;
	const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

	// No client-side type gate: the RELAY accepts anything. Verified by uploading zip, gzip,
	// pdf, csv and json — all stored. Types it cannot identify by magic bytes come back as
	// application/octet-stream with a .bin extension, so they download rather than preview,
	// but they are not refused. (The `buzz` CLI does refuse octet-stream, which is a CLI
	// restriction and was previously mistaken for a relay one.)

	let raw;
	try {
		raw = await ctx.helpers.httpRequest({
			method: 'PUT',
			url,
			body: buffer,
			json: false,
			headers: {
				Authorization: uploadAuthHeader(secretKey, host, sha256),
				'Content-Type': mimeType,
				'X-SHA-256': sha256,
				...authTagHeader(authTag),
			},
		});
	} catch (error) {
		const status =
			(error && error.statusCode) || (error && error.response && error.response.status);

		// The relay SNIFFS the file content and ignores the declared Content-Type — verified by
		// uploading the same bytes as audio/wav, application/octet-stream and image/png, all of
		// which returned 415. Changing the MIME type in the workflow cannot fix this.
		if (status === 415) {
			throw new Error(
				`The Buzz relay refuses this file type (HTTP 415)` +
				`${fileName ? ` for "${fileName}"` : ''}. It detects the type from the file's own ` +
				'content and ignores the declared MIME type, so changing that will not help. ' +
				'Known-rejected: BMP, TIFF, WAV, HTML. ' +
				'Accepted with their real type: PNG, JPEG, GIF, WEBP, PDF, ZIP, GZIP, XML. ' +
				'Plain text, CSV, JSON and Markdown are accepted but stored as ' +
				'application/octet-stream (.bin). Convert to PNG or PDF, or put it in a ZIP.',
			);
		}

		throw error;
	}

	let parsed = raw;
	if (typeof raw === 'string') {
		try {
			parsed = JSON.parse(raw);
		} catch (e) {
			parsed = { raw };
		}
	}

	return {
		url: (parsed && parsed.url) || `${relayUrl}/media/${sha256}`,
		sha256: (parsed && parsed.sha256) || sha256,
		size: (parsed && parsed.size) || buffer.length,
		mimeType: (parsed && parsed.type) || mimeType,
		fileName,
		response: parsed,
	};
}

// Buzz renders attachments from MARKDOWN IN THE CONTENT, not from the imeta tag — verified
// by capturing `buzz messages send --file`, whose imeta tag is byte-identical to ours while
// its content carries `![image](url)`. A bare URL uploads and stores fine and then renders
// as nothing, which is why an attachment can look successful and be invisible.
function attachmentMarkdown(upload) {
	const label = upload.fileName || (upload.mimeType || '').split('/')[0] || 'file';
	return String(upload.mimeType || '').startsWith('image/')
		? `![${label}](${upload.url})`
		: `[${label}](${upload.url})`;
}

// Download auth, captured from `buzz media get`. Differs from upload in three ways that
// matter: no `x` tag, content is "Get media" (not "Get file"), and it is a plain GET against
// the media URL rather than a PUT to /upload.
function downloadAuthHeader(secretKey, host) {
	const nowSec = Math.floor(Date.now() / 1000);

	const event = finalizeEvent(
		{
			kind: 24242,
			created_at: nowSec,
			tags: [
				['t', 'get'],
				['expiration', String(nowSec + 600)],
				['server', host],
			],
			content: 'Get media',
		},
		secretKey,
	);

	return `Nostr ${Buffer.from(JSON.stringify(event), 'utf8').toString('base64')}`;
}

const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

// Uploads are read fully into a Buffer before hashing (Blossom needs the sha256 up front), so an
// oversized input becomes heap in n8n's MAIN process. The relay's own ceiling is 100 MB for
// generic files (buzz-media/src/config.rs), so anything above that is refused locally anyway —
// this cap just makes the refusal happen BEFORE the allocation instead of after.
// 
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

// Bounded output: one row is emitted per requested pubkey, so an unbounded input is an
// unbounded item count in n8n's main process. 
const MAX_PRESENCE_PUBKEYS = 500;

// The relay clamps a /query `limit` to 500 (1000 for an unfiltered kind:0 search). Reads that
// omit `limit` get the relay DEFAULT of 100 — which is how `reaction: remove` could answer "no
// reaction found" while an older matching one existed. Always ask explicitly, and say so when the
// answer came back full. 
const RELAY_QUERY_CAP = 500;
const RELAY_PROFILE_QUERY_CAP = 1000;

// Refuse from the binary METADATA first, before getBinaryDataBuffer() pulls the whole thing into
// memory. n8n exposes the size as `fileSize` (a human string like "2.71 kB") or the raw byte
// count, depending on how the item was produced — so only a numeric one is trusted here, and the
// post-load check below is what actually guarantees the cap.
function assertUploadSizeAllowed(meta, fileName) {
	const declared = Number(meta && (meta.fileSizeBytes !== undefined ? meta.fileSizeBytes : meta.bytes));
	if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
		throw new Error(
			`Refusing to upload ${declared} bytes${fileName ? ` ("${fileName}")` : ''} — the limit is ` +
			`${MAX_UPLOAD_BYTES}. The relay would reject it too.`,
		);
	}
}

// SSRF guard. `fileUrl` normally arrives from `attachments[].url` on an inbound message, and
// THE RELAY IS A SHARED COMMUNITY — any member can post an attachment whose imeta url points
// at http://127.0.0.1:5678, a Docker-internal service, or 169.254.169.254. Without this check
// a workflow piping attachments straight into Download would fetch those from INSIDE the n8n
// container, using its network position. Media is served from the relay's own origin
// (https://<relay>/media/<sha256>.<ext>, verified against a real inbound PDF), so same-origin
// is both the correct and the sufficient rule.
function assertSameOriginAsRelay(fileUrl, relayUrl) {
	let parsed;
	try {
		parsed = new URL(fileUrl);
	} catch (e) {
		throw new Error(`File URL is not a valid URL: "${fileUrl}"`);
	}

	const relay = new URL(relayUrl);

	if (parsed.protocol !== relay.protocol || parsed.host !== relay.host) {
		throw new Error(
			`Refusing to download from ${parsed.protocol}//${parsed.host} — it is not this ` +
			`credential's relay (${relay.protocol}//${relay.host}). Buzz serves attachments from ` +
			'the relay origin, so a URL pointing anywhere else came from someone else\'s message, ' +
			'not from the relay. Downloading it would fetch that address from inside n8n.',
		);
	}

	return parsed;
}

// Enforces the byte cap WITHOUT buffering. The previous version read the whole body into an
// ArrayBuffer and then copied it into a Buffer — two full copies of a file that may be 100 MB —
// and only checked the size once both already existed in memory, which is too late to help.
// Counting in a Transform aborts mid-flight instead, and `counter` holds the true byte count
// once the stream has been consumed (content-length is the server's claim, not a measurement).
function cappedStream(limit, counter) {
	return new Transform({
		transform(chunk, _encoding, callback) {
			counter.bytes += chunk.length;
			if (counter.bytes > limit) {
				callback(new Error(
					`Download aborted: the body exceeded the ${limit} byte limit.`,
				));
				return;
			}
			callback(null, chunk);
		},
	});
}

async function downloadBlob(ctx, relayUrl, secretKey, fileUrl, authTag) {
	const parsed = assertSameOriginAsRelay(fileUrl, relayUrl);

	const response = await ctx.helpers.httpRequest({
		method: 'GET',
		url: fileUrl,
		encoding: 'stream',
		returnFullResponse: true,
		headers: { Authorization: downloadAuthHeader(secretKey, parsed.host), ...authTagHeader(authTag) },
	});

	const headers = response.headers || {};

	// Cheap pre-check: refuse before reading a byte when the server declares it is too big.
	const declared = Number(headers['content-length']);
	if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
		if (response.body && typeof response.body.destroy === 'function') response.body.destroy();
		throw new Error(
			`Refusing to download ${declared} bytes — the limit is ${MAX_DOWNLOAD_BYTES}.`,
		);
	}

	const counter = { bytes: 0 };

	// 🔴 `source.pipe(transform)` does NOT forward the source's `error` event. If the relay or a
	// proxy resets the connection AFTER headers — mid-body — the response stream emits `error`
	// with no listener, which reaches `uncaughtException` in n8n's MAIN process and takes every
	// workflow on the instance down with it. `pipeline()` propagates the failure into the
	// returned stream, so it surfaces as a normal node error instead.
	// (Reproduced under Node 22.)
	const capped = cappedStream(MAX_DOWNLOAD_BYTES, counter);
	stream.pipeline(response.body, capped, (error) => {
		// pipeline destroys `capped` with this error, so the consumer already sees it. Swallow
		// here only so the callback itself cannot throw.
		if (error && !capped.destroyed) capped.destroy(error);
	});

	return {
		stream: capped,
		mimeType: headers['content-type'] || 'application/octet-stream',
		counter,
	};
}

function imetaTag(upload) {
	const parts = [
		`url ${upload.url}`,
		`m ${upload.mimeType}`,
		`x ${upload.sha256}`,
		`size ${upload.size}`,
	];
	// Buzz's own client includes filename in imeta; without it, clients show the hash.
	if (upload.fileName) parts.push(`filename ${upload.fileName}`);
	return ['imeta', ...parts];
}

// A Nostr event id is the hash of (pubkey, created_at, kind, tags, content), and `created_at`
// is SECOND-resolution with nothing else varying — so two identical sends inside one second
// produce the SAME id, and the relay silently dedupes the second away. The workflow reported
// success and only one message existed. Affects send, reaction, edit, delete and canvas alike.
// (The NIP-98 nonce protects the HTTP auth event, not the application event.)
//
// Nudging `created_at` forward keeps the id unique using only standard fields. The obvious
// alternative — an extra nonce tag — would also work, but it changes the event shape for every
// Buzz client that reads it, and the relay has not been measured for how it treats unknown
// tags on kind:9. A timestamp a second or two late is the cheaper trade.
//
// Custom nodes load in n8n's MAIN process, so this set is shared across every workflow and
// execution on the instance — which is exactly the scope the collision happens in.
const recentEventIds = new Set();
const MAX_TIMESTAMP_NUDGE = 30;

// `minCreatedAt` exists for REPLACEABLE kinds (0, 30315, …). The relay breaks a created_at tie by
// LOWEST event id and silently discards the loser while still answering `accepted:true` — so two
// profile edits in the same second can leave one of them dropped with both reporting success.
// Publishing strictly newer than the head we merged from removes the tie entirely.
// 
function finalizeUniqueEvent(kind, tags, content, secretKey, minCreatedAt) {
	let createdAt = Math.floor(Date.now() / 1000);
	if (Number.isFinite(minCreatedAt) && createdAt <= minCreatedAt) createdAt = minCreatedAt + 1;
	let event = finalizeEvent({ kind, created_at: createdAt, tags, content }, secretKey);

	for (let nudge = 0; recentEventIds.has(event.id) && nudge < MAX_TIMESTAMP_NUDGE; nudge += 1) {
		createdAt += 1;
		event = finalizeEvent({ kind, created_at: createdAt, tags, content }, secretKey);
	}

	recentEventIds.add(event.id);
	if (recentEventIds.size > 5000) {
		for (const id of recentEventIds) {
			recentEventIds.delete(id);
			if (recentEventIds.size <= 4000) break;
		}
	}

	return event;
}

// One shape for every channel-metadata (kind 39000) read, so List / Get / Search cannot drift
// apart the way shapeMessage() once did between two copies of this file.
function shapeChannel(event) {
	const tags = event.tags || [];
	const hasFlag = (name) => tags.some((t) => t[0] === name);
	const archived = tagValue(event, 'archived');
	return {
		channelId: tagValue(event, 'd'),
		name: tagValue(event, 'name') || tagValue(event, 'd'),
		about: tagValue(event, 'about'),
		topic: tagValue(event, 'topic'),
		purpose: tagValue(event, 'purpose'),
		// ⚠️ The relay does NOT store these under the names the CREATE event (kind 9007) uses.
		// It rewrites them: visibility becomes a BARE `["public"]` / `["private"]` tag, and the
		// type lands in `["t","stream"|"forum"]`. Reading `visibility` / `channel_type` here —
		// the create-side names — returned undefined for every real channel, while a synthetic
		// test asserting those invented names passed happily. Verified against live kind:39000:
		//   ["d",…],["name",…],["about",…],["public"],["closed"],["t","stream"],["archived","true"]
		visibility: hasFlag('public') ? 'public' : hasFlag('private') ? 'private' : undefined,
		channelType: tagValue(event, 't'),
		closed: hasFlag('closed') ? true : undefined,
		archived: archived === undefined ? undefined : archived === 'true',
		updatedAt: event.created_at,
	};
}

// One shape for every kind:0 read (Get / Get Many / Get Self), for the same reason shapeChannel
// exists: three copies of this would drift.
// 📌 Most real profiles on the relay carry `display_name` and NO `name` (only the n8n bot has
// both), so an absent `name` is normal and must not read as an error.
function shapeProfile(event) {
	let profile = {};
	try {
		profile = JSON.parse(event.content || '{}');
	} catch (e) {
		profile = { raw: event.content };
	}
	return {
		pubkey: event.pubkey,
		found: true,
		name: profile.name,
		displayName: profile.display_name,
		about: profile.about,
		picture: profile.picture,
		nip05: profile.nip05,
		profile,
		updatedAt: event.created_at,
	};
}

// Turn a presence-snapshot response into one row per REQUESTED pubkey.
//
// 🔑 Two traps, both of which produce a confidently wrong answer rather than an error:
//
// 1. The response events are `kind:20001` signed by the RELAY's own key, with the user the
//    status belongs to in a `p` TAG. Reading `event.pubkey` attributes every status to the
//    relay. Observed live: every row carried the relay's own pubkey, never the user's.
// 2. Presence is a Redis key with a 180 s TTL, so an OFFLINE user simply has no event. Emitting
//    only what came back would silently drop them, and a workflow asking "is X online?" would
//    get no row at all instead of `false`. Every requested pubkey gets a row.
function presenceFromEvents(pubkeys, events) {
	const byPubkey = new Map();
	for (const event of events || []) {
		const target = (event.tags || []).find((t) => t[0] === 'p' && t[1]);
		if (!target) continue;
		const existing = byPubkey.get(target[1]);
		if (!existing || event.created_at > existing.created_at) byPubkey.set(target[1], event);
	}
	return pubkeys.map((pubkey) => {
		const event = byPubkey.get(pubkey);
		const status = event ? String(event.content || '') : 'offline';
		return {
			pubkey,
			status,
			online: status === 'online',
			// Absent rather than 0 when unknown — a fake timestamp reads as real data.
			updatedAt: event ? event.created_at : undefined,
		};
	});
}

// Mentions become `p` tags — lowercased, de-duplicated and capped, per buzz-sdk's
// `mention_tags()`. The relay matches mentions on this tag, never on the display name.
function mentionTags(raw) {
	const list = String(raw == null ? '' : raw)
		.split(',').map((m) => m.trim()).filter(Boolean)
		.map((m) => normalisePubkey(m));
	const seen = [];
	for (const pk of list) if (!seen.includes(pk)) seen.push(pk);
	if (seen.length > MENTION_CAP) {
		throw new Error(`Too many mentions: ${seen.length} — the relay caps them at ${MENTION_CAP}`);
	}
	return seen.map((pk) => ['p', pk]);
}

// NIP-10 thread references, per buzz-sdk's `thread_tags()`. A direct reply to the root carries
// ONE marked `e` tag; a nested reply carries root AND parent, distinctly marked. Collapsing
// those two cases would reparent replies in the client's thread view.
function threadTags(rootId, parentId) {
	const root = String(rootId).trim();
	const parent = String(parentId || '').trim() || root;
	if (root === parent) return [['e', root, '', 'reply']];
	return [['e', root, '', 'root'], ['e', parent, '', 'reply']];
}

// Merge profile edits over the EXISTING kind:0 content.
//
// ⚠️ kind:0 is REPLACEABLE — whatever is published wins outright, so anything omitted is
// destroyed. `buzz users set-profile` does merge, but it DROPS `name`: given
// {name, display_name, about, picture} and `--about`, it republished {about, display_name,
// picture} with `name` gone (captured 2026-08-04). It also maps its single `--name` flag onto
// `display_name`. Mirroring that would silently delete the @-handle. This keeps every existing
// key and treats `name` and `display_name` as the separate things they are.
//
// An empty string means "leave unchanged" rather than "clear", because n8n collection fields
// default to '' and the destructive reading would make an untouched field wipe a real value.
function mergeProfile(existing, fields) {
	// Guard here too, not only at the call site — a non-object `existing` spreads into numeric
	// keys and destroys the profile. 
	if (existing !== undefined && existing !== null
		&& (typeof existing !== 'object' || Array.isArray(existing))) {
		throw new Error(
			`mergeProfile expects the existing profile to be an object, got ${
				Array.isArray(existing) ? 'an array' : typeof existing
			}`,
		);
	}
	const next = { ...(existing || {}) };
	const set = (key, value) => {
		if (value === undefined || value === null || value === '') return;
		next[key] = String(value);
	};
	set('name', fields.name);
	set('display_name', fields.displayName);
	set('about', fields.about);
	set('picture', fields.picture);
	set('nip05', fields.nip05);
	return next;
}

// The relay wants a 64-char hex pubkey. An npub reaches it as a plain string and comes back as
// an opaque rejection, so fail here with the reason and the fix instead.
// Validate AND canonicalise. The relay emits pubkeys lowercase (`to_hex()`), so an uppercase
// input matched nothing on the way back: `user: getPresence` reported a genuinely-online user as
// offline, with no error anywhere. Anything that keys a Map or filters by pubkey must go through
// this, not through assertHexPubkey alone.
// (Reproduced against a live relay.)
function normalisePubkey(pubkey) {
	// Trim BEFORE validating: the call sites used to trim themselves, and validating first made a
	// padded-but-valid pubkey throw. Caught by the regression test for this very fix.
	const trimmed = String(pubkey == null ? '' : pubkey).trim();
	assertHexPubkey(trimmed);
	return trimmed.toLowerCase();
}

function assertHexPubkey(pubkey) {
	if (/^[0-9a-f]{64}$/i.test(pubkey)) return;
	if (/^npub1/.test(pubkey)) {
		throw new Error(
			`Buzz wants a 64-character HEX pubkey, but got an npub ("${pubkey.slice(0, 16)}…"). ` +
			'Convert it first — npub and hex are the same key in different encodings.',
		);
	}
	throw new Error(
		`"${String(pubkey).slice(0, 24)}" is not a valid pubkey — expected 64 hexadecimal characters`,
	);
}

async function publishEvent(ctx, relayUrl, secretKey, kind, tags, content, options = {}) {
	const url = `${relayUrl}/events`;

	// A delegated agent must prove which owner it acts for on EVERY event it signs, not only on
	// messages — the relay reads the owner out of this tag (a ban on the owner cascades to the
	// agent). Appended here so no operation can forget it.
	const allTags = options.authTag ? [...tags, options.authTag] : tags;

	const event = finalizeUniqueEvent(
		kind,
		allTags,
		String(content == null ? '' : content),
		secretKey,
		options.minCreatedAt,
	);

	const response = await ctx.helpers.httpRequest({
		method: 'POST',
		url,
		body: event,
		json: true,
		// Both: the tag ON the event proves delegation for the event itself, the HEADER is what
		// `/events` feeds to enforce_relay_membership.
		headers: { Authorization: authHeader(secretKey, url, 'POST'), ...authTagHeader(options.authTag) },
	});

	// The relay answers HTTP 200 with {"accepted": false} when it takes the request but
	// REJECTS the event — membership lapsed, a duplicate id, a policy refusal. This used to be
	// coerced to a boolean and returned as ordinary output, so the node reported success and
	// the workflow carried on while nothing had been posted. A send that did not land is an
	// error, not a data field.
	if (!response || response.accepted !== true) {
		const detail = (response && (response.message || response.error || response.reason)) || '';
		throw new Error(
			`The Buzz relay did not accept this kind:${kind} event` +
			`${detail ? ` — ${detail}` : ''}. Event id ${event.id}. ` +
			`Relay response: ${JSON.stringify(response)}`,
		);
	}

	// The relay answers `accepted:true` with `message:"duplicate:"` when it TOOK the request but
	// DISCARDED the event — a replaceable write losing a tie, or a resend of an identical event.
	// That is not an error (the desired state may already hold), but reporting it as a plain
	// success hides a write that never landed. Surface it instead of throwing, so the canvas
	// writer — which legitimately republishes unchanged content — keeps working.
	// 
	const relayMessage = String((response && response.message) || '');
	const discarded = /duplicate|stale|no-?op/i.test(relayMessage);

	return {
		accepted: true,
		discarded,
		relayMessage: relayMessage || undefined,
		eventId: event.id,
		createdAt: event.created_at,
		kind,
		pubkey: event.pubkey,
		relay: relayUrl,
		response,
	};
}

// queryEvents / tagValue / newestFirst / shapeMessage now live in ../shared — see the note
// at the top of this file for why the local copies were removed.

class Buzz {
	constructor() {
		this.description = {
			displayName: 'Buzz',
			name: 'buzz',
			icon: 'file:buzz.svg',
			group: ['output'],
			version: 1,
			subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
			description: 'Read and write messages, reactions and canvas documents on a Buzz relay',
			defaults: { name: 'Buzz' },
			inputs: ['main'],
			outputs: ['main'],
			credentials: [{ name: 'buzzApi', required: true }],
			properties: [
				{
					displayName: 'Resource',
					name: 'resource',
					type: 'options',
					noDataExpression: true,
					options: [
						{ name: 'Message', value: 'message' },
						{ name: 'Reaction', value: 'reaction' },
						{ name: 'Canvas', value: 'canvas' },
						{ name: 'Channel', value: 'channel' },
						{ name: 'User', value: 'user' },
						{ name: 'File', value: 'file' },
					],
					default: 'message',
				},
				{
					displayName: 'Operation',
					name: 'operation',
					type: 'options',
					noDataExpression: true,
					displayOptions: { show: { resource: ['file'] } },
					options: [
						{
							name: 'Upload',
							value: 'upload',
							description: 'Upload binary data to the relay Blossom store and return its URL',
							action: 'Upload a file',
						},
						{
							name: 'Download',
							value: 'download',
							description: 'Fetch a relay attachment as binary data',
							action: 'Download a file',
						},
					],
					default: 'upload',
				},
				{
					displayName: 'Input Binary Field',
					name: 'binaryPropertyName',
					type: 'string',
					default: 'data',
					required: true,
					displayOptions: { show: { resource: ['file'], operation: ['upload'] } },
					description:
						'Name of the binary field holding the file to upload. This node caps each upload at 100 MiB; the relay may impose a lower, type-specific limit (images 50 MB, GIFs 10 MB, generic 100 MB).',
				},
				{
					displayName: 'File URL',
					name: 'fileUrl',
					type: 'string',
					default: '',
					required: true,
					displayOptions: { show: { resource: ['file'], operation: ['download'] } },
					placeholder: '={{ $json.attachments[0].url }}',
					description:
						'Relay media URL to fetch. Attachments from the Buzz Trigger provide this as attachments[n].url. Media requires Blossom auth, so a plain HTTP Request node cannot fetch it.',
				},
				{
					displayName: 'Put Output in Field',
					name: 'outputBinaryField',
					type: 'string',
					default: 'data',
					required: true,
					displayOptions: { show: { resource: ['file'], operation: ['download'] } },
					description: 'Binary field to write the downloaded file into',
				},
				{
					displayName: 'Options',
					name: 'downloadOptions',
					type: 'collection',
					placeholder: 'Add option',
					default: {},
					displayOptions: { show: { resource: ['file'], operation: ['download'] } },
					options: [
						{
							displayName: 'File Name',
							name: 'fileName',
							type: 'string',
							default: '',
							placeholder: '={{ $json.attachments[0].filename }}',
							description:
								'Name for the downloaded file. Defaults to the last path segment, which on the relay is the SHA-256 hash.',
						},
					],
				},

				{
					displayName: 'Operation',
					name: 'operation',
					type: 'options',
					noDataExpression: true,
					displayOptions: { show: { resource: ['message'] } },
					options: [
						{ name: 'Send', value: 'send', description: 'Send a message to a channel', action: 'Send a message' },
						{ name: 'Get Many', value: 'getMany', description: 'Retrieve recent messages from a channel', action: 'Get many messages' },
						{ name: 'Search', value: 'search', description: 'Full-text search across messages', action: 'Search messages' },
						{ name: 'Edit', value: 'edit', description: 'Replace the content of a message you sent', action: 'Edit a message' },
						{ name: 'Delete', value: 'delete', description: 'Delete a message by event ID', action: 'Delete a message' },
						{ name: 'Thread', value: 'thread', description: 'Get a root message and its replies', action: 'Get a message thread' },
						{ name: 'Vote', value: 'vote', description: 'Upvote or downvote a forum post', action: 'Vote on a message' },
						{ name: 'Send Diff', value: 'sendDiff', description: 'Send a code diff / patch to a channel', action: 'Send a diff' },
						{ name: 'Send Forum Post', value: 'sendForumPost', description: 'Start a forum thread — the only kind of message a vote can target', action: 'Send a forum post' },
						{ name: 'Send Forum Comment', value: 'sendForumComment', description: 'Reply inside a forum thread', action: 'Send a forum comment' },
					],
					default: 'send',
				},
				{
					displayName: 'Operation',
					name: 'operation',
					type: 'options',
					noDataExpression: true,
					displayOptions: { show: { resource: ['reaction'] } },
					options: [
						{ name: 'Add', value: 'add', description: 'Add an emoji reaction to a message', action: 'Add a reaction' },
						{ name: 'Remove', value: 'remove', description: 'Remove one of your own emoji reactions from a message', action: 'Remove a reaction' },
						{ name: 'Get', value: 'get', description: 'List all reactions on a message', action: 'Get reactions' },
						{ name: 'Add Custom Emoji', value: 'addCustomEmoji', description: 'React with a custom emoji shortcode', action: 'Add a custom emoji reaction' },
					],
					default: 'add',
				},
				{
					displayName: 'Operation',
					name: 'operation',
					type: 'options',
					noDataExpression: true,
					displayOptions: { show: { resource: ['canvas'] } },
					options: [
						{ name: 'Set', value: 'set', description: 'Replace a channel canvas document', action: 'Set a canvas' },
						{ name: 'Get', value: 'get', description: 'Read the current canvas document', action: 'Get a canvas' },
					],
					default: 'set',
				},
				{
					displayName: 'Operation',
					name: 'operation',
					type: 'options',
					noDataExpression: true,
					displayOptions: { show: { resource: ['channel'] } },
					options: [
						{ name: 'List', value: 'list', description: 'List channels visible to this identity', action: 'List channels' },
						{ name: 'Get', value: 'get', description: 'Read one channel’s metadata by UUID', action: 'Get a channel' },
						{ name: 'Search', value: 'search', description: 'Find channels whose name, about, topic or purpose matches a query', action: 'Search channels' },
						{ name: 'Create', value: 'create', description: 'Create a channel and return its new UUID', action: 'Create a channel' },
						{ name: 'Update', value: 'update', description: 'Change a channel name and/or description', action: 'Update a channel' },
						{ name: 'Set Topic', value: 'setTopic', description: 'Set the channel topic line', action: 'Set a channel topic' },
						{ name: 'Set Purpose', value: 'setPurpose', description: 'Set the channel purpose line', action: 'Set a channel purpose' },
						{ name: 'Archive', value: 'archive', description: 'Archive a channel', action: 'Archive a channel' },
						{ name: 'Unarchive', value: 'unarchive', description: 'Restore an archived channel', action: 'Unarchive a channel' },
						{ name: 'Delete', value: 'delete', description: 'Delete a channel permanently', action: 'Delete a channel' },
						{ name: 'Join', value: 'join', description: 'Join a channel as this identity', action: 'Join a channel' },
						{ name: 'Leave', value: 'leave', description: 'Leave a channel as this identity', action: 'Leave a channel' },
						{ name: 'Get Members', value: 'members', description: 'List a channel’s members', action: 'Get channel members' },
						{ name: 'Add Member', value: 'addMember', description: 'Add a pubkey to a channel', action: 'Add a channel member' },
						{ name: 'Remove Member', value: 'removeMember', description: 'Remove a pubkey from a channel', action: 'Remove a channel member' },
					],
					default: 'list',
				},
				{
					displayName: 'Operation',
					name: 'operation',
					type: 'options',
					noDataExpression: true,
					displayOptions: { show: { resource: ['user'] } },
					options: [
						{ name: 'Get', value: 'get', description: 'Look up one user profile (kind:0) by pubkey', action: 'Get a user' },
						{ name: 'Get Many', value: 'getMany', description: 'List every user profile on the relay, optionally filtered by a name search', action: 'Get many users' },
						{ name: 'Get Self', value: 'getSelf', description: 'Get the profile of the identity this credential signs as', action: 'Get own user' },
						{ name: 'Set Profile', value: 'setProfile', description: 'Update this identity’s own profile (kind:0), merging with what is already there', action: 'Set own profile' },
						{ name: 'Set Status', value: 'setStatus', description: 'Set or clear the NIP-38 status line on this identity’s profile', action: 'Set own status' },
						{ name: 'Get Presence', value: 'getPresence', description: 'Get online/away/offline presence for one or more pubkeys', action: 'Get user presence' },
					],
					default: 'get',
				},
				{
					displayName: 'Channel Name or ID',
					name: 'forumChannelId',
					type: 'options',
					typeOptions: { loadOptionsMethod: 'getChannels' },
					default: '',
					required: true,
					displayOptions: { show: { resource: ['message'], operation: ['sendForumPost', 'sendForumComment'] } },
					description: 'Must be a FORUM-type channel. Posting a forum kind into a stream channel is refused by the relay.',
				},
				{
					displayName: 'Content',
					name: 'forumContent',
					type: 'string',
					typeOptions: { rows: 4 },
					default: '',
					required: true,
					displayOptions: { show: { resource: ['message'], operation: ['sendForumPost', 'sendForumComment'] } },
				},
				{
					displayName: 'Root Event ID',
					name: 'forumRootId',
					type: 'string',
					default: '',
					required: true,
					displayOptions: { show: { resource: ['message'], operation: ['sendForumComment'] } },
					description: 'The forum post (kind 45001) this thread belongs to',
				},
				{
					displayName: 'Parent Event ID',
					name: 'forumParentId',
					type: 'string',
					default: '',
					displayOptions: { show: { resource: ['message'], operation: ['sendForumComment'] } },
					description: 'Leave empty to reply directly to the root. Set it to nest the reply under another comment.',
				},
				{
					displayName: 'Mentions',
					name: 'forumMentions',
					type: 'string',
					default: '',
					displayOptions: { show: { resource: ['message'], operation: ['sendForumPost', 'sendForumComment'] } },
					description: 'Comma-separated 64-char hex pubkeys to mention (max 50)',
				},
				{
					displayName: 'Emoji Shortcode',
					name: 'emojiShortcode',
					type: 'string',
					default: '',
					required: true,
					displayOptions: { show: { resource: ['reaction'], operation: ['addCustomEmoji'] } },
					placeholder: 'party_parrot',
					description: 'Without the surrounding colons — the node adds them',
				},
				{
					displayName: 'Emoji Image URL',
					name: 'emojiUrl',
					type: 'string',
					default: '',
					required: true,
					displayOptions: { show: { resource: ['reaction'], operation: ['addCustomEmoji'] } },
				},
				{
					displayName: 'Direction',
					name: 'voteDirection',
					type: 'options',
					options: [
						{ name: 'Up', value: 'up' },
						{ name: 'Down', value: 'down' },
					],
					default: 'up',
					displayOptions: { show: { resource: ['message'], operation: ['vote'] } },
					description: 'Sent as content "+" or "-" on a kind:45002 event',
				},
				{
					displayName: 'Channel Name or ID',
					name: 'diffChannelId',
					type: 'options',
					typeOptions: { loadOptionsMethod: 'getChannels' },
					default: '',
					required: true,
					displayOptions: { show: { resource: ['message'], operation: ['sendDiff'] } },
					description: 'Channel to post the diff into. Choose from the list, or specify a UUID using an expression.',
				},
				{
					displayName: 'Diff',
					name: 'diffContent',
					type: 'string',
					typeOptions: { rows: 8 },
					default: '',
					required: true,
					displayOptions: { show: { resource: ['message'], operation: ['sendDiff'] } },
					description: 'The patch text itself — it becomes the event content',
				},
				{
					displayName: 'Repository URL',
					name: 'diffRepo',
					type: 'string',
					default: '',
					required: true,
					displayOptions: { show: { resource: ['message'], operation: ['sendDiff'] } },
					placeholder: 'https://github.com/org/repo',
				},
				{
					displayName: 'Commit SHA',
					name: 'diffCommit',
					type: 'string',
					default: '',
					required: true,
					displayOptions: { show: { resource: ['message'], operation: ['sendDiff'] } },
				},
				{
					displayName: 'Additional Fields',
					name: 'diffOptions',
					type: 'collection',
					placeholder: 'Add Field',
					default: {},
					displayOptions: { show: { resource: ['message'], operation: ['sendDiff'] } },
					options: [
						{ displayName: 'File Path', name: 'file', type: 'string', default: '', description: 'Single file path within the repo' },
						{ displayName: 'Parent Commit', name: 'parentCommit', type: 'string', default: '' },
						{ displayName: 'Source Branch', name: 'sourceBranch', type: 'string', default: '' },
						{ displayName: 'Target Branch', name: 'targetBranch', type: 'string', default: '' },
						{ displayName: 'Pull Request Number', name: 'pr', type: 'string', default: '' },
						{ displayName: 'Language', name: 'lang', type: 'string', default: '', description: 'Language hint. The CLI auto-detects from the file extension; this node does not, so set it if you want one.' },
						{ displayName: 'Description', name: 'description', type: 'string', default: '' },
						{ displayName: 'Reply To Event ID', name: 'replyTo', type: 'string', default: '' },
					],
				},
				{
					displayName: 'Profile Fields',
					name: 'profileFields',
					type: 'collection',
					placeholder: 'Add Field',
					default: {},
					displayOptions: { show: { resource: ['user'], operation: ['setProfile'] } },
					description:
						'Only the fields you set are changed — everything else in the existing profile is preserved',
					options: [
						{ displayName: 'Username (name)', name: 'name', type: 'string', default: '', description: 'The @-handle. This is what @-mentions resolve against.' },
						{ displayName: 'Display Name', name: 'displayName', type: 'string', default: '', description: 'The human-readable name shown in clients' },
						{ displayName: 'About', name: 'about', type: 'string', default: '' },
						{ displayName: 'Picture URL', name: 'picture', type: 'string', default: '' },
						{ displayName: 'NIP-05', name: 'nip05', type: 'string', default: '' },
					],
				},
				{
					displayName: 'Pubkeys',
					name: 'presencePubkeys',
					type: 'string',
					default: '',
					required: true,
					displayOptions: { show: { resource: ['user'], operation: ['getPresence'] } },
					placeholder: '64-char hex, comma-separated for several',
					description:
						'One row is returned per pubkey — a pubkey with no presence entry comes back as offline rather than being omitted',
				},
				{
					displayName: 'Status Text',
					name: 'statusText',
					type: 'string',
					default: '',
					displayOptions: { show: { resource: ['user'], operation: ['setStatus'] } },
					description: 'Leave empty to CLEAR the status',
				},
				{
					displayName: 'Status Emoji',
					name: 'statusEmoji',
					type: 'string',
					default: '',
					displayOptions: { show: { resource: ['user'], operation: ['setStatus'] } },
					description: 'Optional emoji shown before the status text',
				},
				{
					displayName: 'Search',
					name: 'userSearch',
					type: 'string',
					default: '',
					displayOptions: { show: { resource: ['user'], operation: ['getMany'] } },
					description:
						'Optional name search, matched RELAY-SIDE via the NIP-50 `search` filter field. Leave empty to return every profile.',
				},
				{
					displayName: 'Limit',
					name: 'userLimit',
					type: 'number',
					default: 100,
					// Relay caps: 500 with a search, 1000 without.
					typeOptions: { minValue: 1, maxValue: 1000 },
					displayOptions: { show: { resource: ['user'], operation: ['getMany'] } },
					description: 'Max profiles to return. The CLI uses 100 for a name search.',
				},

				// Channel ops take a RAW uuid, not the loadOptions picker used elsewhere: `create`
				// returns a brand-new uuid that no picker can know yet, and archived channels are
				// legitimate targets for `unarchive` while absent from the list.
				{
					displayName: 'Channel UUID',
					name: 'channelUuid',
					type: 'string',
					default: '',
					required: true,
					displayOptions: {
						show: {
							resource: ['channel'],
							operation: ['get', 'update', 'setTopic', 'setPurpose', 'archive', 'unarchive', 'delete', 'join', 'leave', 'members', 'addMember', 'removeMember'],
						},
					},
					description: 'UUID of the target channel',
				},
				{
					displayName: 'Name',
					name: 'channelName',
					type: 'string',
					default: '',
					required: true,
					displayOptions: { show: { resource: ['channel'], operation: ['create'] } },
				},
				{
					displayName: 'Channel Type',
					name: 'channelType',
					type: 'options',
					options: [
						{ name: 'Stream', value: 'stream' },
						{ name: 'Forum', value: 'forum' },
					],
					default: 'stream',
					displayOptions: { show: { resource: ['channel'], operation: ['create'] } },
				},
				{
					displayName: 'Visibility',
					name: 'channelVisibility',
					type: 'options',
					options: [
						{ name: 'Private', value: 'private' },
						{ name: 'Open', value: 'open' },
					],
					default: 'private',
					displayOptions: { show: { resource: ['channel'], operation: ['create'] } },
				},
				{
					displayName: 'TTL (Seconds)',
					name: 'channelTtl',
					type: 'number',
					default: 0,
					typeOptions: { minValue: 0 },
					displayOptions: { show: { resource: ['channel'], operation: ['create'] } },
					description: 'Make the channel EPHEMERAL: the relay archives it this many seconds after the last message. 0 = permanent.',
				},
				{
					displayName: 'Description',
					name: 'channelAbout',
					type: 'string',
					default: '',
					displayOptions: { show: { resource: ['channel'], operation: ['create', 'update'] } },
					description: 'Channel description. Leave empty on Update to leave it unchanged.',
				},
				{
					displayName: 'New Name',
					name: 'channelNewName',
					type: 'string',
					default: '',
					displayOptions: { show: { resource: ['channel'], operation: ['update'] } },
					description: 'Leave empty to leave the name unchanged',
				},
				{
					displayName: 'Topic',
					name: 'channelTopic',
					type: 'string',
					default: '',
					required: true,
					displayOptions: { show: { resource: ['channel'], operation: ['setTopic'] } },
				},
				{
					displayName: 'Purpose',
					name: 'channelPurpose',
					type: 'string',
					default: '',
					required: true,
					displayOptions: { show: { resource: ['channel'], operation: ['setPurpose'] } },
				},
				{
					displayName: 'Query',
					name: 'channelQuery',
					type: 'string',
					default: '',
					required: true,
					displayOptions: { show: { resource: ['channel'], operation: ['search'] } },
					description: 'Case-insensitive substring matched against name, about, topic and purpose',
				},
				{
					displayName: 'Member Role',
					name: 'memberRole',
					type: 'options',
					options: [
						{ name: 'Member', value: 'member' },
						{ name: 'Admin', value: 'admin' },
						{ name: 'Owner', value: 'owner' },
						{ name: 'Guest', value: 'guest' },
						{ name: 'Bot', value: 'bot' },
					],
					default: 'member',
					displayOptions: { show: { resource: ['channel'], operation: ['addMember'] } },
				},
				{
					displayName: 'Pubkey',
					name: 'targetPubkey',
					type: 'string',
					default: '',
					required: true,
					displayOptions: {
						show: {
							resource: ['channel'],
							operation: ['addMember', 'removeMember'],
						},
					},
					description: '64-character hex pubkey (not an npub)',
				},
				{
					displayName: 'Pubkey',
					name: 'userPubkey',
					type: 'string',
					default: '',
					required: true,
					displayOptions: { show: { resource: ['user'], operation: ['get'] } },
					description: '64-character hex pubkey (not an npub)',
				},

				{
					displayName: 'Channel Name or ID',
					name: 'channelId',
					type: 'options',
					typeOptions: { loadOptionsMethod: 'getChannels' },
					default: '',
					required: true,
					displayOptions: {
						show: {
							resource: ['message', 'canvas'],
							operation: ['send', 'getMany', 'edit', 'delete', 'set', 'get'],
						},
					},
					description:
						'Channel to target. Choose from the list, or specify a UUID using an expression. Required even for Edit and Delete — the relay rejects channel-scoped events without an h tag.',
				},
				{
					displayName: 'Channel Name or ID',
					name: 'channelId',
					type: 'options',
					typeOptions: { loadOptionsMethod: 'getChannels' },
					default: '',
					displayOptions: { show: { resource: ['reaction'] } },
					description:
						'Optional for reactions — the relay derives the channel from the target event. Choose from the list, or specify a UUID using an expression.',
				},
				{
					displayName: 'Channel Name or ID',
					name: 'channelId',
					type: 'options',
					typeOptions: { loadOptionsMethod: 'getChannels' },
					default: '',
					required: true,
					displayOptions: { show: { resource: ['message'], operation: ['search'] } },
					description:
						'Required. The relay rejects an authors-filtered query with no channel scope (403), so a search must name a channel. Choose from the list, or specify a UUID using an expression.',
				},

				{
					displayName: 'Message',
					name: 'content',
					type: 'string',
					typeOptions: { rows: 4 },
					default: '',
					required: true,
					displayOptions: { show: { resource: ['message'], operation: ['send'] } },
					description: 'Message text. Supports markdown and @mentions.',
				},
				{
					displayName: 'Options',
					name: 'options',
					type: 'collection',
					placeholder: 'Add option',
					default: {},
					displayOptions: { show: { resource: ['message'], operation: ['send'] } },
					options: [
						{
							displayName: 'Reply to Event ID',
							name: 'replyTo',
							type: 'string',
							default: '',
							description: 'Event ID to reply to, which threads the message under it',
						},
						{
							displayName: 'Attach Binary Fields',
							name: 'attachments',
							type: 'string',
							default: '',
							placeholder: 'data, chart',
							description:
								'Comma-separated binary field names to upload and attach. Each becomes an imeta tag, and its URL is appended to the message so clients that ignore imeta still show it.',
						},
						{
							displayName: 'Broadcast',
							name: 'broadcast',
							type: 'boolean',
							default: false,
							description: 'Whether to add Buzz\'s broadcast tag to the message',
						},
						{
							displayName: 'Mentions',
							name: 'mentions',
							type: 'string',
							default: '',
							description: 'Comma-separated 64-char hex pubkeys to mention (max 50). Mentions are matched on this tag, not on names in the text.',
						},
					],
				},

				{
					displayName: 'Limit',
					name: 'limit',
					type: 'number',
					typeOptions: { minValue: 1, maxValue: 500 },
					default: 50,
					displayOptions: { show: { resource: ['message'], operation: ['getMany', 'search'] } },
					description: 'Max number of results to return. The relay caps this at 500 per filter.',
				},
				{
					displayName: 'Only My Messages',
					name: 'onlyMine',
					type: 'boolean',
					default: false,
					displayOptions: { show: { resource: ['message'], operation: ['getMany', 'search'] } },
					description:
						'Whether to return only messages sent by this credential\'s identity. Combine with Limit 1 to find the last message this bot posted — which is how you get an event ID for Edit or Delete.',
				},
				{
					displayName: 'Filters',
					name: 'filters',
					type: 'collection',
					placeholder: 'Add filter',
					default: {},
					displayOptions: { show: { resource: ['message'], operation: ['getMany', 'search'] } },
					options: [
						{
							displayName: 'Since',
							name: 'since',
							type: 'dateTime',
							default: '',
							description: 'Only return messages created after this time',
						},
						{
							displayName: 'Before',
							name: 'before',
							type: 'dateTime',
							default: '',
							description: 'Only return messages created before this time',
						},
					],
				},
				{
					displayName: 'Search Query',
					name: 'search',
					type: 'string',
					default: '',
					displayOptions: { show: { resource: ['message'], operation: ['search'] } },
					description:
						'Full-text query. May be left empty when Only My Messages is on, to list this identity\'s messages across channels.',
				},

				{
					displayName: 'Event ID',
					name: 'eventId',
					type: 'string',
					default: '',
					required: true,
					displayOptions: {
						show: {
							resource: ['message', 'reaction'],
							// ⚠️ Every operation that reads `eventId` must be listed here. n8n STRIPS
							// parameters that are not displayed for the selected operation, so a
							// missing entry surfaces at runtime as `Could not get parameter
							// "eventId"` — not as a UI glitch. Adding `vote` was missed once.
							operation: ['edit', 'delete', 'add', 'remove', 'get', 'thread', 'vote'],
						},
					},
					placeholder: '64-character hex event ID',
					description:
						'The message event to act on. Get one from a previous Send, or from Get Many / Search with Only My Messages.',
				},
				{
					displayName: 'New Message',
					name: 'content',
					type: 'string',
					typeOptions: { rows: 4 },
					default: '',
					required: true,
					displayOptions: { show: { resource: ['message'], operation: ['edit'] } },
					description: 'Replacement message text',
				},
				{
					displayName: 'Emoji',
					name: 'emoji',
					type: 'string',
					default: '👍',
					required: true,
					displayOptions: { show: { resource: ['reaction'], operation: ['add', 'remove'] } },
					description: 'Emoji character, or a :shortcode: for a custom emoji',
				},
				{
					displayName: 'Channel Name or ID',
					name: 'threadChannelId',
					type: 'options',
					typeOptions: { loadOptionsMethod: 'getChannels' },
					default: '',
					required: true,
					displayOptions: { show: { resource: ['message'], operation: ['thread'] } },
					description:
						'Thread reads are channel-scoped — the relay requires the #h filter. Choose from the list, or specify a UUID using an expression.',
				},
				{
					displayName: 'Limit',
					name: 'threadLimit',
					type: 'number',
					default: 100,
					// The relay clamps to 500 regardless; a larger number here just misleads.
					typeOptions: { minValue: 1, maxValue: 500 },
					displayOptions: { show: { resource: ['message'], operation: ['thread'] } },
					description: 'Max replies to return. The CLI default is 100.',
				},
				{
					displayName: 'Depth Limit',
					name: 'threadDepthLimit',
					type: 'number',
					default: 0,
					typeOptions: { minValue: 0 },
					displayOptions: { show: { resource: ['message'], operation: ['thread'] } },
					description:
						'Max reply nesting depth. 0 leaves it unset, which is what the CLI sends when the flag is omitted.',
				},

				{
					displayName: 'Canvas Content',
					name: 'content',
					type: 'string',
					typeOptions: { rows: 8 },
					default: '',
					required: true,
					displayOptions: { show: { resource: ['canvas'], operation: ['set'] } },
					description:
						'Markdown document that REPLACES the channel canvas wholesale. Good for dashboards that should update in place rather than scroll past as messages. Use Canvas: Get first if you need to append.',
				},
			],
		};

		this.methods = {
			loadOptions: {
				async getChannels() {
					const credentials = await this.getCredentials('buzzApi');
					const relayUrl = normaliseRelayUrl(credentials.relayUrl);
					const secretKey = decodeSecretKey(credentials.privateKey);
					// The channel picker is its own scope with its own credentials read, so the
					// delegation tag has to be resolved here too — otherwise a delegated identity
					// sees an empty channel list and no error.
					const authTag = parseAuthTag(credentials.authTag);

					const events = await queryEvents(this, relayUrl, secretKey, [
						{ kinds: [KIND_CHANNEL_METADATA], limit: 500 },
					], authTag);

					const seen = new Map();
					for (const event of events) {
						const uuid = tagValue(event, 'd');
						if (!uuid) continue;
						const name = tagValue(event, 'name') || uuid;
						const existing = seen.get(uuid);
						if (!existing || existing.created_at < (event.created_at || 0)) {
							seen.set(uuid, { name, created_at: event.created_at || 0 });
						}
					}

					return Array.from(seen.entries())
						.map(([value, meta]) => ({ name: meta.name, value }))
						.sort((a, b) => a.name.localeCompare(b.name));
				},
			},
		};
	}

	async execute() {
		const items = this.getInputData();
		const returnData = [];

		const credentials = await this.getCredentials('buzzApi');
		const relayUrl = normaliseRelayUrl(credentials.relayUrl);
		const secretKey = decodeSecretKey(credentials.privateKey);
		const authTag = parseAuthTag(credentials.authTag);

		// Bound once rather than passed at ~15 call sites: threading `authTag` through each one
		// meant any new operation silently published without it, which the relay would accept
		// while treating the agent as unauthorised-by-owner.
		const publish = (kind, tags, content, opts = {}) =>
			publishEvent(this, relayUrl, secretKey, kind, tags, content, { authTag, ...opts });
		// Same reasoning as `publish`: bound once so a delegated identity cannot be silently
		// dropped from a read, an upload or a download by a call site that forgot to pass it.
		const query = (filters) => queryEvents(this, relayUrl, secretKey, filters, authTag);
		const upload = (buffer, mimeType, fileName) =>
			uploadBlob(this, relayUrl, secretKey, buffer, mimeType, fileName, authTag);
		const download = (fileUrl) => downloadBlob(this, relayUrl, secretKey, fileUrl, authTag);
		const selfPubkey = getPublicKey(secretKey);

		const resource = this.getNodeParameter('resource', 0);
		const operation = this.getNodeParameter('operation', 0);

		const toUnix = (value) => {
			if (!value) return undefined;
			const ms = new Date(value).getTime();
			return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
		};

		for (let i = 0; i < items.length; i++) {
			try {
				let result;

				if (resource === 'file' && operation === 'download') {
					const fileUrl = String(this.getNodeParameter('fileUrl', i)).trim();
					const outputField = String(this.getNodeParameter('outputBinaryField', i, 'data')).trim();
					const downloadOptions = this.getNodeParameter('downloadOptions', i, {}) || {};

					const blob = await download(fileUrl);
					const fallbackName = decodeURIComponent(new URL(fileUrl).pathname.split('/').pop() || 'file');
					const fileName = downloadOptions.fileName || fallbackName;

					// prepareBinaryData consumes the stream, so `counter.bytes` is only accurate
					// after it resolves — hence the await before building the json payload.
					const binary = await this.helpers.prepareBinaryData(
						blob.stream, fileName, blob.mimeType,
					);

					returnData.push({
						json: { url: fileUrl, fileName, mimeType: blob.mimeType, size: blob.counter.bytes },
						binary: { [outputField]: binary },
						pairedItem: { item: i },
					});
					continue;
				} else if (resource === 'file' && operation === 'upload') {
					const property = String(this.getNodeParameter('binaryPropertyName', i)).trim();
					const meta = this.helpers.assertBinaryData(i, property);
					assertUploadSizeAllowed(meta, meta.fileName);
					const buffer = await this.helpers.getBinaryDataBuffer(i, property);
					assertUploadSizeAllowed({ fileSizeBytes: buffer.length }, meta.fileName);

					const upload = await upload(buffer, meta.mimeType, meta.fileName,
					);
					result = upload;
				} else if (resource === 'message' && operation === 'send') {
					const channelId = normaliseChannelId(this.getNodeParameter('channelId', i));
					const options = this.getNodeParameter('options', i, {});
					const tags = [['h', channelId]];
					if (options.replyTo) tags.push(['e', String(options.replyTo).trim()]);
					if (options.broadcast) tags.push(['broadcast', '1']);
					tags.push(...mentionTags(options.mentions));

					let content = String(this.getNodeParameter('content', i));
					assertContentWithinLimit(content, undefined, 'message');
					const uploads = [];

					let attachedBytes = 0;
					const attachNames = String(options.attachments || '')
						.split(',')
						.map((name) => name.trim())
						.filter(Boolean);

					for (const property of attachNames) {
						const meta = this.helpers.assertBinaryData(i, property);
						assertUploadSizeAllowed(meta, meta.fileName);
						const buffer = await this.helpers.getBinaryDataBuffer(i, property);
						assertUploadSizeAllowed({ fileSizeBytes: buffer.length }, meta.fileName);
						// Aggregate cap too: five 90 MB attachments are individually legal and
						// collectively fatal.
						attachedBytes += buffer.length;
						if (attachedBytes > MAX_UPLOAD_BYTES) {
							throw new Error(
								`Attachments total ${attachedBytes} bytes — the combined limit is ${MAX_UPLOAD_BYTES}`,
							);
						}
						const upload = await upload(buffer, meta.mimeType, meta.fileName,
						);
						uploads.push(upload);
						tags.push(imetaTag(upload));
						content = `${content}\n${attachmentMarkdown(upload)}`;
					}

					// The pre-check above ran on the bare text; each attachment appends a markdown
					// link, so a near-limit message with attachments could still cross 64 KiB.
					assertContentWithinLimit(content, undefined, 'message with attachments');
					result = await publish(KIND_MESSAGE, tags, content);
					result.channelId = channelId;
					if (uploads.length) {
						result.attachments = uploads.map((u) => ({
							url: u.url, sha256: u.sha256, size: u.size, mimeType: u.mimeType, fileName: u.fileName,
						}));
					}
				} else if (
					resource === 'message' &&
					(operation === 'getMany' || operation === 'search')
				) {
					const limit = this.getNodeParameter('limit', i, 50);
					const onlyMine = this.getNodeParameter('onlyMine', i, false);
					const filters = this.getNodeParameter('filters', i, {});
					const rawChannelId = String(this.getNodeParameter('channelId', i, '') || '').trim();
					const channelId = rawChannelId ? normaliseChannelId(rawChannelId) : '';

					const filter = { kinds: [KIND_MESSAGE], limit };
					if (channelId) filter['#h'] = [channelId];
					if (onlyMine) filter.authors = [selfPubkey];

					const since = toUnix(filters.since);
					const before = toUnix(filters.before);
					if (since) filter.since = since;
					if (before) filter.until = before;

					if (operation === 'search') {
						const search = String(this.getNodeParameter('search', i, '') || '').trim();
						if (search) filter.search = search;
						if (!search && !onlyMine) {
							throw new Error(
								'Search needs either a Search Query or Only My Messages turned on',
							);
						}
					}

					const events = newestFirst(await query([filter]));
					for (const event of events) {
						returnData.push({ json: shapeMessage(event, selfPubkey), pairedItem: { item: i } });
					}
					continue;
				} else if (resource === 'message' && operation === 'edit') {
					const channelId = normaliseChannelId(this.getNodeParameter('channelId', i));
					const eventId = String(this.getNodeParameter('eventId', i)).trim();
					const newContent = String(this.getNodeParameter('content', i));
					assertContentWithinLimit(newContent, undefined, 'edited message');
					result = await publish(KIND_MESSAGE_EDIT,
						[['e', eventId], ['h', channelId]],
						newContent,
					);
					result.editedEventId = eventId;
					result.channelId = channelId;
				} else if (resource === 'message' && operation === 'delete') {
					const channelId = normaliseChannelId(this.getNodeParameter('channelId', i));
					const eventId = String(this.getNodeParameter('eventId', i)).trim();
					result = await publish(KIND_DELETE, [['e', eventId], ['h', channelId]], '',
					);
					result.deletedEventId = eventId;
					result.channelId = channelId;
				} else if (resource === 'reaction' && operation === 'add') {
					const eventId = String(this.getNodeParameter('eventId', i)).trim();
					const rawChannelId = String(this.getNodeParameter('channelId', i, '') || '').trim();
					const channelId = rawChannelId ? normaliseChannelId(rawChannelId) : '';
					const tags = [['e', eventId]];
					if (channelId) tags.push(['h', channelId]);

					result = await publish(KIND_REACTION, tags, this.getNodeParameter('emoji', i),
					);
					result.reactedToEventId = eventId;
				} else if (resource === 'reaction' && operation === 'get') {
					const eventId = String(this.getNodeParameter('eventId', i)).trim();
					const events = await query([
						{ '#e': [eventId], kinds: [KIND_REACTION], limit: RELAY_QUERY_CAP },
					]);
					const reactionsTruncated = events.length >= RELAY_QUERY_CAP;
					if (reactionsTruncated) {
						this.logger?.warn?.(
							`Buzz reaction: get hit the ${RELAY_QUERY_CAP}-event cap — the list is incomplete`,
						);
					}
					for (const event of newestFirst(events)) {
						returnData.push({
							json: {
								reactionId: event.id,
								reactedToEventId: eventId,
								emoji: event.content,
								pubkey: event.pubkey,
								createdAt: event.created_at,
								truncated: reactionsTruncated || undefined,
							},
							pairedItem: { item: i },
						});
					}
					continue;
				} else if (resource === 'reaction' && operation === 'remove') {
					// Two steps, exactly as the CLI does it: a reaction is an event, so removing one
					// means finding YOUR kind:7 on that target and deleting it by id. There is no
					// "unreact" verb. Captured 2026-08-04 — the query filters by `authors` = self,
					// and the emoji match is done client-side because the relay cannot filter on
					// event content.
					const eventId = String(this.getNodeParameter('eventId', i)).trim();
					const emoji = String(this.getNodeParameter('emoji', i));
					const selfPubkey = getPublicKey(secretKey);

					const mine = await query([
						{ '#e': [eventId], authors: [selfPubkey], kinds: [KIND_REACTION], limit: RELAY_QUERY_CAP },
					]);
					const match = newestFirst(mine).find((e) => e.content === emoji);
					if (!match) {
						// Deleting "nothing" silently would look identical to a successful removal.
						throw new Error(
							`No reaction "${emoji}" by this identity found on event ${eventId.slice(0, 12)}… ` +
							`(it has ${mine.length} reaction(s) from this identity` +
							`${mine.length ? `: ${mine.map((e) => e.content).join(' ')}` : ''}). ` +
							'Nothing was deleted.' +
							(mine.length >= RELAY_QUERY_CAP
								? ` ⚠️ The search hit the ${RELAY_QUERY_CAP}-event cap, so an older matching reaction may exist and simply not have been seen.`
								: ''),
						);
					}

					// NOTE: only an `e` tag — no `h`. Message edit/delete DO require `h`
					// ("channel-scoped events must include an h tag"), but the captured reaction
					// deletion carries the reaction id alone. Do not "fix" this by adding a channel.
					result = await publish(KIND_DELETE, [['e', match.id]], '',
					);
					result.removedReactionId = match.id;
					result.reactedToEventId = eventId;
					result.emoji = emoji;
				} else if (resource === 'canvas' && operation === 'set') {
					const channelId = normaliseChannelId(this.getNodeParameter('channelId', i));
					result = await publish(KIND_CANVAS, [['h', channelId]], this.getNodeParameter('content', i),
					);
					result.channelId = channelId;
				} else if (resource === 'canvas' && operation === 'get') {
					const channelId = normaliseChannelId(this.getNodeParameter('channelId', i));
					const events = newestFirst(
						await query([
							{ kinds: [KIND_CANVAS], '#h': [channelId], limit: 10 },
						]),
					);
					const latest = events[0];

					returnData.push({
						json: {
							channelId,
							found: Boolean(latest),
							content: latest ? latest.content : '',
							eventId: latest ? latest.id : undefined,
							pubkey: latest ? latest.pubkey : undefined,
							createdAt: latest ? latest.created_at : undefined,
						},
						pairedItem: { item: i },
					});
					continue;
				} else if (resource === 'message' && operation === 'thread') {
					// Captured from `buzz messages thread`: TWO filters in ONE /query — the replies
					// (#e = root, #h = channel) and the root itself by id. `depth_limit` is a
					// NON-STANDARD filter field the relay understands; it is only sent when set,
					// matching the CLI when --depth-limit is omitted.
					const rootId = String(this.getNodeParameter('eventId', i)).trim();
					const channelId = normaliseChannelId(this.getNodeParameter('threadChannelId', i));
					const limit = Number(this.getNodeParameter('threadLimit', i, 100)) || 100;
					const depthLimit = Number(this.getNodeParameter('threadDepthLimit', i, 0)) || 0;

					const repliesFilter = {
						'#e': [rootId],
						'#h': [channelId],
						kinds: THREAD_KINDS,
						limit,
					};
					if (depthLimit > 0) repliesFilter.depth_limit = depthLimit;

					const events = await query([
						repliesFilter,
						{ ids: [rootId], limit: 1 },
					]);

					const selfPubkey = getPublicKey(secretKey);
					// The relay returns root and replies in one flat array, so mark which is which
					// rather than making the caller re-compare ids.
					for (const event of newestFirst(events)) {
						returnData.push({
							json: {
								...shapeMessage(event, selfPubkey),
								isRoot: event.id === rootId,
								rootEventId: rootId,
							},
							pairedItem: { item: i },
						});
					}
					continue;
				} else if (
					resource === 'message'
					&& (operation === 'sendForumPost' || operation === 'sendForumComment')
				) {
					const channelId = normaliseChannelId(this.getNodeParameter('forumChannelId', i));
					const content = String(this.getNodeParameter('forumContent', i));
					assertContentWithinLimit(content, undefined, 'forum post');

					const tags = [['h', channelId]];
					if (operation === 'sendForumComment') {
						tags.push(...threadTags(
							this.getNodeParameter('forumRootId', i),
							this.getNodeParameter('forumParentId', i, ''),
						));
					}
					tags.push(...mentionTags(this.getNodeParameter('forumMentions', i, '')));

					result = await publish(
						operation === 'sendForumPost' ? KIND_FORUM_POST : KIND_FORUM_COMMENT,
						tags,
						content,
					);
					result.channelId = channelId;
				} else if (resource === 'reaction' && operation === 'addCustomEmoji') {
					// Custom emoji reactions are still kind 7, but the content is the shortcode
					// wrapped in colons and an `emoji` tag carries the shortcode + image URL.
					const eventId = String(this.getNodeParameter('eventId', i)).trim();
					const shortcode = String(this.getNodeParameter('emojiShortcode', i))
						.trim().replace(/^:|:$/g, '');
					const url = String(this.getNodeParameter('emojiUrl', i)).trim();
					if (!/^[a-z0-9_]+$/i.test(shortcode)) {
						throw new Error(
							`Emoji shortcode must be letters, digits and underscores only, got "${shortcode}"`,
						);
					}
					result = await publish(
						KIND_REACTION,
						[['e', eventId], ['emoji', shortcode, url]],
						`:${shortcode}:`,
					);
					result.reactedToEventId = eventId;
					result.emoji = `:${shortcode}:`;
				} else if (resource === 'message' && operation === 'vote') {
					// Captured: kind 45002, content "+" / "-", tags h + e. The channel is NOT a
					// parameter — the CLI resolves it from the target event, so the node does too
					// rather than asking for something the caller would have to look up anyway.
					const eventId = String(this.getNodeParameter('eventId', i)).trim();
					const direction = String(this.getNodeParameter('voteDirection', i)).trim();
					// The UI is a two-value dropdown, but an EXPRESSION can produce anything, and
					// `=== 'down' ? '-' : '+'` silently turned "DOWN" or "sideways" into an UPVOTE
					// while echoing the bogus value back as `direction`.
					// 
					if (direction !== 'up' && direction !== 'down') {
						throw new Error(
							`Vote direction must be exactly "up" or "down", got "${direction}"`,
						);
					}

					const found = await query([{ ids: [eventId] }]);
					const target = newestFirst(found)[0];
					if (!target) throw new Error(`No event found with id ${eventId}`);
					const channelId = tagValue(target, 'h');
					if (!channelId) {
						// The CLI's own wording — a vote is channel-scoped and cannot be placed.
						throw new Error(
							`Event ${eventId.slice(0, 12)}… has no h-tag — cannot determine channel`,
						);
					}

					result = await publish(KIND_VOTE,
						[['h', channelId], ['e', eventId]],
						direction === 'down' ? '-' : '+',
					);
					result.votedOnEventId = eventId;
					result.channelId = channelId;
					result.direction = direction;
				} else if (resource === 'message' && operation === 'sendDiff') {
					const channelId = normaliseChannelId(this.getNodeParameter('diffChannelId', i));
					const diff = String(this.getNodeParameter('diffContent', i));
					// Diffs cap LOWER than messages — 60 KiB, not 64. Verified in builders.rs.
					assertContentWithinLimit(diff, MAX_DIFF_CONTENT_BYTES, 'diff');
					const opts = this.getNodeParameter('diffOptions', i, {}) || {};

					const tags = [
						['h', channelId],
						['repo', String(this.getNodeParameter('diffRepo', i)).trim()],
						['commit', String(this.getNodeParameter('diffCommit', i)).trim()],
					];
					if (opts.file) tags.push(['file', String(opts.file)]);
					if (opts.parentCommit) tags.push(['parent-commit', String(opts.parentCommit)]);
					// 🔑 Source and target branch share ONE tag with TWO values — captured as
					// ["branch","feat","main"], not two separate tags.
					if (opts.sourceBranch || opts.targetBranch) {
						tags.push(['branch', String(opts.sourceBranch || ''), String(opts.targetBranch || '')]);
					}
					if (opts.pr) tags.push(['pr', String(opts.pr)]);
					if (opts.lang) tags.push(['l', String(opts.lang)]); // the tag is `l`, not `lang`
					if (opts.description) tags.push(['description', String(opts.description)]);

					// The CLI always emits an `alt` summary: "Diff" bare, or
					// "Diff: <file> — <description>" when those are present.
					const altParts = [opts.file, opts.description].filter(Boolean).map(String);
					tags.push(['alt', altParts.length ? `Diff: ${altParts.join(' — ')}` : 'Diff']);

					// Reply marker is the 4-element NIP-10 form: ["e", id, "", "reply"].
					if (opts.replyTo) tags.push(['e', String(opts.replyTo).trim(), '', 'reply']);

					result = await publish(KIND_DIFF, tags, diff);
					result.channelId = channelId;
				} else if (resource === 'user' && operation === 'setProfile') {
					const fields = this.getNodeParameter('profileFields', i, {}) || {};
					const selfPubkey = getPublicKey(secretKey);

					const existingEvents = await query([
						{ authors: [selfPubkey], kinds: [KIND_PROFILE], limit: 1 },
					]);
					const existingEvent = newestFirst(existingEvents)[0];
					let existing = {};
					if (existingEvent && String(existingEvent.content || '').trim() !== '') {
						// ⚠️ Refuse rather than coerce. `kind:0` content only has to be valid JSON —
						// the relay does not require an object — so an existing profile could be an
						// array, a string or null. Spreading those produced NUMERIC KEYS: `["x"]`
						// became {"0":"x",...} and `"abc"` became {"0":"a","1":"b","2":"c",...},
						// destroying the profile while reporting success. Malformed JSON was also
						// silently treated as {} and would have WIPED a real profile.
						// 
						let parsed;
						try {
							parsed = JSON.parse(existingEvent.content);
						} catch (e) {
							throw new Error(
								'Refusing to update the profile: the existing kind:0 content is not valid ' +
								'JSON, so merging would replace it with whatever is set here and destroy ' +
								'the rest. Fix or clear the profile first.',
							);
						}
						if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
							throw new Error(
								`Refusing to update the profile: the existing kind:0 content is ${
									Array.isArray(parsed) ? 'an array' : `a ${parsed === null ? 'null' : typeof parsed}`
								}, not an object. Merging into it would corrupt the profile.`,
							);
						}
						existing = parsed;
					}

					// ⚠️ DELIBERATE DEVIATION FROM THE CLI — verified by capture, not assumed.
					// `buzz users set-profile` reads the existing profile and merges, but it DROPS
					// the `name` field: given {name, display_name, about, picture} and --about, it
					// republished {about, display_name, picture} with `name` GONE. It also maps its
					// single --name flag onto `display_name`. Since kind:0 is REPLACEABLE, mirroring
					// that would silently delete the @-handle — the exact field that makes @mybot
					// resolve. This node merges over ALL existing keys and exposes `name` and
					// `display_name` as separate inputs.
					const next = mergeProfile(existing, fields);

					if (JSON.stringify(next) === JSON.stringify(existing)) {
						throw new Error(
							'User: Set Profile was given no fields to change. Set at least one, ' +
							'or the existing profile would just be republished unchanged.',
						);
					}

					// Strictly newer than the head we merged from, so a concurrent edit in the same
					// second cannot silently win the lowest-event-id tie-break and discard this.
					result = await publish(KIND_PROFILE, [], JSON.stringify(next),
						{ minCreatedAt: existingEvent ? existingEvent.created_at : undefined, authTag },
					);
					if (result.discarded) {
						throw new Error(
							`The relay accepted the request but DISCARDED the profile write (${result.relayMessage}). ` +
							'Another write almost certainly won the race — re-read and retry.',
						);
					}
					result.pubkey = selfPubkey;
					result.profile = next;
					result.previousProfile = existing;
				} else if (resource === 'user' && operation === 'getPresence') {
					// Captured: the READ filter asks for kind 40902 (PRESENCE_SNAPSHOT) with the
					// TARGET pubkeys as `authors`, and limit = how many were asked for. What comes
					// back is kind 20001 relay-signed — see presenceFromEvents for why that matters.
					const raw = String(this.getNodeParameter('presencePubkeys', i));
					// Lowercase (the relay returns lowercase, so an uppercase request matched
					// nothing and reported a live user as offline) and de-duplicate — the relay
					// dedupes its own lookup, but the node was still emitting one row per repeat,
					// so 50k copies of one key meant 50k output items.
					const pubkeys = [...new Set(
						raw.split(',').map((p) => p.trim()).filter(Boolean).map(normalisePubkey),
					)];
					if (!pubkeys.length) throw new Error('User: Get Presence needs at least one pubkey');
					if (pubkeys.length > MAX_PRESENCE_PUBKEYS) {
						throw new Error(
							`User: Get Presence was given ${pubkeys.length} distinct pubkeys — the limit is ` +
							`${MAX_PRESENCE_PUBKEYS}. Split the request.`,
						);
					}

					const events = await query([
						{ authors: pubkeys, kinds: [KIND_PRESENCE_SNAPSHOT], limit: pubkeys.length },
					]);
					for (const row of presenceFromEvents(pubkeys, events)) {
						returnData.push({ json: row, pairedItem: { item: i } });
					}
					continue;
				} else if (resource === 'user' && operation === 'setStatus') {
					// Captured: kind 30315 with a `d` tag of "general" (the NIP-38 status type),
					// optional `emoji` tag, content = the text. Clearing is the same event with
					// empty content and no emoji.
					const text = String(this.getNodeParameter('statusText', i, '') || '');
					const emoji = String(this.getNodeParameter('statusEmoji', i, '') || '');
					const tags = [['d', 'general']];
					if (text && emoji) tags.push(['emoji', emoji]);

					result = await publish(KIND_USER_STATUS, tags, text,
					);
					result.pubkey = getPublicKey(secretKey);
					result.status = text;
					result.cleared = text === '';
				} else if (resource === 'channel' && operation === 'list') {
					const events = await query([
						{ kinds: [KIND_CHANNEL_METADATA], limit: RELAY_QUERY_CAP },
					]);
					if (events.length >= RELAY_QUERY_CAP) {
						this.logger?.warn?.(
							`Buzz channel: list hit the ${RELAY_QUERY_CAP}-channel relay cap — the list is incomplete`,
						);
					}

					for (const event of events) {
						const shaped = shapeChannel(event);
						if (!shaped.channelId) continue;
						// Additive only — the pre-existing channelId/name/about/updatedAt keys keep
						// their names so existing workflows reading them are unaffected.
						returnData.push({ json: shaped, pairedItem: { item: i } });
					}
					continue;
				} else if (resource === 'channel' && operation === 'get') {
					const uuid = normaliseChannelId(this.getNodeParameter('channelUuid', i));
					const events = await query([
						{ '#d': [uuid], kinds: [KIND_CHANNEL_METADATA], limit: 1 },
					]);
					const event = newestFirst(events)[0];
					if (!event) throw new Error(`No channel found with UUID "${uuid}"`);
					result = shapeChannel(event);
				} else if (resource === 'channel' && operation === 'search') {
					// The CLI pulls the full metadata set and filters locally — the relay has no
					// text filter for kind 39000. Mirrored rather than invented.
					const query = String(this.getNodeParameter('channelQuery', i)).toLowerCase();
					const events = await query([
						{ kinds: [KIND_CHANNEL_METADATA], limit: RELAY_QUERY_CAP },
					]);
					// The filtering is local, so hitting the cap means a MATCH may be missing —
					// not merely that the page was full.
					if (events.length >= RELAY_QUERY_CAP) {
						this.logger?.warn?.(
							`Buzz channel: search fetched the ${RELAY_QUERY_CAP}-channel cap before filtering — a match may be missing`,
						);
					}
					for (const event of events) {
						const shaped = shapeChannel(event);
						if (!shaped.channelId) continue;
						const hay = ['name', 'about', 'topic', 'purpose']
							.map((k) => String(shaped[k] || ''))
							.join('\n')
							.toLowerCase();
						if (!hay.includes(query)) continue;
						returnData.push({ json: shaped, pairedItem: { item: i } });
					}
					continue;
				} else if (resource === 'channel' && operation === 'members') {
					const uuid = normaliseChannelId(this.getNodeParameter('channelUuid', i));
					const events = await query([
						{ '#d': [uuid], kinds: [KIND_CHANNEL_MEMBERS], limit: 1 },
					]);
					const event = newestFirst(events)[0];
					if (!event) throw new Error(`No member list found for channel "${uuid}"`);
					// ⚠️ This emits ONE ITEM PER MEMBER, so every node wired after it runs once per
					// member. That is normal n8n fan-out, but on a channel-mutating chain it means
					// the same write fires N times — an acceptance run archived a channel twice and
					// the second attempt failed with "channel is archived". Put a Limit after this
					// if the next node mutates.
					// `role` is best-effort: live kind:39002 `p` tags carry only the pubkey, and
					// roles live in kind:39003 when they are defined at all.
					for (const tag of event.tags || []) {
						if (tag[0] !== 'p' || !tag[1]) continue;
						returnData.push({
							json: { channelId: uuid, pubkey: tag[1], role: tag[2] || undefined },
							pairedItem: { item: i },
						});
					}
					continue;
				} else if (resource === 'channel' && operation === 'create') {
					// 🔑 The CLIENT mints the channel uuid and sends it as the `h` tag — the relay
					// does not allocate one. Captured, and not something that could be guessed.
					const uuid = crypto.randomUUID();
					const tags = [
						['h', uuid],
						['name', String(this.getNodeParameter('channelName', i))],
						['visibility', String(this.getNodeParameter('channelVisibility', i))],
						['channel_type', String(this.getNodeParameter('channelType', i))],
					];
					const about = String(this.getNodeParameter('channelAbout', i, '') || '');
					if (about) tags.push(['about', about]);
					const ttl = Number(this.getNodeParameter('channelTtl', i, 0)) || 0;
					if (ttl > 0) tags.push(['ttl', String(ttl)]);
					result = await publish(KIND_CHANNEL_CREATE, tags, '');
					result.channelId = uuid;
				} else if (resource === 'channel' && operation === 'update') {
					const uuid = normaliseChannelId(this.getNodeParameter('channelUuid', i));
					const tags = [['h', uuid]];
					const newName = String(this.getNodeParameter('channelNewName', i, '') || '');
					const about = String(this.getNodeParameter('channelAbout', i, '') || '');
					if (newName) tags.push(['name', newName]);
					if (about) tags.push(['about', about]);
					if (tags.length === 1) {
						throw new Error('Channel: Update needs a New Name or a Description — both were empty');
					}
					result = await publish(KIND_CHANNEL_EDIT_METADATA, tags, '');
					result.channelId = uuid;
				} else if (
					resource === 'channel' &&
					['setTopic', 'setPurpose', 'archive', 'unarchive'].includes(operation)
				) {
					const uuid = normaliseChannelId(this.getNodeParameter('channelUuid', i));
					const tag =
						operation === 'setTopic'
							? ['topic', String(this.getNodeParameter('channelTopic', i))]
							: operation === 'setPurpose'
								? ['purpose', String(this.getNodeParameter('channelPurpose', i))]
								: ['archived', operation === 'archive' ? 'true' : 'false'];
					result = await publish(KIND_CHANNEL_EDIT_METADATA, [['h', uuid], tag], '',
					);
					result.channelId = uuid;
				} else if (
					resource === 'channel' && ['join', 'leave', 'delete'].includes(operation)
				) {
					const uuid = normaliseChannelId(this.getNodeParameter('channelUuid', i));
					const kind =
						operation === 'join'
							? KIND_CHANNEL_JOIN
							: operation === 'leave'
								? KIND_CHANNEL_LEAVE
								: KIND_CHANNEL_DELETE;
					result = await publish(kind, [['h', uuid]], '');
					result.channelId = uuid;
				} else if (
					resource === 'channel' && ['addMember', 'removeMember'].includes(operation)
				) {
					const uuid = normaliseChannelId(this.getNodeParameter('channelUuid', i));
					const pubkey = normalisePubkey(this.getNodeParameter('targetPubkey', i));
					const tags = [['h', uuid], ['p', pubkey]];
					if (operation === 'addMember') {
						tags.push(['role', String(this.getNodeParameter('memberRole', i))]);
					}
					result = await publish(operation === 'addMember' ? KIND_CHANNEL_ADD_MEMBER : KIND_CHANNEL_REMOVE_MEMBER,
						tags,
						'',
					);
					result.channelId = uuid;
					result.pubkey = pubkey;
				} else if (resource === 'user' && operation === 'get') {
					const pubkey = normalisePubkey(this.getNodeParameter('userPubkey', i));
					const events = await query([
						{ authors: [pubkey], kinds: [KIND_PROFILE], limit: 1 },
					]);
					const event = newestFirst(events)[0];
					// A pubkey with no kind:0 is normal, not an error — it is what an un-mentionable
					// bot looks like. Report it plainly instead of throwing.
					result = event ? shapeProfile(event) : { pubkey, found: false, profile: null };
				} else if (resource === 'user' && operation === 'getMany') {
					// Captured from `buzz users get --name`: the relay supports a NIP-50 `search`
					// field on kind:0, so the filtering is RELAY-side, not a fetch-everything-and-
					// grep like channel search. Omit it and every profile comes back.
					const search = String(this.getNodeParameter('userSearch', i, '') || '').trim();
					const limit = Number(this.getNodeParameter('userLimit', i, 100)) || 100;

					// The relay clamps a searched kind:0 query to 500 and an unsearched one to 1000,
					// so a larger number here silently did less than it said.
					const cap = search ? RELAY_QUERY_CAP : RELAY_PROFILE_QUERY_CAP;
					const effectiveLimit = Math.min(limit, cap);
					if (limit > cap) {
						this.logger?.warn?.(
							`Buzz user: getMany limit ${limit} exceeds the relay cap of ${cap}${search ? ' for a search' : ''} — using ${cap}`,
						);
					}
					const filter = { kinds: [KIND_PROFILE], limit: effectiveLimit };
					if (search) filter.search = search;

					const events = await query([filter]);
					if (events.length >= effectiveLimit) {
						this.logger?.warn?.(
							`Buzz user: getMany returned ${events.length} profiles — at the limit, so the list may be incomplete`,
						);
					}
					for (const event of newestFirst(events)) {
						returnData.push({ json: shapeProfile(event), pairedItem: { item: i } });
					}
					continue;
				} else if (resource === 'user' && operation === 'getSelf') {
					const selfPubkey = getPublicKey(secretKey);
					const events = await query([
						{ authors: [selfPubkey], kinds: [KIND_PROFILE], limit: 1 },
					]);
					const event = newestFirst(events)[0];
					// No kind:0 for this identity is the un-mentionable-bot case again — and worth
					// surfacing plainly, since it is the exact condition that stops @-mentions
					// working at all.
					result = event
						? shapeProfile(event)
						: { pubkey: selfPubkey, found: false, profile: null };
				} else {
					throw new Error(`Unsupported operation "${resource}: ${operation}"`);
				}

				returnData.push({ json: result, pairedItem: { item: i } });
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({ json: { error: error.message }, pairedItem: { item: i } });
					continue;
				}
				throw error;
			}
		}

		return [returnData];
	}
}

// `Buzz` is what n8n's loader reads (via package.json n8n.nodes). The rest is exported so the
// security-critical guard can be tested without standing up an n8n execution context.
module.exports = {
	Buzz,
	assertSameOriginAsRelay,
	finalizeUniqueEvent,
	publishEvent,
	shapeChannel,
	shapeProfile,
	cappedStream,
	mergeProfile,
	normalisePubkey,
	presenceFromEvents,
	assertHexPubkey,
	MAX_DOWNLOAD_BYTES,
};
