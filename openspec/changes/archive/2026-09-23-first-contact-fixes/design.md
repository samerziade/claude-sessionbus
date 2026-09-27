# Design: first-contact fixes

## Context

First contact with a real homeserver produced one outage and one surprise. The outage was ours:
`op read` waited for a fingerprint that a launchd agent can never supply, and because the token is
resolved on the way to `startBroker`, the socket was never bound. Five sessions lost each other
over a credential helper. The surprise was cosmetic and permanent: a space named after the bare
repository, with no owner anywhere in it.

## Decisions

### D1 — the broker binds before the bridge is built

`runForeground` resolves configuration, binds the socket, and *then* constructs the bridge. Today
the bridge is constructed first because the relay needs to read the server back, which is already
solved by a late-bound `serverRef()` — so the ordering was incidental, not required.

**Why it is the right shape:** the existing rules already say provisioning may not gate binding
(`session-grouping`) and a Matrix failure may not exit the broker (`broker-lifecycle`). Resolving
a credential in front of `listen()` broke both in a way no unit test could see, because every test
injects a token that returns instantly.

**Alternatives considered.** *Resolve the token in a worker or with a watchdog that kills the
broker* — a watchdog turns a bridge problem into a process death, the opposite of the contract.
*Require a non-interactive helper by documentation* — documentation does not bind a socket.

### D2 — the token command carries a deadline

`resolveMatrixToken` takes a timeout and a killer for the child. On expiry the child is killed and
the result is an `invalid` problem naming the command that timed out — never the command's output,
which may carry the secret it printed before hanging.

The default is **ten seconds**: long enough for a network-backed secret manager, short enough that
an operator watching a login does not conclude the machine is broken. It is not configurable;
another knob whose only correct value is "shorter than a human's patience" is not worth the
surface area.

### D3 — a project is `<owner>-<repo>`, displayed as `<owner>/<repo>`

`projectFromRemote` keeps the owner segment it already parses and joins it with `-`. The separator
inside a project segment is free: `.` is the structural separator between segments, so a dash
carries no meaning and cannot create a boundary.

A space additionally carries a **display name** of `<owner>/<repo>` — the form a person recognizes
— while its alias stays the slug. The alias must survive the character rules; the name does not,
and a client shows the name.

**Alternatives considered.** *`<owner>.<repo>` in the alias* — this would give a project two
segments where every other identifier kind has one, breaking the property that segment counts are
fixed per kind, which is what makes truncated and untruncated identifiers disjoint. *Keep the bare
repo and rely on the `projects` override* — the override exists for a repository whose directory
name makes a poor alias, not to work around a scheme that loses information the remote already
carries.

**What this does not change:** a directory with no usable remote still falls back to its own name,
which has no owner to keep, and a name that slugs to nothing is still no project.

## Testing strategy

- **Pure and already covered:** `projectFromRemote` and `slug` stay pure; the owner change is new
  cases in `matrix-names.test.ts` and `project.test.ts`, including a remote with no owner segment.
- **Faked:** `resolveMatrixToken`'s timeout is tested with an injected clock and a fake runner that
  never settles, asserting the problem's severity and that the child was killed. No real process is
  spawned for the timeout case.
- **The ordering is tested where it is observable:** `server.test.ts` already proves a slow
  `onRegistered` cannot delay binding; the new case proves a bridge that is never constructed at
  all — because the token never resolves — still leaves a bound socket and delivering sessions.
- `broker/src/index.ts` remains glue with no unit test; what it must guarantee is expressed through
  `startBroker` and `resolveMatrixToken`, which are both injectable.
