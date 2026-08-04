// Regression test — polling used a single `limit: 100` query with
// no paging, so a burst of more than 100 messages between polls was silently truncated, and
// `since: cursor + 1` skipped anything sharing the newest second.
// Run: node test/pagination.test.js

const assert = require('assert');
const { fetchPaged } = require('../nodes/shared.js');

let passed = 0;
const ok = (name, fn) => fn().then(() => { passed += 1; console.log(`  ok  ${name}`); });

// A fake relay holding `total` events, one per second counting back from `newest`.
// Honours since / until / limit the way a NIP-01 relay does, newest first.
function fakeRelay(total, newest = 1_000_000) {
	const events = Array.from({ length: total }, (_, i) => ({
		id: `e${i}`,
		created_at: newest - i,
	}));
	const calls = [];

	return {
		calls,
		run: async (filters) => {
			const f = filters[0];
			calls.push({ since: f.since, until: f.until, limit: f.limit });
			return events
				.filter((e) => (f.since === undefined || e.created_at >= f.since))
				.filter((e) => (f.until === undefined || e.created_at <= f.until))
				.sort((a, b) => b.created_at - a.created_at)
				.slice(0, f.limit);
		},
	};
}

async function main() {
	await ok('a short page returns immediately, one query', async () => {
		const relay = fakeRelay(7);
		const got = await fetchPaged(relay.run, {}, 0, { pageLimit: 100 });
		assert.strictEqual(got.length, 7);
		assert.strictEqual(relay.calls.length, 1);
	});

	await ok('a 250-event burst is fully collected, not truncated at 100', async () => {
		const relay = fakeRelay(250);
		const got = await fetchPaged(relay.run, {}, 0, { pageLimit: 100, maxPages: 10 });
		assert.strictEqual(got.length, 250, `expected all 250, got ${got.length}`);
		assert.strictEqual(new Set(got.map((e) => e.id)).size, 250, 'no duplicates across pages');
	});

	await ok('an exactly-full single page still probes for more', async () => {
		const relay = fakeRelay(100);
		const got = await fetchPaged(relay.run, {}, 0, { pageLimit: 100 });
		assert.strictEqual(got.length, 100);
		assert.ok(relay.calls.length >= 2, 'a full page must trigger a follow-up query');
	});

	await ok('paging walks `until` strictly backwards (no infinite loop)', async () => {
		const relay = fakeRelay(250);
		await fetchPaged(relay.run, {}, 0, { pageLimit: 100, maxPages: 10 });
		const untils = relay.calls.map((c) => c.until).filter((u) => u !== undefined);
		for (let i = 1; i < untils.length; i += 1) {
			assert.ok(untils[i] < untils[i - 1], 'until must strictly decrease');
		}
	});

	await ok('maxPages caps the work and reports truncation', async () => {
		const relay = fakeRelay(10000);
		let truncatedAt = null;
		const got = await fetchPaged(relay.run, {}, 0, {
			pageLimit: 100,
			maxPages: 3,
			onTruncated: (n) => { truncatedAt = n; },
		});
		assert.strictEqual(relay.calls.length, 3, 'must stop at maxPages');
		assert.strictEqual(got.length, 300);
		assert.strictEqual(truncatedAt, 300, 'caller must be told data was left behind');
	});

	await ok('`since` is passed through INCLUSIVE on every page', async () => {
		const relay = fakeRelay(250);
		await fetchPaged(relay.run, {}, 4242, { pageLimit: 100, maxPages: 10 });
		for (const call of relay.calls) {
			assert.strictEqual(call.since, 4242, 'since must never be incremented');
		}
	});

	await ok('same-second events are not skipped (the `since + 1` bug)', async () => {
		// Three events sharing one second, at exactly the cursor.
		const events = [
			{ id: 'a', created_at: 500 },
			{ id: 'b', created_at: 500 },
			{ id: 'c', created_at: 500 },
		];
		const run = async (filters) =>
			events.filter((e) => e.created_at >= filters[0].since);

		const got = await fetchPaged(run, {}, 500, { pageLimit: 100 });
		assert.strictEqual(got.length, 3, 'all three same-second events must come back');
	});

	await ok('the base filter is preserved on every page', async () => {
		const relay = fakeRelay(250);
		const base = { kinds: [9], '#h': ['channel-uuid'] };
		const run = async (filters) => {
			assert.deepStrictEqual(filters[0].kinds, [9]);
			assert.deepStrictEqual(filters[0]['#h'], ['channel-uuid']);
			return relay.run(filters);
		};
		await fetchPaged(run, base, 0, { pageLimit: 100, maxPages: 10 });
		assert.deepStrictEqual(base, { kinds: [9], '#h': ['channel-uuid'] }, 'base must not mutate');
	});

	await ok('an empty relay yields nothing and one query', async () => {
		const relay = fakeRelay(0);
		const got = await fetchPaged(relay.run, {}, 0, { pageLimit: 100 });
		assert.strictEqual(got.length, 0);
		assert.strictEqual(relay.calls.length, 1);
	});

	console.log(`\n${passed} checks passed`);
}

main().catch((error) => { console.error(error); process.exit(1); });
