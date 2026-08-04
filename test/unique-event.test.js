// Regression test — two identical sends inside the same second
// hashed to the SAME Nostr event id, so the relay deduped one away while the node reported
// success. Run: node test/unique-event.test.js

const assert = require('assert');
const { generateSecretKey, verifyEvent } = require('nostr-tools');
const { finalizeUniqueEvent } = require('../nodes/Buzz/Buzz.node.js');

const sk = generateSecretKey();
let passed = 0;
const ok = (name, fn) => { fn(); passed += 1; console.log(`  ok  ${name}`); };

const send = (content, tags = [['h', 'channel-uuid']]) =>
	finalizeUniqueEvent(9, tags, content, sk);

ok('two identical sends in the same second get DIFFERENT ids', () => {
	const a = send('deploy finished');
	const b = send('deploy finished');
	assert.notStrictEqual(a.id, b.id, 'ids collided — the relay would drop one');
	assert.strictEqual(b.created_at, a.created_at + 1, 'the second is nudged forward one second');
});

ok('ten identical rapid-fire sends are all distinct', () => {
	const ids = new Set();
	for (let i = 0; i < 10; i += 1) ids.add(send('same text every time').id);
	assert.strictEqual(ids.size, 10, `expected 10 distinct ids, got ${ids.size}`);
});

ok('nudged events are still VALID signed Nostr events', () => {
	const a = send('signature check');
	const b = send('signature check');
	assert.ok(verifyEvent(a), 'first event must verify');
	assert.ok(verifyEvent(b), 'nudged event must still verify');
});

ok('different content in the same second is untouched', () => {
	const before = Math.floor(Date.now() / 1000);
	const a = send('alpha');
	const b = send('beta');
	assert.notStrictEqual(a.id, b.id);
	// Neither needed a nudge, so both carry the real wall-clock second.
	assert.ok(a.created_at >= before && a.created_at <= before + 1);
	assert.ok(b.created_at >= before && b.created_at <= before + 1);
});

ok('the fix covers reactions, edits, deletes and canvas too, not just messages', () => {
	for (const kind of [5, 7, 40003, 40100]) {
		const a = finalizeUniqueEvent(kind, [['e', 'target']], 'x', sk);
		const b = finalizeUniqueEvent(kind, [['e', 'target']], 'x', sk);
		assert.notStrictEqual(a.id, b.id, `kind ${kind} still collides`);
	}
});

ok('identical content with different tags does not collide', () => {
	const a = send('hello', [['h', 'channel-a']]);
	const b = send('hello', [['h', 'channel-b']]);
	assert.notStrictEqual(a.id, b.id);
});

console.log(`\n${passed} checks passed`);
