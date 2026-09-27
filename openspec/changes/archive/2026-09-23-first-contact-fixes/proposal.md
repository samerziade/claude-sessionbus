# Proposal: first-contact fixes

## Why

The bridge ran against a real homeserver for the first time and three things were wrong. Two are
defects the fakes could not have caught, and one is a naming decision the operator overruled once
they saw it in a client.

1. **A hung credential helper took the whole bus down.** The broker resolves the appservice token
   by running the configured `tokenCommand`. Under a supervisor there is no terminal, so a helper
   that wants interactive approval blocks forever — and because the token is resolved *before*
   `startBroker`, the socket was never bound. Sessions could not reach each other at all. That
   contradicts the rule the bridge is built around: a Matrix problem may disable the bridge and
   must never touch local delivery. Observed live; recovery needed killing the helper by hand.
2. **Nothing bounds how long the token command may take.** Even bound after the socket, an
   unbounded child process leaves the bridge permanently "about to start" with no diagnosis.
3. **A project is identified by its bare repository name.** Two repositories with the same name in
   different organizations share one space, and the space a person sees in a client is named
   `repo` with no owner. The alternative was recorded as an open question when the requirement
   was written and is now settled: identify a project by owner and repository.

## What Changes

- **Bind before resolving.** `startBroker` runs first; the bridge is constructed afterwards, so a
  slow or hung token command can never delay or prevent local delivery.
- **Bound the token command.** It gets a timeout. Exceeding it is an `invalid` configuration
  problem — the bridge stays off, the broker keeps serving, and `broker config` names the reason.
  The child process is killed rather than left running.
- **Identify a project by owner and repository.** The derivation keeps the owner: identifiers
  become `<owner>-<repo>` inside their segment, and a project space carries the human-readable
  name `<owner>/<repo>`. A directory with no usable remote still falls back to its own name, and
  a project that slugs to nothing is still no project.

## Impact

- **Identifiers change, and identifiers are permanent.** A project provisioned under the old
  scheme keeps its old space and rooms; the new scheme provisions new ones beside them. The one
  space created during first contact is empty and can be discarded. This is acceptable only
  because the bridge has never carried a real conversation.
- **Capabilities:** `session-grouping` (project derivation and the space's name),
  `broker-configuration` (the token command's timeout), `broker-lifecycle` (bind order).
- **Seams:** no interface changes. `resolveMatrixToken` gains an injected deadline, the entrypoint
  reorders two existing calls, and `projectFromRemote` returns more of what it already parses.
- **Breaking risk:** none to identity, beacons or the inbox subscription — the project is
  announced on registration and read by the bridge only. A session whose project changes name is
  provisioned afresh; its local delivery is untouched.
