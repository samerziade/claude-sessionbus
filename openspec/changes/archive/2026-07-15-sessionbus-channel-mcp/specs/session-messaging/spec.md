## ADDED Requirements

### Requirement: Channel message schema and sortable id

A message SHALL be a single JSON object `{ id, from, to, text, createdAt }` where
`from` carries `{ sessionId, name, epic?, role }` and `to` carries
`{ kind: 'session' | 'epic', value }`. The `id` SHALL be a sortable, dependency-free
identifier formed from `base36(createdAt)` plus a random suffix, so name-order sorting
of inbox files approximates arrival order.

#### Scenario: Id encodes the timestamp

- **WHEN** an id is generated at time `1000` with random suffix `abcd`
- **THEN** the id is `base36(1000) + '-abcd'`

#### Scenario: Distinct suffixes yield distinct ids

- **WHEN** two ids are generated at the same time with different random suffixes
- **THEN** the two ids differ

### Requirement: Identifier-safe channel meta mapping

The server SHALL map a message to channel meta using only identifier-safe keys
(letters/digits/underscore), because the channel contract silently drops any other key.
The keys MUST be `from`, `from_id` (the sender's short id), `role`, `msg_id`, and `epic`
when the sender has one; the message `text` MUST become the notification content.
Inbound messages therefore arrive as
`<channel source="sessionbus" …attrs…>text</channel>`.

#### Scenario: Meta uses identifier-safe keys

- **WHEN** a worker message from `1234 epic:2345` is mapped to channel meta
- **THEN** meta is `{ from, from_id, role, epic, msg_id }` with no hyphenated keys

#### Scenario: Epic omitted when the sender has none

- **WHEN** a `role: none` sender with no epic is mapped
- **THEN** meta omits `epic` and sets `role` to `none`

### Requirement: Flexible to-address resolution

`send_message`'s `to` argument SHALL be resolved against live peers in this order:
exact full `sessionId`, `pm` (the PM of the caller's epic), `epic` / `epic:N`
(broadcast), short-id prefix of at least 4 chars against the hyphen-stripped session id,
then name substring. The resolver SHALL never silently guess: an unmatched target
returns `not_found`, a target matching multiple peers returns `ambiguous` with the
candidate list, and `pm`/`epic` requested by a caller with no epic returns `no_epic`.

#### Scenario: pm resolves to the caller's epic PM

- **WHEN** a worker in epic `2345` resolves `to: 'pm'` and a PM for epic `2345` is present
- **THEN** resolution is `{ ok: true, kind: 'session', recipients: [thePM] }`

#### Scenario: epic broadcasts to same-epic members

- **WHEN** a worker in epic `2345` resolves `to: 'epic'`
- **THEN** resolution is `{ ok: true, kind: 'epic' }` with every same-epic live peer

#### Scenario: epic:N targets a specific epic

- **WHEN** any caller resolves `to: 'epic:9'`
- **THEN** resolution returns the live members of epic `9`

#### Scenario: Unambiguous short-id prefix and name substring

- **WHEN** a caller resolves a short-id prefix or a name substring that matches exactly one peer
- **THEN** resolution is `{ ok: true, kind: 'session', recipients: [thatPeer] }`

#### Scenario: Ambiguous target returns candidates

- **WHEN** a name substring matches more than one peer
- **THEN** resolution is `{ ok: false, reason: 'ambiguous', candidates: [...] }`

#### Scenario: Unresolved and no-epic cases

- **WHEN** a target matches nothing, THEN resolution is `{ ok: false, reason: 'not_found' }`
- **WHEN** `pm` or `epic` is requested by a caller with no epic, THEN resolution is `{ ok: false, reason: 'no_epic' }`

### Requirement: Atomic flat-file mailbox transport

The transport SHALL sit behind a `Transport` interface (`send`, `poll`, `watch`) with a
flat-file implementation so a future broker daemon is a drop-in swap. A send SHALL write
one message file into the recipient's inbox
(`~/.claude/channels/bus/<recipientSessionId>/<id>.json`) atomically: write a
`.<id>.tmp` file, then `rename` it into place so a reader never observes a partial file.

#### Scenario: Send is atomic and leaves no temp file

- **WHEN** a message is sent and then the recipient polls
- **THEN** the message is delivered AND no `.tmp` file remains in the inbox

### Requirement: Poll and watch delivery with at-least-once semantics

A recipient SHALL receive messages by polling its own inbox and by watching it
(`fs.watch` plus a ~1s poll fallback, since macOS `fs.watch` can miss events). On each
scan the server SHALL parse each message file, deliver newly-seen messages, and archive
their files to `consumed/`. Delivery is **at-least-once**: an in-memory set of delivered
ids suppresses duplicate watch fires, and archival to `consumed/` prevents re-delivery
across restarts. Messages persist on disk, so an offline or busy recipient receives them
on its next scan.

#### Scenario: Delivered exactly once within an instance

- **WHEN** a message is sent and the recipient polls twice
- **THEN** the first poll returns the message and the second returns nothing

#### Scenario: Consumed archival

- **WHEN** a recipient polls after a message arrives
- **THEN** the message file is moved to `consumed/<id>.json` and removed from the inbox root

#### Scenario: Offline messages delivered on next scan

- **WHEN** messages are queued before the recipient starts polling
- **THEN** the recipient's first scan returns all queued messages

#### Scenario: Watch delivers a message that arrives after watching starts

- **WHEN** a recipient is watching and a message is sent
- **THEN** the watch callback is invoked with that message

### Requirement: send_message tool with delivery summary

The server SHALL expose a `send_message({ to, text })` tool that resolves `to` against
live peers, writes one message copy into each resolved recipient's inbox, and returns a
delivery summary (`kind`, `recipients`, `count`). On a failed resolution it SHALL return
`{ ok: false, reason, candidates? }` without writing any message.

#### Scenario: Routes pm to the PM inbox

- **WHEN** a worker calls `send_message({ to: 'pm', text: '…' })`
- **THEN** the tool reports one recipient AND the PM can poll its inbox and read the message with the sender's `from.name`

#### Scenario: Unknown target writes nothing

- **WHEN** a caller sends to an unknown target
- **THEN** the tool returns `{ ok: false, reason: 'not_found' }` and no inbox is written

### Requirement: Broadcast fan-out and self-suppression

An `epic` broadcast SHALL write one copy into each live epic member's inbox. A session
SHALL never deliver a message to its own inbox, including on broadcasts.

#### Scenario: Broadcast excludes the sender

- **WHEN** a member broadcasts to its epic
- **THEN** every other live epic member receives a copy and the sender does not

### Requirement: Inbound delivery as a channel event

An inbound message SHALL be delivered into the recipient session's context as a
`notifications/claude/channel` event whose content is the message text and whose meta is
the identifier-safe mapping, arriving wrapped as
`<channel source="sessionbus" from_id="…" msg_id="…" …>text</channel>`. This SHALL drive
a turn even when the session is idle.

#### Scenario: Incoming message becomes a channel notification

- **WHEN** a worker sends `ping` to a watching PM session
- **THEN** the PM's notify handler is called once with content `ping` and meta including `from`, `from_id`, `role`, and `epic`
