## Why

The socket broker runs under a launchd agent whose only restart trigger is process
exit: `KeepAlive` with `SuccessfulExit=false` respawns the broker **only when it exits
non-zero**. But the broker does not exit on an unrecoverable runtime failure — after the
listen socket is up, a server `error` event is caught and merely logged
(`server.ts` swaps the startup `reject` handler for a log-only one), and there are no
`uncaughtException` / `unhandledRejection` handlers. The result is a process that stays
alive but stops serving: launchd still sees `state = running`, so it never restarts it,
and every session's `send_message` silently queues under a broker that is dead to
clients. This is the "sometimes it crashes and doesn't restart" symptom — the daemon
becomes a zombie the supervisor cannot see. The broker log confirms the shape: many
clean "listening" lines and **zero stack traces**, i.e. when it goes down it goes quiet
rather than crashing.

## What Changes

- The supervised broker MUST **fail loud**: any unrecoverable runtime error exits the
  process non-zero so the supervisor (launchd `KeepAlive`) restarts it, instead of
  continuing in a non-serving state.
- A post-listen server `error` event stops being swallowed: the running server surfaces
  it to its owner (the process entry point) as a fatal condition, which cleans up the
  socket and exits non-zero.
- The process entry point installs `uncaughtException` and `unhandledRejection`
  backstops that log and exit non-zero.
- Clean shutdown stays clean (no behavior change): `SIGTERM` / `SIGINT` and the `stop`
  command still exit `0`, so `SuccessfulExit=false` correctly leaves the broker stopped
  rather than fighting a deliberate shutdown.
- **Out of scope, called out so the gap is known, not silently covered:** launchd's
  exit-driven `KeepAlive` cannot detect a *hung* (deadlocked, event-loop-stalled) broker
  that never exits — that needs a health probe / watchdog and is deferred. The pinned
  nvm node path in the plist (a node upgrade moves the binary and the agent cannot spawn
  at all) belongs to the install/`doctor` work (mission priority 2) and is deferred.

## Capabilities

### New Capabilities

- `broker-lifecycle`: the socket broker daemon's process-lifecycle contract under a
  supervisor — start/listen, clean vs. unclean exit, and the fail-loud rule that an
  unrecoverable runtime error MUST exit non-zero (so `KeepAlive` restarts it) while a
  deliberate shutdown MUST exit zero. No such capability exists today: `session-messaging`
  specifies the `Transport` interface and the flat-file mailbox, but nothing specifies the
  broker daemon's supervised behavior.

### Modified Capabilities

<!-- None. `session-messaging` describes message delivery and the Transport seam, not the
     broker process lifecycle; its requirements are unchanged. -->

## Impact

- **Architecture seam:** this does **not** go through the `Transport` interface or
  `HandlerDeps`. It touches the broker daemon's own process boundary — a lifecycle seam
  that is not yet specified. `startBroker`'s options interface (`StartBrokerOptions` in
  `broker/src/server.ts`) gains a fatal-error callback so the library surfaces the error
  instead of deciding to exit; the `process.exit` decision lives at the entry point
  (`broker/src/index.ts`). The interface change is worked in design.md.
- **Code:** `broker/src/server.ts` (post-listen error path), `broker/src/index.ts`
  (fatal handler + `uncaughtException`/`unhandledRejection` wiring). Paired tests:
  `broker/src/server.test.ts`, and coverage for the entry-point fatal path.
- **Identity / beacons / inbox subscription:** untouched — no breaking risk on that axis.
  A faster, correct restart is strictly safer for delivery than a silently dead broker.
- **Dependencies:** none added.
- **Ops:** no plist change required — the fix makes the *existing* `KeepAlive` policy
  effective by ensuring the broker actually exits when it fails.
