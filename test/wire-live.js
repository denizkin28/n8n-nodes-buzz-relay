// LIVE WIRE TEST — talks to a real Buzz relay over HTTP.
//
// Everything in `npm test` is offline: it exercises parsing, guards and event construction, and
// it has never once proved that the relay accepts what we build. Every wire-level defect this
// node has had — the same-second duplicate ids the relay silently deduped, the delegated auth tag
// missing from reads, an unrecognised /query shape read as "no messages" — was invisible to the
// offline suite by construction. This file is the counterpart: it asserts against the relay.
//
// NOT part of `npm test`. It needs credentials, network, and it writes to a real channel.
//   npm run test:wire
//
// Configuration is entirely by environment, so no relay URL, channel id or key is baked into a
// file that gets published:
//   BUZZ_RELAY_URL       required, e.g. https://relay.example.net
//   BUZZ_IDENTITY_FILE   required, JSON containing {"nsec": "..."} — read at runtime, never logged
//   BUZZ_CHANNEL_NAME    optional, default "wire-test" (found by name, created if absent)
//
// The bot must already be a member of the relay's community: membership is granted in Buzz
// Desktop and there is no API for it, so a fresh key cannot bootstrap itself.

const assert = require('assert');
const fs = require('fs');
const crypto = require('crypto');
const { generateSecretKey } = require('nostr-tools');

const {
	decodeSecretKey,
	normaliseRelayUrl,
	queryEvents,
	tagValue,
	KIND_MESSAGE,
	KIND_CHANNEL_METADATA,
} = require('../nodes/shared.js');
const { publishEvent } = require('../nodes/Buzz/Buzz.node.js');

const KIND_CHANNEL_CREATE = 9007;
const KIND_DELETE = 5;

const RELAY_URL = normaliseRelayUrl(requireEnv('BUZZ_RELAY_URL'));
const CHANNEL_NAME = process.env.BUZZ_CHANNEL_NAME || 'wire-test';

function requireEnv(name) {
	const value = process.env[name];
	if (!value) {
		console.error(`\nMissing ${name}. See the header of this file for the three variables.`);
		process.exit(2);
	}
	return value;
}

// The secret never enters a log line, an error message or the process title.
function loadSecretKey() {
	const path = requireEnv('BUZZ_IDENTITY_FILE');
	let parsed;
	try {
		parsed = JSON.parse(fs.readFileSync(path, 'utf8'));
	} catch (error) {
		console.error(`\nCould not read ${path}: ${error.code || error.message}`);
		process.exit(2);
	}
	if (!parsed.nsec) {
		console.error(`\n${path} has no "nsec" field.`);
		process.exit(2);
	}
	return decodeSecretKey(parsed.nsec);
}

// n8n hands nodes a `this.helpers.httpRequest`. The node code is written against that shape, so
// the shim reproduces it rather than the node being rewritten around fetch: what runs here is
// the same code path that runs inside n8n.
const ctx = {
	helpers: {
		async httpRequest({ method, url, body, json, headers }) {
			const response = await fetch(url, {
				method,
				headers: { ...(json ? { 'content-type': 'application/json' } : {}), ...headers },
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			const text = await response.text();
			if (!response.ok) {
				// n8n's helper throws on non-2xx; the node relies on that.
				const error = new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
				error.statusCode = response.status;
				throw error;
			}
			try {
				return JSON.parse(text);
			} catch {
				return text;
			}
		},
	},
};

let passed = 0;
let failed = 0;
const results = [];

async function ok(name, fn) {
	try {
		await fn();
		passed += 1;
		console.log(`  ok    ${name}`);
	} catch (error) {
		failed += 1;
		results.push(`${name}: ${error.message}`);
		console.log(`  FAIL  ${name}\n          ${error.message}`);
	}
}

const query = (secretKey, filters) => queryEvents(ctx, RELAY_URL, secretKey, filters);
const publish = (secretKey, kind, tags, content) =>
	publishEvent(ctx, RELAY_URL, secretKey, kind, tags, content);

async function findOrCreateChannel(secretKey) {
	const events = await query(secretKey, [{ kinds: [KIND_CHANNEL_METADATA], limit: 500 }]);
	const newestByUuid = new Map();
	for (const event of events) {
		const uuid = tagValue(event, 'd');
		if (!uuid) continue;
		const previous = newestByUuid.get(uuid);
		if (!previous || previous.created_at < (event.created_at || 0)) {
			newestByUuid.set(uuid, { name: tagValue(event, 'name') || uuid, created_at: event.created_at || 0 });
		}
	}
	for (const [uuid, meta] of newestByUuid) {
		if (meta.name === CHANNEL_NAME) return { uuid, created: false };
	}

	// The CLIENT mints the uuid and sends it as the `h` tag — the relay does not allocate one.
	const uuid = crypto.randomUUID();
	await publish(secretKey, KIND_CHANNEL_CREATE, [
		['h', uuid],
		['name', CHANNEL_NAME],
		['visibility', 'private'],
		['channel_type', 'stream'],
		['about', 'Automated wire test. Messages here are created and deleted by npm run test:wire.'],
	], '');
	return { uuid, created: true };
}

async function main() {
	const secretKey = loadSecretKey();
	console.log(`relay:   ${RELAY_URL}`);

	const channel = await findOrCreateChannel(secretKey);
	console.log(`channel: ${CHANNEL_NAME} (${channel.created ? 'created' : 'existing'})\n`);

	const h = [['h', channel.uuid]];
	const posted = [];
	const stamp = `wire-test ${new Date().toISOString()} ${crypto.randomUUID().slice(0, 8)}`;

	await ok('auth is accepted by the relay (a signed NIP-98 header returns data)', async () => {
		const events = await query(secretKey, [{ kinds: [KIND_CHANNEL_METADATA], limit: 1 }]);
		assert(Array.isArray(events), 'expected /query to return an array of events');
	});

	let first;
	await ok('a message is published and the relay reports it accepted', async () => {
		first = await publish(secretKey, KIND_MESSAGE, h, stamp);
		posted.push(first.eventId);
		assert.strictEqual(first.accepted, true, 'relay did not accept the message');
		assert.strictEqual(first.discarded, false, `relay discarded it: ${first.relayMessage}`);
		assert.match(first.eventId, /^[0-9a-f]{64}$/, 'event id is not a 64-char hex string');
	});

	await ok('the published message reads back with byte-identical content', async () => {
		const events = await query(secretKey, [{ ids: [first.eventId] }]);
		assert.strictEqual(events.length, 1, `expected exactly 1 event for the id, got ${events.length}`);
		assert.strictEqual(events[0].content, stamp, 'content changed in transit');
		assert.strictEqual(events[0].id, first.eventId, 'relay stored a different id');
	});

	// THE regression the offline suite cannot prove. Two identical sends inside one second hash to
	// the same Nostr id, so the relay deduped one away while the node reported two successes. The
	// fix nudges `created_at`; only the relay can confirm both survived.
	await ok('two identical sends in the same second BOTH persist on the relay', async () => {
		const content = `${stamp} duplicate-probe`;
		const a = await publish(secretKey, KIND_MESSAGE, h, content);
		const b = await publish(secretKey, KIND_MESSAGE, h, content);
		posted.push(a.eventId, b.eventId);

		assert.notStrictEqual(a.eventId, b.eventId, 'the two sends produced the SAME event id');
		assert.strictEqual(a.discarded, false, 'first send was discarded');
		assert.strictEqual(b.discarded, false, 'second send was discarded as a duplicate');

		const stored = await query(secretKey, [{ ids: [a.eventId, b.eventId] }]);
		const ids = new Set(stored.map((e) => e.id));
		assert.strictEqual(ids.size, 2, `relay kept ${ids.size} of the 2 events — one was deduped away`);
	});

	// Negative control. Without this the suite could pass against a relay that authenticates
	// nobody, and every check above would be measuring nothing.
	await ok('a NON-MEMBER key is REFUSED (proves auth is actually enforced)', async () => {
		const stranger = generateSecretKey();
		let refused = false;
		try {
			await publish(stranger, KIND_MESSAGE, h, 'this must never be stored');
		} catch (error) {
			refused = true;
			assert(
				/membership|forbidden|403|401|auth|not accept/i.test(error.message),
				`refused, but for an unexpected reason: ${error.message}`,
			);
		}
		assert(refused, 'the relay ACCEPTED a write from a key that is not a member');
	});

	await ok('published messages can be deleted and are then gone', async () => {
		for (const id of posted) {
			await publish(secretKey, KIND_DELETE, [...h, ['e', id]], '');
		}
		const remaining = await query(secretKey, [{ ids: posted }]);
		assert.strictEqual(remaining.length, 0, `${remaining.length} of ${posted.length} messages survived deletion`);
		posted.length = 0;
	});

	if (posted.length) {
		console.log(`\n  cleanup: ${posted.length} message(s) left on the relay`);
	}

	console.log(`\n${passed} checks passed, ${failed} failed`);
	if (failed) {
		console.log('\nfailures:');
		for (const line of results) console.log(`  - ${line}`);
	}
	process.exit(failed ? 1 : 0);
}

main().catch((error) => {
	console.error(`\nwire test aborted: ${error.message}`);
	process.exit(1);
});
