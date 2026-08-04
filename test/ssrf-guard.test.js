// Regression test — `file: download` was an unrestricted SSRF
// primitive on a SHARED community relay. Run: node test/ssrf-guard.test.js
//
// No n8n context needed: the guard is pure. The real download path is covered by the
// PDF download workflow, which must still pass after this change.

const assert = require('assert');
const { assertSameOriginAsRelay } = require('../nodes/Buzz/Buzz.node.js');
const { shapeMessage } = require('../nodes/shared.js');

const RELAY = 'https://your-community.communities.buzz.xyz';
let passed = 0;

function ok(name, fn) {
	fn();
	passed += 1;
	console.log(`  ok  ${name}`);
}

function rejects(name, fileUrl) {
	ok(name, () => {
		assert.throws(
			() => assertSameOriginAsRelay(fileUrl, RELAY),
			/Refusing to download|not a valid URL/,
			`expected ${fileUrl} to be refused`,
		);
	});
}

console.log('SSRF guard — must ACCEPT the relay origin');

ok('a relay attachment URL is accepted', () => {
	const url = `${RELAY}/media/a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1.pdf`;
	assert.strictEqual(assertSameOriginAsRelay(url, RELAY).host, 'your-community.communities.buzz.xyz');
});

ok('a trailing-slash relay URL still matches', () => {
	assert.ok(assertSameOriginAsRelay(`${RELAY}/media/abc.png`, `${RELAY}/`));
});

console.log('\nSSRF guard — must REFUSE everything else');

rejects('loopback',                 'http://127.0.0.1:5678/rest/workflows');
rejects('loopback by name',         'http://localhost:5678/rest/workflows');
rejects('IPv6 loopback',            'http://[::1]:5678/');
rejects('cloud metadata endpoint',  'http://169.254.169.254/latest/meta-data/');
rejects('docker-internal service',  'http://n8n-runners:5679/');
rejects('private LAN address',      'http://192.168.1.1:8080/');
rejects('a private LAN address',     'http://10.0.0.1:5678/');
rejects('a different host',         'https://evil.example.com/payload.pdf');
rejects('http when relay is https', `http://your-community.communities.buzz.xyz/media/a.pdf`);
rejects('lookalike host',           'https://your-community.communities.buzz.xyz.evil.com/a.pdf');
rejects('userinfo trick',           'https://your-community.communities.buzz.xyz@evil.com/a.pdf');
rejects('file scheme',              'file:///etc/passwd');
rejects('not a URL at all',         'not-a-url');

console.log('\nshapeMessage must expose attachments (the copies had diverged)');

ok('imeta is parsed into attachments', () => {
	const event = {
		id: 'e1', pubkey: 'p1', kind: 9, created_at: 1785699606, content: 'see attached',
		tags: [
			['h', 'channel-uuid'],
			['imeta',
				'url https://your-community.communities.buzz.xyz/media/abc.pdf',
				'm application/pdf',
				'x abc',
				'size 100000',
				'filename example document.pdf'],
		],
	};
	const shaped = shapeMessage(event, 'someone-else');
	assert.strictEqual(shaped.attachments.length, 1);
	assert.strictEqual(shaped.attachments[0].m, 'application/pdf');
	// A filename with spaces must survive: imeta splits on the FIRST space only.
	assert.strictEqual(shaped.attachments[0].filename, 'example document.pdf');
	// And the URL it yields must be one the download guard accepts.
	assert.ok(assertSameOriginAsRelay(shaped.attachments[0].url, RELAY));
});

console.log(`\n${passed} checks passed`);
