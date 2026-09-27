# Tasks: first-contact fixes

## 1. Bind before the bridge

- [x] 1.1 In `broker/src/server.test.ts`, add a case proving a bridge that is never constructed
      cannot stop the broker serving: start the broker, never construct a bridge, register two
      sessions and deliver a message between them, asserting the socket was bound and no fatal
      was signalled.
- [x] 1.2 Reorder `runForeground` in `broker/src/index.ts`: `startBroker` first, then resolve the
      token and construct the bridge, then attach the bridge's hooks. Keep the late-bound
      `serverRef()` the relay already uses.
- [x] 1.3 Confirm by hand, with a `tokenCommand` of `["sleep", "600"]` in a temp `HOME`: the
      socket appears and `broker status` reports running while the command is still outstanding.
      Kill the broker afterwards; do not leave it running.

## 2. A deadline on the token command

- [x] 2.1 In `broker/src/config.test.ts`, write the four scenarios of "The token command is
      bounded by a deadline" against an injected runner and clock: a command that never settles
      yields `severity: 'invalid'`; the child is killed; the message names the command and not its
      output; a command that answers in time is untouched and its child is not killed.
- [x] 2.2 Give `resolveMatrixToken` a deadline and a killer through its injected dependencies,
      defaulting to ten seconds. No new configuration field.
- [x] 2.3 Wire the real runner in `broker/src/index.ts` so the deadline applies in production, and
      make sure the killed child cannot leave the broker holding a pipe.

## 3. A project keeps its owner

- [x] 3.1 In `broker/src/matrix-names.test.ts`, extend `projectFromRemote`'s cases to the
      scenarios in the delta: the three URL forms yield `owner-repo`, a remote with no owner
      yields the repository alone, and two same-named repositories under different owners differ.
- [x] 3.2 Change `projectFromRemote` to keep the owner, joined with `-`.
- [x] 3.3 In `bus/src/project.test.ts`, cover the fallbacks that must not change: a directory with
      no usable remote uses its own name, a name that slugs to nothing announces no project, and a
      configured override still wins.
- [x] 3.4 In `broker/src/matrix-provisioner.test.ts`, add the two space-name scenarios: a project
      derived from a remote creates its space with the display name `<owner>/<repo>`, and a
      project with no owner uses its slug.
- [x] 3.5 Carry the display name to `ensureSpace` and set it on creation. The alias is unchanged
      in shape; only what it is built from changes.

## 4. Verification

- [x] 4.1 `pnpm lint` from the repo root is clean.
- [x] 4.2 `pnpm test` passes in `bus` and in `broker`, with no pre-existing test deleted; record
      the counts before and after.
- [x] 4.3 Mutation-test the three behaviours this change adds — the bind ordering, the deadline,
      and the owner in the project — confirming each mutation actually applied before trusting
      that a test failed.
- [x] 4.4 Update `CLAUDE.md`: the test counts, the project-identity rule, and the open item that
      says the bridge has never run against a homeserver — it has now, and what first contact
      found belongs there.
