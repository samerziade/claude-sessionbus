## 1. `resolveConfig` (`broker/src/config.ts`)

- [x] 1.1 Write `broker/src/config.test.ts` first, precedence group: defaults apply with
      `file: undefined, env: {}`; a file value overrides a default; an env value overrides
      both file and default; two calls with identical arguments return identical results
      while ambient `process.env` is mutated between them (purity/blind-spot case).
- [x] 1.2 Extend `config.test.ts`, problems-as-data group: `resolveConfig` never throws on a
      non-object `file`; a non-object `file` falls back to all-defaults with one `warning`;
      a missing file produces no problem; multiple independent problems (an unknown key plus
      a malformed `matrix` block) are all reported, not just the first.
- [x] 1.3 Extend `config.test.ts`, core-fatal group: `channelsHome: ''` and `channelsHome: 42`
      each produce a `severity: 'fatal'` problem with `path: 'channelsHome'`, and the
      resolved `config.channelsHome` still falls back to a usable default; an unrecognized
      `transport` value produces a `severity: 'warning'` problem and falls back to `'file'`.
- [x] 1.4 Extend `config.test.ts`, matrix-invalid group: an enabled-but-incomplete `matrix`
      block produces a `severity: 'invalid'` problem and forces `config.matrix.enabled` to
      `false`; a malformed-but-disabled `matrix` block produces no problem; a well-formed
      enabled `matrix` block resolves cleanly with `enabled: true` and no `matrix.*` problems.
- [x] 1.5 Extend `config.test.ts`, unknown-keys group: an unknown top-level key warns and is
      dropped while the rest of the file still resolves; an unknown key inside `matrix` warns
      without disabling an otherwise well-formed, enabled bridge.
- [x] 1.6 Implement `broker/src/config.ts`: the `ConfigSource`, `ConfigProblem`,
      `MatrixConfig`, `Config`, `ResolvedConfig`, `ResolveConfigInput` types and the
      `resolveConfig` function, per design.md's interface and severity-model decisions. No
      `fs`, `child_process`, or `process.env` reads inside this file.
- [x] 1.7 Run `broker` tests and confirm 1.1–1.5 pass.

## 2. `formatConfigReport` (`broker/src/config.ts`)

- [x] 2.1 Extend `config.test.ts` first: given a `ResolvedConfig` fixture, the report names
      each field's source (`'default'` / `'file'` / `'env'`); a `fatal`-severity problem still
      produces a full report (source lines plus the problem's `path` and `message`); a
      fixture with a `tokenCommand` array prints the command but no resolved secret value
      (the function is never given one, so this is really "the fixture proves the type
      cannot carry a token," not a redaction rule to test in isolation).
- [x] 2.2 Implement `formatConfigReport(resolved: ResolvedConfig): string` in `config.ts`.
- [x] 2.3 Run `broker` tests and confirm 2.1 passes.

## 3. `resolveMatrixToken` (`broker/src/config.ts`)

- [x] 3.1 Write the token-resolution cases in `config.test.ts` first: `deps.run`'s trimmed
      output becomes the token; `SESSIONBUS_MATRIX_AS_TOKEN` set in `deps.env` short-circuits
      and `deps.run` is asserted never called (`vi.fn` call-count); a throwing `deps.run`
      is caught and returned as `{ ok: false, problem }` with `severity: 'invalid'`, never a
      thrown exception out of `resolveMatrixToken`; the returned `problem.message` does not
      contain a fixture string standing in for a partial token value.
- [x] 3.2 Implement `resolveMatrixToken(matrix, deps)` in `config.ts`, per design.md's
      `TokenResolutionDeps` / `TokenResolution` shapes.
- [x] 3.3 Run `broker` tests and confirm 3.1 passes.

## 4. Broker entrypoint wiring (`broker/src/index.ts`)

- [x] 4.1 Write a test first for the fatal-decision helper: a small, named, exported function
      (e.g. `hasFatalProblem(problems: ConfigProblem[]): boolean`) returns `true` when any
      problem has `severity: 'fatal'` and `false` otherwise (including the empty-array and
      warning/invalid-only cases) — factored out of `main()` so it's unit-testable, mirroring
      `handleServerError`'s split in `server.ts`.
- [x] 4.2 Implement `hasFatalProblem` in `broker/src/config.ts` (or `index.ts` if it has no
      reuse outside the entrypoint — prefer `config.ts` since `bus`'s entrypoint will need
      the identical decision) and confirm 4.1 passes.
- [x] 4.3 Rewire `broker/src/index.ts`: at the top of `main()`, read the config file (parse
      failure/ENOENT → `file: undefined` for `resolveConfig`, per design.md's file-reading
      decision) and the two recognized env vars (`CHANNELS_HOME`, `SESSIONBUS_TRANSPORT`),
      call `resolveConfig` once, and derive `paths` (`daemonPaths`) from the resolved
      `config.channelsHome` instead of the current module-scope `process.env.CHANNELS_HOME`
      read.
- [x] 4.4 In `runForeground()`, after building the existing `createFatalGuard`, call
      `guard(new Error(...))` with the joined problem messages when `hasFatalProblem` is
      true, and return before binding the socket; otherwise log any `warning`/`invalid`
      problems to stderr and continue exactly as today.
- [x] 4.5 Add the `config` subcommand to `main()`'s dispatch: resolves config (already done
      above), prints `formatConfigReport`'s output to stdout, and — unlike `runForeground` —
      exits `0` regardless of problem severity (diagnosing or stopping a misconfigured broker
      must not itself be blocked by the misconfiguration).
- [x] 4.6 Manually verify (not vitest-reachable per design.md's entrypoint-is-glue
      convention): `broker --foreground` with a fatal `channelsHome` in a temp config file
      exits non-zero and prints the reason; `broker config` against the same file prints the
      fatal problem and exits `0`.

## 5. `bus` entrypoint wiring (`bus/src/index.ts`)

- [x] 5.1 Extend `bus/src/transport.test.ts` first: construct a `ResolvedConfig`-shaped
      fixture (or call the real `resolveConfig` from `config.ts` via the cross-package
      import) that resolves `transport: 'socket'` from a fake file with no env override, pass
      `resolved.config.transport` as `createTransport`'s `mode`, and assert socket-mode
      behavior (file mailbox not read) — and the equivalent case for a config-resolved
      `'file'` mode reading the file mailbox. Do not modify any existing case in this file.
- [x] 5.2 Rewire `bus/src/index.ts`: import `resolveConfig` from `../../broker/src/config.ts`
      (cross-package import, matching `broker/src/daemon.ts`'s existing import of
      `../../bus/src/registry.ts`), read the config file and the two recognized env vars
      once at the top of `main()`, and pass `config.channelsHome` /
      `join(config.channelsHome, 'broker.sock')` / `mode: config.transport` into
      `createTransport` in place of the current module-scope `process.env` reads for
      `CHANNELS_HOME` and the implicit env fallback inside `transport.ts`.
- [x] 5.3 Confirm `bus/src/transport.ts` itself is unchanged — no edits to its `mode`
      resolution or fallback-warning behavior (design.md's explicit non-goal for this task
      group).
- [x] 5.4 Run `bus` tests and confirm 5.1 passes and no existing `bus` test regresses.

## 6. Makefile and launchd

- [x] 6.1 Confirm `broker/launchd/broker.plist.template` still substitutes only
      `__CHANNELS_HOME__` (plus `__LABEL__`, `__NODE__`, `__ENTRY__`, `__LOG__`, `__ROOT__`,
      none of which are config knobs) — no plist edit expected; this task is a check, not a
      change, and exists so a future Matrix-config addition to the plist is caught in review.
- [x] 6.2 Edit `Makefile`'s `mcp-add` target: drop `-e SESSIONBUS_TRANSPORT=$(TRANSPORT)` from
      the `claude mcp add` invocation.
- [x] 6.3 Edit `Makefile`'s `setup` (or add a new prerequisite target `mcp-add` depends on):
      ensure `~/.claude/sessionbus/config.json` exists and has a `"transport": "socket"` key,
      merging into any existing file's JSON rather than overwriting it, and leaving an
      existing `transport` key untouched if the file already sets one.
- [ ] 6.4 Manually verify: `make setup` run twice is idempotent (second run does not rewrite
      an already-correct config file); after `make setup`, `claude mcp get sessionbus` shows
      no `-e SESSIONBUS_TRANSPORT` flag; a session started after `make setup` still reaches
      the broker (socket transport still selected, now via the config file).

## 7. Verification

- [x] 7.1 Run `pnpm lint` (biome + `tsc --noEmit` per package) — the CI gate — and confirm it
      is clean.
- [x] 7.2 Run both package suites (`pnpm test` in `bus` and in `broker`) and confirm all pass,
      including the new `config.test.ts` cases and the extended `transport.test.ts` cases.
- [x] 7.3 Update `CLAUDE.md`: add `broker/src/config.ts` to the module/layout notes (it's a
      `broker`-package module but is imported cross-package by `bus`, same pattern as
      `daemon.ts` importing `bus/src/registry.ts` — worth stating explicitly since it's now
      the second instance of the pattern); note the `broker config` subcommand alongside
      `start`/`stop`/`status`/`restart`; note the new `~/.claude/sessionbus/config.json` path
      and its precedence (defaults → file → env) in the Configs section.
