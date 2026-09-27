# session-grouping Specification

## Purpose
TBD - created by archiving change matrix-provisioning. Update Purpose after archive.
## Requirements
### Requirement: Deterministic identifiers for projects, groupings and work identities

The system SHALL derive every remote identifier from a project name and a work identity by a
pure, deterministic function — the same inputs SHALL always produce byte-identical output, and
no identifier SHALL depend on a session id, a process id, a clock or a random source, because a
session id is not stable across a resume and an identifier that moved would strand the history
attributed to it.

A **slug** SHALL be produced from free text by lowercasing it, removing one trailing `.git`,
replacing each run of characters outside `a-z0-9` with a single `-`, and trimming leading and
trailing `-`. A slug MAY be empty, and the caller SHALL decide what an empty slug means: an
empty **project** slug means the session has no project (see the derivation requirement), while
an empty **discriminator** slug uses the literal `unnamed`. Slugging SHALL NOT invent a name of
its own — a hash-named project would be unrecognizable to a human in a client, and "no project"
is already a supported state that needs no substitute.

Identifiers SHALL use only the characters `a-z`, `0-9`, `-` and `.`, all of which are valid in
both the user and the alias namespace, and SHALL be built as **dot-separated segments**: a
configured namespace prefix, the project, a fixed kind marker, and — where the kind has one —
a discriminator. `.` SHALL be the structural separator and SHALL NOT occur inside a segment,
since slugging collapses every character outside `a-z0-9` to `-`.

| Identifier | Shape |
|------------|-------|
| Project space alias | `#<prefix>.<project>` |
| Project lobby room alias | `#<prefix>.<project>.lobby` |
| Epic room alias | `#<prefix>.<project>.epic.<epic>` |
| PM user | `@<prefix>.<project>.pm.<epic>` |
| Worker user | `@<prefix>.<project>.w.<issue>` |
| Unstructured-title user | `@<prefix>.<project>.s.<title>` |
| Bridge's own user | `@<prefix>.bridge` |

`<epic>` and `<issue>` come from the session title as `session-discovery` already parses it;
`<issue>` and `<title>` are the slugged forms of the captured tokens. A discriminator that
slugs to nothing SHALL use the literal `unnamed`, so every session that has a project still has
exactly one identity in it.

#### Scenario: Slug rules

- **WHEN** `My Repo.git` is slugged
- **THEN** the result is `my-repo`

#### Scenario: Runs of separators collapse and edges are trimmed

- **WHEN** `  --Foo__/  Bar!!  ` is slugged
- **THEN** the result is `foo-bar` with no leading, trailing or doubled `-`

#### Scenario: PM, worker and unstructured identifiers

- **WHEN** identifiers are built for project `sessionbus` with prefix `cc` for a PM of epic
  `42`, a worker whose title captured the issue token `issue-123`, and a session titled
  `planning notes`
- **THEN** the users are `@cc.sessionbus.pm.42`, `@cc.sessionbus.w.issue-123` and
  `@cc.sessionbus.s.planning-notes` respectively

#### Scenario: Grouping aliases for a project

- **WHEN** aliases are built for project `sessionbus` with prefix `cc` and epic `42`
- **THEN** the space alias is `#cc.sessionbus`, the lobby alias is `#cc.sessionbus.lobby`, and
  the epic room alias is `#cc.sessionbus.epic.42`

#### Scenario: Blank title yields the unnamed identity

- **WHEN** a user identifier is built for a session whose title is empty or whitespace-only
- **THEN** the identifier ends with `.s.unnamed`

#### Scenario: A discriminator that slugs to nothing yields the unnamed identity

- **WHEN** a worker user identifier is built for a captured issue token of `---`
- **THEN** the identifier ends with `.w.unnamed` rather than an empty or invented segment

#### Scenario: Determinism

- **WHEN** the same project and identity are named twice, in either order, by two separately
  constructed namers
- **THEN** both calls return byte-identical identifiers

#### Scenario: Slugging a name that has no alphanumeric content yields nothing

- **WHEN** the project names `...` and `///` are slugged
- **THEN** both yield the empty string, and no substitute name is invented for either

### Requirement: Identifiers are unambiguous across every project and identity

Two different `(project, identity)` pairs SHALL NEVER produce the same identifier. The
guarantee SHALL rest on the structural separator being impossible inside a segment: slugging
collapses every character outside `a-z0-9` to `-`, so a segment can never contain `.`, and an
identifier therefore splits back into its segments unambiguously. No escaping SHALL be
required on writing or on reading, and free text — a project name, an issue token, a title —
SHALL be used verbatim in its own segment however many `-` it contains.

Because the number of segments is fixed per kind, no project name can impersonate another
project's space, lobby, epic room or member.

#### Scenario: A project named like another project's lobby does not collide

- **WHEN** the lobby alias for project `foo` and the space alias for project `foo-lobby` are
  both built with prefix `cc`
- **THEN** the two aliases differ, being `#cc.foo.lobby` and `#cc.foo-lobby` respectively

#### Scenario: A project named like another project's epic room does not collide

- **WHEN** the epic-room alias for project `x` epic `42` and the space alias for project
  `x-epic-42` are both built
- **THEN** the two aliases differ

#### Scenario: A project name cannot impersonate another project's worker

- **WHEN** the worker user for project `x` issue `w-1` and the worker user for project `x-w`
  issue `1` are both built
- **THEN** the two user identifiers differ, being `@cc.x.w.w-1` and `@cc.x-w.w.1` respectively

#### Scenario: A hyphenated project name is used verbatim

- **WHEN** identifiers are built for a project whose slug contains `-`
- **THEN** the project segment is that slug unchanged, with no escaping applied

#### Scenario: An identifier splits back into its segments

- **WHEN** any identifier built by the namer is split on `.`
- **THEN** the first segment is the configured prefix, the second is the project, and the
  segment count matches the kind that produced it

### Requirement: Identifiers stay inside the 255-byte limit without losing their discriminator

A fully qualified identifier — sigil, localpart, `:` and homeserver domain — SHALL be at most
255 bytes. When the untruncated identifier would exceed that budget, the system SHALL append a
further segment holding the first eight lowercase hexadecimal characters of a SHA-256 hash **of
the untruncated localpart**, and SHALL recover the remaining space by shortening the project
segment first, never leaving it ending in `-`. The kind marker SHALL always survive. Hashing
the untruncated localpart is what keeps two long inputs that share a prefix apart; truncating
without it would silently merge two distinct work identities into one user.

An identifier that fits its budget SHALL NOT carry a hash segment. Because the hash is an extra
segment, a truncated identifier SHALL NEVER equal an untruncated one of the same kind.

#### Scenario: An over-long project is truncated and hash-suffixed

- **WHEN** a worker user is built for issue `123` on a 400-character project name against a
  homeserver domain of ordinary length
- **THEN** the fully qualified user id is at most 255 bytes, still contains the `.w.123`
  discriminator, and ends with `.` followed by eight lowercase hexadecimal characters

#### Scenario: Truncation never merges two distinct inputs

- **WHEN** two 400-character project names that share their first 390 characters are each
  named for the same worker identity
- **THEN** the two resulting user ids differ

#### Scenario: Truncation never merges two distinct discriminators

- **WHEN** two workers whose issue tokens are 400 characters long and differ only in their
  final character are named on the same over-long project
- **THEN** the two resulting user ids differ

#### Scenario: Truncation is deterministic

- **WHEN** the same over-long project and identity are named twice
- **THEN** both results are byte-identical

#### Scenario: A short identifier carries no hash

- **WHEN** a worker user is built for issue `123` on project `sessionbus`
- **THEN** the identifier is exactly `@cc.sessionbus.w.123:<domain>` with no hash segment

#### Scenario: A longer homeserver domain shrinks the available budget

- **WHEN** the same long project name is named against a short domain and against a domain 100
  bytes longer
- **THEN** both fully qualified ids are at most 255 bytes

### Requirement: A project space and its lobby never share an alias

The project space and the project lobby SHALL have distinct aliases for every project, because
a space and a room are the same kind of object to the homeserver and an alias can be claimed
only once. The lobby SHALL NOT be the space itself: the space exists to nest rooms, and the
lobby exists to carry the conversation of sessions that have no epic.

#### Scenario: Space and lobby aliases differ for any project

- **WHEN** the space alias and the lobby alias are built for the same project
- **THEN** the two aliases are different strings

#### Scenario: Provisioning creates two distinct objects

- **WHEN** a project's space and lobby are both ensured
- **THEN** two different room identifiers are returned, one of them created as a space and the
  other as an ordinary room

### Requirement: A project is derived from the session's working directory

A session SHALL announce a project derived from its working directory: **the owner and repository
taken from the `origin` remote**, joined as `<owner>-<repo>`, when the directory is a repository
with such a remote, and otherwise the directory's own name. A repository name alone does not
identify a project: two repositories of the same name in different organizations would share one
space, and the name a person sees in a client would carry no owner. Parsing a remote URL SHALL be
a pure function of the URL string, so it is testable without a repository, and SHALL accept the
SSH shorthand, an `ssh://` URL and an `https://` URL, ignoring any trailing `/` and one trailing
`.git`. A remote carrying no owner segment SHALL yield the repository name alone.

The joining character SHALL be `-`, which carries no structural meaning: `.` separates an
identifier's segments, so a project remains exactly one segment however many dashes it contains,
and segment counts stay fixed per identifier kind.

When no project can be derived — no usable remote and a directory whose name slugs to nothing —
the session SHALL announce no project, and SHALL NOT substitute a placeholder or a name derived
from a hash. A session that announces no project is not provisioned at all, which is already a
supported state; a hash-named project would instead create a space and rooms that no human can
recognize in a client, and every session whose directory name happens to slug to nothing would
land in a different unrecognizable one.

#### Scenario: SSH shorthand remote

- **WHEN** the remote URL `git@host.example:owner/repo.git` is parsed
- **THEN** the project is `owner-repo`

#### Scenario: HTTPS remote with a trailing slash

- **WHEN** the remote URL `https://host.example/owner/repo/` is parsed
- **THEN** the project is `owner-repo`

#### Scenario: An ssh:// URL keeps its owner

- **WHEN** the remote URL `ssh://git@host.example/owner/repo.git` is parsed
- **THEN** the project is `owner-repo`

#### Scenario: A remote with no owner segment yields the repository alone

- **WHEN** the remote URL `https://host.example/repo.git` is parsed
- **THEN** the project is `repo`

#### Scenario: Two repositories of one name in different organizations are different projects

- **WHEN** the remotes `git@host.example:one/api.git` and `git@host.example:two/api.git` are parsed
- **THEN** the projects differ

#### Scenario: A directory with no usable remote falls back to its own name

- **WHEN** a session's directory has no `origin` remote and is named `scratch`
- **THEN** the project is `scratch`

#### Scenario: A project that slugs to nothing is announced as no project

- **WHEN** a session's directory has no usable remote and is named `...`
- **THEN** the session announces no project and no substitute is invented

### Requirement: Registration announces project and title and never waits on the remote

A session's register announcement SHALL carry its project and its current title as **optional**
fields. The broker SHALL bind the connection and acknowledge the registration before any remote
provisioning is started, and SHALL NOT let provisioning that is slow, failing or never settling
change local binding, acknowledgement or delivery. An announcement that omits the new fields
SHALL be handled exactly as it is today, so a session that has not been updated is never made
unreachable by this change.

#### Scenario: Registration with a project and title is acknowledged and provisioned

- **WHEN** a client registers with a matching protocol version, a project and a title
- **THEN** it receives the acknowledgement, the broker reports it as one connected client, and
  provisioning is invoked with that project and title

#### Scenario: Registration without the new fields still binds

- **WHEN** a client registers with a matching protocol version and neither a project nor a
  title
- **THEN** it receives the acknowledgement and is bound, and no provisioning is invoked

#### Scenario: Provisioning that never settles does not delay delivery

- **WHEN** a client registers while provisioning returns a promise that never settles, and a
  message is then routed to that client
- **THEN** the acknowledgement was already received and the message is delivered

#### Scenario: Failing provisioning leaves routing and the process untouched

- **WHEN** provisioning rejects for a registering client
- **THEN** the client stays bound, a message routed to it is still delivered, no unhandled
  rejection escapes, and no fatal exit is signalled

### Requirement: The identity-to-session mapping is rebuilt on every registration

The broker SHALL maintain a mapping from a work identity to the session id currently holding
it, and SHALL rebuild that mapping on **every** registration rather than accumulating entries.
A session registers more than once — a resumed launch corrects its session id moments after
start — so an entry left pointing at a discarded id would address a session nobody answers to,
which is exactly the silent-loss failure the beacon and subscription rules exist to prevent. A
disconnect SHALL remove the mapping it owns.

#### Scenario: A corrected session id replaces the previous mapping

- **WHEN** a connection registers a work identity under one session id and then re-registers
  the same identity under a different session id
- **THEN** looking up that identity yields the second session id, and the first session id is
  no longer mapped to it

#### Scenario: The later of two sessions holding one identity wins

- **WHEN** two connections register the same work identity in sequence
- **THEN** looking up that identity yields the session id of the later registration

#### Scenario: Disconnect clears the mapping

- **WHEN** a registered connection disconnects
- **THEN** looking up its work identity yields nothing

#### Scenario: An identity with no live session resolves to nothing

- **WHEN** a work identity that has never registered is looked up
- **THEN** the lookup yields nothing rather than an error

### Requirement: Remote calls return typed outcomes and never throw

Every remote call SHALL return a typed result and SHALL NOT throw across its boundary, because
the process that hosts it treats an unhandled rejection as a fatal error and a remote outage is
not a reason to end it. Failures SHALL be distinguishable, at minimum: an authentication or
authorization refusal, a rate-limit refusal carrying the server's retry delay, a server-side
failure, a transport failure, and a protocol-level error carrying the server's error code.

#### Scenario: A successful call returns its value

- **WHEN** a call succeeds and the server returns a body
- **THEN** the result is a success carrying the parsed value

#### Scenario: Authentication refusal is its own outcome

- **WHEN** the server answers a call with status 401 or 403
- **THEN** the result is a failure whose kind marks it as an authentication failure, distinct
  from every other failure kind

#### Scenario: Rate limiting carries the retry delay

- **WHEN** the server answers with status 429 and a body carrying a retry delay of 1500
  milliseconds
- **THEN** the result is a failure whose kind marks it as rate limited and which carries 1500

#### Scenario: Server failure is its own outcome

- **WHEN** the server answers with status 500
- **THEN** the result is a failure whose kind marks it as a server failure

#### Scenario: A transport failure does not throw

- **WHEN** the injected transport rejects
- **THEN** the call resolves to a failure whose kind marks it as a transport failure, and no
  exception escapes

#### Scenario: A protocol error carries the server's error code

- **WHEN** the server answers with status 400 and an error code of `M_USER_IN_USE`
- **THEN** the result is a failure carrying that error code

#### Scenario: A malformed success body is a failure, not a crash

- **WHEN** the server answers with status 200 and a body that is not valid JSON
- **THEN** the call resolves to a failure rather than throwing

### Requirement: Remote calls act as the identity they are made for and never leak the token

Every call made on behalf of a user in the namespace SHALL name that user as the actor on the
outgoing request. This covers the bridge's own user exactly as it covers a session's: the
bridge's user is an **ordinary user in the namespace**, not the credential's own sender
identity, so a call meant to act as it SHALL name it explicitly. A call that named no actor
would be attributed to the credential's sender identity, which is an idle account that takes
part in nothing — so an unattributed room creation, join or invite is a call made by the wrong
user, not a call made by the bridge.

The only call that SHALL NOT name an actor is registering a user, because the account it
creates does not exist yet and so cannot be acted as.

The access token SHALL appear in no returned value, no error, and no emitted log line, on any
path.

#### Scenario: A call on behalf of a session identity is attributed to it

- **WHEN** a room is joined on behalf of `@cc.sessionbus.w.123`
- **THEN** the outgoing request identifies that user as the actor

#### Scenario: A call on behalf of the bridge's own user is attributed to it

- **WHEN** a room is created, joined and an invitation sent on behalf of the bridge's user
- **THEN** each outgoing request identifies the bridge's user as the actor, and none is left
  unattributed

#### Scenario: Registering a user names no actor

- **WHEN** a user is registered
- **THEN** the outgoing request carries no actor override

#### Scenario: The token never appears in a failure

- **WHEN** a client built with a distinctive token receives a 401, a 429, a 500, a malformed
  body and a transport rejection in turn
- **THEN** no returned failure, when serialized, contains the token

#### Scenario: The token never appears in a log line

- **WHEN** the same failures occur with a log collector attached
- **THEN** no collected line contains the token

### Requirement: The bridge's own user exists before anything is provisioned

The bridge SHALL ensure its own user (`@<prefix>.bridge`) exists before any provisioning begins,
and SHALL NOT start any user, space, room or membership ensure until that has succeeded. Being
permitted to act as a user in the namespace does not make that account exist: the credential is
accepted for any name in the namespace while the homeserver holds no such account until one is
registered. Every room and space is created as the bridge's user, so on a fresh homeserver
nothing else can succeed until it does.

Ensuring the bridge's user SHALL be idempotent, with an "already in use" refusal counting as
success. A failure to ensure it is a failure of the **bridge**, not of the process: it SHALL NOT
end the broker or affect local delivery, SHALL NOT be remembered as a failure, and SHALL be
retried after a delay that grows between attempts up to a fixed cap — except an authentication
refusal, which no retry can fix and which SHALL stop the attempts and leave provisioning off.
Sessions that register while the ensure is outstanding SHALL wait for it rather than be
provisioned ahead of it or dropped.

The bridge SHALL NOT set, and SHALL NOT overwrite, the display name of its own user. That name
is the operator's to choose and it is chosen outside this system, for the same reason an adopted
room's settings are trusted as-is: a daemon that silently overwrites what a human chose is worse
than a name that looks inconsistent beside the title-derived session names. This is a rule about
the bridge's **own** user only — a session's user still carries its session title, unchanged.

#### Scenario: A fresh homeserver registers the bridge's user first

- **WHEN** the bridge starts against a homeserver where its user does not exist, and a session
  then registers with a project
- **THEN** the bridge's user is registered before the first room or space creation request is
  made

#### Scenario: An existing bridge user counts as success

- **WHEN** registering the bridge's user fails with `M_USER_IN_USE`
- **THEN** the ensure succeeds and provisioning proceeds

#### Scenario: Ensuring the bridge's user twice raises no error

- **WHEN** the bridge's user is ensured twice in sequence against a homeserver where it already
  exists after the first call
- **THEN** both calls succeed

#### Scenario: A transient failure blocks provisioning and is retried

- **WHEN** registering the bridge's user fails with a server error, and a session registers with
  a project before the homeserver recovers
- **THEN** no room, space or session-user request is made while it is failing, a later retry
  registers the bridge's user, and the waiting session is then provisioned

#### Scenario: Retry delays grow and never exceed the cap

- **WHEN** registering the bridge's user fails ten times in a row with a server error, with the
  clock injected and the jitter source fixed at its maximum
- **THEN** the successive retry delays are non-decreasing, the later ones are equal to the cap,
  and none exceeds it

#### Scenario: A rate-limit refusal waits at least as long as the server asked

- **WHEN** registering the bridge's user is refused with status 429 carrying a retry delay
  longer than the next scheduled backoff
- **THEN** the next attempt is made no sooner than the server's retry delay

#### Scenario: An authentication refusal is not retried

- **WHEN** registering the bridge's user is refused with status 401
- **THEN** no further registration attempt is made, no room, space or session-user request is
  made, and a session registering afterwards is bound and delivered to normally but not
  provisioned

#### Scenario: A failing bridge-user ensure is never fatal

- **WHEN** registering the bridge's user keeps failing while a session registers and a message
  is routed to it
- **THEN** the session is acknowledged, the message is delivered, and no fatal exit is signalled

#### Scenario: A session user is never ensured ahead of the bridge's user

- **WHEN** a session registers while the bridge-user ensure is still outstanding
- **THEN** the recorded request order has the bridge's user registration completing before any
  registration request for the session's user

#### Scenario: The bridge's display name is never set on registration

- **WHEN** the bridge's user is registered and did not previously exist
- **THEN** no request is made to set its display name

#### Scenario: An operator-chosen bridge display name is left alone

- **WHEN** the bridge's user already exists carrying a display name the operator chose, and the
  bridge is started and provisions a session
- **THEN** no request is made to set or read its display name, and the name is unchanged
  afterwards

#### Scenario: Session display names are unaffected

- **WHEN** a session user and the bridge's user are both ensured in the same run
- **THEN** the session's user has its display name set to the session title and the bridge's
  user has none set

### Requirement: Provisioning is idempotent and safe to repeat

Ensuring a user, a space, a room or a membership SHALL be idempotent: repeating it SHALL
produce the same result without creating a second object. A user that already exists SHALL be
treated as success, since that is the normal outcome of the second and every later session for
one work identity. An alias that is already claimed SHALL be resolved and the existing room
adopted, since two sessions racing to create a grouping is the expected case, not an error.

Adoption SHALL be the whole of what makes a repeated creation safe. A creation request SHALL
NOT carry a transaction id: creation has none in the protocol, so one would be a parameter the
server ignores, and a reader would take creation for retry-safe on the strength of it — an
appearance of idempotency is worse than none, because nothing then looks in the place where the
guarantee actually lives.

#### Scenario: Ensuring a user twice creates it once

- **WHEN** the same user is ensured twice in sequence
- **THEN** both calls succeed and exactly one create request was made

#### Scenario: An already-existing user is a success

- **WHEN** creating a user fails with `M_USER_IN_USE`
- **THEN** the ensure succeeds

#### Scenario: A claimed alias is adopted

- **WHEN** creating a room fails because its alias is already in use, and resolving that alias
  returns an existing room
- **THEN** the ensure succeeds and returns the existing room's identifier

#### Scenario: Ensuring a room twice returns the same room

- **WHEN** the same room is ensured twice in sequence
- **THEN** both calls return the same identifier and exactly one create request was made

#### Scenario: Ensuring an existing membership is a success

- **WHEN** a user that is already a member of a room is ensured into it
- **THEN** the ensure succeeds

#### Scenario: Creation carries no transaction id

- **WHEN** a room or a space is created
- **THEN** the request carries no transaction id, and a repeated creation is made safe by
  adopting the claimed alias instead

#### Scenario: Adoption failure is reported, not swallowed

- **WHEN** creating a room fails because its alias is in use and resolving that alias also
  fails
- **THEN** the ensure returns a failure rather than a room identifier

### Requirement: Concurrent ensures share one attempt and failures are not cached

Concurrent ensures of the same object SHALL share a single in-flight attempt, so two sessions
registering at once do not race the same creation. A **failed** attempt SHALL NOT be
remembered: a later ensure of the same object SHALL try again, because caching a transient
failure would leave a session permanently without its room for the life of the process.

#### Scenario: Two concurrent ensures make one request

- **WHEN** the same room is ensured twice without awaiting the first call
- **THEN** both calls resolve to the same identifier and exactly one create request was made

#### Scenario: A failed ensure is retried by the next caller

- **WHEN** an ensure fails because the server is unavailable, and the same object is ensured
  again after the server recovers
- **THEN** the second ensure succeeds

#### Scenario: Different objects do not share an attempt

- **WHEN** two different rooms are ensured concurrently
- **THEN** two create requests are made and each call returns its own identifier

### Requirement: Created rooms are private, readable by later joiners, and known to the operator

A room or space the system creates SHALL be unencrypted, invite-only, and configured so a
member who joins later can read what was said before they joined — an encrypted or
join-restricted history would make the durable record unreadable by the sessions it exists for.
The operator SHALL be invited to a room the system **creates**. A room that was adopted rather
than created SHALL NOT be re-invited, so an operator who left a room is not dragged back into
it on every restart, and its existing settings SHALL NOT be reconciled against what creation
would have asked for — the system may not hold the power to change them, and overriding a
setting the operator changed deliberately is worse than living with a drifted one.

#### Scenario: Creation settings

- **WHEN** a room is created
- **THEN** the creation request asks for an invite-only, unencrypted room whose history is
  readable by later joiners

#### Scenario: The operator is invited to a created room

- **WHEN** a room is created
- **THEN** the operator is invited to it

#### Scenario: An adopted room does not re-invite the operator

- **WHEN** a room is adopted because its alias was already claimed
- **THEN** the operator is not invited to it

#### Scenario: An adopted room's settings are not reconciled

- **WHEN** a room is adopted whose join rule, history visibility or topic differ from what
  creation would have asked for
- **THEN** the ensure succeeds and no request is made to change any of them

#### Scenario: A space is created as a space

- **WHEN** a project space is ensured and does not exist
- **THEN** the creation request marks it as a space rather than an ordinary room

### Requirement: The bridge's own user is a joined member of every room and space it provisions

Every room and space the system **creates or adopts** SHALL have the bridge's own user
(`@<prefix>.bridge`) as a joined member before the ensure reports success, and ensuring that
membership SHALL be idempotent. The bridge observes inbound traffic through a single stream as
its own user, and that stream carries only rooms that user has joined, so a room without the
bridge's user in it is a room whose every mention is silently never seen — while provisioning,
posting and the operator's own client all report success.

Adoption is where this matters most. An adopted room may predate the bridge or have been made by
hand, so bridge membership is the one thing an adopted room SHALL still be brought to. This does
not contradict trusting an adopted room as-is: its **settings** are not reconciled, but the
bridge's own **participation** is not a setting of the room, it is a precondition of the system
working at all.

A room whose bridge membership cannot be established SHALL fail the ensure rather than succeed
without it. Succeeding silently would reproduce exactly the failure shape this system has
already shipped once — a component reporting success while it cannot receive — and the ensure
is not memoized on failure, so a later ensure tries again.

#### Scenario: A created room has the bridge's user joined

- **WHEN** a room is ensured and does not exist
- **THEN** the ensure succeeds and the bridge's user is a joined member of the created room

#### Scenario: A created space has the bridge's user joined

- **WHEN** a project space is ensured and does not exist
- **THEN** the ensure succeeds and the bridge's user is a joined member of the created space

#### Scenario: An adopted room lacking the bridge's user gets it joined

- **WHEN** a room is adopted because its alias was already claimed, and the bridge's user is not
  among its joined members
- **THEN** a join is made as the bridge's user, and the ensure succeeds only after that join
  succeeds

#### Scenario: A room that already has the bridge's user issues no further join

- **WHEN** a room is adopted whose joined members already include the bridge's user
- **THEN** the ensure succeeds and no join request is made for the bridge's user

#### Scenario: Repeating the ensure does not repeat the join

- **WHEN** the same adopted room is ensured twice in sequence
- **THEN** at most one join request is made for the bridge's user across both calls

#### Scenario: A failed bridge join fails the ensure

- **WHEN** a room is adopted, the bridge's user is not a member, and joining it is refused
- **THEN** the ensure returns a failure rather than a room identifier

#### Scenario: A failed bridge join is retried by the next ensure

- **WHEN** an ensure has failed because the bridge's user could not join, and the same room is
  ensured again after the join would be accepted
- **THEN** a join is attempted again and the second ensure succeeds

#### Scenario: Bridge membership does not reconcile settings

- **WHEN** an adopted room's join rule, history visibility or topic differ from what creation
  would have asked for, and the bridge's user is joined to it
- **THEN** no request is made to change any of those settings

### Requirement: A failed space link degrades to an unlinked space

Ensuring a project space SHALL still succeed when nesting it under the root space fails, SHALL
report the space as unlinked, and SHALL NOT attempt a further nesting under that same parent
for the rest of the run — the privilege needed to nest a child is held by the operator, not by
this system, and rooms remain fully usable unlinked. Only their presentation in a client is
affected.

The suppression SHALL be keyed on the **parent**, not on the child. The power to nest belongs
to the parent space and does not vary by child, so one refusal settles it; keying it on the
pair would issue one doomed request per space per registration while appearing to suppress
anything at all.

#### Scenario: Link failure still yields a usable space

- **WHEN** a project space is ensured and linking it under the root space fails for lack of
  privilege
- **THEN** the ensure succeeds, returns the space identifier, and reports it as unlinked

#### Scenario: A refused parent is not attempted again

- **WHEN** two different project spaces are ensured against a root space that refuses to nest
  either of them
- **THEN** exactly one nesting request is made in total, and both spaces are returned unlinked

#### Scenario: A successful link is reported

- **WHEN** a project space is ensured and the link succeeds
- **THEN** the ensure reports the space as linked

### Requirement: A session's remote user carries its current title

Ensuring a user SHALL set that user's display name to the session's title, and SHALL set it
again when a later registration presents a different title for the same identity, so a renamed
session does not keep a stale label on its history. Re-ensuring with an unchanged title SHALL
NOT issue a further update.

#### Scenario: The display name is set on first ensure

- **WHEN** a user is ensured for a session titled `123 epic:42`
- **THEN** the display name is set to `123 epic:42`

#### Scenario: An unchanged title is not rewritten

- **WHEN** the same user is ensured twice with the same title
- **THEN** the display name is set exactly once

#### Scenario: A changed title updates the display name

- **WHEN** a user is ensured with one title and then ensured again with a different title
- **THEN** the display name is set a second time, to the new title

### Requirement: A session with no epic is grouped into its project lobby

A session whose title identifies an epic SHALL be provisioned into its project's epic room; a
session whose title identifies no epic SHALL be provisioned into its project's lobby under its
generic identity, so an unstructured session still takes part rather than being excluded. Every
session with a project SHALL be a member of that project's lobby.

#### Scenario: A worker is joined to its epic room and its lobby

- **WHEN** a session titled `123 epic:42` in project `sessionbus` is provisioned
- **THEN** its user is a member of both the epic room for epic `42` and the project lobby

#### Scenario: An unstructured session joins only the lobby

- **WHEN** a session titled `planning notes` in project `sessionbus` is provisioned
- **THEN** its user is a member of the project lobby and no epic room is ensured

#### Scenario: A session with no project is not provisioned

- **WHEN** a session registers without a project
- **THEN** no user, space or room is ensured for it

### Requirement: Durable grouping state is written atomically and read tolerantly

State that must survive a restart SHALL be written so that a reader never observes a partial
document — written to a temporary name and then renamed into place — and SHALL be read
tolerantly, treating an unreadable or malformed document exactly as an absent one. A value
SHALL be readable through the interface as soon as it is set, before it has been persisted, and
SHALL be durable once an explicit flush completes. Flush SHALL be explicit rather than only
time-based, because a deliberate shutdown between two debounced writes would otherwise lose
every value set since the last one.

#### Scenario: A value set is readable immediately

- **WHEN** a value is set and read back through the same instance before any flush
- **THEN** the value just set is returned

#### Scenario: A flushed value survives a new instance

- **WHEN** values are set, flushed, and a new instance is constructed over the same location
- **THEN** the new instance returns those values

#### Scenario: No partial document is left behind

- **WHEN** a set is followed by a flush
- **THEN** the persisted document parses successfully and no temporary artifact remains
  alongside it

#### Scenario: A malformed document reads as absent

- **WHEN** a new instance is constructed over a location holding a truncated or malformed
  document
- **THEN** every read returns nothing and no error is raised

#### Scenario: A malformed document is replaced by the next flush

- **WHEN** a value is set and flushed over a location that held a malformed document
- **THEN** the location afterwards holds a valid document containing that value

#### Scenario: An absent location reads as empty and can be written

- **WHEN** a new instance is constructed over a location that does not exist
- **THEN** every read returns nothing, and a set followed by a flush creates the document

#### Scenario: Flush is idempotent

- **WHEN** flush is called twice with no intervening change
- **THEN** both calls complete and the persisted document is unchanged

#### Scenario: Unknown lookups return nothing

- **WHEN** a cursor or a thread handle that was never recorded is looked up
- **THEN** the lookup returns nothing rather than raising

#### Scenario: The last write for a key wins

- **WHEN** the same key is set twice before a flush and the state is then flushed and re-read
- **THEN** the second value is returned

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

### Requirement: A project space carries a human-readable name

A project space SHALL be created with a display name of `<owner>/<repo>` when the project was
derived from a remote carrying both, and the project's own slug otherwise. An alias must satisfy
the identifier character rules; a display name has no such constraint and is what a client shows,
so the form a person recognizes belongs there.

#### Scenario: The space shows owner and repository

- **WHEN** a space is created for the project `owner-repo` derived from `git@host.example:owner/repo.git`
- **THEN** the creation request carries the display name `owner/repo`

#### Scenario: A project with no owner shows its slug

- **WHEN** a space is created for the project `scratch`, derived from a directory name
- **THEN** the creation request carries the display name `scratch`

