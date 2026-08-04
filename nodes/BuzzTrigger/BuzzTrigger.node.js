const { finalizeEvent, getPublicKey, verifyEvent } = require('nostr-tools');
const {
	KIND_MESSAGE,
	decodeSecretKey,
	normaliseRelayUrl,
	parseAuthTag,
	queryEvents,
	fetchPaged,
	newestFirst,
	shapeMessage,
	loadChannels,
} = require('../shared');

const KIND_CLIENT_AUTH = 22242;
const KIND_PRESENCE_UPDATE = 20001;

// Presence refresh. The relay stores presence as a Redis key with a 180 s TTL
// (`buzz-pubsub/src/presence.rs`), so it must be re-sent well inside that window or the bot
// silently drops offline. 60 s is the interval the TTL was designed around (3x = one missed
// refresh does not flap).
const PRESENCE_REFRESH_MS = 60000;

// Reconnect backoff. Reset happens on EOSE (subscription confirmed), never on `open`.
const BASE_RETRY_MS = 1000;
const MAX_RETRY_MS = 60000;

// If the subscription is not confirmed within this, the connection is broken in a way that
// will not fix itself — drop it rather than sit on a live socket with a dead subscription.
const HANDSHAKE_TIMEOUT_MS = 20000;

// Protocol-level liveness probe, because a half-open TCP connection looks open forever.
const HEARTBEAT_INTERVAL_MS = 60000;
const HEARTBEAT_TIMEOUT_MS = 15000;

// Re-requested on reconnect so a same-second boundary cannot fall through the gap. Small
// enough that the `seen` set (5 000 ids) always covers the replay.
const OVERLAP_SECONDS = 5;

// Ceiling on catch-up after an outage, so a long-stopped workflow does not replay history.
const MAX_CATCHUP_SECONDS = 24 * 60 * 60;

// How many delivered event ids survive a restart, so the overlap window cannot re-deliver.
// Comfortably larger than anything OVERLAP_SECONDS can cover; 64-char ids, so ~13 KB.
const PERSISTED_IDS = 200;

// Polling pagination — `limit: 100` with no paging silently truncated bursts.
const PAGE_LIMIT = 100;
const MAX_POLL_PAGES = 10;

function toWebSocketUrl(relayUrl) {
	return relayUrl.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
}

// One node, both transports. n8n's own `polling: true` + poll() plumbing is not used —
// everything runs inside trigger(), which is free-form, so a single node can offer a live
// subscription or an interval without needing two node types. The cost is that polling mode
// gets a plain interval instead of n8n's cron-style Poll Times UI.
class BuzzTrigger {
	constructor() {
		this.description = {
			displayName: 'Buzz Trigger',
			name: 'buzzTrigger',
			icon: 'file:buzz.svg',
			group: ['trigger'],
			version: 1,
			subtitle: '={{$parameter["mode"]}} — {{$parameter["channelId"]}}',
			description: 'Starts a workflow when a message is posted in a Buzz channel',
			defaults: { name: 'Buzz Trigger' },
			inputs: [],
			outputs: ['main'],
			credentials: [{ name: 'buzzApi', required: true }],
			properties: [
				{
					displayName: 'Connection Mode',
					name: 'mode',
					type: 'options',
					noDataExpression: true,
					options: [
						{
							name: 'Realtime',
							value: 'realtime',
							description: 'Hold a live relay subscription — fires in about a second',
						},
						{
							name: 'Polling',
							value: 'polling',
							description:
								'Ask the relay on an interval — higher latency, but no persistent connection to drop',
						},
					],
					default: 'realtime',
					description:
						'Realtime opens a WebSocket to the relay (outbound, so it works from behind NAT). Polling is the safer fallback if a long-lived connection is undesirable.',
				},
				{
					displayName: 'Poll Interval (Seconds)',
					name: 'pollInterval',
					type: 'number',
					typeOptions: { minValue: 10 },
					default: 60,
					displayOptions: { show: { mode: ['polling'] } },
					description: 'How often to ask the relay for new messages',
				},
				{
					displayName: 'Channel Name or ID',
					name: 'channelId',
					type: 'options',
					typeOptions: { loadOptionsMethod: 'getChannels' },
					default: '',
					required: true,
					description:
						'Channel to watch. Choose from the list, or specify a UUID using an expression.',
				},
				{
					displayName: 'Options',
					name: 'options',
					type: 'collection',
					placeholder: 'Add option',
					default: {},
					options: [
						{
							displayName: 'Ignore Own Messages',
							name: 'ignoreOwnMessages',
							type: 'boolean',
							default: true,
							description:
								'Whether to skip messages sent by this credential\'s own identity. Leave on — a workflow that both posts and watches the same channel will otherwise retrigger itself in a loop.',
						},
						{
							displayName: 'Only When Mentioned',
							name: 'mentionsMe',
							type: 'boolean',
							default: false,
							description:
								'Whether to trigger only on messages that @-mention this identity. Filtered by the relay via the p tag. The identity needs a kind:0 profile with a name before it can be @-mentioned at all.',
						},
						{
							displayName: 'Only Messages Containing',
							name: 'contains',
							type: 'string',
							default: '',
							placeholder: 'deploy',
							description: 'Only trigger on messages whose text contains this, case-insensitive',
						},
						{
							displayName: 'Only Replies To',
							name: 'replyTo',
							type: 'string',
							default: '',
							description: 'Only trigger on messages replying to this event ID',
						},
					],
				},
			],
		};

		this.methods = {
			loadOptions: {
				async getChannels() {
					return loadChannels(this);
				},
			},
		};
	}

	async trigger() {
		const credentials = await this.getCredentials('buzzApi');
		const relayUrl = normaliseRelayUrl(credentials.relayUrl);
		const secretKey = decodeSecretKey(credentials.privateKey);
		// NIP-OA delegation applies to the trigger too: over HTTP it rides as a header, and over
		// the WebSocket it must be a tag ON the NIP-42 auth event — `handlers/auth.rs` pulls it
		// straight off that event. Without it a delegated identity cannot subscribe at all.
		const authTag = parseAuthTag(credentials.authTag);
		const selfPubkey = getPublicKey(secretKey);

		const mode = this.getNodeParameter('mode');
		const channelId = String(this.getNodeParameter('channelId')).trim();
		const options = this.getNodeParameter('options', {}) || {};

		const baseFilter = { kinds: [KIND_MESSAGE], '#h': [channelId] };
		if (options.mentionsMe) baseFilter['#p'] = [selfPubkey];

		// --- cursor -------------------------------------------------------------------------
		// Persisted across restarts, so messages posted while n8n was down are picked up on the
		// next start instead of being silently skipped. It also bounds reconnect replay: `since`
		// used to be pinned to activation time, so every reconnect re-requested everything since
		// then, and the (correct) `seen` trim had by then evicted the oldest — which re-fired
		// old work. Now `since` advances with delivered events and only a small overlap window
		// is re-requested, comfortably inside what `seen` still remembers.
		const staticData = this.getWorkflowStaticData('node');
		const scope = `${channelId}:${options.mentionsMe ? 'mentions' : 'all'}`;
		const cursorKey = `cursor:${scope}`;
		const deliveredKey = `delivered:${scope}`;
		const startedAt = Math.floor(Date.now() / 1000);

		let cursor = Number(staticData[cursorKey]) || startedAt;

		// A long outage should not replay days of history into a workflow on restart.
		if (startedAt - cursor > MAX_CATCHUP_SECONDS) {
			this.logger?.warn?.(
				`Buzz trigger cursor is ${startedAt - cursor}s old; catching up only the last ` +
				`${MAX_CATCHUP_SECONDS}s. Older messages in this channel will not be delivered.`,
			);
			cursor = startedAt - MAX_CATCHUP_SECONDS;
		}

		// The dedupe set is SEEDED FROM DISK, not started empty. `cursor` alone is not enough:
		// `since` is inclusive and the overlap window deliberately re-requests a few seconds, so
		// a cold start — a restart, or a workflow edit that re-registers the trigger — would
		// re-deliver whatever sits in that window with nothing to dedupe against. Observed for
		// real: one execution delivered a mention, and re-activating the workflow
		// re-delivered the SAME event in a later execution, which then failed on the
		// relay's "duplicate: reaction already exists".
		const persisted = Array.isArray(staticData[deliveredKey]) ? staticData[deliveredKey] : [];
		const seen = new Set(persisted);

		let manualResolve = null;
		let closing = false;

		// The overlap window and an inclusive `since` are only safe when there is something to
		// dedupe against. If `seen` is empty — a first activation, or an upgrade from a version
		// that persisted the cursor but not the delivered ids — re-requesting that window would
		// REPLAY instead of catching up. Starting just after the cursor can miss a same-second
		// sibling of an already-delivered message, which is far less damaging than re-firing
		// work: a replayed reaction is rejected by the relay outright ("duplicate: reaction
		// already exists"). Self-heals the moment anything is delivered.
		const sinceFor = (transport) => {
			if (seen.size === 0) return cursor + 1;
			return transport === 'realtime' ? Math.max(0, cursor - OVERLAP_SECONDS) : cursor;
		};

		const advanceCursor = (events) => {
			for (const event of events) {
				if ((event.created_at || 0) > cursor) cursor = event.created_at;
			}
			staticData[cursorKey] = cursor;
			// Only the tail needs persisting — enough to cover the overlap window on the next
			// cold start. The full in-memory set stays bounded separately at 5 000.
			staticData[deliveredKey] = Array.from(seen).slice(-PERSISTED_IDS);
		};

		const accepts = (event) => {
			if (!event || seen.has(event.id)) return false;
			// Inbound events are attacker-supplied until proven otherwise: the relay is a shared
			// community and a compromised or hostile one could forge `pubkey`. verifyEvent checks
			// the signature against the pubkey, so `isMine` and any pubkey-based routing in the
			// workflow downstream mean what they claim to.
			try {
				if (!verifyEvent(event)) {
					this.logger?.warn?.(`Buzz trigger dropped an event with an invalid signature: ${event.id}`);
					return false;
				}
			} catch (e) {
				return false;
			}
			if (options.ignoreOwnMessages !== false && event.pubkey === selfPubkey) return false;
			if (options.contains) {
				const needle = String(options.contains).toLowerCase();
				if (!String(event.content || '').toLowerCase().includes(needle)) return false;
			}
			if (options.replyTo) {
				const target = String(options.replyTo).trim();
				if (!(event.tags || []).some((t) => t[0] === 'e' && t[1] === target)) return false;
			}
			return true;
		};

		const deliver = (events) => {
			if (!events.length) return;
			for (const event of events) seen.add(event.id);
			// Bound the dedupe set so a long-lived trigger cannot grow without limit.
			if (seen.size > 5000) for (const id of seen) { seen.delete(id); if (seen.size <= 4000) break; }

			advanceCursor(events);
			this.emit([this.helpers.returnJsonArray(events.map((e) => shapeMessage(e, selfPubkey)))]);
			if (manualResolve) { manualResolve(); manualResolve = null; }
		};

		const fetchSince = (sinceSec) =>
			fetchPaged(
				(filters) => queryEvents(this, relayUrl, secretKey, filters, authTag),
				baseFilter,
				sinceSec,
				{
					pageLimit: PAGE_LIMIT,
					maxPages: MAX_POLL_PAGES,
					onTruncated: (count) => this.logger?.warn?.(
						`Buzz trigger stopped after ${MAX_POLL_PAGES} pages (${count} events); ` +
						'some older messages in this window were not fetched.',
					),
				},
			);

		// ---------------------------------------------------------------- polling transport
		if (mode === 'polling') {
			const intervalMs = Math.max(10, Number(this.getNodeParameter('pollInterval', 60))) * 1000;
			let timer = null;

			const tick = async () => {
				try {
					// `since` is INCLUSIVE and the cursor is second-resolution, so querying from
					// `cursor + 1` skipped anything sharing the newest second. Re-request that
					// second and let `seen` drop what was already delivered — except on a cold
					// start, where `seen` is empty and there is nothing to drop against.
					const events = newestFirst(await fetchSince(sinceFor('polling'))).filter(accepts);
					if (events.length) deliver(events.reverse());
				} catch (error) {
					this.logger?.error?.(`Buzz trigger poll failed: ${error.message}`);
				}
			};

			timer = setInterval(tick, intervalMs);

			return {
				closeFunction: async () => { closing = true; clearInterval(timer); },
				manualTriggerFunction: async () => {
					// Manual test: show recent traffic instead of waiting for the next interval.
					const events = newestFirst(
						await queryEvents(this, relayUrl, secretKey, [{ ...baseFilter, limit: 5 }], authTag),
					).filter(accepts);
					if (events.length) deliver(events.reverse());
					else await new Promise((resolve) => { manualResolve = resolve; });
				},
			};
		}

		// --------------------------------------------------------------- realtime transport
		const wsUrl = toWebSocketUrl(relayUrl);
		const subId = `n8n-${Math.random().toString(36).slice(2, 10)}`;
		const pingSubId = `${subId}-ping`;

		let socket = null;
		let retryDelay = BASE_RETRY_MS;
		let retryTimer = null;
		let authTimer = null;
		let heartbeatTimer = null;
		let pingTimer = null;
		let presenceTimer = null;
		// A relay may issue more than one AUTH challenge on a connection; a single
		// `pendingAuthId` meant the second answer orphaned the first and the OK went unmatched.
		let pendingAuthIds = new Set();
		let subscribed = false;
		// ⚠️ EOSE support on THIS relay is UNVERIFIED — it is standard NIP-01 and almost every
		// relay sends it, but it was never measured here, and the relay already deviates in
		// other ways (filters at the top level, 403 on an authors query without #h). So nothing
		// below may DEPEND on EOSE: it is a fast-path confirmation when present, and the
		// handshake falls back to a grace timer when it is not. Getting this wrong would mean an
		// endless reconnect loop, which is worse than the silent-death bug being fixed.
		let sawEoseEver = false;

		const clearTimers = () => {
			if (authTimer) { clearTimeout(authTimer); authTimer = null; }
			if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
			if (pingTimer) { clearTimeout(pingTimer); pingTimer = null; }
			if (presenceTimer) { clearInterval(presenceTimer); presenceTimer = null; }
		};

		// Presence (kind:20001) is WEBSOCKET-ONLY. The relay rejects it over HTTP outright —
		// `ingest.rs`: "kind 20001 is only accepted via WebSocket" — so the ACTION node can
		// never set it, and this trigger is the only place the bot can appear online at all.
		//
		// ⚠️ This deliberately does NOT reuse startHeartbeat(): that timer only arms once EOSE
		// has been observed (`if (!sawEoseEver) return;`), and on a relay that never sends EOSE
		// presence would then never refresh and the bot would drop offline after 180 s with no
		// other symptom. Presence gets its own unconditional timer.
		//
		// Presence is cosmetic — it must never break message delivery, so every failure here is
		// swallowed rather than surfaced.
		const sendPresence = (status) => {
			if (!socket || socket.readyState !== 1) return;
			try {
				const event = finalizeEvent(
					{
						kind: KIND_PRESENCE_UPDATE,
						created_at: Math.floor(Date.now() / 1000),
						tags: authTag ? [authTag] : [],
						content: status,
					},
					secretKey,
				);
				socket.send(JSON.stringify(['EVENT', event]));
			} catch (e) { /* never break the trigger for a status dot */ }
		};

		const startPresence = () => {
			if (presenceTimer) clearInterval(presenceTimer);
			sendPresence('online');
			presenceTimer = setInterval(() => {
				if (closing || !socket || socket.readyState !== 1) return;
				sendPresence('online');
			}, PRESENCE_REFRESH_MS);
		};

		// One way back to a good state from any broken one: drop the socket and let the
		// close handler schedule a reconnect. Previously an AUTH that never got an OK, a
		// rejected AUTH, and a CLOSED subscription each left a LIVE socket with a DEAD
		// subscription — connected, silent, and never recovering.
		const resetConnection = (why) => {
			if (closing) return;
			this.logger?.warn?.(`Buzz realtime resetting connection: ${why}`);
			clearTimers();
			subscribed = false;
			pendingAuthIds = new Set();
			try { if (socket) socket.close(); } catch (e) { /* the close handler takes it from here */ }
		};

		const subscribe = () => {
			// `since` comes from the advancing cursor with a small overlap, not from activation
			// time, so a reconnect re-requests seconds rather than hours.
			const filter = { ...baseFilter, since: sinceFor('realtime') };
			socket.send(JSON.stringify(['REQ', subId, filter]));
		};

		const confirmSubscribed = (how) => {
			if (subscribed) return;
			subscribed = true;
			retryDelay = BASE_RETRY_MS;
			if (authTimer) { clearTimeout(authTimer); authTimer = null; }
			// INFO, not debug: n8n runs at info, and this line is the only way to tell whether
			// the relay actually sends EOSE or whether the grace-period fallback carried the
			// handshake — which decides whether the half-open-socket heartbeat ever arms.
			this.logger?.info?.(`Buzz realtime subscription confirmed (${how})`);
			startHeartbeat();
			// Only once the subscription is confirmed, so the status dot means "this trigger is
			// actually receiving", not merely "a socket opened". That makes presence a genuine
			// health signal for the documented silent-death failure mode.
			startPresence();
		};

		// A TCP connection can die without either side sending a FIN, leaving a socket that
		// looks open forever and delivers nothing. There is no ping() on the WHATWG WebSocket,
		// so liveness is probed at the protocol level with a throwaway REQ.
		//
		// Only armed once the relay has been OBSERVED to send EOSE. If it never does, the
		// probe has no reply to wait for, and treating that silence as a dead connection would
		// reconnect every minute forever. In that case the trigger keeps the pre-existing
		// behaviour (reconnect on close/error only) rather than inventing a worse failure.
		const startHeartbeat = () => {
			if (!sawEoseEver) return;
			if (heartbeatTimer) clearInterval(heartbeatTimer);
			heartbeatTimer = setInterval(() => {
				if (closing || !socket || socket.readyState !== 1) return;
				try {
					socket.send(JSON.stringify(['REQ', pingSubId, { ...baseFilter, limit: 1 }]));
					if (pingTimer) clearTimeout(pingTimer);
					pingTimer = setTimeout(
						() => resetConnection('heartbeat got no response — connection is half-open'),
						HEARTBEAT_TIMEOUT_MS,
					);
				} catch (e) {
					resetConnection(`heartbeat send failed: ${e.message}`);
				}
			}, HEARTBEAT_INTERVAL_MS);
		};

		const connect = () => {
			if (closing) return;
			socket = new WebSocket(wsUrl);

			socket.addEventListener('open', () => {
				// NOTE: retryDelay is deliberately NOT reset here. A relay that accepts the TCP
				// connection and then immediately drops it would otherwise reconnect every
				// second forever. It resets once the subscription is actually confirmed.
				subscribe();
				// Fallback confirmation for a relay that does not send EOSE. If the socket is
				// still open by now and the relay has not CLOSED our subscription or rejected
				// AUTH, the subscription is as live as it is going to look.
				authTimer = setTimeout(() => {
					if (closing) return;
					if (socket && socket.readyState === 1 && pendingAuthIds.size === 0) {
						confirmSubscribed('grace period, no EOSE from the relay');
					} else {
						resetConnection('handshake did not complete in time');
					}
				}, HANDSHAKE_TIMEOUT_MS);
			});

			// The ENTIRE handler is wrapped. This runs on a socket event, not inside n8n's
			// execution context, so anything thrown here reaches `uncaughtException` in n8n's
			// MAIN process and takes every other workflow on the instance down with it. A relay
			// (or anyone able to influence one) sending `{}` or `null` used to be enough: the
			// `const [type] = msg` destructure below sat outside the old try/catch and threw
			// `TypeError: msg is not iterable`. Nothing in here is worth crashing the instance for.
			socket.addEventListener('message', (frame) => {
			  try {
				let msg;
				try {
					msg = JSON.parse(typeof frame.data === 'string' ? frame.data : String(frame.data));
				} catch (e) { return; }

				// Every relay frame is a JSON array. Anything else is malformed or hostile.
				if (!Array.isArray(msg)) return;

				const [type] = msg;

				// NIP-42: the relay only challenges after a REQ, and ignores a subscription sent
				// before the AUTH event is accepted — so the re-REQ must wait for the OK.
				if (type === 'AUTH') {
					const authEvent = finalizeEvent(
						{
							kind: KIND_CLIENT_AUTH,
							created_at: Math.floor(Date.now() / 1000),
							tags: authTag
								? [['relay', wsUrl], ['challenge', String(msg[1])], authTag]
								: [['relay', wsUrl], ['challenge', String(msg[1])]],
							content: '',
						},
						secretKey,
					);
					pendingAuthIds.add(authEvent.id);
					socket.send(JSON.stringify(['AUTH', authEvent]));
					return;
				}

				if (type === 'OK' && pendingAuthIds.has(msg[1])) {
					pendingAuthIds.delete(msg[1]);
					if (msg[2] === true) {
						subscribe();
					} else {
						// A rejected AUTH used to be logged and nothing else, leaving a connected
						// socket that would never receive an event.
						resetConnection(`relay rejected auth: ${msg[3]}`);
					}
					return;
				}

				if (type === 'EVENT' && msg[1] === subId) {
					// Traffic on our subscription is itself proof it is live.
					confirmSubscribed('event received');
					if (accepts(msg[2])) deliver([msg[2]]);
					return;
				}

				if (type === 'EOSE') {
					// Arming the heartbeat must NOT depend on confirmation ORDER. NIP-01 sends
					// stored events BEFORE the EOSE, so a busy subscription confirms via
					// 'event received' while sawEoseEver is still false — and startHeartbeat()
					// would then bail out permanently on a relay that does support EOSE.
					// Observed live: the first confirmation here was 'event received'.
					if (!sawEoseEver) {
						sawEoseEver = true;
						this.logger?.info?.('Buzz realtime: the relay DOES send EOSE — heartbeat armed');
						startHeartbeat();
					}
					if (msg[1] === pingSubId) {
						// Liveness confirmed; retire the probe subscription.
						if (pingTimer) { clearTimeout(pingTimer); pingTimer = null; }
						try { socket.send(JSON.stringify(['CLOSE', pingSubId])); } catch (e) { /* next heartbeat retries */ }
						return;
					}
					if (msg[1] === subId) confirmSubscribed('EOSE');
					return;
				}

				if (type === 'CLOSED' && msg[1] === subId) {
					const reason = String(msg[2] || '');
					// auth-required is the normal prelude to an AUTH challenge; anything else
					// means the subscription is gone and will not come back on its own.
					if (!reason.startsWith('auth-required')) {
						resetConnection(`relay closed the subscription: ${reason}`);
					}
				}
			  } catch (error) {
				// Log and swallow. See the note above the handler.
				this.logger?.error?.(`Buzz realtime frame handler failed: ${error.message}`);
			  }
			});

			const scheduleReconnect = () => {
				if (closing || retryTimer) return;
				clearTimers();
				subscribed = false;
				// Jitter keeps a fleet of reconnecting clients from hammering the relay in lockstep.
				const jittered = retryDelay * (0.5 + Math.random());
				retryTimer = setTimeout(() => { retryTimer = null; connect(); }, jittered);
				retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
			};

			socket.addEventListener('close', scheduleReconnect);
			socket.addEventListener('error', () => {
				try { socket.close(); } catch (e) { /* already closing */ }
			});
		};

		connect();

		return {
			closeFunction: async () => {
				closing = true;
				if (retryTimer) clearTimeout(retryTimer);
				// ⛔ Do NOT send an explicit `offline` here. Presence is IDENTITY-wide, not
				// connection-wide, and the relay treats the two paths differently:
				//   • explicit offline  → clear_presence() UNCONDITIONALLY (handlers/event.rs)
				//   • socket disconnect → clears only when no other connection remains
				//                         (connection.rs: `if remaining.is_empty()`)
				// So with two triggers on one credential, deactivating either one used to mark
				// the still-connected bot offline until the survivor's next 60 s refresh.
				// The relay's own disconnect cleanup is already correct and sufficient.
				// (Verified against the relay source.)
				clearTimers();
				try {
					if (socket && socket.readyState === 1) socket.send(JSON.stringify(['CLOSE', subId]));
					if (socket) socket.close();
				} catch (e) { /* nothing useful to do while shutting down */ }
			},
			manualTriggerFunction: async () =>
				new Promise((resolve) => { manualResolve = resolve; }),
		};
	}
}

module.exports = { BuzzTrigger };
