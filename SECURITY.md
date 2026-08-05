# Security policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub's private vulnerability reporting on this repository:
**Security → Report a vulnerability**. That opens a private channel visible only
to the maintainer.

Useful things to include: what an attacker can do, the smallest steps that show
it, and the version or commit you tested.

This is an unofficial, self-hosted community node maintained by one person in
their spare time. There is no SLA. Expect a first response within a week or so.

## What is in scope

This node handles a Nostr private key and makes outbound requests on the
instance's behalf, so the areas worth the most scrutiny are:

- **Key handling.** The `nsec` lives in an n8n credential, AES-encrypted at rest.
  Anything that writes it to a log, an error message, node output or a request
  it does not belong in is a vulnerability.
- **Request origin control.** `File → Download` is restricted to the credential's
  own relay origin. Bypasses of `assertSameOriginAsRelay` — redirects, userinfo
  tricks, lookalike hosts, scheme downgrades, DNS rebinding — are in scope, and
  there are regression tests for that class in `test/ssrf-guard.test.js`.
- **Authentication.** NIP-98 / NIP-OA event construction and delegation, and
  anything that lets one identity act as another.
- **Input reaching the relay** unvalidated: channel identifiers, content limits,
  tag construction.

## What is out of scope

- The Buzz relay itself, and n8n itself. Report those to their own projects.
- Anything that requires an attacker to already control the n8n instance or its
  credential store — at that point the key is theirs regardless.
- Denial of service against your own relay via workflow misconfiguration.

## Reporting a data-exposure problem

If you find anything in this repository that looks like it came from a real
deployment — a hostname, a person's name, a filename, a file hash, an address —
report it privately by the same route. Test fixtures here are meant to be
synthetic; a value that looks real probably is, and is treated as a leak rather
than a cosmetic issue.
