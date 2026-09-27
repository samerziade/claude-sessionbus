## ADDED Requirements

### Requirement: Pair threads are created on first direct-message mirror between two identities

The outbound mirror SHALL ensure a pair thread exists before posting the first direct message between two identities into a room: if no pair thread is known for that pair within that room, it SHALL create one (a root event announcing the pairing) and remember it; if one is already known, it SHALL reuse it. Every subsequent direct-message mirror between the same pair in that room SHALL post into that same pair thread. A worker-to-worker pair's thread is distinct from either worker's thread with its PM.

#### Scenario: First direct-message mirror creates and uses a pair thread

- **WHEN** the outbound mirror posts the first direct message between a worker and its PM, and no pair thread is known for them
- **THEN** a pair thread is created (a root event announcing the pairing) AND the message is posted into that thread

#### Scenario: A later direct-message mirror reuses the existing pair thread

- **WHEN** the outbound mirror posts a second direct message between the same pair after a pair thread already exists
- **THEN** no new pair thread is created AND the message is posted into the existing pair thread

#### Scenario: Worker-to-worker pairs get their own thread

- **WHEN** the outbound mirror posts the first direct message between two workers who each already have a pair thread with their own PM
- **THEN** a distinct pair thread is created for the worker-to-worker pair, separate from either worker's PM thread

### Requirement: send_message's thread argument selects the outbound mirror thread

`send_message`'s optional `thread` argument SHALL determine which Matrix thread the outbound
mirror posts a message into:

- Omitted: the mirror SHALL resolve the thread of the most recent message this session received
  from the resolved recipient; if no such prior thread is known, it SHALL fall back to the pair
  thread (creating one per the pair-thread requirement if none exists).
- A thread handle string: the mirror SHALL post into the thread that handle resolves to.
- `{ new: title }`: the mirror SHALL create a new thread with a root event titled `title` and post
  into it.

A bad handle SHALL never be reinterpreted as a different conversation. How far that can be
checked before the message is written depends on what the transport can answer synchronously,
so the guarantee is staged in three parts:

- **Shape, in every transport.** A handle that is not well formed SHALL fail the call with
  `{ ok: false, reason: 'invalid_thread' }` and write nothing. Deciding a handle's shape needs
  no lookup, so this holds wherever `send_message` runs.
- **Resolution, where the transport can answer synchronously.** Where thread state is reachable
  from `send_message` without a round trip, a well-formed handle that names no thread SHALL fail
  the call with `{ ok: false, reason: 'thread_not_found' }` and write nothing.
- **Resolution, where it cannot.** Where thread state is not reachable synchronously — the socket
  transport, until the inbound relay change adds a request/reply frame that makes the check
  available in every mode — the message SHALL be delivered locally as normal and its mirror SHALL
  be posted to the destination room's **main timeline**, never to any other thread, and the
  unresolved handle SHALL be logged. The message was already delivered, so dropping its mirror
  would leave a hole in the record that nobody can see or recover; the main timeline is not a
  wrong conversation, it is the neutral one.

#### Scenario: Omitted thread resolves to the most recently received thread from that recipient

- **WHEN** `send_message({ to: 'pm', text: '…' })` is called with no `thread` argument, and this session most recently received a message from that PM in thread `t_9f2a`
- **THEN** the outbound mirror posts into `t_9f2a`

#### Scenario: Omitted thread falls back to the pair thread with no prior inbound thread

- **WHEN** `send_message({ to: 'w-123', text: '…' })` is called with no `thread` argument, and this session has never received a message from `w-123` in any thread
- **THEN** the outbound mirror posts into the pair thread for this session and `w-123`

#### Scenario: An explicit thread handle posts into the thread it resolves to

- **WHEN** `send_message({ to: 'pm', text: '…', thread: 't_9f2a' })` is called and `t_9f2a` resolves to a known thread
- **THEN** the outbound mirror posts into that thread

#### Scenario: A new titled thread argument creates and posts into a new thread

- **WHEN** `send_message({ to: 'epic', text: '…', thread: { new: 'rollout plan' } })` is called
- **THEN** a new thread with a root event titled "rollout plan" is created AND the message is posted into it

#### Scenario: A malformed thread handle fails without writing, in any transport

- **WHEN** `send_message({ to: 'pm', text: '…', thread: 'not a handle' })` is called
- **THEN** the tool returns `{ ok: false, reason: 'invalid_thread' }` AND no message is written to the PM's inbox

#### Scenario: An unresolvable thread handle fails without writing where thread state is reachable

- **WHEN** `send_message({ to: 'pm', text: '…', thread: 't_doesnotexist' })` is called, the handle is well formed, thread state is reachable synchronously, and the handle does not resolve to a known thread
- **THEN** the tool returns `{ ok: false, reason: 'thread_not_found' }` AND no message is written to the PM's inbox

#### Scenario: An unresolvable handle mirrors to the main timeline where thread state is not reachable

- **WHEN** `send_message({ to: 'pm', text: '…', thread: 't_doesnotexist' })` is called over a transport that cannot resolve a handle synchronously
- **THEN** the PM receives the message as normal AND the outbound mirror posts it to the destination room's main timeline, in no thread at all, AND the unresolved handle is logged

### Requirement: Thread handles are stable and resolvable

A thread handle SHALL resolve to exactly one Matrix thread root, and the same handle SHALL resolve
to the same thread across separate resolutions, including after a broker restart, since thread
mappings persist in bridge state. A newly created thread's handle SHALL be returned so a later
`send_message` call can target it explicitly. The handle allocation strategy itself is an
implementation detail of bridge state and is not constrained by this requirement.

#### Scenario: Resolving the same handle twice returns the same thread

- **WHEN** a thread handle is resolved twice, with a broker restart between the two resolutions
- **THEN** both resolutions identify the same thread

#### Scenario: A newly created thread's handle is usable immediately

- **WHEN** a new thread is created (via pair-thread creation or a `{ new: title }` argument) and its handle is captured
- **THEN** a subsequent `send_message` call using that handle as `thread` posts into that same thread
