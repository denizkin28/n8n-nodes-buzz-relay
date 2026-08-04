# n8n-nodes-buzz-relay

An [n8n](https://n8n.io) community node for **[Buzz](https://github.com/block/buzz)** — Block's
Nostr-based team chat — covering messages, threads, reactions, channels, users, presence, files
and canvases, plus a realtime trigger.

Works against a **hosted** Buzz community or a **self-hosted** relay.

> **Not affiliated with Block, Inc.** "Buzz" is their product; this is an independent client.

## Install

**n8n UI** — Settings → Community nodes → Install → `n8n-nodes-buzz-relay`

**Self-hosted, manually:**

```bash
cd ~/.n8n/custom          # create it if it does not exist
npm install n8n-nodes-buzz-relay
# restart n8n
```

**Requires Node 22+.** The trigger's realtime mode uses the global `WebSocket`, which is not
available unflagged before Node 22. On older runtimes everything else still works — set the
trigger's **Connection Mode** to *Polling*.

## Credential — Buzz API

| Field | |
|---|---|
| **Relay URL** | Base URL of the relay. `https://`, `http://`, `wss://` and `ws://` are all accepted and normalised to the REST form. |
| **Private Key** | The bot identity's Nostr secret key, `nsec1…` or 64-char hex. |
| **NIP-OA Auth Tag** | *Optional.* A delegated-agent auth tag `["auth","<owner-pubkey-hex>","<conditions>","<sig-hex>"]`, proving this identity acts for an owner. Attached to every event published. Leave empty for an ordinary member key. |

Two things that are not obvious and cause most first-run failures:

1. **The bot's pubkey must already be a member of the community**, or every request fails with
   `relay_membership_required`. Membership is relay-side — add it in the Buzz desktop app.
2. **A bot with no `kind:0` profile cannot be @-mentioned at all.** Publish one first
   (`User → Set Profile`), or mention-driven workflows will never fire.

## Operations

### Buzz (action)

| Resource | Operations |
|---|---|
| **Message** | Send (reply-to + binary attachments), Get Many, Search, Edit, Delete, Thread, Vote, Send Diff |
| **Reaction** | Add, Remove, Get |
| **Channel** | List, Get, Search, Create, Update, Set Topic, Set Purpose, Archive, Unarchive, Delete, Join, Leave, Get Members, Add Member, Remove Member |
| **User** | Get, Get Many (+ relay-side name search), Get Self, Set Profile, Set Status, Get Presence |
| **File** | Upload, Download |
| **Canvas** | Get, Set |

### Buzz Trigger

One node, two transports via **Connection Mode**:

| Mode | Latency | Notes |
|---|---|---|
| **Realtime** (default) | ~1.5 s | Persistent WebSocket. Outbound-only, so it works from behind NAT. Requires Node 22+. |
| **Polling** | your interval, min 10 s | No long-lived connection; self-heals on the next tick. |

Filters: **Only When Mentioned** (matched relay-side on the `p` tag, not on the display name),
**Only Replies To**, and content matching. Attachments are parsed out of `imeta` so the output
feeds straight into `File → Download`.

While a realtime trigger is active the bot also publishes **presence**, so it shows as online.

## Behaviour worth knowing

These are relay behaviours discovered by testing, not opinions — they explain results that
otherwise look like bugs in this node.

- **Uploads are permanent.** The relay implements no media delete at any layer and orphan blobs
  are never reclaimed. Deleting a message removes the *reference*, not the file. Treat uploading
  to a shared community as publishing.
- **Audio and video cannot be uploaded** — the product has no stored-media feature for them.
  Images, PDF, ZIP, GZIP and XML are accepted; BMP, TIFF, WAV and HTML are refused.
- **Images carrying a C2PA / Content-Credentials manifest are rejected** with
  `422 media contains metadata or a non-canonical metadata channel` — common for AI-generated
  images, and invisible to EXIF/ICC checks. Re-encode the pixels to strip it.
- **An archived channel cannot be deleted** — unarchive first.
- **The channel creator is its sole owner**, and re-adding them at a lower role is refused.
- **Votes require a forum post or comment as their target**; a plain message is refused.
- **Reactions are not idempotent** — reacting twice to the same event is rejected outright.
- **`Get Members`, `Get Many`, `Search`, `Thread` and `Get Presence` emit one item per result.**
  Put a **Limit** node after them before any node that writes, or the write fires once per item.
- **Presence is ephemeral** (a ~180 s TTL): a user with no entry is reported `offline` rather
  than omitted, so `is X online?` always returns a row.
- **Content is capped in UTF-8 BYTES, not characters** — 64 KiB for messages and edits, 60 KiB
  for diffs. Emoji cost 4 bytes each, so a "short" message can still exceed it.
- **Set Profile merges** over the existing `kind:0` rather than replacing it, and treats an empty
  field as *leave unchanged*. `kind:0` is replaceable, so a naive write would delete every field
  you did not set — including the `name` that makes `@mentions` resolve.

## Security

- **`File → Download` is restricted to the credential's own relay origin.** Buzz serves media
  from the relay, so a URL pointing anywhere else came from someone else's message; fetching it
  would make n8n issue a request to that address. Downloads are capped at 100 MB, uploads too
  (per file and in aggregate).
- **The private key lives in an n8n credential** and is AES-encrypted at rest. Do not inline it
  in a Code node — Code node state is written to execution data in plaintext.

## Development

```bash
npm install
npm test        # ~50 checks, no network or relay required
```

Tests cover the SSRF guard, pagination, event-id uniqueness, response shaping and the profile
merge. They deliberately do **not** cover the streaming download path, WebSocket lifecycle or
live relay behaviour — verify those against a real relay.

## Icons

`buzz.svg` / `buzz.dark.svg` are original artwork for this package. They are **not** Block's
Buzz mark, and this project is not affiliated with Block, Inc.

## License

MIT — see [LICENSE](LICENSE).
