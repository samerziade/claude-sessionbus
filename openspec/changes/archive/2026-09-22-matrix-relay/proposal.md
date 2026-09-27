## Why

Sessions can already be grouped into rooms and their traffic mirrored outward, but the
conversation is still one-directional: the operator can read what sessions say and cannot
say anything back that a session will act on. There is also no way for a session to learn
what was said in a room before it existed — delivery is ephemeral, so a message a session
missed is gone.

This change closes the return path. An operator mentions a work identity from any Matrix
client and the named session wakes with the missed context already in hand; a session can
read room history on demand; and a session can answer a human directly. It is the last of
the three bridge changes and the one that turns a mirror into a conversation.

## What Changes

- **A single inbound sync loop.** The bridge long-polls `/sync` once, **masqueraded as the
  bridge bot** — the homeserver refuses to sync for an appservice's own sender identity and
  answers 500, so the masquerade is a correctness requirement rather than a convention, and
  every request the relay makes as the bot carries it — across every room the bot has joined. It resumes from a persisted sync cursor across
  restarts, and on a cold start with no cursor it begins at "now" — a restart can never
  replay yesterday's mentions as fresh wakes.
- **The bridge bot accepts invites from the configured operator only.** The homeserver
  does not auto-accept and pushes nothing to the bridge, so an invite to the bot — above
  all to the operator's root space — stays pending until the relay joins it. The relay joins
  if and only if the inviter is the configured operator and declines every other invite.
  This is a security boundary: the relay wakes sessions on mentions in any room the bot
  belongs to, so accepting any local account's invite would let any account on the
  homeserver drive a session from a room it controls. Invites already pending before the
  bridge starts are recovered on every start, cold or warm. Invites to session users never
  reach the relay and are out of scope.
- **A filter chain decides what wakes anything.** In order: an event whose sender is in
  the `cc` namespace is dropped (this is what makes echo loops structurally impossible,
  not merely unlikely); an event whose id has already been seen is dropped; an event with
  no mention of a registered identity is recorded as history and wakes nothing; an event
  that would wake the identity that sent it is dropped.
- **A mention becomes a wake through the existing route.** A mentioned identity is mapped
  to its currently live session id and delivered through the broker core's existing
  `route()` — the same call a local `send_message` makes. Matrix adds exactly one hop;
  everything from the deliver frame onward is code that already ships. An `@room` mention
  wakes every registered member of the room.
- **The wake carries the unread window inline**, capped at 20 messages or ~2000
  characters, whichever comes first, keeping the newest. When the window is truncated
  `omitted` is non-zero and `since` still points at the *pre-delivery* cursor, so a
  follow-up `read_history({ room, since })` returns the whole window including what was
  dropped. Inlining removes a silent failure mode: a pull-only wake lets the model answer
  without ever fetching the context, and nothing detects it.
- **BREAKING (spec-level): the channel meta contract widens.** `toChannelMeta` today emits
  exactly `from`, `from_id`, `role`, `msg_id` and `epic`. Every message gains `origin`
  (`session` or `human`), and a relayed wake additionally carries `room`, `thread`,
  `thread_title`, `mentions`, `unread`, `omitted` and `since`. `from_id` becomes a full
  Matrix user id rather than a short session id when the sender is a human, because
  `from_id` has to stay a value a reply's `to` accepts. Every key stays identifier-safe,
  because the channel contract silently drops any key that is not.
- **A read cursor per identity per room**, advancing when a wake is delivered and when
  `read_history` returns events, persisted atomically. The cursor is what makes catch-up
  work and is what removes the need for an offline queue: an identity that was down when
  it was mentioned receives **one** catch-up wake on its next register, never a replayed
  burst.
- **A `read_history` tool** — `read_history({ room?, thread?, since?, limit?, search? })`
  — defaulting to the caller's epic room, or its lobby when it has no epic. Any room in
  the `cc` namespace is readable, so a session on one epic can look up how another epic
  solved something, while writing stays limited to rooms the session belongs to. On the
  file transport it returns a structured `{ ok: false, reason: 'unavailable' }` rather
  than throwing.
- **A session can answer a human.** A `send_message` whose `to` is a Matrix user id
  outside the `cc` namespace skips local routing entirely and posts into the room and
  thread of that person's most recent mention of this session, falling back to the
  session's own room.

## Capabilities

### New Capabilities

<!-- None. Everything here is message delivery, channel meta, and history — the surface
     `session-messaging` already owns. Rooms, spaces, identity-to-Matrix-user mapping and
     thread allocation belong to `session-grouping`, which a separate change mints; this
     change consumes that mapping and does not define it. -->

### Modified Capabilities

- `session-messaging`: gains inbound relay of a human mention as a channel event — the
  sync loop and its filter chain, operator-only invite acceptance for the bridge bot,
  mention-to-session mapping through the existing
  `route()`, the capped inline unread window and its rendered transcript, the per-identity
  read cursor and catch-up on register, `read_history`, and a reply addressed to a
  non-`cc` Matrix id. Its existing **Identifier-safe channel meta mapping** requirement is
  modified: the key set becomes conditional on the message's origin.

## Impact

- **Architecture seam:** two existing seams, no new one.
  - `HandlerDeps` in `bus/src/handlers.ts` gains the `read_history` handler and the
    Matrix-aware `to` path in `send_message`. Both are injected, so both are testable
    without stdio.
  - The `Transport` interface in `bus/src/mailbox.ts` gains a `history` member. The flat
    file implementation answers `unavailable`; the socket implementation round-trips a
    new request/reply frame pair. This is an interface change and is worked in design.md.
  - The relay itself hangs off `broker/src/broker.ts`'s existing `route()` — deliberately
    *not* a new delivery path. A relayed mention converges on the same call a local send
    uses, which is the property that keeps one delivery path per message.
- **Code:** `broker/src/matrix-bridge.ts` (inbound half: sync loop, filter chain, window
  builder, cursor), `broker/src/protocol.ts` (history request/reply frames),
  `bus/src/handlers.ts`, `bus/src/message.ts` (meta mapping), `bus/src/mailbox.ts` and the
  socket transport, `bus/src/index.ts` (tool registration and `instructions`). Paired
  `*.test.ts` for every new module; extensions to the existing ones.
- **Assumed present, not built here:** the configuration layer, Matrix naming,
  provisioning, `bridge-state`, the outbound mirror and thread allocation. This change
  reads them through their interfaces and fakes them in tests.
- **Identity, beacons and inbox subscription — breaking risk, called out:** the relay
  maps a *stable work identity* to a *currently live session id*, and then routes to that
  session id. That id is exactly the one the session last registered with, which is the
  id its beacon and its inbox subscription name. If the relay ever caches a session id
  across a re-register, a wake is queued under an id nobody holds: `route()` queues
  unknown recipients silently, `send_message` reports success, and the message is never
  delivered. The identity-to-session map must therefore be re-read on every relay and
  re-bound on every `register`, never cached — the same rule that already governs
  `HandlerDeps.self`. Nothing in this change writes a beacon or changes what a session
  subscribes to.
- **Delivery is at-most-once at the final hop, by inheritance.** The cursor advances when
  the wake is handed to a live conn. Claude Code's channel allowlist can still swallow the
  notification below that point with every layer reporting success, which no layer here
  can detect. This is a pre-existing property of the local path, not something the relay
  introduces; it is recorded in design.md rather than papered over.
- **Dependencies:** none added. `fetch` and the JSON state file are already available.
- **Ops:** a Matrix fault never exits the broker. The relay returns errors across its
  boundary rather than throwing, and every async path carries its own handler, because the
  process-level `unhandledRejection` backstop would otherwise turn a homeserver hiccup
  into a supervised restart.
