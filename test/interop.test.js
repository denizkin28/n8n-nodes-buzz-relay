// Tests for the capabilities adopted after reviewing the competing `n8n-nodes-buzz` package
// (2026-08-04). Every limit and shape here was verified against the relay's own SDK at
// `crates/buzz-sdk/src/{builders,nip_oa}.rs`, not copied from that package.
// Run: node test/interop.test.js

const assert = require('assert');
const {
	normaliseRelayUrl, normaliseChannelId, assertContentWithinLimit, parseAuthTag,
	MAX_CONTENT_BYTES, MAX_DIFF_CONTENT_BYTES,
} = require('../nodes/shared.js');

let passed = 0;
const ok = (name, fn) => { fn(); passed += 1; console.log(`  ok  ${name}`); };

console.log('\nnormaliseRelayUrl — accept the WebSocket forms instead of rejecting them');

ok('wss:// and ws:// convert to https:// and http://', () => {
	// wss:// is the form the Buzz app and docs show, so it is what people paste. Previously this
	// threw and told them to fix it by hand.
	assert.strictEqual(normaliseRelayUrl('wss://relay.example'), 'https://relay.example');
	assert.strictEqual(normaliseRelayUrl('ws://relay.example:3000'), 'http://relay.example:3000');
});

ok('http(s) pass through unchanged', () => {
	assert.strictEqual(normaliseRelayUrl('https://relay.example'), 'https://relay.example');
	assert.strictEqual(normaliseRelayUrl('http://10.0.0.1:3000'), 'http://10.0.0.1:3000');
});

ok('trailing slashes, query strings and fragments are stripped', () => {
	// Any of these on a BASE url is a paste error, and would corrupt every path built from it.
	assert.strictEqual(normaliseRelayUrl('https://relay.example///'), 'https://relay.example');
	assert.strictEqual(normaliseRelayUrl('https://relay.example/?a=1#x'), 'https://relay.example');
});

ok('empty and non-URL input fail with a useful message', () => {
	assert.throws(() => normaliseRelayUrl(''), /empty/i);
	assert.throws(() => normaliseRelayUrl('not a url'), /valid URL/i);
	assert.throws(() => normaliseRelayUrl('ftp://relay.example'), /http/i);
});

console.log('\nnormaliseChannelId — a UUID, lowercased');

ok('accepts a UUID in either case and lowercases it', () => {
	const u = '11111111-2222-3333-4444-AAAAAAAAAAAA';
	assert.strictEqual(normaliseChannelId(u), '11111111-2222-3333-4444-aaaaaaaaaaaa');
});

ok('rejects a channel NAME with a message that says what was expected', () => {
	// The most likely mistake: passing "#general" or "general" instead of the uuid.
	assert.throws(() => normaliseChannelId('general'), /must be a UUID/);
	assert.throws(() => normaliseChannelId('#general'), /must be a UUID/);
	assert.throws(() => normaliseChannelId(''), /must be a UUID/);
});

console.log('\nassertContentWithinLimit — BYTES, not characters');

ok('allows content at exactly the limit', () => {
	assertContentWithinLimit('a'.repeat(MAX_CONTENT_BYTES));
});

ok('rejects one byte over, naming both sizes', () => {
	assert.throws(
		() => assertContentWithinLimit('a'.repeat(MAX_CONTENT_BYTES + 1)),
		/65537 bytes.*limit is 65536/,
	);
});

ok('multi-byte characters count as their UTF-8 length', () => {
	// 🐝 is 4 bytes. A character-length check would pass 65535 of them; the relay would not.
	const bees = '\u{1F41D}'.repeat(20000); // 80 000 bytes, 20 000 characters
	assert.throws(() => assertContentWithinLimit(bees), /80000 bytes/);
});

ok('diffs cap LOWER than messages — 60 KiB, not 64', () => {
	// Verified in builders.rs: build_diff_message uses 60*1024 while build_message uses 64*1024.
	assert.strictEqual(MAX_DIFF_CONTENT_BYTES, 60 * 1024);
	assertContentWithinLimit('a'.repeat(MAX_DIFF_CONTENT_BYTES), MAX_DIFF_CONTENT_BYTES, 'diff');
	assert.throws(
		() => assertContentWithinLimit('a'.repeat(MAX_DIFF_CONTENT_BYTES + 1), MAX_DIFF_CONTENT_BYTES, 'diff'),
		/diff is 61441 bytes/,
	);
});

console.log('\nparseAuthTag — NIP-OA delegated agent identity');

ok('empty means "not delegated", not an error', () => {
	assert.strictEqual(parseAuthTag(''), null);
	assert.strictEqual(parseAuthTag(undefined), null);
	assert.strictEqual(parseAuthTag('   '), null);
});

ok('a well-formed 4-element auth tag parses through', () => {
	const tag = parseAuthTag('["auth","' + 'a'.repeat(64) + '","kind=9","' + 'b'.repeat(128) + '"]');
	assert.strictEqual(tag[0], 'auth');
	assert.strictEqual(tag.length, 4);
});

ok('malformed tags fail HERE rather than being sent and ignored', () => {
	// The relay reads the owner out of this tag; a broken one would leave the agent treated as
	// unauthorised, which is far harder to diagnose after the fact than a local error.
	assert.throws(() => parseAuthTag('not json'), /valid JSON/);
	assert.throws(() => parseAuthTag('{"auth":"x"}'), /4-element/);
	assert.throws(() => parseAuthTag('["auth","a","b"]'), /4-element/);
	assert.throws(() => parseAuthTag('["nope","a","b","c"]'), /4-element/);
	assert.throws(() => parseAuthTag('["auth","a","b",123]'), /4-element/);
});

console.log(`\n${passed} checks passed`);
