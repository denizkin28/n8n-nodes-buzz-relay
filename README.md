# n8n-nodes-buzz-relay

**Unofficial.** A custom [n8n](https://github.com/n8n-io/n8n) node for **[Buzz](https://github.com/block/buzz)** — Block's
Nostr-based team chat — covering messages, threads, reactions, channels, users, presence, files
and canvases, plus a realtime trigger.

> **Not affiliated with Block, Inc.** "Buzz" is their product; this is an independent client.

## What this is

A **custom node for self-hosted n8n**, talking to a **Buzz relay** — either a hosted Buzz
community or a relay you run yourself.

It is **not** published as an n8n "community node" and is not on npm. You install it by putting
it in n8n's custom-nodes directory, which means:

- **Self-hosted n8n only.** n8n Cloud cannot load custom nodes.
- **Node 22+.** Realtime mode additionally depends on Node's global `WebSocket`, which is only
  unflagged from 22.0.0. Dependencies also require ≥ 20.19, so older runtimes are not supported
  even for the non-realtime operations.

## Install

Drop it into n8n's custom-nodes directory and restart. The directory is
`<n8n data dir>/custom/node_modules/<package>` — `~/.n8n/custom/node_modules/` for a default
install.

```bash
mkdir -p ~/.n8n/custom/node_modules
cd ~/.n8n/custom/node_modules
git clone https://github.com/denizkin28/n8n-nodes-buzz-relay.git
cd n8n-nodes-buzz-relay && npm install --omit=dev
# restart n8n
```

**Docker.** The same path applies *inside* the container, so bind-mount a host directory at the
n8n data dir and place the package under `custom/node_modules/` there — no custom image needed,
and image digest pins stay intact:

```yaml
volumes:
  - ./data:/home/node/.n8n        # package lives in ./data/custom/node_modules/<package>
```

Install or mount the package in **every n8n container that loads or executes workflows** — the
main instance, and in queue mode every worker too — then restart those containers. Restarting
only a task-runner container is not enough.

Verify it loaded: the **Buzz** and **Buzz Trigger** nodes appear in the node panel.

## Before you start

You need a **Nostr identity for the bot** and a relay it is allowed to use:

1. **Create a dedicated identity for the bot** — do not reuse your own. Any Nostr keypair works;
   the Buzz desktop app can create one, or use the `buzz` CLI. Keep the **nsec** (secret) and note
   the **public key**.
2. **Add that public key to the community.** Membership is enforced relay-side, so until this is
   done every request fails with `relay_membership_required`. On a hosted community, an owner or
   admin adds it in Buzz Desktop.
3. **Note the relay URL** — the base URL of the community's relay.
4. **Publish a profile for the bot** once the credential works (`User → Set Profile`). A bot with
   no `kind:0` profile cannot be `@`-mentioned at all, so mention-driven workflows never fire.

## Credential — Buzz API

| Field | |
|---|---|
| **Relay URL** | Base URL of the relay. `https://`, `http://`, `wss://` and `ws://` are all accepted and normalised to the REST form. |
| **Private Key** | The bot identity's Nostr secret key, `nsec1…` or 64-char hex. |
| **NIP-OA Auth Tag** | *Optional.* A delegated-agent auth tag `["auth","<owner-pubkey-hex>","<conditions>","<sig-hex>"]`, proving this identity acts for an owner. Attached to every event published. Leave empty for an ordinary member key. |

**The single most common first-run failure is `relay_membership_required`** — the bot's public
key is not yet a member of the community. See step 2 above.

**On Docker, the second most common failure** is cloning into the host's `~/.n8n` rather than the
directory actually bind-mounted at the container's data dir. Use the host-side path that maps to
it, and make sure the n8n user can read the files.

## Operations

### Buzz (action)

| Resource | Operations |
|---|---|
| **Message** | Send (reply-to, mentions, broadcast, binary attachments), Get Many, Search, Edit, Delete, Thread, Vote, Send Diff, **Send Forum Post**, **Send Forum Comment** |
| **Reaction** | Add, Remove, Get, **Add Custom Emoji** |
| **Channel** | List, Get, Search, Create (optional TTL for ephemeral channels), Update, Set Topic, Set Purpose, Archive, Unarchive, Delete, Join, Leave, Get Members, Add Member, Remove Member |
| **User** | Get, Get Many (+ relay-side name search), Get Self, Set Profile, Set Status, Get Presence |
| **File** | Upload, Download |
| **Canvas** | Get, Set |

### Buzz Trigger

One node, two transports via **Connection Mode**:

| Mode | Latency | Notes |
|---|---|---|
| **Realtime** (default) | ~1.5 s *(observed)* | Persistent WebSocket. Outbound-only, so it works from behind NAT. Requires Node 22+. |
| **Polling** | your interval, min 10 s | No long-lived connection; self-heals on the next tick. |

Filters: **Only When Mentioned** (matched relay-side on the `p` tag, not on the display name),
**Only Replies To**, and content matching. Attachments are parsed out of `imeta` so the output
feeds straight into `File → Download`.

While a realtime trigger is active the bot also publishes **presence**, so it shows as online.

## Behaviour worth knowing

These relay, SDK and node behaviours explain results that might otherwise look surprising. The
layer responsible is named in each case, because "the relay rejected it" and "this node refused"
need different fixes.

- **Uploads are effectively permanent** *(relay)*. The relay exposes **no media-delete API**, and
  no active reclamation/GC path exists — the storage layer has a delete primitive, but nothing
  production calls it. Deleting a message removes the *reference*, not the file. Treat uploading
  to a shared community as publishing.
- **Standalone audio is rejected** *(relay)*; validated MP4 **video is supported** by the relay
  (500 MB default ceiling), though this node applies its own 100 MiB cap. Images, PDF, ZIP, GZIP
  and XML are accepted; BMP, TIFF, WAV and HTML are refused.
- **Images carrying forbidden or non-canonical metadata channels are rejected** *(relay)* with
  `422 media contains metadata or a non-canonical metadata channel`. Observed with an image
  carrying a Content Credentials / C2PA manifest, which EXIF and ICC checks do not surface —
  dump the JPEG `APP` markers to see it. Re-encoding the pixels removes it.
- **An archived channel cannot be deleted** *(relay)* — unarchive first.
- **A new channel starts with its creator as sole owner** *(relay)*. Further owners can be added; the last remaining owner cannot be demoted or removed.
- **Votes require a forum post or comment as their target** *(relay)*; a plain message is refused.
- **Reactions are not idempotent** *(relay)* — reacting twice to the same event is rejected outright.
- **Many operations emit one item per result** *(n8n)*: Message Get Many / Search / Thread,
  Reaction Get, Channel List / Search / Get Members, and User Get Many / Get Presence. Put a
  **Limit** node after them before anything that writes, or the write fires once per item.
- **Presence is ephemeral** *(relay)* — a ~180 s TTL: a user with no entry is reported `offline` rather
  than omitted, so `is X online?` always returns a row.
- **Content is capped in UTF-8 BYTES, not characters.** This node and the Buzz SDK cap messages
  and edits at 64 KiB; the relay separately enforces 60 KiB for diffs. Emoji cost 4 bytes each,
  so a "short" message can still exceed it.
- **Set Profile merges** *(node)* over the existing `kind:0` rather than replacing it, and treats an empty
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
npm test        # 72 checks, no network or relay required
```

Tests cover the SSRF guard, pagination, event-id uniqueness, response shaping, the profile merge
and capped-stream error propagation. They deliberately do **not** cover the full HTTP download
and n8n binary-storage path, the WebSocket lifecycle, or live relay behaviour — verify those
against a real relay.

## Icons

`buzz.svg` / `buzz.dark.svg` were drawn for this package: a message bubble with a status dot,
in indigo. They share no shape or colour value with Block's Buzz mark (a bee, built from
circles and ellipses in `#d7d72e`).

This project is **not affiliated with, endorsed by, or connected to Block, Inc.** "Buzz" is
their product name, used here only to say what this node talks to.

## Related projects

- **n8n** — <https://github.com/n8n-io/n8n> (self-hosted workflow automation)
- **Buzz** — <https://github.com/block/buzz> (the relay and desktop client this talks to)

Neither project is affiliated with this one.

## License

MIT — see [LICENSE](LICENSE).
