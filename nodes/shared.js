// Shared helpers for the Buzz nodes.
//
// NOTE: Buzz.node.js still carries its own copies of these. That duplication is deliberate
// for now — it was left alone rather than refactored, because the action node is working and
// verified, and every change to it costs an `n8n` container restart. Unify when the package
// is rewritten in TypeScript for npm publication.

const { finalizeEvent, nip19 } = require('nostr-tools');

const KIND_MESSAGE = 9;
const KIND_HTTP_AUTH = 27235;
const KIND_CHANNEL_METADATA = 39000;

function decodeSecretKey(raw) {
	const key = String(raw || '').trim();

	if (key.startsWith('nsec')) {
		const decoded = nip19.decode(key);
		if (decoded.type !== 'nsec') {
			throw new Error(`Expected an nsec key but got a ${decoded.type}`);
		}
		return decoded.data;
	}

	if (/^[0-9a-f]{64}$/i.test(key)) {
		const bytes = new Uint8Array(32);
		for (let i = 0; i < 32; i++) {
			bytes[i] = parseInt(key.slice(i * 2, i * 2 + 2), 16);
		}
		return bytes;
	}

	throw new Error('Private key must be an nsec1... string or 64 hexadecimal characters');
}

function normaliseRelayUrl(raw) {
	const trimmed = String(raw == null ? '' : raw).trim();
	if (!trimmed) {
		throw new Error('Relay URL is empty in the Buzz API credential');
	}

	// Accept the WebSocket forms and convert, rather than rejecting them. `wss://` is what the
	// Buzz app and docs show, so it is the form people naturally paste — and this node talks to
	// the relay's REST surface, which is the same host over http(s). Refusing it taught the user
	// nothing they could not be given automatically.
	let url;
	try {
		url = new URL(trimmed);
	} catch (e) {
		throw new Error(
			`Relay URL is not a valid URL: "${trimmed}". Expected something like ` +
			'https://your-community.communities.buzz.xyz',
		);
	}

	if (url.protocol === 'ws:') url.protocol = 'http:';
	else if (url.protocol === 'wss:') url.protocol = 'https:';

	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error(
			`Relay URL must be http(s):// or ws(s)://, got "${url.protocol}//" in "${trimmed}"`,
		);
	}

	// A query string or fragment on a base URL is always a paste error, and would corrupt every
	// path built from it.
	url.search = '';
	url.hash = '';
	url.pathname = url.pathname.replace(/\/+$/, '');
	if (url.pathname === '/') url.pathname = '';

	return url.toString().replace(/\/$/, '');
}

// Buzz channel ids are UUIDs. Validating locally turns an opaque relay rejection into a message
// that names the offending value, and lowercasing matches how the relay stores them.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normaliseChannelId(raw) {
	const trimmed = String(raw == null ? '' : raw).trim();
	if (!UUID_PATTERN.test(trimmed)) {
		throw new Error(
			`Channel ID must be a UUID, got "${trimmed.slice(0, 40)}". Pick a channel from the ` +
			'list, or pass the channel UUID (not its name).',
		);
	}
	return trimmed.toLowerCase();
}

// Content ceilings enforced by the relay SDK (`buzz-sdk/src/builders.rs`), in BYTES not
// characters — `check_content` measures UTF-8 length, so emoji and non-Latin text hit it sooner
// than the character count suggests. Checking locally names the limit and the actual size
// instead of surfacing a generic relay rejection.
const MAX_CONTENT_BYTES = 64 * 1024;
const MAX_DIFF_CONTENT_BYTES = 60 * 1024; // diffs and git patches are lower — verified in builders.rs

function assertContentWithinLimit(content, max = MAX_CONTENT_BYTES, what = 'message') {
	const bytes = Buffer.byteLength(String(content == null ? '' : content), 'utf8');
	if (bytes > max) {
		throw new Error(
			`This ${what} is ${bytes} bytes — the relay limit is ${max}. Note the limit is on ` +
			'UTF-8 BYTES, so emoji and non-Latin characters count for more than one.',
		);
	}
}

// NIP-OA delegated-agent auth tag: ["auth", <owner-pubkey-hex>, <conditions>, <sig-hex>].
// Optional — only set when a bot acts on behalf of an owner identity. Shape per
// `buzz-sdk/src/nip_oa.rs`; the relay extracts the owner from it (a ban on the owner cascades
// to the agent), so a malformed tag must fail here rather than be sent and silently ignored.
function parseAuthTag(raw) {
	const trimmed = String(raw == null ? '' : raw).trim();
	if (!trimmed) return null;

	let parsed;
	try {
		parsed = JSON.parse(trimmed);
	} catch (e) {
		throw new Error(
			'NIP-OA Auth Tag is not valid JSON. Expected ["auth","<owner-pubkey-hex>","<conditions>","<sig-hex>"]',
		);
	}
	if (!Array.isArray(parsed) || parsed.length !== 4 || parsed[0] !== 'auth'
		|| !parsed.every((p) => typeof p === 'string')) {
		throw new Error(
			'NIP-OA Auth Tag must be a 4-element JSON array of strings starting with "auth": ' +
			'["auth","<owner-pubkey-hex>","<conditions>","<sig-hex>"]',
		);
	}
	return parsed;
}

let authCounter = 0;

// Identical url + method + created_at produce an identical event id, which the relay
// rejects as "NIP-98: replay detected". The nonce keeps concurrent requests distinct.
function authHeader(secretKey, url, method) {
	authCounter += 1;
	const nonce = `${authCounter}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

	const event = finalizeEvent(
		{
			kind: KIND_HTTP_AUTH,
			created_at: Math.floor(Date.now() / 1000),
			tags: [
				['u', url],
				['method', method],
				['nonce', nonce],
			],
			content: '',
		},
		secretKey,
	);

	return `Nostr ${Buffer.from(JSON.stringify(event), 'utf8').toString('base64')}`;
}

// The relay wants the filter list at the top level; a wrapped { filters: [...] } is
// rejected with "invalid filters: invalid type: map, expected a sequence".
// 🔑 Delegated (NIP-OA) identities must send the auth tag as an `x-auth-tag` HEADER on every
// HTTP request, not only inside published events. The relay feeds that header into
// `enforce_relay_membership` (buzz-relay/src/api/bridge.rs), so a delegated bot that is not
// independently a relay member is refused on READS — query, media upload and download — even
// though its writes succeed. Omitting it here made delegation look supported while leaving it
// unusable. 
function authTagHeader(authTag) {
	return authTag ? { 'x-auth-tag': JSON.stringify(authTag) } : {};
}

async function queryEvents(ctx, relayUrl, secretKey, filters, authTag) {
	const url = `${relayUrl}/query`;

	const response = await ctx.helpers.httpRequest({
		method: 'POST',
		url,
		body: filters,
		json: true,
		headers: { Authorization: authHeader(secretKey, url, 'POST'), ...authTagHeader(authTag) },
	});

	if (Array.isArray(response)) return response;
	if (response && Array.isArray(response.events)) return response.events;
	if (response && Array.isArray(response.data)) return response.data;

	// A shape we do not recognise used to fall through to `[]`, which is indistinguishable from
	// "the channel has no messages" — so relay API drift would present as a quiet empty result
	// and a trigger that had simply stopped firing. Fail loudly instead.
	throw new Error(
		'The Buzz relay returned an unrecognised response to /query — expected an array, ' +
		`{events: [...]} or {data: [...]}, got ${JSON.stringify(response)?.slice(0, 200)}. ` +
		'This usually means the relay API changed.',
	);
}

// Pages backwards through a time window instead of taking the first `pageLimit` and stopping.
// A single `limit: 100` query silently truncated any burst larger than that between polls —
// the events were simply never seen, with nothing to indicate loss.
//
// `runQuery` takes a filter array and resolves to events, so this stays pure and testable.
// `since` is INCLUSIVE in Nostr, so the caller passes its cursor unchanged and relies on a
// dedupe set; passing `cursor + 1` is what used to skip events sharing the newest second.
async function fetchPaged(runQuery, baseFilter, sinceSec, options = {}) {
	const pageLimit = options.pageLimit || 100;
	const maxPages = options.maxPages || 10;

	const collected = [];
	let until;

	for (let page = 0; page < maxPages; page += 1) {
		const filter = { ...baseFilter, since: sinceSec, limit: pageLimit };
		if (until !== undefined) filter.until = until;

		const batch = await runQuery([filter]);
		collected.push(...batch);

		// A short page means the window is exhausted.
		if (batch.length < pageLimit) return collected;

		// Walk the window back to just before the oldest event of this page.
		const oldest = Math.min(...batch.map((event) => event.created_at || 0));
		if (!Number.isFinite(oldest) || oldest <= sinceSec) return collected;
		until = oldest - 1;
	}

	// Only reachable by exhausting maxPages, which means there may be more we did not fetch.
	if (options.onTruncated) options.onTruncated(collected.length);
	return collected;
}

function tagValue(event, name) {
	const tag = (event.tags || []).find((entry) => entry[0] === name);
	return tag ? tag[1] : undefined;
}

function newestFirst(events) {
	return events.slice().sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
}

function shapeMessage(event, selfPubkey) {
	const imeta = (event.tags || []).filter((t) => t[0] === 'imeta');

	return {
		eventId: event.id,
		content: event.content,
		pubkey: event.pubkey,
		isMine: event.pubkey === selfPubkey,
		createdAt: event.created_at,
		createdAtIso: event.created_at ? new Date(event.created_at * 1000).toISOString() : undefined,
		channelId: tagValue(event, 'h'),
		replyTo: tagValue(event, 'e'),
		kind: event.kind,
		attachments: imeta.map((tag) => {
			const parsed = {};
			for (const part of tag.slice(1)) {
				const idx = String(part).indexOf(' ');
				if (idx > 0) parsed[String(part).slice(0, idx)] = String(part).slice(idx + 1);
			}
			return parsed;
		}),
	};
}

async function loadChannels(ctx) {
	const credentials = await ctx.getCredentials('buzzApi');
	const relayUrl = normaliseRelayUrl(credentials.relayUrl);
	const secretKey = decodeSecretKey(credentials.privateKey);

	const events = await queryEvents(ctx, relayUrl, secretKey, [
		{ kinds: [KIND_CHANNEL_METADATA], limit: 500 },
	]);

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
}

module.exports = {
	KIND_MESSAGE,
	KIND_HTTP_AUTH,
	KIND_CHANNEL_METADATA,
	decodeSecretKey,
	normaliseRelayUrl,
	normaliseChannelId,
	assertContentWithinLimit,
	parseAuthTag,
	authTagHeader,
	MAX_CONTENT_BYTES,
	MAX_DIFF_CONTENT_BYTES,
	authHeader,
	queryEvents,
	fetchPaged,
	tagValue,
	newestFirst,
	shapeMessage,
	loadChannels,
};
