// Regression tests for the review of v0.10.1 (2026-08-04).
// One test per finding fixed, each asserting the BROKEN behaviour is gone.
// Run: node test/regressions.test.js

const assert = require('assert');
const stream = require('stream');
const {
	cappedStream, mergeProfile, normalisePubkey, presenceFromEvents,
} = require('../nodes/Buzz/Buzz.node.js');

let passed = 0;
const ok = (name, fn) => { fn(); passed += 1; console.log(`  ok  ${name}`); };
const okAsync = async (name, fn) => { await fn(); passed += 1; console.log(`  ok  ${name}`); };

console.log('\nuppercase pubkeys must not read as offline');

const LOWER = 'b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0';
const UPPER = LOWER.toUpperCase();
const presenceEvent = (target) => ({
	kind: 20001, pubkey: 'relay', content: 'online', created_at: 1, tags: [['p', target]],
});

ok('normalisePubkey lowercases while still validating', () => {
	assert.strictEqual(normalisePubkey(UPPER), LOWER);
	assert.strictEqual(normalisePubkey(`  ${LOWER}  `), LOWER);
	assert.throws(() => normalisePubkey('nope'), /64 hexadecimal/);
});

ok('an uppercase request now resolves to the online row', () => {
	// Before the fix this returned {status:"offline"} for a demonstrably online user, because the
	// relay canonicalises the returned `p` tag to lowercase and the Map key was case-sensitive.
	const [row] = presenceFromEvents([normalisePubkey(UPPER)], [presenceEvent(LOWER)]);
	assert.strictEqual(row.online, true, 'uppercase input must not read as offline');
	assert.strictEqual(row.pubkey, LOWER);
});

console.log('\na non-object existing profile must be refused, not coerced');

ok('an array profile is rejected instead of becoming numeric keys', () => {
	// Before: {...['x']} produced {"0":"x"} and the merge destroyed the profile.
	assert.throws(() => mergeProfile(['x'], { about: 'changed' }), /array/i);
});

ok('a string profile is rejected instead of being exploded per character', () => {
	assert.throws(() => mergeProfile('abc', { about: 'changed' }), /object|string/i);
});

ok('null and undefined still mean "no existing profile"', () => {
	assert.deepStrictEqual(mergeProfile(null, { name: 'n' }), { name: 'n' });
	assert.deepStrictEqual(mergeProfile(undefined, { name: 'n' }), { name: 'n' });
});

console.log('\na mid-download source error must be catchable, not fatal');

// This is the blocker: `source.pipe(transform)` does NOT forward the source's error, so a relay
// resetting the connection after headers emitted an unhandled 'error' — which reaches
// uncaughtException in n8n's MAIN process and takes every workflow down. The fix routes it
// through stream.pipeline(), which destroys the consumer with the same error.
async function errorReachesConsumer(wire) {
	const source = new stream.PassThrough();
	const capped = cappedStream(1024 * 1024, { bytes: 0 });
	wire(source, capped);
	const seen = new Promise((resolve) => {
		capped.on('error', (e) => resolve(e));
		capped.on('end', () => resolve(null));
		capped.resume();
	});
	source.write('partial body');
	setImmediate(() => source.destroy(new Error('ECONNRESET')));
	return seen;
}

(async () => {
	await okAsync('pipeline() surfaces the source error on the returned stream', async () => {
		const err = await errorReachesConsumer((source, capped) => {
			stream.pipeline(source, capped, (e) => { if (e && !capped.destroyed) capped.destroy(e); });
		});
		assert.ok(err, 'the consumer must receive the error rather than it going unhandled');
		assert.match(String(err.message), /ECONNRESET/);
	});

	// Prove the OLD topology really did lose it — otherwise the test above proves nothing.
	await okAsync('the old .pipe() topology did NOT forward it (regression guard)', async () => {
		const source = new stream.PassThrough();
		const capped = cappedStream(1024 * 1024, { bytes: 0 });
		source.pipe(capped);
		let sawOnCapped = false;
		capped.on('error', () => { sawOnCapped = true; });
		capped.resume();
		source.on('error', () => {}); // keep THIS test from being the crash
		source.destroy(new Error('ECONNRESET'));
		await new Promise((r) => setTimeout(r, 50));
		assert.strictEqual(sawOnCapped, false, 'pipe() forwarding it would invalidate the fix rationale');
	});

	console.log(`\n${passed} checks passed`);
})();
