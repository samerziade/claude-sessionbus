<!-- Retroactive change: the MVP shipped as pure Node modules under bus/ with paired
     *.test.ts (47 tests passing). Completed tasks are checked. Module order is acyclic:
     message/identity are leaves; registry uses identity; mailbox uses message; address
     uses identity; handlers uses all; index wires handlers to a real MCP Server. -->

## 1. Package scaffold + message module

- [x] 1.1 Create standalone `package.json` (`type: module`, `test`/`start` scripts) and NodeNext `tsconfig.json` (`allowImportingTsExtensions`, `noEmit`, strict, `types: ["node"]`)
- [x] 1.2 Install exact-pinned deps with `--ignore-workspace`: `@modelcontextprotocol/sdk` (runtime); `vitest`, `typescript`, `@types/node` (dev)
- [x] 1.3 TDD `message.ts`: `ChannelMessage`/`MessageFrom`/`MessageTo` types, `newMessageId` (sortable base36 id), `shortId`, `toChannelMeta` (identifier-safe keys, epic omitted when absent)

## 2. Identity — parse title & resolve own identity

- [x] 2.1 TDD `identity.ts`: `parseSessionName` (PM `^epic:(\d+)$`, worker `^(\S+)\s+epic:(\d+)$`, else `none`, trims/blank)
- [x] 2.2 `resolveIdentity(sessionId, entries)` → matched entry's parsed identity, or null when no entry matches

## 3. Registry & presence

- [x] 3.1 TDD `registry.ts` `readSessionEntries`: read `*.json` only, skip malformed/non-JSON, empty on missing dir, `isSessionEntry` shape guard
- [x] 3.2 `isPidAlive` via `process.kill(pid, 0)` (success/`EPERM` = alive, `ESRCH` = dead)
- [x] 3.3 Presence beacons: `writeBeacon`, `refreshBeacon` (mtime touch), `removeBeacon`, `readBeacons` (prune + delete dead-pid beacons on read)

## 4. Mailbox — flat-file transport

- [x] 4.1 TDD `mailbox.ts`: `Transport` interface (`send`/`poll`/`watch`) + `createFileMailbox`
- [x] 4.2 `send` atomic (write `.<id>.tmp` → `rename`), no temp file left behind
- [x] 4.3 `poll`: scan sorted `*.json`, in-memory delivered-id dedup, archive to `consumed/`, offline messages delivered on first scan
- [x] 4.4 `watch`: `fs.watch` + ~1s poll fallback, drains queued messages on start, returns a stop function

## 5. Address resolution

- [x] 5.1 TDD `address.ts` `resolveTo`: order exact sessionId → `pm` → `epic`/`epic:N` → short-id prefix (≥4) → name substring
- [x] 5.2 Explicit failures: `not_found`, `ambiguous` (with candidates), `no_epic`; never silently guess

## 6. Handlers — tools + inbound bridge (DI)

- [x] 6.1 TDD `handlers.ts` `livePeers` (registry ∩ live beacon, excludes self) and `buildChannelNotification`
- [x] 6.2 `whoami`, `listPeers({ scope })` (epic default, metadata + shortId), `sendMessage({ to, text })` (delivery summary; no write on failed resolution; broadcast fan-out; self-suppression)
- [x] 6.3 `start()` → `transport.watch` bridging inbound messages to `notify` as channel events

## 7. MCP server wiring

- [x] 7.1 `index.ts`: resolve `self` from registry (fallback `role: none`), build real deps, register `whoami`/`list_peers`/`send_message` + instructions string, connect stdio
- [x] 7.2 Beacon lifecycle: write on startup, ~30s refresh interval (unref'd), remove beacon + exit on SIGTERM
- [x] 7.3 Manual smoke test (background node + `kill -TERM` the real pid); document the teardown gotcha

## 8. Verification

- [x] 8.1 `pnpm test` green — full suite (47 tests; two `watch` tests wait ~1.3s on the poll interval)
- [x] 8.2 Reconcile stale carried-over configs so plain `pnpm exec tsc --noEmit`, root `pnpm install`, and `biome check` are clean. `tsconfig.json` (already NodeNext/strict/noEmit) and `pnpm-workspace.yaml` (already globs `bus`) were reconciled prior to this change; trimmed `biome.json` of the dead styreo `apps/web/**` override and Tailwind CSS directives (no CSS/JSX in this repo)
