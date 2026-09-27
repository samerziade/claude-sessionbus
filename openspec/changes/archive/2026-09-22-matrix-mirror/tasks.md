## 1. Shared message shape

- [x] 1.1 Write failing tests in `bus/src/message.test.ts` for an optional `ChannelMessage.thread`
      field (`ThreadSelector` union) and for `toChannelMeta` ignoring it.
- [x] 1.2 Add `ThreadSelector` type and the optional `thread` field to `ChannelMessage` in
      `bus/src/message.ts`; confirm `toChannelMeta` is unchanged.

## 2. Broadcast and multi-recipient id sharing

- [x] 2.1 Write failing tests in `bus/src/handlers.test.ts` asserting a broadcast's delivered
      copies share one `ChannelMessage.id` (currently each recipient gets a distinct id — this
      test should fail against today's implementation).
- [x] 2.2 Fix `sendMessage` in `bus/src/handlers.ts` to mint the id once, outside the recipient
      fan-out loop, and reuse it for every copy.
- [x] 2.3 Write failing tests for list-valued `to`: multiple named recipients resolve and fan out
      sharing one id; `mixed_kind` failure when an epic target is mixed with named recipients;
      duplicate-recipient de-duplication; a failed entry writes nothing for any entry.
- [x] 2.4 Extend `resolveTo`/`sendMessage` (`bus/src/address.ts`, `bus/src/handlers.ts`) to accept
      `to: string | string[]`, aggregate resolutions, de-duplicate by `sessionId`, and return
      `mixed_kind` per the design.
- [x] 2.5 Write failing tests for the `thread` argument attaching to written copies without
      altering local delivery or channel meta.
- [x] 2.6 Add the optional `thread` argument to `sendMessage`'s args and attach it to each written
      `ChannelMessage` copy.

## 3. Broker onRouted hook

- [x] 3.1 Write failing tests in `broker/src/broker.test.ts`: `onRouted` fires once per `route()`
      call for both the live-delivery and queued-offline paths; fires once per fan-out recipient,
      all sharing one id; a throwing `onRouted` does not affect routing or process liveness; a
      broker with no `onRouted` configured behaves exactly as before.
- [x] 3.2 Add the optional `onRouted?: (msg: ChannelMessage) => void` field to
      `BrokerCoreOptions` and invoke it from `route()` in `broker/src/broker.ts`, wrapped so a
      throw cannot propagate out of `route()`.

## 4. Outbound mirror module

- [x] 4.1 Write failing tests in a new `broker/src/matrix-mirror.test.ts` for `createMatrixMirror`:
      id-based dedupe within a bounded window (repeated `onRouted` invocations sharing one id
      enqueue one job; distinct ids enqueue distinct jobs; a fan-out resolving to zero recipients
      never invokes the mirror, per the broker's `onRouted` contract), per-room job ordering,
      exponential backoff with jitter on a failing post (fake timers), drop-oldest behavior when a
      room's queue is at capacity, and `txnId` equal to `msg.id` on every attempt including
      retries.
- [x] 4.2 Implement `createMatrixMirror(deps)` in a new `broker/src/matrix-mirror.ts`: a factory
      closure (no module-level state) taking injected `deps` for posting, room resolution, and
      thread resolution — no live HTTP client — exposing an `onRouted`-compatible handler to wire
      into `createBrokerCore`.

## 5. Room selection

- [x] 5.1 Write failing tests for room selection: a direct message between peers sharing an epic
      room targets that room; a direct message between peers with no shared epic room targets the
      sender's lobby; an epic broadcast targets the epic room with a room-wide mention; a
      multi-recipient send where every recipient shares the sender's epic room posts once into
      that room mentioning each recipient; a multi-recipient send without a shared room posts once
      into the sender's lobby mentioning each recipient.
- [x] 5.2 Implement room selection in `matrix-mirror.ts` against the injected room-resolution
      dependency (provisioning's room-lookup contract, assumed available per design.md).

## 6. Pair threads and thread argument resolution

- [x] 6.1 Write failing tests for pair-thread creation: the first direct-message mirror between a
      pair creates and posts into a new pair thread; a later mirror between the same pair reuses
      it; worker-to-worker pairs get a thread distinct from either worker's PM thread.
- [x] 6.2 Implement pair-thread ensure-and-reuse logic in `matrix-mirror.ts` against the injected
      thread-resolution dependency (bridge-state's contract, assumed available per design.md).
- [x] 6.3 Write failing tests for `thread` argument resolution: omitted resolves to the most
      recently received thread from the recipient, else the pair thread; an explicit handle posts
      into the thread it resolves to; `{ new: title }` creates and posts into a new thread; an
      unresolvable handle fails `send_message` with `thread_not_found` and writes nothing.
- [x] 6.4 Wire `ChannelMessage.thread` through `matrix-mirror.ts`'s job construction to select the
      target thread per the above resolution rules, returning a `thread_not_found` failure path
      that `bus/src/handlers.ts`'s `sendMessage` can surface (see design.md's open question on
      confirming this against the provisioning/bridge-state change).

## 7. Verification

- [x] 7.1 Run `pnpm lint` from the repo root and fix any violations.
- [x] 7.2 Run `pnpm test` in `bus/` and `broker/` and confirm all tests, including the new ones
      added above, pass.
- [x] 7.3 Update `CLAUDE.md`'s module table to add `broker/src/matrix-mirror.ts`, and update the
      `send_message` description and `ChannelMessage` shape references if they've drifted from
      what's implemented.
