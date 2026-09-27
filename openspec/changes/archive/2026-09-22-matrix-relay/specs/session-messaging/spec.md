## ADDED Requirements

### Requirement: Single inbound sync loop with a resumable cursor

The bridge SHALL consume inbound room events through exactly one long-poll sync stream,
opened **as the configured bot user** through the appservice masquerade parameter, covering
every room the bot has joined — never one stream per room. The homeserver refuses to sync
for the appservice's own sender identity and answers such a request with a server error, so
an unmasqueraded stream is a defect, not a fallback. Every request the relay makes as the
bot SHALL carry the same masquerade: opening the stream, joining a room to accept an
invite, declining an invite, and reading history. The set of rooms it reads is exactly the
bot's joined set, so a room enters it the moment the bot joins, including by accepting an
operator invite.

The relay SHALL persist the sync position returned by a batch only **after** that batch's
events have been processed, so an interrupted batch is re-read rather than skipped;
re-reading is harmless because every event is deduplicated by id. On start with a persisted
position it SHALL resume from it. With no usable persisted position — a first run, a store
that cannot be parsed, or a position recorded under a bot identity other than the currently
configured one — it SHALL establish its starting position from the homeserver's current
stream position and SHALL NOT relay any event that precedes it, so a restart can never
replay old mentions as fresh wakes. A sync position is scoped to the user whose stream
produced it, which is why a position from a different bot identity is unusable rather than
merely stale.

#### Scenario: The stream is opened as the bot, never as the sender identity

- **WHEN** the relay opens its sync stream
- **THEN** the request carries the masquerade parameter naming the configured bot user AND
  no request is issued as the appservice's sender identity

#### Scenario: Resumes from the persisted position

- **WHEN** the bridge starts with a persisted sync position and opens its stream
- **THEN** its first sync request carries that position as its starting point

#### Scenario: A position recorded under a different bot identity is discarded

- **WHEN** the bridge starts with a persisted position that was recorded under a bot
  identity other than the configured one
- **THEN** it starts as though no position were persisted and relays nothing that predates
  the start

#### Scenario: Cold start begins at now

- **WHEN** the bridge starts with no persisted position and a `cc` room already contains
  an unread message mentioning a registered identity
- **THEN** no wake is routed for that pre-existing message AND the persisted position is
  set to the homeserver's current stream position

#### Scenario: An unreadable position store behaves as a cold start

- **WHEN** the persisted state cannot be parsed and the bridge starts
- **THEN** the bridge starts successfully, relays nothing that predates start, and does
  not raise

#### Scenario: One stream serves every room

- **WHEN** the bridge has joined two `cc` rooms and both receive a message
- **THEN** at most one sync request is in flight at a time and both messages are observed
  through it

#### Scenario: A room joined by accepting an invite is read by the same stream

- **WHEN** the bot accepts an operator invite to a room and a human then posts a message in
  that room mentioning a registered identity whose session is live
- **THEN** that identity is woken through the same single stream, with no second stream
  opened

#### Scenario: The position advances only after a batch is processed

- **WHEN** a batch is received and its events are processed
- **THEN** the persisted position equals that batch's returned next position

#### Scenario: A replayed batch wakes nothing twice

- **WHEN** the same batch is delivered to the bridge a second time
- **THEN** exactly one wake is routed in total for the mention it contains

### Requirement: The bridge bot accepts invites from the configured operator only

The relay SHALL accept a pending invite addressed to the bridge bot if and only if the
inviter is the configured operator, by joining that room as the bot. The inviter is the
sender of the invite membership event, compared by exact Matrix user id — never by display
name. There are three outcomes, not two:

- **Accept** — the inviter is exactly the configured operator: join the room as the bot.
- **Decline** — the inviter is an identifiable user who is not the operator: leave the room,
  which is how the protocol refuses a pending invite.
- **Ignore** — the inviter cannot be determined, because the stripped invite state carried no
  membership event for the bot: leave the invite pending and do nothing. This is not an
  invite from someone else, it is an invite that could not be attributed, and declining it
  would destroy something the operator may well have sent. Failing closed without destroying
  it is the same choice the no-operator case makes below, for the same reason. This is a security boundary, not
a convenience: the relay wakes sessions on mentions in any room the bot belongs to, so
accepting any local account's invite would let any account on the homeserver drive a
session from a room it controls. With no operator configured the relay SHALL accept no
invite and SHALL decline none, leaving them pending for a correctly configured start.

Every join and every decline SHALL be issued as the bot through the masquerade parameter,
like every other request the relay makes on the bot's behalf.

Acceptance SHALL be idempotent: an invite already accepted, or already being accepted,
SHALL NOT produce a second join. A join that fails SHALL be retried on a later sync
iteration rather than dropped, until it succeeds or the invite is withdrawn. Invites that
were already pending before the bridge started SHALL be found and handled on start, whether
the start is cold or resumes from a persisted position — starting the event stream at "now"
SHALL NOT skip them.

The relay handles only invites addressed to the bot itself. Its stream carries no other
user's invites, so an invite addressed to a session user is never seen and never acted on;
session users are joined to rooms by provisioning, which leaves no pending invite.

#### Scenario: An operator invite is accepted by exactly one join

- **WHEN** a sync batch carries a pending invite to the bot whose inviter is the configured
  operator
- **THEN** exactly one join of that room is issued as the bot AND no decline is issued

#### Scenario: A join and a decline are issued as the bot

- **WHEN** one batch carries an operator invite and an invite from another local user
- **THEN** both the join and the decline carry the masquerade parameter naming the
  configured bot user

#### Scenario: A non-operator invite is declined and never joined

- **WHEN** a sync batch carries a pending invite to the bot from a local user who is not
  the configured operator
- **THEN** no join is issued AND the invite is declined

#### Scenario: An invite that cannot be attributed is left pending

- **WHEN** a pending invite to the bot carries no membership event naming the bot, so its
  inviter cannot be determined
- **THEN** no join is issued AND no decline is issued

#### Scenario: An impostor display name is not the operator

- **WHEN** an invite comes from a different user whose display name equals the operator's
- **THEN** no join is issued AND the invite is declined

#### Scenario: A mention in a declined room wakes nothing

- **WHEN** a non-operator invite has been declined and that inviter then posts a mention of
  a registered identity in that room
- **THEN** no wake is routed

#### Scenario: A replayed invite is joined once

- **WHEN** the batch carrying an operator invite is delivered a second time, after the join
  succeeded but before the room shows as joined
- **THEN** exactly one join has been issued in total

#### Scenario: A failed join is retried on a later sync

- **WHEN** the join for an operator invite fails and the next sync iteration runs without
  the invite appearing again
- **THEN** a second join of that room is issued

#### Scenario: Retrying stops when the invite is withdrawn

- **WHEN** a join for an operator invite has failed and a later batch shows the bot's
  invite to that room withdrawn
- **THEN** no further join of that room is issued

#### Scenario: A cold start accepts an invite that was already pending

- **WHEN** the bridge starts with no persisted position and an operator invite to the bot
  was already pending before it started
- **THEN** exactly one join of that room is issued AND no message that predates the start
  is relayed

#### Scenario: A warm start accepts an invite that was already pending

- **WHEN** an operator invite was observed, its join failed, the sync position was
  persisted past the batch that carried it, and the bridge then restarts from that
  persisted position
- **THEN** exactly one join of that room is issued after the restart, even though no
  incremental batch carries the invite again

#### Scenario: No configured operator accepts and declines nothing

- **WHEN** no operator is configured and a pending invite to the bot is observed
- **THEN** no join is issued AND no decline is issued

#### Scenario: A failed join never becomes a decline

- **WHEN** the join for an operator invite fails
- **THEN** no decline is issued for that room

### Requirement: Inbound filter chain

Every inbound event SHALL pass a filter chain before anything is woken, and a filtered
event SHALL produce no wake and SHALL NOT advance any read cursor. In order:

1. An event whose sender is inside the `cc` namespace SHALL be discarded. Session traffic
   reaches Matrix only as a mirror, so discarding `cc` senders leaves exactly one delivery
   path per message and makes an echo loop structurally impossible rather than merely
   unlikely.
2. An event whose id has already been processed SHALL be discarded. The set of processed
   ids SHALL be bounded, evicting the oldest first.
3. An event that is not a plain text room message SHALL be discarded.
4. An event that would wake the identity that sent it SHALL be discarded. Under a correct
   configuration this rule never fires: every registered identity is a user inside the `cc`
   namespace by construction, so rule 1 has already discarded anything it could apply to. It
   is retained as the last line of defence against a **misconfigured `namespacePrefix`** —
   the prefix is configuration, identifiers are permanent, and a prefix that does not match
   the one identities were minted under turns rule 1 into a no-op. The rule is therefore
   specified over the identity set rather than over the namespace, and fires exactly when a
   registered identity's user id falls outside the configured prefix.

#### Scenario: A mirrored session message never wakes anything

- **WHEN** an inbound event is received whose sender is a `cc`-namespace user and whose
  body mentions a registered identity
- **THEN** no wake is routed

#### Scenario: A repeated event id wakes once

- **WHEN** the same event is received in two separate batches
- **THEN** exactly one wake is routed

#### Scenario: A non-text event is ignored

- **WHEN** an inbound event that is not a plain text room message names a registered
  identity
- **THEN** no wake is routed

#### Scenario: No self-wake, when a misconfigured prefix lets one through

- **WHEN** a registered identity whose user id falls outside the configured namespace prefix
  sends an event naming itself
- **THEN** no wake is routed for that identity

#### Scenario: A self-mention does not silence the others

- **WHEN** that same event names another registered identity as well
- **THEN** the other identity is woken and the sender is not

#### Scenario: Filtered events leave the read cursor alone

- **WHEN** a batch contains only events discarded by the filter chain
- **THEN** every registered identity's read cursor is unchanged

#### Scenario: The processed-id set is bounded and evicts oldest first

- **WHEN** more distinct events are processed than the dedupe bound and the most recently
  processed event is then re-delivered
- **THEN** it is still recognised as seen and wakes nothing

### Requirement: A mention wakes only the identities it names

Only an explicit mention SHALL wake a session; every other message is history a session
may read when it chooses. The relay SHALL read the mentioned identities from the event's
mentions field, map each to the session id that identity most recently registered with,
and deliver the wake through the broker core's existing route — the same call a local send
makes, so Matrix adds one hop and no second delivery path. A room-wide mention SHALL wake
every registered identity that is a member of that room, excluding the sender. An event
naming several identities SHALL be processed once and SHALL produce one independent wake
per named identity, each with that identity's own window and cursor. A named `cc` user
that no identity has registered SHALL be ignored without failing the other wakes. A named
identity with no currently live session SHALL produce no wake and SHALL NOT advance that
identity's cursor, so the unread messages are still waiting at its next register.

The identity-to-session map SHALL be re-read at relay time and re-bound on every register,
never cached. A session id that a re-register has replaced is held by nobody: routing to
it queues the wake silently, reports success, and delivers nothing.

#### Scenario: A named identity is woken

- **WHEN** a human posts a message mentioning a registered identity whose session is live
- **THEN** exactly one wake is routed to that identity's current session id

#### Scenario: An unmentioned room member is not woken

- **WHEN** a human posts a message in a room with three registered members and mentions
  none of them
- **THEN** no wake is routed

#### Scenario: A room-wide mention wakes every registered member but the sender

- **WHEN** a human posts a room-wide mention in a room with three registered members
- **THEN** three wakes are routed, one per member, and none is routed to the sender

#### Scenario: Two named identities get one wake each

- **WHEN** one event mentions two registered identities with different unread histories
- **THEN** two wakes are routed and each carries its own unread count

#### Scenario: An unknown named user is ignored

- **WHEN** one event mentions a registered identity and a `cc` user nobody has registered
- **THEN** the registered identity is woken and the unknown name causes no failure

#### Scenario: A named identity with no live session is not woken

- **WHEN** a named identity has no live session
- **THEN** no wake is routed AND that identity's read cursor is unchanged

#### Scenario: A re-registered session is routed to its new id

- **WHEN** an identity registers under one session id, then re-registers under a
  different one, and is then mentioned
- **THEN** the wake is routed to the second session id and not to the first

### Requirement: The wake carries a capped unread window inline

A wake SHALL carry the woken identity's unread window for the waking room inline: every
relayable message in that room after that identity's read cursor, up to and including the
waking event, oldest first. Inlining removes a silent failure mode — a pull-only wake
lets the model answer without ever fetching the missing context, and nothing detects it.

The window SHALL be capped at the configured limits, defaulting to 20 messages and 2000
characters of rendered transcript, whichever binds first, keeping the newest. `unread`
SHALL be the number of messages delivered in the window and `omitted` the number the cap
dropped, so their sum is everything that was unread. The waking event SHALL always be the
last message in the window, even when it alone exceeds the character cap. `since` SHALL be
the identity's read cursor as it stood **before** this wake, never the advanced one, so a
follow-up history read from `since` returns the whole window including what the cap
dropped.

#### Scenario: An untruncated window carries every unread message

- **WHEN** an identity with three unread messages in a room — the third being a mention of
  it — is woken
- **THEN** the wake reports `unread` 3 and `omitted` 0 and the content renders all three

#### Scenario: The message cap keeps the newest

- **WHEN** an identity has 25 short unread messages ending in a mention and the message cap
  is 20
- **THEN** the wake reports `unread` 20 and `omitted` 5 and the oldest delivered message is
  the sixth

#### Scenario: The character cap truncates

- **WHEN** the unread messages render to more than the character cap
- **THEN** the delivered content is at most the character cap AND `omitted` is greater
  than zero

#### Scenario: Exactly at the message cap is not truncated

- **WHEN** an identity has exactly as many unread messages as the message cap
- **THEN** every one is delivered and `omitted` is 0

#### Scenario: A mention with no prior unread

- **WHEN** an identity whose cursor is current is mentioned
- **THEN** the wake reports `unread` 1 and `omitted` 0 and renders only the mention

#### Scenario: The waking event survives the cap

- **WHEN** the waking event alone renders longer than the character cap
- **THEN** it is still the last message in the content AND `omitted` counts every message
  the cap dropped

#### Scenario: since points at the pre-delivery cursor

- **WHEN** a truncated wake is delivered and the recipient then reads history for that room
  from the wake's `since`
- **THEN** the read returns the dropped messages as well as the delivered ones

#### Scenario: The window spans the room's threads

- **WHEN** an identity's unread messages in a room include one on the main timeline and one
  inside a thread, and it is then mentioned
- **THEN** `unread` counts both and the content renders both

### Requirement: Rendered transcript content for a relayed wake

The content of a relayed wake SHALL be a plain-text transcript, oldest first with the
waking event last, one line per message:

```text
[HH:MM] <sender>: <text>
```

`HH:MM` SHALL be 24-hour, zero-padded, derived from the message's own timestamp.
`<sender>` SHALL be the sender's display name when it has one, else the localpart of its
Matrix user id. A message belonging to a thread other than the wake's own SHALL be
rendered with its thread handle after the time — `[HH:MM] (t_9f2a) <sender>: <text>` — so
a mixed window is unambiguous. A multi-line message body SHALL be carried verbatim, with
only its first line prefixed. Lines SHALL be joined by a single newline, with no trailing
newline. The transcript SHALL NOT contain raw Matrix event ids: a thread is referred to by
its handle, which keeps the transcript readable and stable.

#### Scenario: Line shape

- **WHEN** a message sent at 14:02 by a sender whose display name is `samer` is rendered
- **THEN** the line is `[14:02] samer: <text>`

#### Scenario: Display name falls back to the localpart

- **WHEN** a sender has no display name set
- **THEN** the line uses the localpart of its Matrix user id as the sender

#### Scenario: A single-digit hour is zero padded

- **WHEN** a message sent at 09:05 is rendered
- **THEN** the line begins `[09:05] `

#### Scenario: Off-thread lines carry their thread handle

- **WHEN** a window contains a message from a thread other than the wake's own
- **THEN** that line carries the other thread's handle and the wake's own lines do not

#### Scenario: A multi-line body is verbatim

- **WHEN** a message body contains a newline
- **THEN** the rendered transcript keeps both lines and prefixes only the first

#### Scenario: No raw event ids in the transcript

- **WHEN** a window containing threaded messages is rendered
- **THEN** no rendered line contains a Matrix event id

### Requirement: Read cursor per identity and room

The bridge SHALL keep a read cursor per identity **and room**: the stream position of the
last message that identity has consumed there. A single cursor per identity cannot answer
"what did I miss in this room", which is exactly what a wake has to report.

The cursor SHALL advance when a wake is delivered to a live session and when a history
read returns messages for a room that identity is a member of. It SHALL NOT advance when
no wake was delivered, and SHALL NOT be created or advanced for a room the reader is not a
member of — reading another group's room is a lookup, not consumption. A cursor SHALL be
an opaque token: the bridge round-trips it and a caller SHALL NOT parse it. Advancing
SHALL be monotonic, so a replayed or out-of-order advance is a no-op rather than a
regression. Cursors SHALL be persisted atomically — written to a temporary file and then
renamed — so a reader never observes a partial write, and an unreadable store SHALL be
treated as absent rather than raising.

#### Scenario: A wake advances the cursor

- **WHEN** an identity is woken with three unread messages, and the only message to arrive
  in that room afterwards is a second mention of it
- **THEN** the second wake reports `unread` 1 — the three already delivered are behind the
  cursor, so the window holds the new mention and nothing else

#### Scenario: A history read advances the cursor for a member room

- **WHEN** an identity reads history for its own room covering every unread message and is
  then mentioned by a new message
- **THEN** the wake reports `unread` 1

#### Scenario: Reading a non-member room does not move any cursor

- **WHEN** an identity reads history for a `cc` room it is not a member of
- **THEN** its cursor for its own room is unchanged AND no cursor is recorded for the room
  it read

#### Scenario: Advancing is monotonic

- **WHEN** a cursor is advanced to a newer position and then an older position is applied
- **THEN** the stored cursor is still the newer position

#### Scenario: Advancing is idempotent

- **WHEN** the same advance is applied twice
- **THEN** the stored cursor equals the value one advance would have produced

#### Scenario: A partial write is never observed

- **WHEN** a cursor store is read while a write is in progress
- **THEN** the read yields either the previous complete value or the new complete value,
  never a partial one

#### Scenario: An unreadable cursor store is treated as absent

- **WHEN** the cursor store cannot be parsed and an identity is then mentioned
- **THEN** the wake is delivered, reports no unread backlog, and nothing raises

#### Scenario: The store already holds the advanced cursor while the wake reports the old one

- **WHEN** a wake is delivered
- **THEN** the wake's `since` is the pre-delivery cursor AND the persisted cursor is the
  post-delivery one

### Requirement: One catch-up wake on register after downtime

An identity that registers SHALL receive exactly one catch-up wake per room in which at
least one message mentioning it has arrived since its cursor. The catch-up wake SHALL be
built by the same capped-window rules as any other wake, and the bridge SHALL NOT replay
the missed messages as separate wakes. An identity that registers with unread messages but no mention
SHALL receive no wake — chatter is history, not a wake. An identity that registers with
nothing unread SHALL receive no wake. A second register immediately after a catch-up wake
SHALL NOT produce a second wake for the same messages, because the cursor has already
advanced past them.

#### Scenario: A mention received while offline produces one wake on register

- **WHEN** an identity is mentioned while it has no live session and it then registers
- **THEN** exactly one wake is routed to it

#### Scenario: Several missed mentions still produce one wake

- **WHEN** an identity is mentioned three times while offline and then registers
- **THEN** exactly one wake is routed AND its `unread` counts all the missed messages

#### Scenario: Unread chatter without a mention wakes nothing

- **WHEN** an identity registers with unread messages in its room but none mentioning it
- **THEN** no wake is routed

#### Scenario: Nothing unread wakes nothing

- **WHEN** an identity whose cursor is current registers
- **THEN** no wake is routed

#### Scenario: Re-registering does not repeat the catch-up

- **WHEN** an identity registers, receives its catch-up wake, and registers again with no
  new messages in between
- **THEN** no second wake is routed

#### Scenario: A catch-up window obeys the cap

- **WHEN** an identity missed more messages than the cap allows and registers
- **THEN** the wake reports a non-zero `omitted` AND its `since` is the cursor as it stood
  before the catch-up

### Requirement: read_history tool

The server SHALL expose `read_history({ room?, thread?, since?, limit?, search? })`
returning `{ ok: true, room, messages, more }`, where `messages` is oldest-first and each
entry carries `{ from, from_id, origin, text, at, thread? }`. `room` SHALL default to the
caller's epic room, or its lobby when the caller has no epic. **Any** room in the `cc`
namespace SHALL be readable, so a session working one group can look up how another solved
something; writing stays limited to rooms the session belongs to. `since` SHALL accept an
opaque cursor taken from a wake or a previous return. `limit` SHALL have a default and a
maximum, and `more` SHALL report whether the room holds further messages beyond the
returned page. `search` SHALL restrict the result to messages containing the given text. A
room that does not exist, or one outside the `cc` namespace, SHALL return
`{ ok: false, reason: 'not_found' }`. Reading history SHALL never wake another session.

#### Scenario: Defaults to the caller's epic room

- **WHEN** a session with an epic calls `read_history({})`
- **THEN** the result's `room` is its epic room

#### Scenario: Defaults to the lobby without an epic

- **WHEN** a session with no epic calls `read_history({})`
- **THEN** the result's `room` is its project lobby

#### Scenario: Reads a room the caller does not belong to

- **WHEN** a session reads a `cc` room it is not a member of
- **THEN** the result is `ok: true` with that room's messages

#### Scenario: since resumes from a truncated wake

- **WHEN** a session calls `read_history({ room, since })` with the `since` from a
  truncated wake
- **THEN** the result includes the messages the wake's cap dropped

#### Scenario: limit caps the page and reports more

- **WHEN** a room holds more messages than the requested `limit`
- **THEN** exactly `limit` messages are returned AND `more` is true

#### Scenario: A limit above the maximum is clamped

- **WHEN** a session requests a `limit` larger than the maximum
- **THEN** at most the maximum number of messages is returned

#### Scenario: search filters the result

- **WHEN** a session calls `read_history({ search: 'beacon' })`
- **THEN** every returned message contains `beacon` and messages that do not are absent

#### Scenario: An unknown room is not_found

- **WHEN** a session reads a room that does not exist or is outside the `cc` namespace
- **THEN** the result is `{ ok: false, reason: 'not_found' }`

#### Scenario: A history read is made as the bot

- **WHEN** a session reads history for any room
- **THEN** the request the relay makes carries the masquerade parameter naming the
  configured bot user

#### Scenario: Reading wakes nobody

- **WHEN** a session reads a room whose other members are live
- **THEN** no wake is routed to any of them

#### Scenario: A message entry matches its declared shape

- **WHEN** a history read returns a human-authored message
- **THEN** its entry has exactly the declared keys, `origin` is `human`, and `from_id` is
  that human's full Matrix user id

### Requirement: History and Matrix replies are structurally unavailable without the bridge

`read_history` SHALL return `{ ok: false, reason: 'unavailable' }` rather than throwing
whenever no bridge is present — on the flat-file transport, and on the socket transport
when the bridge is disabled or its configuration was rejected. A `send_message` addressed
to a Matrix user id SHALL fail the same way and SHALL write nothing. The homeserver being
unreachable is not a broker fault: local messaging keeps working unchanged, and no
unavailable path raises across the bridge boundary.

#### Scenario: read_history on the flat-file transport

- **WHEN** a session on the flat-file transport calls `read_history({})`
- **THEN** it returns `{ ok: false, reason: 'unavailable' }` and does not throw

#### Scenario: read_history with the bridge disabled

- **WHEN** a session on the socket transport calls `read_history({})` while the bridge is
  disabled
- **THEN** it returns `{ ok: false, reason: 'unavailable' }` and does not throw

#### Scenario: A Matrix-addressed send with no bridge writes nothing

- **WHEN** a session with no bridge calls `send_message({ to: '@someone:example', text })`
- **THEN** it returns `{ ok: false, reason: 'unavailable' }` AND no inbox is written

#### Scenario: Local messaging is unaffected

- **WHEN** the bridge is unavailable and a session sends to a live local peer
- **THEN** the peer receives the message exactly as it does with no bridge configured

### Requirement: A reply to a human posts into that person's most recent mention

A `send_message` whose `to` is a Matrix user id **outside** the `cc` namespace SHALL skip
local routing entirely — no local inbox is written and no session is woken — and SHALL
post the text into the room and thread of that person's most recent mention of the calling
session. That default is what keeps a session called into a discussion answering *in* that
discussion. When that person has never mentioned the caller, or the remembered room is one
the caller no longer belongs to, the post SHALL fall back to the caller's own room — its
epic room, else its lobby — on the main timeline. Writing is limited to rooms the session
belongs to. The result SHALL report the destination room and thread.

#### Scenario: The reply lands in the mention's room and thread

- **WHEN** a human mentions a session inside a thread and the session replies to that
  human's Matrix id
- **THEN** the reply is posted in that room and that thread

#### Scenario: No prior mention falls back to the caller's epic room

- **WHEN** a session with an epic replies to a human who has never mentioned it
- **THEN** the reply is posted on the main timeline of the session's epic room

#### Scenario: No prior mention and no epic falls back to the lobby

- **WHEN** a session with no epic replies to a human who has never mentioned it
- **THEN** the reply is posted on the main timeline of the session's project lobby

#### Scenario: The most recent mention wins

- **WHEN** a human mentioned the session in one room and later in another, and the session
  replies
- **THEN** the reply is posted in the later room

#### Scenario: A remembered room the caller has left falls back

- **WHEN** the most recent mention is in a room the calling session is no longer a member
  of
- **THEN** the reply is posted in the caller's own room instead

#### Scenario: Nothing is delivered locally

- **WHEN** a session replies to a human's Matrix id while local peers are live
- **THEN** no local inbox is written and no peer receives a channel event

#### Scenario: A cc-namespace target is still resolved locally

- **WHEN** a session sends to a target inside the `cc` namespace
- **THEN** it is resolved by the existing local to-address rules and is not treated as a
  Matrix reply

## MODIFIED Requirements

### Requirement: Identifier-safe channel meta mapping

The server SHALL map a message to channel meta using only identifier-safe keys
(letters/digits/underscore), because the channel contract silently drops any other key.
Every meta value SHALL be a string; a count is rendered as a decimal string.

Every message SHALL carry `from`, `from_id`, `origin`, `role` and `msg_id`, plus `epic`
when the sender has one. `origin` SHALL be `session` for a locally routed session-to-session
message and `human` for a message relayed from a sender outside the `cc` namespace — a
human mention usually outranks a peer's, and the model cannot tell them apart from the name
alone. `from_id` SHALL be a value the `to` argument of a reply accepts: the sender's short
session id for a session-origin message, and the sender's full Matrix user id for a
human-origin one. `role` SHALL be the sender's session role, and `none` for a sender that
has no session.

A relayed wake SHALL additionally carry `room` (where to read or reply), `unread` (how
many messages the window delivered), `omitted` (how many the cap dropped) and `since` (the
cursor to hand a history read), plus `thread` and `thread_title` when the message belongs
to a thread, and `mentions` — a comma-separated list of the *other* identities the same
event named, so several sessions called into one discussion do not all answer.

The message `text` MUST become the notification content. Inbound messages therefore arrive
as `<channel source="sessionbus" …attrs…>text</channel>`.

#### Scenario: Meta uses identifier-safe keys

- **WHEN** a worker message from `1234 epic:2345` is mapped to channel meta
- **THEN** meta is `{ from, from_id, origin, role, epic, msg_id }` with no hyphenated keys

#### Scenario: Epic omitted when the sender has none

- **WHEN** a `role: none` sender with no epic is mapped
- **THEN** meta omits `epic` and sets `role` to `none`

#### Scenario: A locally routed message is session origin

- **WHEN** a session-to-session message is mapped
- **THEN** `origin` is `session` and `from_id` is the sender's short session id

#### Scenario: A relayed human mention is human origin

- **WHEN** a mention from a sender outside the `cc` namespace is mapped
- **THEN** `origin` is `human`, `from_id` is that sender's full Matrix user id, and `role`
  is `none`

#### Scenario: A relayed wake carries the window keys

- **WHEN** a relayed wake is mapped
- **THEN** meta includes `room`, `unread`, `omitted` and `since`, each a string

#### Scenario: Thread keys are omitted for a top-level message

- **WHEN** a relayed wake whose waking message is on the main timeline is mapped
- **THEN** meta omits `thread` and `thread_title`

#### Scenario: mentions lists the other identities only

- **WHEN** one event mentions two identities and the wake for the first is mapped
- **THEN** `mentions` names the second identity and does not name the first

#### Scenario: mentions is omitted when nobody else was named

- **WHEN** an event mentions exactly one identity and its wake is mapped
- **THEN** meta omits `mentions`
