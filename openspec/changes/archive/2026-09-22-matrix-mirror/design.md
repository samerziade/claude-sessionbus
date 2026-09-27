## Context

The bridge design (`docs/superpowers/specs/2026-09-22-sessionbus-matrix-bridge-design.md`) splits
the Matrix bridge into three changes: provisioning (rooms/users/spaces exist), the outbound mirror
(this change), and the inbound relay (mentions wake sessions, `read_history`). This change assumes
provisioning's outputs exist and are addressable — a project's lobby room, an epic's room, and a
Matrix user per work identity — without depending on how they are created.

Two seams carry this change:

- **`BrokerCore` in `broker/src/broker.ts`** — currently `{ register, route, disconnect,
  connectedCount }`. `route(to, msg)` either delivers to a live conn or queues the message for a
  later `register`. Nothing observes routed traffic today.
- **`HandlerDeps`/`createHandlers` in `bus/src/handlers.ts`** — `sendMessage({ to, text })`
  resolves `to` via `resolveTo` (`bus/src/address.ts`) and calls `deps.transport.send` once per
  resolved recipient.

## Goals / Non-Goals

**Goals**

- Give the broker core a way to observe routed traffic without knowing about Matrix.
- Specify an outbound mirror queue: ordering, bounds, retry, and overflow behavior.
- Specify which room a mirrored message lands in, and how a fan-out (broadcast or a list `to`)
  becomes at most one Matrix event.
- Specify `send_message`'s new `to: string | string[]` and optional `thread` arguments as an
  observable contract, including how `thread` selection reaches the mirror.

**Non-Goals**

- The Matrix HTTP client, provisioning, naming, or `bridge-state`'s internal storage format —
  assumed to exist behind the contracts this design names, built by a separate change.
- The inbound `/sync` relay, wake payloads, read cursors, `read_history` — a separate change.
- Any change to the flat-file `Transport`'s on-disk message format.
- Rate breakers or thread brakes (explicitly deferred by the source design, §9/§16).

## Decisions

### D1 — `onRouted` is an optional hook on `BrokerCoreOptions`, not a new export or emitter

`BrokerCoreOptions` already carries `maxQueuePerSession` and `log`; adding `onRouted?: (msg:
ChannelMessage) => void` follows the same shape and keeps `BrokerCore`'s returned interface
unchanged (`register`/`route`/`disconnect`/`connectedCount`). `route()` calls it after a message is
either delivered or queued.

**Alternatives considered:**

- An `EventEmitter` on `BrokerCore` — rejected: it would let a caller `.on('routed', …)` and adds a
  Node-specific type surface for one callback; a plain option is simpler and matches the existing
  `log` option.
- A decorator that wraps `route()` from outside `broker.ts` — rejected: the dedupe-by-`id` window
  (D2) has to see every `route()` call including ones a wrapper could not intercept without
  reimplementing queuing, so the hook belongs inside `route()` itself.

**Interface change:** yes — `BrokerCoreOptions` gains one optional field. `BrokerCore`'s public
shape is unchanged, so this is additive and does not break existing callers that omit the option.

### D2 — Dedupe is a bounded in-memory window keyed by `msg.id`, owned by the mirror consumer

"Once per unique `msg.id`" cannot be enforced by `route()` alone, because `route()` is called once
per **recipient**, and a fan-out (broadcast or list `to`) calls it once per recipient with — after
D3 — the same `id`. The mirror module (not `broker.ts`) keeps a bounded FIFO set of recently seen
ids and only enqueues a mirror job the first time an id is seen; `onRouted` itself fires
unconditionally on every `route()` call, keeping the broker core free of any notion of "seen
before". This mirrors the loop-safety pattern the source design already uses for inbound
`event_id` dedupe (§9), applied here to outbound ids.

**Alternatives considered:** doing the dedupe inside `broker.ts` — rejected: it would give the
broker core a notion of "have I mirrored this" that belongs to the mirror, not to routing, and
would need its own eviction policy tangled into `route()`.

### D3 — A fan-out (broadcast or list `to`) mints its `ChannelMessage.id` once and reuses it for every recipient copy

Today `bus/src/handlers.ts`'s `sendMessage` calls `newMessageId(now())` **inside** the `for`
recipient loop, so a 3-member broadcast currently produces three distinct ids, not one. This
directly contradicts the source design's premise (§4.2: "a broadcast arrives as N `send` frames
that share one id") and would defeat D2's dedupe — see the Design-doc gaps in the handback report.
This change fixes it: the id is minted once before the loop and every recipient's `ChannelMessage`
copy carries that same id. The existing per-recipient `createdAt` stays per-copy (harmless — it is
not part of dedupe or mailbox addressing, which is keyed by `<recipientSessionId>/<id>.json`, and
two recipients never share a directory).

**Alternatives considered:** keep per-recipient ids and dedupe the mirror by `(from.sessionId,
text, createdAt-bucket)` instead — rejected: fragile, and it reintroduces exactly the kind of
inference-based heuristic the source design's structural loop-safety section (§9) exists to avoid.

### D4 — `ChannelMessage` gains an optional `thread` selector, consumed only by the mirror

`onRouted(msg)` receives only the `ChannelMessage`, so a sender's thread intent has to travel
inside it. A new optional field is added to the canonical type (`bus/src/message.ts`, reused by
`broker/src/protocol.ts` per the repo's "reuse canonical types" rule):

```ts
export type ThreadSelector = { kind: 'handle'; handle: string } | { kind: 'new'; title: string }
```

`ChannelMessage.thread?: ThreadSelector`. `toChannelMeta` is intentionally **not** changed to
surface `thread` in the local `<channel>` notification — that belongs to the inbound relay's wake
payload (out of scope here per the task boundary) — so this field is inert for local delivery and
meaningful only to the mirror consumer.

**Alternatives considered:** a side-channel argument threaded separately into `onRouted` —
rejected: `onRouted`'s signature is fixed by the source design as `onRouted(msg)`; a second
argument would need a second seam through `route()` that does not exist and is not asked for by
`onRouted`'s specified contract.

### D5 — Room selection for a multi-recipient fan-out: shared room if all recipients share one, else the sender's lobby

A direct message to one recipient uses the pair's shared epic room (same project, same epic) or
else the sender's lobby (§7.2). A list `to` generalizes this: if every resolved recipient shares
the *same* epic room as the sender, the mirror posts once into that room, mentioning each recipient
individually (not `m.mentions.room`, since it is not addressed to the whole room). If recipients
are mixed — different epics, no shared epic, or spanning projects — the mirror posts once into the
sender's lobby, mentioning every recipient individually. A list `to` may not mix an epic-broadcast
target (`'epic'` / `'epic:N'`) with named recipients in the same call (`resolveTo` returns a new
`mixed_kind` failure) — mixing a room-wide mention with named mentions in one event is not
addressed by the source design and this change does not invent semantics for it.

**Alternatives considered:** one Matrix event per recipient for a list `to` — rejected: it makes a
list `to` behave differently from mirroring's own broadcast case (one event, several mentions) for
no benefit, and multiplies the event count the operator has to read.

### D6 — Pair-thread creation is triggered by the first mirrored direct message between the pair, not by a join event

The source design (§6) ties pair-thread creation to "when a worker joins an epic room" — a
provisioning/registration event out of this change's scope. Since the mirror module is what
actually needs a thread to post into, this change ties creation to the point the mirror needs one:
before posting the first direct-message mirror between two identities that have no pair thread yet,
the mirror asks bridge state to create one (root event + `rememberThread`) and posts into it. In
practice this fires at the same moment a join-triggered thread would (the pair's first message),
without requiring this change to specify or depend on the provisioner's join hook.

**Alternatives considered:** depend on a join hook fired by provisioning — rejected: out of this
change's scope per the task boundary, and would create a cross-change interface dependency that
does not otherwise exist.

### D7 — Thread handle allocation is out of scope; only the resolution contract is specified

`bridge-state` internals are explicitly out of scope for this change. This design specifies only
the contract the mirror needs: given a `ThreadSelector`, resolve it to a Matrix thread's root
`event_id` (creating a new thread + handle for `{ kind: 'new' }`, or looking one up for `{ kind:
'handle' }`), and given an identity pair with no explicit selector, resolve the pair thread
(creating it on first use per D6). The exact handle format and allocation strategy are left to
whichever change builds `bridge-state`.

### D8 — Mirror queue: ordered per room, bounded, exponential backoff with jitter, drop-oldest overflow

Each room has its own FIFO job queue so ordering within a room is preserved even though jobs from
different rooms can retry independently. A failed post is retried with exponential backoff
(illustratively: base delay doubling per attempt, capped near 60s, with jitter to avoid synchronized
retries after an outage) — matching §12's homeserver-unreachable row. When a room's queue is at
capacity, the oldest queued job is dropped and the drop is logged; delivery to the room continues
with the next job. The exact cap and backoff constants are configuration, not part of this design
(the config layer is a separate change) — this design fixes only the qualitative behavior the specs
must be executable against.

### Testing Strategy

- `broker/src/broker.test.ts` (extended): `onRouted` fires once per `route()` call (unconditionally
  — dedupe is not `broker.ts`'s job per D2); a throwing `onRouted` does not affect routing or
  process liveness (consistent with `broker-lifecycle`'s existing fail-loud boundary — a Matrix
  fault must not become a broker fault).
- A new `broker/src/matrix-mirror.ts` + `matrix-mirror.test.ts`: factory `createMatrixMirror(deps)`
  (per-room queues in a closure, no module-level state) covering id-dedupe within the bounded
  window, room selection for direct/broadcast/list-`to` cases, `txnId` equal to `msg.id` on every
  post attempt including retries, per-room ordering under interleaved failures, exponential
  backoff/jitter scheduling (fake timers), and drop-oldest overflow with a log line.
  `matrix-mirror.ts` depends only on injected `deps` (a post function, a room-resolver, a
  thread-resolver) — no live HTTP client in tests.
- `bus/src/handlers.test.ts` (extended): list-valued `to` resolves and fans out with one shared
  `id`; a `mixed_kind` failure when a list mixes an epic target with named recipients; the existing
  single-string `to` scenarios are unaffected (backward compatible); `thread` argument shapes
  (`omitted`, `"<handle>"`, `{ new: "<title>" }`) attach the corresponding `ThreadSelector` to every
  recipient copy of the message.
- `bus/src/message.test.ts` (extended): `ChannelMessage.thread` is optional and `toChannelMeta`
  ignores it (no `thread` key leaks into local channel meta from this change).
- `bus/src/address.test.ts` (extended): a broadcast (`'epic'`/`'epic:N'`) mixed with named entries
  in a list resolution returns `mixed_kind`.

## Risks / Trade-offs

- **[Risk]** D3's id-sharing fix changes existing broadcast behavior (each recipient copy's `id` is
  now shared, not distinct) → **Mitigation**: the on-disk mailbox format is unaffected (still
  `<recipientSessionId>/<id>.json`, still one file per recipient directory). The observable change
  is that `msg.id` is now equal across a fan-out's copies. `session-messaging`'s broadcast
  scenario constrains delivery and self-exclusion, not id distinctness, so the baseline spec is
  not contradicted — but the shipped broadcast test **did** assert distinctness outright
  (`expect(a[0].id).not.toBe(b[0].id) // distinct id per recipient`), and this change inverts that
  assertion deliberately rather than finding no test to touch. An earlier draft of this note
  claimed no test asserted it; that was wrong, and the inversion is the change's one intentional
  break with shipped behavior. Flagged explicitly for the archiving reviewer.
- **[Risk]** A room's mirror queue can grow unbounded relative to wall-clock time if the homeserver
  is down for a long outage → **Mitigation**: bounded per-room capacity with drop-oldest (D8);
  gaps are logged, not silent, matching §12's stated trade-off ("history gains a gap, delivery does
  not").
- **[Trade-off]** Pair-thread creation on first message (D6) instead of on join (§6) means a thread
  can exist with no announcing root-event context if the provisioning change's join flow later adds
  one independently — **Mitigation**: bridge-state's `rememberThread` is idempotent per D7's
  contract, so whichever creates the thread first wins and the other adopts it; this needs explicit
  confirmation once the provisioning change's design is written (open question below).

## Migration Plan

Additive only: `onRouted` is optional (existing broker instantiations without it are unaffected),
`ChannelMessage.thread` is optional, and `send_message`'s `to` accepting a list is a superset of
accepting a string. No data migration; the mirror queue is in-memory and starts empty on every
broker start (consistent with §10 — nothing about the mirror queue is persisted). Rollback is
removing the `onRouted` option at the call site; local messaging is untouched either way.

## Open Questions

1. Does the provisioning change's join flow also create a pair thread, and if so, does its
   `rememberThread` call race safely with this change's on-first-message creation (D6)? Needs
   confirmation once that change's design exists.
2. When a list `to` or broadcast resolves to zero live recipients, `route()` is never called and
   `onRouted` never fires — see the handback report's design-doc gap. This design deliberately keeps
   that behavior (mirroring only what was actually routed) rather than inventing a "mirror intent
   even with nobody to deliver to" path, but flags it as a real gap in the source design.
3. Cross-project direct messages (sender and recipient in different projects, e.g. via full
   `sessionId` or name-substring addressing) fall back to the sender's lobby under D5, but the
   recipient is not necessarily a member of the sender's project space — so the recipient's own
   client would not see the mirrored copy even though local delivery succeeds. This is a
   provisioning-membership question, not a mirror-behavior question, and is out of this change's
   scope to resolve.
