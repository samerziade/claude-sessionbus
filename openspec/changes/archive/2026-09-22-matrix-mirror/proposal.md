## Why

Today session-to-session traffic is delivered once and then gone: nothing durable records what
was said, and no human can watch a conversation happen. The bridge design
(`docs/superpowers/specs/2026-09-22-sessionbus-matrix-bridge-design.md`) closes that by mirroring
routed traffic into Matrix rooms. This change lands the outbound half only — the mirror queue, room
selection, idempotent posting, and the `send_message` argument surface (list `to`, `thread`) needed
to address it. It depends on provisioning (rooms/users already exist) and precedes the inbound
relay (mentions waking sessions); both are separate changes.

## What Changes

- The broker core (`broker/src/broker.ts`) gains an optional `onRouted(msg)` hook, invoked once per
  unique `msg.id` after `route()` — a broadcast fans out as several `send` frames that share one
  id, and the hook fires once for the set, not once per frame.
- A new outbound mirror queue: ordered per room, bounded, retried with exponential backoff and
  jitter on failure, dropping the oldest queued job on overflow (mirroring is best-effort; local
  delivery is never affected by mirror failures).
- Room selection for a routed message: a direct message goes to the sender and recipient's shared
  epic room, or the sender's lobby when they share no epic room; an epic broadcast goes to the epic
  room with `m.mentions.room` set.
- Posting is masqueraded as the sender's Matrix user, using `msg.id` as the Matrix `txnId` so a
  retried post after a transient failure does not create a duplicate event.
- `send_message` (`bus/src/handlers.ts`) accepts a list-valued `to` (send the same text to several
  resolved recipients in one call) and an optional `thread` argument that selects which Matrix
  thread the mirrored post lands in.
- **BREAKING**: none — `to` remains valid as a single string, and `thread` is optional. Existing
  callers are unaffected.

## Capabilities

### New Capabilities

- `session-grouping`: thread assignment for mirrored traffic — pair threads created mechanically
  when a worker joins an epic room, thread handles as stable short aliases for Matrix root event
  ids, and the resolution rules for `send_message`'s `thread` argument (omitted, handle, or new).
  This change adds only the threading slice of `session-grouping`; provisioning (rooms, spaces,
  identity-to-user mapping) is minted by a separate change and is not covered here.

### Modified Capabilities

- `session-messaging`: adds the outbound mirror (the `onRouted` hook contract, mirror queue
  ordering/backoff/overflow behavior, room selection, idempotent posting) and extends
  `send_message` to accept a list-valued `to` and an optional `thread` argument.

## Impact

- `broker/src/broker.ts`: new optional `onRouted` hook on `BrokerCoreOptions`/`BrokerCore`.
- A new `broker/src/matrix-mirror.ts` (or similarly named) module owning the outbound queue,
  reached through the `onRouted` seam — the broker core stays unaware of Matrix.
- `bus/src/handlers.ts`: `sendMessage` signature grows `to: string | string[]` and an optional
  `thread` argument; `HandlerDeps` gains whatever seam is needed to pass `thread` resolution intent
  through to the transport/mirror (see design.md for the exact shape).
- No change to the flat-file `Transport` interface's on-disk format; mirroring is additive and
  keeps local delivery on its existing path.
- Depends on the provisioning change for room/user existence and on bridge-state for thread
  persistence; this change specifies the *contract* those pieces must satisfy but does not
  implement them.
