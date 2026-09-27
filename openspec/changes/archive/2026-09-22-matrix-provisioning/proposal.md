## Why

A session's conversation today has nowhere to live: the broker holds conns and queues in
memory, a delivered message is gone, and `epic:N` is a routing convention with no place
behind it. There is also no seat for a human — the only participants are MCP servers on one
Mac. A private homeserver closes all three gaps at once (durable history, an operator seat, a
real grouping surface), but none of that is reachable until every session reliably *has* a
user, a project space, a lobby, and — when it has an epic — an epic room.

This change lands that foundation and nothing else: deterministic naming, an HTTP client
that fails in typed, non-throwing ways, an idempotent provisioner, a durable state seam, and
the two register-frame fields (`project`, `title`) the provisioner needs. Mirroring traffic
and relaying mentions are separate, later changes that build on exactly these pieces.

## What Changes

- **New `broker/src/matrix-names.ts` (pure).** Project + identity → a user localpart, a room
  alias and a space alias, from one slug rule (lowercase, `.git` stripped, runs of
  non-alphanumerics collapsed to a single `-`, edges trimmed) assembled into **dot-separated
  segments** — `@cc.<project>.w.<issue>`, `#cc.<project>.epic.<n>`. `.` is the structural
  separator and cannot occur inside a slug, so segments never blur into one another and no
  escaping is needed on either side. Identifiers stay inside the 255-byte Matrix-ID budget:
  when the naive identifier would overflow, the **project segment** is shortened and a short
  hash of the untruncated localpart is appended as a further segment, so the discriminator
  (`.pm.42`, `.w.123`) always survives and two long project names can never collapse onto one
  identifier.
- **A project space and its lobby get distinct aliases.** A space and a room are both rooms to
  the homeserver and an alias is claimed exactly once, so the lobby is `<project>.lobby`
  rather than sharing the space's alias.
- **New `broker/src/matrix-client.ts` (I/O, injected `fetch`).** Register a user, create a room
  or space, resolve an alias, join, invite, set a display name and link a space child — each
  acting *as* a named user in the namespace, the bridge's own user included. The credential's
  sender identity is a separate idle account that nothing ever acts as, so naming the actor is
  required on every call but registration. Every call returns a typed result and never throws across its
  boundary; authentication, rate-limit, server, transport and protocol failures are distinct
  outcomes; no returned value or log line ever contains the access token.
- **New `broker/src/matrix-provisioner.ts`.** Idempotent `ensureUser` / `ensureSpace` /
  `ensureRoom` / `ensureMember`, memoized so concurrent callers share one attempt, adopting an
  alias that already exists, treating "user already in use" as success, and degrading to an
  unlinked space when the bridge lacks power to nest it, without re-attempting a parent that has
  already refused. Rooms it creates are invite-only,
  unencrypted, readable by later joiners, and the operator is invited. **Every room and space it
  creates or adopts has the bridge's own user joined before the ensure succeeds** — rooms are
  created as that user, and an adopted room that lacks it gets it joined. The relay observes
  inbound traffic through one stream held as that user, which carries only rooms it has joined,
  so a room without it is a room whose mentions are silently never seen; a join that cannot be
  made therefore fails the ensure rather than being swallowed.
- **The bridge registers its own user before provisioning anything.** Being permitted to act as
  a name in the namespace does not create that account — and `whoami` cannot tell you, since it
  answers for the credential's sender identity, which is not the bridge's user. Every room is
  created as the bridge's user, so on a fresh homeserver nothing could be created at all. The
  bridge ensures its own user once at start (idempotent, "already in use" counts as success),
  and all provisioning waits on that. A failure is retried with capped backoff and never ends
  the broker; an authentication refusal stops the retries and leaves provisioning off. Every
  user — the bridge's and each session's — is registered without logging in, so no unused
  devices or access tokens are ever minted. **The bridge never sets its own user's display
  name:** that account is the operator's, named by them, and overwriting a human's choice is
  the same mistake as reconciling an adopted room's settings.
- **New `broker/src/bridge-state.ts` behind a `BridgeState` interface.** A single JSON
  document written atomically (`.tmp` + `renameSync`) and read tolerantly (a corrupt document
  behaves as absent), holding the sync token, a read cursor per identity and thread-handle
  mappings. The interface gains an explicit `flush()` so debounced writes are durable across a
  deliberate shutdown.
- **`RegisterFrame` gains optional `project` and `title`.** `bus` derives the project from the
  session's working directory — the `origin` remote's repository name, falling back to the
  directory's own name — and sends the current session title. When neither yields a usable name
  the field is **omitted** rather than filled with a generated one, and such a session is simply
  not provisioned: a hash-named project would be unrecognizable in a client, and "no project" is
  already a supported state. **Not breaking:** both fields are optional; a register frame
  without them binds the conn exactly as today.
- **The broker keeps an identity → current session id map**, rebuilt on every register so the
  session id a `--resume` launch discards never stays mapped. Consuming it for inbound routing
  is out of scope here.
- **Provisioning never gates local delivery.** The conn is bound and `welcome` sent before any
  Matrix work starts; provisioning runs in the background and a homeserver failure changes
  nothing about local messaging.

Out of scope, deliberately, and owned by sibling changes: the configuration layer itself (a
resolved config object is an input here), the outbound mirror, the inbound relay,
`read_history`, and threading.

## Capabilities

### New Capabilities

- `session-grouping`: how sessions are grouped into durable, addressable conversation
  surfaces — the deterministic mapping from a project and a work identity to a remote user,
  room and space identifier; how a project is derived from a session's working directory; what
  a session's register announcement carries and what it may never delay; idempotent
  provisioning of those users, rooms and spaces; and the durable bookkeeping that grouping
  rests on. No existing capability covers any of this: `session-discovery` is about *which
  local sessions are reachable right now*, and `session-messaging` is about *delivering one
  message*. Neither says anything about a persistent place a conversation lives.

### Modified Capabilities

- `broker-configuration`: the `matrix` block gains a required `domain` — the homeserver's
  server name. Naming needs it and nothing else can supply it: the 255-byte identifier budget
  is computed against the fully qualified id, so the domain is an input to every identifier
  this change mints. It is added here rather than guessed, because both available guesses are
  silently wrong in ordinary deployments — a homeserver's server name is not reliably its URL
  host, and taking it from `matrix.owner` assumes the operator lives on the homeserver the
  bridge talks to. A wrong domain does not fail; it mints a different user and room for
  everything, and an identifier is forever.

<!-- `session-discovery`'s identity parsing is consumed unchanged — this change reads
     `role`/`epic`/`issue` and adds a project dimension beside them, without altering how a
     title is parsed or how a peer is found. `session-messaging`'s delivery contract is
     untouched: nothing here sits on the delivery path. `broker-lifecycle` is unchanged
     because no requirement added here may exit the process. -->

## Impact

- **Architecture seam.** This change goes through **neither** the `Transport` interface in
  `mailbox.ts` **nor** the `HandlerDeps` in `handlers.ts`. It needs two seams of its own, both
  new:
  1. **`BridgeState`** — the same shape of seam as `Transport`: an interface with a
     single-file implementation today, named so a later move to another store is a decision
     rather than a drift.
  2. **The injected `fetch` in `matrix-client.ts`** — the only place that talks to the network,
     so every layer above it is testable without a homeserver.

  It also **extends an existing wire contract**: `RegisterFrame` in `broker/src/protocol.ts`.
  The extension is purely additive (two optional fields) and the protocol version does not
  change, because an old sender and a new receiver still interoperate.
- **Breaking risk — identity, beacons and inbox subscription.** The register path is the one
  place where this change touches identity, and identity there is *unsettled by design*: a
  `--resume` launch mints a throwaway session id, exports it, then swaps in the real one, so
  `register` fires again with a corrected id. Three rules follow and are specified rather than
  assumed:
  - A register frame that omits `project`/`title` MUST bind exactly as it does today, so a
    `bus` that has not been updated is never silently unreachable.
  - Re-registration MUST keep working, and the identity → session-id map MUST be rebuilt, not
    appended to — a stale entry pointing at a discarded id is the broker-side twin of the
    beacon/subscription split that has already shipped a silent-message-loss bug once.
  - Provisioning MUST NOT gate `welcome` or conn binding. A slow or failing homeserver that
    delayed binding would turn a remote outage into local message loss.

  Presence beacons themselves are untouched; `bus` publishes them exactly as it does now.
- **Code.** New: `broker/src/matrix-names.ts`, `matrix-client.ts`, `matrix-provisioner.ts`,
  `bridge-state.ts`, each with a paired `*.test.ts`. Modified: `broker/src/protocol.ts`
  (optional register fields), `broker/src/broker.ts` and `broker/src/server.ts` (carry the new
  fields into the register path and the identity map), `bus/src/index.ts` (derive and send the
  project and title). A pure remote-URL parser lives in `matrix-names.ts` so the only I/O in
  the derivation is reading the remote.
- **Dependencies.** None added. The client uses the runtime's own `fetch`, injected; hashing
  uses `node:crypto`.
- **Configuration.** This change *consumes* a resolved configuration object (homeserver URL,
  access token, namespace prefix, root space, operator, project overrides). Producing that
  object is a sibling change and a hard prerequisite — building on `process.env` reads and
  retrofitting later would mean touching these same modules twice. It *adds* exactly one leaf
  to that object, `matrix.domain`, because naming cannot be written without it and no other
  configured field implies it. File-only like the rest of the `matrix` block; the environment
  layer stays the two variables it already recognizes.
- **Deployment.** Requires a homeserver-side appservice registration claiming the configured
  prefix **followed by the separator** as exclusive user and alias namespaces (`@cc\..*` and
  `#cc\..*` for the default prefix), a dedicated idle sender localpart that nothing ever acts as
  (`cc.sender` — it cannot be the bridge's user, because the homeserver refuses a sync stream
  for an appservice's sender identity and the relay holds exactly one such stream as the
  bridge's user), no inbound URL, and rate limiting disabled; and the bridge's own user — an
  ordinary account in the namespace — holding power level 50 or higher in the root space. Without the power level the spaces are created but not nested, which this
  change treats as a supported degraded state rather than a failure.
- **Ops.** No supervisor or plist change. Nothing specified here may exit the broker: a
  homeserver outage is not a broken broker.
