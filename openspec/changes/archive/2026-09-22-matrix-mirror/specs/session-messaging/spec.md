## MODIFIED Requirements

### Requirement: Broadcast fan-out and self-suppression

An `epic` broadcast SHALL write one copy into each live epic member's inbox. Any `send_message`
call whose resolved `to` produces more than one recipient — an epic broadcast or a multi-entry list
`to` — SHALL write those copies sharing one `ChannelMessage.id`, minted once for the call rather
than once per recipient. A session SHALL never deliver a message to its own inbox, including on
broadcasts.

#### Scenario: Broadcast excludes the sender

- **WHEN** a member broadcasts to its epic
- **THEN** every other live epic member receives a copy and the sender does not

#### Scenario: Broadcast copies share one message id

- **WHEN** a member broadcasts to an epic with three other live members
- **THEN** all three delivered copies carry the same `ChannelMessage.id`

#### Scenario: A multi-recipient send_message call shares one message id

- **WHEN** a caller sends to a list `to` that resolves to two distinct live recipients
- **THEN** both delivered copies carry the same `ChannelMessage.id`

### Requirement: send_message tool with delivery summary

The server SHALL expose a `send_message({ to, text, thread? })` tool. `to` SHALL accept either a
single target string or a non-empty list of target strings; each entry SHALL be resolved against
live peers using the same resolution order as a single `to` (see: Flexible to-address resolution).
When `to` is a list, every entry MUST resolve to `kind: 'session'`; if any entry resolves to `kind:
'epic'` the call SHALL fail with `{ ok: false, reason: 'mixed_kind' }` and write no message.
Resolved recipients SHALL be de-duplicated by `sessionId` before delivery, so a list whose entries
resolve to the same peer writes one copy to that peer. The tool SHALL write one message copy into
each resulting recipient's inbox and return a delivery summary (`kind`, `recipients`, `count`). On
a failed resolution of any entry in the list it SHALL return `{ ok: false, reason, candidates? }`
without writing any message for any entry. The optional `thread` argument, when present, SHALL be
attached as a thread selector to every written copy for the outbound mirror to consume; it SHALL
NOT alter local delivery or the local `<channel>` meta.

#### Scenario: Routes pm to the PM inbox

- **WHEN** a worker calls `send_message({ to: 'pm', text: '…' })`
- **THEN** the tool reports one recipient AND the PM can poll its inbox and read the message with the sender's `from.name`

#### Scenario: Unknown target writes nothing

- **WHEN** a caller sends to an unknown target
- **THEN** the tool returns `{ ok: false, reason: 'not_found' }` and no inbox is written

#### Scenario: List to resolves multiple named recipients in one call

- **WHEN** a caller calls `send_message({ to: ['w-123', 'w-456'], text: '…' })` and both resolve to distinct live peers
- **THEN** the tool reports two recipients AND both recipients' inboxes contain a copy

#### Scenario: List to mixing an epic target with a named recipient fails without writing

- **WHEN** a caller calls `send_message({ to: ['epic', 'w-123'], text: '…' })`
- **THEN** the tool returns `{ ok: false, reason: 'mixed_kind' }` and no inbox is written

#### Scenario: List to with duplicate resolved recipients delivers one copy per recipient

- **WHEN** a caller calls `send_message({ to: ['w-123', '<w-123's full sessionId>'], text: '…' })` and both entries resolve to the same peer
- **THEN** the tool reports one recipient AND that peer's inbox contains exactly one copy

#### Scenario: A failed entry in a list to writes nothing for any entry

- **WHEN** a caller calls `send_message({ to: ['w-123', 'no-such-peer'], text: '…' })` and the second entry does not resolve
- **THEN** the tool returns `{ ok: false, reason: 'not_found' }` AND `w-123`'s inbox contains no copy

#### Scenario: thread argument does not alter local delivery or channel meta

- **WHEN** a caller calls `send_message({ to: 'w-123', text: '…', thread: 't_9f2a' })`
- **THEN** `w-123` receives the message with the same `<channel>` meta keys as a call with no `thread` argument

## ADDED Requirements

### Requirement: Outbound mirror hook fires on every routed message

The broker core SHALL support an optional `onRouted` hook. When configured, `route()` SHALL invoke
it once after each `route()` call, whether the message was delivered to a live connection or queued
for a later registration, passing the routed `ChannelMessage`. For a fan-out whose copies share one
id (per the Broadcast fan-out requirement), the hook SHALL be invoked once per `route()` call — once
per recipient — all invocations carrying the same `ChannelMessage.id`. A throwing `onRouted` SHALL
NOT affect routing, queuing, or broker process liveness. A broker started without `onRouted`
configured SHALL route messages exactly as before this change.

#### Scenario: Hook fires after delivery to a live connection

- **WHEN** a broker configured with `onRouted` routes a message to a registered, connected recipient
- **THEN** the recipient receives a `deliver` frame AND `onRouted` is invoked once with that message

#### Scenario: Hook fires after queuing for an offline recipient

- **WHEN** a broker configured with `onRouted` routes a message to a recipient with no live connection
- **THEN** the message is queued for later delivery AND `onRouted` is invoked once with that message

#### Scenario: Hook fires once per fan-out recipient

- **WHEN** a broker configured with `onRouted` routes three copies of a broadcast, one per recipient, all sharing one id
- **THEN** `onRouted` is invoked three times, each invocation's message carrying that shared id

#### Scenario: A throwing hook does not affect routing or liveness

- **WHEN** `onRouted` throws during a `route()` call
- **THEN** the message is still delivered or queued normally AND the broker does not exit and continues serving other clients

#### Scenario: No hook configured routes unchanged

- **WHEN** a broker is started without `onRouted` configured and a message is routed
- **THEN** delivery or queuing behaves exactly as it did before this change

### Requirement: Outbound mirror deduplicates by message id

The outbound mirror SHALL enqueue at most one mirror job per unique `ChannelMessage.id`, even though
`onRouted` fires once per `route()` call for a multi-recipient fan-out. A message id that has
already produced a mirror job SHALL NOT enqueue a second job for a later `onRouted` invocation
carrying the same id. Because `onRouted` only fires for messages that were actually routed, a
fan-out that resolves to zero live recipients calls `route()` zero times and therefore mirrors
nothing.

#### Scenario: Repeated invocations sharing one id enqueue one mirror job

- **WHEN** `onRouted` is invoked three times for a three-recipient broadcast, all three invocations carrying the same id
- **THEN** exactly one mirror job is enqueued for that id

#### Scenario: Distinct sends enqueue distinct jobs

- **WHEN** the same sender sends the same text to the same recipient twice, producing two messages with two distinct ids
- **THEN** two mirror jobs are enqueued, one per id

#### Scenario: A broadcast with zero live recipients enqueues no mirror job

- **WHEN** a caller broadcasts to an epic with no other live members
- **THEN** `route()` is never called for that broadcast AND no mirror job is enqueued

### Requirement: Outbound mirror queue ordering, bounds, and retry

The outbound mirror SHALL maintain one ordered job queue per destination room. A post that fails
SHALL be retried with exponential backoff and jitter rather than being dropped after one failure,
and a retrying job for one room SHALL NOT block a job queued for a different room from posting.
When a room's queue is at its bound, enqueuing a new job SHALL drop the oldest queued job for that
room and log the drop; delivery for that room SHALL continue with the remaining and newly enqueued
jobs.

#### Scenario: Jobs for the same room post in enqueue order

- **WHEN** two mirror jobs for the same room are enqueued in sequence
- **THEN** the first job's post is attempted before the second job's post

#### Scenario: A retrying job for one room does not block another room

- **WHEN** a job for room A is retrying after a failed post and a job for room B is enqueued
- **THEN** room B's job posts without waiting for room A's retry to succeed

#### Scenario: A failed post is retried rather than dropped

- **WHEN** a mirror job's post attempt fails with a transient error
- **THEN** the job remains queued and is attempted again rather than being discarded

#### Scenario: Enqueuing at capacity drops the oldest queued job

- **WHEN** a room's queue already holds its maximum number of queued jobs and a new job is enqueued
- **THEN** the oldest queued job for that room is dropped and the drop is logged, and the new job is queued

### Requirement: Mirror room selection for direct and broadcast messages

The outbound mirror SHALL select a destination room for each mirror job: a direct message between
two identities who share a live epic room SHALL post into that shared epic room, mentioning the
recipient; a direct message between identities who share no epic room SHALL post into the sender's
lobby, mentioning the recipient; an epic broadcast SHALL post into the epic room, mentioning the
whole room. A multi-recipient `send_message` call (list `to`) whose every resolved recipient shares
the sender's epic room SHALL post once into that room, mentioning each recipient individually;
otherwise it SHALL post once into the sender's lobby, mentioning each recipient individually.

#### Scenario: Direct message between pair sharing an epic room

- **WHEN** the outbound mirror processes a direct message between two identities who share an epic room
- **THEN** the mirror job targets that shared epic room and mentions the recipient

#### Scenario: Direct message between pair sharing no epic room

- **WHEN** the outbound mirror processes a direct message between two identities with no shared epic room
- **THEN** the mirror job targets the sender's lobby and mentions the recipient

#### Scenario: Epic broadcast mentions the whole room

- **WHEN** the outbound mirror processes an epic broadcast
- **THEN** the mirror job targets the epic room and mentions the whole room

#### Scenario: Multi-recipient send sharing one room posts once, mentioning each

- **WHEN** the outbound mirror processes a multi-recipient send whose every recipient shares the sender's epic room
- **THEN** exactly one mirror job targets that epic room, mentioning each recipient individually

#### Scenario: Multi-recipient send without a shared room falls back to the sender's lobby

- **WHEN** the outbound mirror processes a multi-recipient send whose recipients do not all share one epic room
- **THEN** exactly one mirror job targets the sender's lobby, mentioning each recipient individually

### Requirement: Idempotent mirror posting via txnId

The outbound mirror SHALL post as the sending identity's Matrix user, using the message's id as the
Matrix transaction id (`txnId`), so that retrying a post after a transient failure never produces
more than one Matrix event for that message id.

#### Scenario: A retried post reuses the same txnId

- **WHEN** a mirror job's first post attempt fails transiently and is retried
- **THEN** the retried attempt uses the same `txnId` as the first attempt

#### Scenario: Distinct messages use distinct txnIds

- **WHEN** two mirror jobs carry two distinct message ids
- **THEN** their posts use two distinct `txnId` values
