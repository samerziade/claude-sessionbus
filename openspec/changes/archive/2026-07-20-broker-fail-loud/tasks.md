## 1. Fatal guard (`broker/src/fatal.ts`)

- [x] 1.1 Write `broker/src/fatal.test.ts` first: `createFatalGuard({ log, exit })` returns a `fatal(err)` that calls `exit(1)` once, exits exactly once under repeated calls (idempotency), and forwards the error to `log`. Fake `exit` and `log` — never call real `process.exit`.
- [x] 1.2 Implement `broker/src/fatal.ts`: `createFatalGuard` factory returning the idempotent `fatal` closure (module-state-free, per the factory rule). Export the factory; no module-level `let`.
- [x] 1.3 Run `broker` tests and confirm 1.1 passes.

## 2. Post-listen listener error fails loud (`broker/src/server.ts`)

- [x] 2.1 Extend `broker/src/server.test.ts` first: `handleServerError(err, { log, onFatal })` logs and invokes `onFatal` exactly once with the error; with no `onFatal` it only logs (default embeddable behavior).
- [x] 2.2 Extend `broker/src/server.test.ts` (negative): a single connected client's socket `error` drops only that connection, does NOT call `onFatal`, and the broker keeps serving a newly connecting client. Assert connected count reflects the drop.
- [x] 2.3 Extend `broker/src/server.test.ts` (edge): reclaiming a stale socket starts successfully and starting over a live broker still rejects — assert `onFatal` is not called on either path.
- [x] 2.4 Implement in `server.ts`: add `onFatal?: (err: Error) => void` to `StartBrokerOptions`; replace the log-only post-listen closure with `server.on('error', (err) => handleServerError(err, { log, onFatal }))`; add the named `handleServerError`.
- [x] 2.5 Run `broker` tests and confirm 2.1–2.3 pass.

## 3. Process backstops at the entry point (`broker/src/index.ts`)

- [x] 3.1 Write a test first for the backstop wiring: a factored `wireFatalHandlers`-style function, driven with a fake emitter, routes `uncaughtException` and `unhandledRejection` (Error and non-Error reason) to the guard. Keep the `index.ts` glue thin.
- [x] 3.2 Implement in `index.ts`: build `guard = createFatalGuard({ log, exit: process.exit })`, register it on `uncaughtException` / `unhandledRejection`, and pass `onFatal: guard` to `startBroker`.
- [x] 3.3 Confirm the existing `SIGINT` / `SIGTERM` shutdown path is untouched — it still removes the pid file, closes the server, and exits `0` (deliberate shutdown stays a zero exit).
- [x] 3.4 Run `broker` tests and confirm 3.1 passes.

## 4. Verification

- [x] 4.1 Smoke-test the fail-loud path end-to-end without launchd: start the broker in `--foreground`, force an unrecoverable error, and confirm the process exits non-zero (use the teardown gotcha in CLAUDE.md — send signals to the real node pid; a clean `SIGTERM` must still exit `0`). Verified: forced uncaught error → exit 1 via the guard; self-signalled `SIGTERM` → exit 0 with socket + pid cleaned up. (External `kill -TERM` to a backgrounded pid is force-terminated by this sandbox — 143 — so the clean path is exercised via an in-process self-signal.)
- [x] 4.2 Run `pnpm lint` (biome + `tsc --noEmit` per package) — the CI gate — and confirm it is clean.
- [x] 4.3 Run both package suites (`pnpm test` in `bus` and in `broker`) and confirm all pass — 79 bus, 30 broker.
- [x] 4.4 Update CLAUDE.md: record the new `broker/src/fatal.ts` module in the layout/module table and note the fail-loud lifecycle in the broker section; move the "crashes and doesn't restart" concern out of open items if it was listed.
