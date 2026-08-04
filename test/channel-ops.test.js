// Coverage for the channel + user operations added in v0.9.5.
// The wire formats they emit were CAPTURED from the real `buzz` CLI, so what is worth testing
// here is the parsing and the guards — the places a silent wrong answer could get through.
// Run: node test/channel-ops.test.js

const assert = require('assert');
const {
	shapeChannel, shapeProfile, mergeProfile, presenceFromEvents, assertHexPubkey,
} = require('../nodes/Buzz/Buzz.node.js');

let passed = 0;
const ok = (name, fn) => { fn(); passed += 1; console.log(`  ok  ${name}`); };

const ev = (tags, created_at = 1785848000) => ({ tags, created_at });

console.log('\nshapeChannel — one shape for List / Get / Search');

// 🔑 These tags are copied from a LIVE kind:39000 read off the relay on 2026-08-04, not from
// the create-side parameter names. The first version of this test asserted `["visibility",…]`
// and `["channel_type",…]` — the names the CREATE event uses — and PASSED, while the shaping
// returned undefined for every real channel. Synthetic fixtures agreeing with the code proves
// only that they agree with each other.
ok('maps a REAL relay metadata event', () => {
	const s = shapeChannel(ev([
		['d', '11111111-2222-3333-4444-555555555555'],
		['name', 'renamed-channel'],
		['about', 'example description'],
		['private'],
		['closed'],
		['t', 'stream'],
		['topic', 'example-topic'],
		['archived', 'true'],
	]));
	assert.strictEqual(s.channelId, '11111111-2222-3333-4444-555555555555');
	assert.strictEqual(s.name, 'renamed-channel');
	assert.strictEqual(s.about, 'example description');
	assert.strictEqual(s.topic, 'example-topic');
	assert.strictEqual(s.visibility, 'private', 'visibility is a BARE tag, not ["visibility",x]');
	assert.strictEqual(s.channelType, 'stream', 'type lives in ["t",x], not ["channel_type",x]');
	assert.strictEqual(s.closed, true);
	assert.strictEqual(s.archived, true);
	assert.strictEqual(s.updatedAt, 1785848000);
});

ok('public visibility is read from the bare ["public"] tag', () => {
	// A real channel-metadata shape: d,name,about,public,closed,t
	const s = shapeChannel(ev([['d', 'x'], ['name', 'general'], ['public'], ['closed'], ['t', 'stream']]));
	assert.strictEqual(s.visibility, 'public');
	assert.strictEqual(s.channelType, 'stream');
	assert.strictEqual(s.archived, undefined, 'no archived tag means unknown, not false');
});

ok('archived is a real boolean, not the string "false"', () => {
	// The relay sends archived as the STRING "true"/"false". Passing that through untouched
	// would make `if (channel.archived)` true for an UNarchived channel — a silently inverted
	// condition, which is exactly the class of bug that never announces itself.
	assert.strictEqual(shapeChannel(ev([['d', 'x'], ['archived', 'false']])).archived, false);
	assert.strictEqual(shapeChannel(ev([['d', 'x'], ['archived', 'true']])).archived, true);
});

ok('absent archived stays undefined rather than becoming false', () => {
	// "not stated" and "explicitly not archived" are different facts; collapsing them would
	// invent information the relay never sent.
	assert.strictEqual(shapeChannel(ev([['d', 'x']])).archived, undefined);
});

ok('name falls back to the uuid so a nameless channel is still identifiable', () => {
	assert.strictEqual(shapeChannel(ev([['d', 'abc']])).name, 'abc');
});

console.log('\nassertHexPubkey — reject an npub with the reason, not an opaque relay error');

ok('accepts 64-char hex, either case', () => {
	assertHexPubkey('b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0');
	assertHexPubkey('B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0');
});

ok('an npub is named as an npub and told how to fix it', () => {
	assert.throws(
		() => assertHexPubkey('npub1kzctpv9skzctpv9skzctpv9skzctpv9skzctpv9skzctpv9skzcqz5jruf'),
		/npub/i,
		'the error must say the input was an npub — this is the most likely mistake',
	);
});

ok('rejects short, long and non-hex input', () => {
	assert.throws(() => assertHexPubkey('b0b0b0b0'), /64 hexadecimal/);
	assert.throws(() => assertHexPubkey('z'.repeat(64)), /64 hexadecimal/);
	assert.throws(() => assertHexPubkey(''), /64 hexadecimal/);
});

console.log('\nshapeProfile — one shape for Get / Get Many / Get Self');

ok('a profile with display_name but NO name is normal, not broken', () => {
	// Most profiles are exactly this shape — only the bot sets `name`. Treating a
	// missing `name` as an error, or falling back to the pubkey, would misrepresent
	// every human on the relay.
	const s = shapeProfile({
		pubkey: 'e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0',
		created_at: 1785848000,
		content: JSON.stringify({ display_name: 'User A', picture: 'https://x/y.jpg' }),
	});
	assert.strictEqual(s.found, true);
	assert.strictEqual(s.name, undefined);
	assert.strictEqual(s.displayName, 'User A');
	assert.strictEqual(s.picture, 'https://x/y.jpg');
});

ok('maps a full profile', () => {
	const s = shapeProfile({
		pubkey: 'b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0',
		created_at: 1785847273,
		content: JSON.stringify({ name: 'mybot', display_name: 'Example Bot', about: 'bot' }),
	});
	assert.strictEqual(s.name, 'mybot');
	assert.strictEqual(s.displayName, 'Example Bot');
	assert.strictEqual(s.about, 'bot');
	assert.strictEqual(s.updatedAt, 1785847273);
});

ok('malformed JSON content is preserved, never thrown away', () => {
	// Losing the content silently would make a corrupt profile indistinguishable from an empty
	// one, and there would be nothing left to debug from.
	const s = shapeProfile({ pubkey: 'ab', created_at: 1, content: 'not json{' });
	assert.strictEqual(s.profile.raw, 'not json{');
	assert.strictEqual(s.name, undefined);
});

console.log('\nmergeProfile — kind:0 is REPLACEABLE, so an omitted field is a DELETED field');

// The live profile at the time this was written. `name` is what makes @mybot resolve.
const BOT_PROFILE = {
	name: 'mybot',
	display_name: 'Example Bot',
	about: 'Example automation bot.',
	picture: 'https://relay.example/media/32b27211.jpg',
};

ok('changing ONE field preserves every other field, including `name`', () => {
	// This is the whole reason the node deviates from the CLI. `buzz users set-profile --about`
	// republished the profile with `name` MISSING — which would delete the @-handle.
	const next = mergeProfile(BOT_PROFILE, { about: 'new about' });
	assert.strictEqual(next.about, 'new about');
	assert.strictEqual(next.name, 'mybot', 'the @-handle must survive an unrelated edit');
	assert.strictEqual(next.display_name, 'Example Bot');
	assert.strictEqual(next.picture, BOT_PROFILE.picture);
});

ok('name and display_name are SEPARATE fields, not aliases', () => {
	// The CLI has one --name flag and writes it to display_name, which is why setting a
	// "username" through it is impossible.
	const next = mergeProfile(BOT_PROFILE, { name: 'mybot2', displayName: 'Example Two' });
	assert.strictEqual(next.name, 'mybot2');
	assert.strictEqual(next.display_name, 'Example Two');
});

ok('an empty string leaves a field unchanged rather than clearing it', () => {
	// n8n collection fields default to ''. Treating that as "clear" would mean opening the
	// field picker and touching nothing silently wiped real values.
	const next = mergeProfile(BOT_PROFILE, { name: '', about: '', picture: '' });
	assert.deepStrictEqual(next, BOT_PROFILE);
});

ok('unknown existing keys are carried through untouched', () => {
	// The node knows five fields; a profile may legitimately carry others (banner, lud16, …)
	// and republishing without them would destroy them.
	const next = mergeProfile({ ...BOT_PROFILE, lud16: 'a@b.c', banner: 'https://x/b.png' }, { about: 'x' });
	assert.strictEqual(next.lud16, 'a@b.c');
	assert.strictEqual(next.banner, 'https://x/b.png');
});

ok('merging onto an empty or missing profile works', () => {
	assert.deepStrictEqual(mergeProfile({}, { name: 'n' }), { name: 'n' });
	assert.deepStrictEqual(mergeProfile(undefined, { name: 'n' }), { name: 'n' });
});

console.log('\npresenceFromEvents — the status belongs to the `p` tag, NOT to event.pubkey');

const BOT_PK = 'b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0';
const USER_PK = 'c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0';
// Copied from a live response: kind 20001 signed by the RELAY (a different pubkey), user in a `p` tag.
const RELAY_SIGNER = 'd0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0';
const presenceEvent = (target, content, created_at = 1785857369) => ({
	kind: 20001, pubkey: RELAY_SIGNER, content, created_at, tags: [['p', target]],
});

ok('attributes status to the p-tag target, not the relay signer', () => {
	// Using event.pubkey would report the RELAY as online and never the user — a wrong answer
	// that looks completely valid.
	const rows = presenceFromEvents([BOT_PK, USER_PK], [
		presenceEvent(USER_PK, 'online'), presenceEvent(BOT_PK, 'online'),
	]);
	assert.strictEqual(rows.length, 2);
	assert.strictEqual(rows[0].pubkey, BOT_PK);
	assert.strictEqual(rows[0].online, true);
	assert.strictEqual(rows[1].pubkey, USER_PK);
	assert.ok(!rows.some((r) => r.pubkey === RELAY_SIGNER), 'the relay must never appear as a user');
});

ok('a pubkey with NO presence entry comes back offline, not missing', () => {
	// Presence is a 180 s Redis TTL, so offline == absent. Returning only what came back would
	// give "is X online?" no row at all instead of false.
	const rows = presenceFromEvents([BOT_PK, USER_PK], [presenceEvent(BOT_PK, 'online')]);
	assert.strictEqual(rows.length, 2, 'every requested pubkey gets a row');
	const denis = rows.find((r) => r.pubkey === USER_PK);
	assert.strictEqual(denis.status, 'offline');
	assert.strictEqual(denis.online, false);
	assert.strictEqual(denis.updatedAt, undefined, 'no fake timestamp for an absent entry');
});

ok('away is reported as-is and is NOT online', () => {
	const [row] = presenceFromEvents([BOT_PK], [presenceEvent(BOT_PK, 'away')]);
	assert.strictEqual(row.status, 'away');
	assert.strictEqual(row.online, false);
});

ok('keeps the newest entry when a pubkey appears twice', () => {
	const rows = presenceFromEvents([BOT_PK], [
		presenceEvent(BOT_PK, 'away', 100), presenceEvent(BOT_PK, 'online', 200),
	]);
	assert.strictEqual(rows[0].status, 'online');
	assert.strictEqual(rows[0].updatedAt, 200);
});

ok('an empty response still yields a row per pubkey', () => {
	const rows = presenceFromEvents([BOT_PK, USER_PK], []);
	assert.deepStrictEqual(rows.map((r) => r.online), [false, false]);
});

console.log(`\n${passed} checks passed`);
