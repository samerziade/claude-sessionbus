## 1. Inbound filter chain (`broker/src/matrix-relay-filter.ts`)

- [x] 1.1 Write `broker/src/matrix-relay-filter.test.ts` first (happy path): `createInboundFilter({ namespacePrefix, dedupeMax })` returns a predicate that accepts a plain text event from a sender outside the `cc` namespace that names a registered identity.
- [x] 1.2 Extend the test (negative): an event whose sender is inside the `cc` namespace is rejected; an event that is not a plain text room message is rejected; an event that would wake its own sender is rejected.
- [x] 1.3 Extend the test (edge): the same event id is accepted once and rejected on every subsequent call; an event naming only unregistered `cc` users is rejected while an event naming one registered and one unregistered identity is accepted with only the registered one resolved.
- [x] 1.4 Extend the test (blind spot): with a small `dedupeMax`, processing more than that many distinct ids evicts oldest-first and the most recently processed id is still recognised as seen; rejection leaves no side effect a caller could mistake for consumption.
- [x] 1.5 Implement `broker/src/matrix-relay-filter.ts` as a `createInboundFilter()` factory returning a closure that owns the bounded dedupe set — no module-level mutable state.
- [x] 1.6 Run `broker` tests and confirm 1.1–1.4 pass.

## 2. Window selection and transcript render (`broker/src/matrix-window.ts`)

- [x] 2.1 Write `broker/src/matrix-window.test.ts` first (happy path): `buildWindow({ messages, wakeThread, caps, now })` over three unread messages ending in the mention returns `unread: 3`, `omitted: 0`, and a transcript rendering all three oldest-first.
- [x] 2.2 Extend the test (caps): 25 short messages with a 20-message cap returns `unread: 20`, `omitted: 5`, and drops the oldest five; a set that renders past the character cap returns content within the cap and a non-zero `omitted`.
- [x] 2.3 Extend the test (edge): exactly at the message cap is not truncated; a lone mention returns `unread: 1`, `omitted: 0`; a waking event that alone exceeds the character cap is still the last line with `omitted` counting the rest.
- [x] 2.4 Extend the test (render): `[14:02] samer: …` line shape; zero-padded single-digit hour; display-name fallback to the Matrix localpart; an off-thread line carries `(t_…)` while the wake's own lines do not; a multi-line body keeps both lines and prefixes only the first; lines joined by one newline with no trailing newline; no rendered line contains a Matrix event id.
- [x] 2.5 Extend the test (blind spot): the window spans the room's main timeline and its threads and `unread` counts both; `unread + omitted` always equals the full backlog size; the function is pure — two calls with the same input return deep-equal results and mutate no argument.
- [x] 2.6 Implement `broker/src/matrix-window.ts` as pure functions (`buildWindow`, `renderTranscript`) with an injected clock offset. Declare `WindowResult` as an `interface`; no `any`, no laundering casts.
- [x] 2.7 Run `broker` tests and confirm 2.1–2.5 pass.

## 3. Read cursors on the bridge state seam

- [x] 3.1 Extend the bridge-state test first: `getCursor(identity, room)` / `setCursor(identity, room, token)` round-trip an opaque token; an absent pair reads as undefined.
- [x] 3.2 Extend the test (blind spot): advancing is monotonic — applying an older token after a newer one leaves the newer stored; applying the same advance twice is idempotent.
- [x] 3.3 Extend the test (partial writes): a write is atomic — a concurrent read yields either the previous complete value or the new complete value, never a partial one; a store that cannot be parsed reads as absent and does not throw.
- [x] 3.4 Implement the per-`(identity, room)` cursor rows behind the existing `BridgeState` interface, written `.tmp` + `renameSync`, read tolerantly.
- [x] 3.5 Run `broker` tests and confirm 3.1–3.3 pass.

## 4. Sync loop, fan-out and cursor advance (`broker/src/matrix-relay.ts`)

- [x] 4.1 Write `broker/src/matrix-relay.test.ts` first (happy path): `createMatrixRelay({ client, state, route, identities, caps, now })` started with a persisted position issues its first sync request from that position, carrying the masquerade parameter that names the configured bot user and never issuing a request as the appservice sender identity; a batch containing a human mention routes exactly one wake to that identity's current session id.
- [x] 4.2 Extend the test (cold start): with no persisted position, a room that already holds a mention produces no wake and the persisted position becomes the homeserver's current position; an unparseable state store behaves the same and does not throw; a position recorded under a bot identity other than the configured one is discarded and the relay cold-starts.
- [x] 4.3 Extend the test (one stream): two `cc` rooms both receiving messages are observed through a single in-flight sync request.
- [x] 4.4 Extend the test (filtering wired in): a `cc`-sender event routes nothing; a repeated event id routes exactly one wake in total; a batch of filtered-only events leaves every cursor unchanged.
- [x] 4.5 Extend the test (fan-out): one event naming two identities routes two wakes, each with its own `unread`; each wake's `mentions` names the other identity and not itself; a single-mention wake omits `mentions`; a room-wide mention wakes every registered member except the sender.
- [x] 4.6 Extend the test (negative): a named identity with no live session routes nothing AND leaves its cursor unchanged; an unknown `cc` name alongside a registered one does not fail the registered wake.
- [x] 4.7 Extend the test (cursor): a wake advances the cursor so a second mention reports `unread: 1`; the wake's `since` is the pre-delivery cursor while the persisted cursor is already the post-delivery one; the position is persisted only after a batch is processed, and replaying that batch routes no second wake.
- [x] 4.8 Extend the test (breaking risk): an identity that registers under one session id and then re-registers under a different one is routed at its second id — assert the relay re-reads the map at route time rather than caching it.
- [x] 4.9 Extend the test (blind spot): the relay never throws across its boundary — a rejecting `fetch`, a 401 and a 429 each leave the relay alive, route nothing, and produce no unhandled rejection.
- [x] 4.10 Implement `broker/src/matrix-relay.ts` as a `createMatrixRelay(deps)` factory owning the loop handle, the filter and the cursor writes in its closure; compose `matrix-relay-filter.ts` and `matrix-window.ts`; route through the broker core's existing `route()` and add no second delivery path.
- [x] 4.11 Run `broker` tests and confirm 4.1–4.9 pass.

## 5. Operator-only invite acceptance (`broker/src/matrix-invites.ts`)

- [x] 5.1 Write `broker/src/matrix-invites.test.ts` first (pure decision): `decideInvite({ inviter, operator })` returns `accept` when the inviter's user id equals the configured operator exactly, `decline` for any other local user, and `ignore` when no operator is configured; a different user whose display name equals the operator's is `decline`, because only the invite event's sender id is compared.
- [x] 5.2 Extend the test (happy path): `createInviteHandler({ client, operator })` fed a batch whose `rooms.invite` holds an operator invite to the bot issues exactly one join as the bot and no decline, and that join carries the masquerade parameter naming the configured bot user.
- [x] 5.3 Extend the test (negative): a non-operator invite issues no join and declines the invite by leaving the room, the decline carrying the same masquerade; with no operator configured, nothing is joined and nothing is declined; a failed join never turns into a decline.
- [x] 5.4 Extend the test (idempotency): the batch carrying an operator invite, delivered a second time before the room shows as joined, issues no second join.
- [x] 5.5 Extend the test (retry): a failed join is retried on the next sync iteration even though that batch does not carry the invite again; a later batch showing the invite withdrawn stops further retries.
- [x] 5.6 Implement `broker/src/matrix-invites.ts`: the pure `decideInvite`, plus a `createInviteHandler()` factory whose closure owns the in-flight/retry set — no module-level mutable state; every join/decline promise carries its own handler so a homeserver fault cannot reach the process-level rejection backstop.
- [x] 5.7 Extend `broker/src/matrix-relay.test.ts` first (reconciliation on start): on a cold start, an operator invite already pending before start is joined exactly once from the reconciliation sync (no `since`, empty-timeline filter) AND no pre-start message is relayed; on a warm start, an invite whose join failed and whose batch was persisted past is joined after restart, the stream still resumes from the persisted position, and the reconciliation response's `next_batch` is discarded.
- [x] 5.8 Extend `broker/src/matrix-relay.test.ts` first (joined set): after the bot accepts an operator invite, a mention of a live registered identity in that room is routed through the same single stream; a mention in a room whose non-operator invite was declined routes nothing.
- [x] 5.9 Wire the invite handler and the start-up reconciliation sync into `createMatrixRelay`, handling `rooms.invite` on every batch before the timeline.
- [x] 5.10 Run `broker` tests and confirm 5.1–5.5, 5.7 and 5.8 pass.

## 6. Catch-up on register

- [x] 6.1 Extend `broker/src/matrix-relay.test.ts` first (happy path): an identity mentioned while it had no live session receives exactly one wake when it registers.
- [x] 6.2 Extend the test (edge): three missed mentions still produce one wake whose `unread` counts them all; a catch-up window past the cap reports a non-zero `omitted` with `since` at the pre-catch-up cursor.
- [x] 6.3 Extend the test (negative): registering with unread chatter but no mention routes nothing; registering with nothing unread routes nothing.
- [x] 6.4 Extend the test (idempotency): registering again immediately after a catch-up wake, with no new messages, routes no second wake.
- [x] 6.5 Extend the test (edge): an identity with missed mentions in two rooms receives one wake per room, each naming its own `room`.
- [x] 6.6 Implement the register hook on the relay, reusing `buildWindow` so catch-up and live wakes cannot diverge.
- [x] 6.7 Run `broker` tests and confirm 6.1–6.5 pass.

## 7. Widened channel meta (`bus/src/message.ts`)

- [x] 7.1 Extend `bus/src/message.test.ts` first (happy path): a session-to-session message maps to `{ from, from_id, origin: 'session', role, msg_id }` plus `epic` when present, with no hyphenated keys and every value a string.
- [x] 7.2 Extend the test (relayed wake): a human-origin wake maps `origin: 'human'`, `from_id` to the sender's full Matrix user id, `role` to `none`, and includes `room`, `unread`, `omitted` and `since` as decimal/opaque strings.
- [x] 7.3 Extend the test (edge): `thread` and `thread_title` are omitted for a top-level message and present for a threaded one; `mentions` lists the other identities only and is omitted when nobody else was named.
- [x] 7.4 Extend the test (blind spot): the mapped payload matches its declared shape — every key is identifier-safe and every value is a `string`, asserted over both origins.
- [x] 7.5 Implement the widened mapping in `bus/src/message.ts`, keeping `toChannelMeta` a pure function and declaring the wake's extra fields as an `interface` at their canonical home rather than re-deriving them in the broker.
- [x] 7.6 Run `bus` tests and confirm 7.1–7.4 pass.

## 8. History over the `Transport` seam

- [x] 8.1 Extend `broker/src/protocol.test.ts` first: `HistoryRequestFrame` / `HistoryReplyFrame` encode and decode with their correlation id, and an unknown frame type is still skipped without breaking the decoder's buffer.
- [x] 8.2 Write `broker/src/matrix-history.test.ts` first (happy path): resolution defaults to the caller's epic room, and to its lobby when the caller has no epic; every homeserver request the read makes carries the masquerade parameter naming the configured bot user.
- [x] 8.3 Extend the test (cross-room read): a `cc` room the caller is not a member of is readable and returns `ok: true`; reading it records no cursor for that room and leaves the caller's own cursor unchanged.
- [x] 8.4 Extend the test (paging and filters): `since` from a truncated wake returns the messages the cap dropped; `limit` caps the page and sets `more`; a `limit` above the maximum is clamped; `search` returns only matching messages.
- [x] 8.5 Extend the test (negative): a room that does not exist or is outside the `cc` namespace returns `{ ok: false, reason: 'not_found' }`.
- [x] 8.6 Extend the test (blind spot): a read routes no wake to any live member; a returned entry matches its declared shape exactly, with `origin: 'human'` and a full Matrix `from_id` for a human-authored message; a read for a member room advances that cursor so a later mention reports `unread: 1`.
- [x] 8.7 Implement `broker/src/matrix-history.ts` so every homeserver request it makes carries the bot masquerade, asserted in 8.2 and add the frames to `broker/src/protocol.ts`, importing `HistoryMessage` from its canonical home in `bus` rather than restating the shape.
- [x] 8.8 Add `history(query)` to the `Transport` interface in `bus/src/mailbox.ts`; extend `bus/src/mailbox.test.ts` first to assert the flat-file implementation returns `{ ok: false, reason: 'unavailable' }` without touching disk and without throwing.
- [x] 8.9 Extend `bus/src/socket-transport.test.ts` first: a `history` request round-trips over the socket and correlates its reply; a reply that never arrives resolves as `unavailable` rather than hanging forever.
- [x] 8.10 Implement the socket transport's `history`.
- [x] 8.11 Run `bus` and `broker` tests and confirm 8.1–8.9 pass.

## 9. `read_history` tool and Matrix-addressed replies (`bus/src/handlers.ts`)

- [x] 9.1 Extend `bus/src/handlers.test.ts` first (happy path): `read_history({})` returns the transport's result unchanged for the default room; `read_history({ room, since, limit, search })` forwards each argument.
- [x] 9.2 Extend the test (unavailable): `read_history` on the flat-file transport returns `{ ok: false, reason: 'unavailable' }` and does not throw; so does the socket transport with the bridge disabled.
- [x] 9.3 Extend the test (Matrix reply, happy path): `send_message({ to: '@samer:example', text })` posts into the room and thread of that person's most recent mention of this session and reports that destination.
- [x] 9.4 Extend the test (fallbacks): no prior mention falls back to the caller's epic room on the main timeline; no prior mention and no epic falls back to the lobby; a remembered room the caller has left falls back to the caller's own room.
- [x] 9.5 Extend the test (edge): the most recent of two mentions in different rooms wins.
- [x] 9.6 Extend the test (negative/blind spot): a Matrix-addressed send writes no local inbox and wakes no live peer; with no bridge it returns `{ ok: false, reason: 'unavailable' }` and still writes nothing; a `cc`-namespace `to` is resolved by the existing local rules and is not treated as a Matrix reply; local messaging to a live peer is unaffected while the bridge is unavailable.
- [x] 9.7 Implement the `read_history` handler and the Matrix-addressed `to` branch in `bus/src/handlers.ts`, classifying `to` before `resolveTo` runs and returning a narrowed union rather than a laundered cast.
- [x] 9.8 Register `read_history` in `bus/src/index.ts`'s tool list with its input schema, and extend the MCP `instructions` string to document the mention convention, the wake's `room`/`thread`/`since` keys, and replying to a human by `from_id`.
- [x] 9.9 Run `bus` tests and confirm 9.1–9.6 pass.

## 10. Broker wiring

- [x] 10.1 Extend `broker/src/broker.test.ts` first: a relayed wake reaches a registered session through `route()` exactly as a local send does; a session that re-registers under a new id receives a subsequent relayed wake at the new id and not the old one; a throwing relay affects neither routing nor process liveness.
- [x] 10.2 Wire the relay into the broker entrypoint behind the resolved configuration: absent or disabled configuration starts the broker with no relay and every history path answering `unavailable`.
- [x] 10.3 Confirm the relay never calls the fatal guard and that every async path carries its own handler, so a homeserver fault cannot reach the process-level `unhandledRejection` backstop.
- [x] 10.4 Run `broker` tests and confirm 10.1 passes.

## 11. Verification

- [x] 11.1 Run `pnpm lint` from the repo root — biome plus `tsc --noEmit` per package — and confirm it is clean.
- [x] 11.2 Run `pnpm test` in `bus` and in `broker` and confirm every suite passes; record the new totals.
- [x] 11.3 Re-read the new specs against the implementation and confirm every scenario has a corresponding test; report any spec/code disagreement rather than silently rewriting either side.
- [x] 11.4 Smoke-test with the bridge disabled: two local sessions exchange a message unchanged, and `read_history` answers `unavailable` rather than throwing. Follow the teardown note in CLAUDE.md — background the process and signal the real node pid.
- [ ] 11.5 Add one step to the live Matrix smoke checklist and run it once against the real homeserver, as a regression check on behavior already verified rather than an open question: leave an operator invite to the bot pending, cold-start the bridge, and confirm the masqueraded initial sync reports it under `rooms.invite` and the bot joins. Also invite the bot from a non-operator account and confirm it declines.
- [x] 11.6 Update CLAUDE.md: add `matrix-relay.ts`, `matrix-relay-filter.ts`, `matrix-invites.ts`, `matrix-window.ts` and `matrix-history.ts` to the broker module table, record the widened `Transport` interface (`history`) and the widened channel meta, and note the at-most-once boundary at the channel gate and the operator-only invite rule (session-user invites from humans unsupported in v1) under open items.
- [x] 11.7 Run `openspec validate matrix-relay --strict` and confirm it reports the change as valid.
