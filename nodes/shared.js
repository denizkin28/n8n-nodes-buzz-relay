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
	const relayUrl = String(raw || '').trim().replace(/\/+$/, '');

	if (!relayUrl) {
		throw new Error('Relay URL is empty in the Buzz API credential');
	}
	if (!/^https?:\/\//i.test(relayUrl)) {
		throw new Error(
			`Relay URL must start with http:// or https://, got "${relayUrl}". A wss:// URL will not work here.`,
		);
	}

	return relayUrl;
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
async function queryEvents(ctx, relayUrl, secretKey, filters) {
	const url = `${relayUrl}/query`;

	const response = await ctx.helpers.httpRequest({
		method: 'POST',
		url,
		body: filters,
		json: true,
		headers: { Authorization: authHeader(secretKey, url, 'POST') },
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
	authHeader,
	queryEvents,
	fetchPaged,
	tagValue,
	newestFirst,
	shapeMessage,
	loadChannels,
};
