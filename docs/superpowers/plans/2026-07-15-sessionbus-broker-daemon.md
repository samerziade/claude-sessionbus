# sessionbus Broker Daemon (Socket Transport) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a real-time broker daemon and a `SocketTransport` client behind the existing `Transport` interface, so sessions in socket mode deliver messages over a unix domain socket instead of the file mailbox, with a manageable background daemon.

**Architecture:** A single long-lived broker process per machine listens on `~/.claude/channels/broker.sock` and routes messages by sessionId (dumb router — it never parses identity). Each session's sessionbus, when `SESSIONBUS_TRANSPORT=socket`, runs a `SocketTransport` (implementing the unchanged `{ send, poll, watch }` interface) that connects, registers its sessionId, buffers-and-retries while the broker is down, and receives pushed deliveries. The broker holds an in-memory queue for offline peers. Everything above the `Transport` interface — `handlers.ts`, discovery, beacons — is untouched; only a one-line factory swap changes in `bus/src/index.ts`.

**Tech Stack:** TypeScript on Node 25 (native `.ts` type-stripping, no build step), `node:net` unix domain sockets, NDJSON wire protocol, vitest. New `broker/` workspace package alongside the existing `bus/` package.

## Global Constraints

- **Node 25 native type-stripping** — no `enum`, `namespace`, decorators, or parameter-properties; no `any`. Local imports use explicit `.ts` extensions; SDK imports use `.js` specifiers. No build step.
- **Cross-package imports are relative `.ts` paths** — `bus/src/*` ↔ `broker/src/*` reference each other by relative path (e.g. `../../broker/src/protocol.ts`), never by package name. This resolves under `allowImportingTsExtensions` and Node type-stripping; no workspace dependency entry is needed for a relative import.
- **Atomic writes** for any shared on-disk state — write `.tmp`, then `renameSync`.
- **`tsc --noEmit` must stay clean** in both packages; the existing 47 `bus` tests must keep passing.
- **`ChannelMessage`** (from `bus/src/message.ts`) is the on-the-wire message payload, serialized as-is.
- **`PROTOCOL_VERSION = 1`** — the single protocol version constant, exported from `broker/src/protocol.ts`.
- **macOS unix socket path limit is 104 chars** (`sun_path`) — tests must use short temp socket paths (a short basename under `mkdtemp`).

---

## File Structure

New files:

| File | Responsibility |
| ---- | -------------- |
| `broker/package.json` | Standalone workspace package manifest (type: module; test/start/lint scripts). |
| `broker/tsconfig.json` | NodeNext + `allowImportingTsExtensions` + strict + noEmit (copy of `bus/tsconfig.json`). |
| `broker/src/protocol.ts` | Frame types, `PROTOCOL_VERSION`, `encodeFrame`, streaming `createFrameDecoder`. Single source of truth for the wire protocol. |
| `broker/src/broker.ts` | `createBrokerCore` — the router/queue state machine, tested against a fake `Conn` (no sockets). |
| `broker/src/server.ts` | `startBroker` — `node:net` server, stale-socket reclaim, frame dispatch, lifecycle. |
| `broker/src/daemon.ts` | `daemonPaths`/`startDaemon`/`stopDaemon`/`daemonStatus`/`queryConnected` — background daemon control. |
| `broker/src/index.ts` | `broker [start\|stop\|status\|restart\|--foreground]` CLI entrypoint (glue; no unit test). |
| `bus/src/socket-transport.ts` | `createSocketTransport` — client implementing `Transport` over the socket. |
| `bus/src/transport.ts` | `createTransport` — factory selecting file vs socket by `SESSIONBUS_TRANSPORT`. |

Modified files:

| File | Change |
| ---- | ------ |
| `pnpm-workspace.yaml` | Add `broker` to `packages`. |
| `bus/src/index.ts` | Swap the single `createFileMailbox(...)` line for `createTransport(...)`. |
| `README.md` | Add a "Broker daemon (real-time transport)" section. |

---

### Task 1: Wire protocol + broker package scaffold

**Files:**
- Create: `broker/package.json`
- Create: `broker/tsconfig.json`
- Modify: `pnpm-workspace.yaml`
- Create: `broker/src/protocol.ts`
- Test: `broker/src/protocol.test.ts`

**Interfaces:**
- Consumes: `ChannelMessage` (type) from `bus/src/message.ts`.
- Produces:
  - `const PROTOCOL_VERSION = 1`
  - `type RegisterFrame = { type: 'register'; sessionId: string; protocolVersion: number }`
  - `type SendFrame = { type: 'send'; to: string; msg: ChannelMessage }`
  - `type DeliverFrame = { type: 'deliver'; msg: ChannelMessage }`
  - `type WelcomeFrame = { type: 'welcome'; protocolVersion: number }`
  - `type StatsRequestFrame = { type: 'stats' }`
  - `type StatsReplyFrame = { type: 'stats_reply'; connected: number }`
  - `type Frame = RegisterFrame | SendFrame | DeliverFrame | WelcomeFrame | StatsRequestFrame | StatsReplyFrame`
  - `function encodeFrame(frame: Frame): string`
  - `function createFrameDecoder(): (chunk: string) => Frame[]`

- [ ] **Step 1: Scaffold the broker package**

Create `broker/package.json`:

```json
{
	"name": "broker",
	"version": "0.0.0",
	"private": true,
	"type": "module",
	"description": "sessionbus broker daemon — unix-socket message router",
	"scripts": {
		"test": "vitest run",
		"start": "node src/index.ts",
		"lint": "tsc --noEmit"
	},
	"devDependencies": {
		"@types/node": "25.9.4",
		"typescript": "6.0.3",
		"vitest": "4.1.9"
	}
}
```

Create `broker/tsconfig.json` (identical to `bus/tsconfig.json`):

```json
{
	"compilerOptions": {
		"target": "ESNext",
		"lib": ["ESNext"],
		"module": "NodeNext",
		"moduleResolution": "NodeNext",
		"types": ["node"],
		"allowImportingTsExtensions": true,
		"resolveJsonModule": true,
		"isolatedModules": true,
		"strict": true,
		"noEmit": true,
		"skipLibCheck": true,
		"incremental": true,
		"tsBuildInfoFile": "./tsconfig.tsbuildinfo"
	},
	"include": ["src"],
	"exclude": ["node_modules"]
}
```

Edit `pnpm-workspace.yaml` — add `broker` under `packages`:

```yaml
packages:
  - bus
  - broker

allowBuilds:
  esbuild: true

onlyBuiltDependencies:
  - esbuild
```

- [ ] **Step 2: Install so the new package is linked**

Run: `pnpm install`
Expected: completes without error; `broker/node_modules` is created (symlinks to workspace store).

- [ ] **Step 3: Write the failing test**

Create `broker/src/protocol.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { ChannelMessage } from '../../bus/src/message.ts'
import { createFrameDecoder, encodeFrame, type Frame } from './protocol.ts'

const MSG: ChannelMessage = {
	id: 'abc-1',
	from: { sessionId: 's-from', name: 'from', role: 'none' },
	to: { kind: 'session', value: 's-to' },
	text: 'hello',
	createdAt: 1
}

describe('protocol codec', () => {
	it('round-trips a frame through encode + decode', () => {
		const frame: Frame = { type: 'deliver', msg: MSG }
		const decode = createFrameDecoder()
		expect(decode(encodeFrame(frame))).toEqual([frame])
	})

	it('reassembles a frame split across two chunks', () => {
		const frame: Frame = { type: 'send', to: 's-to', msg: MSG }
		const wire = encodeFrame(frame)
		const cut = Math.floor(wire.length / 2)
		const decode = createFrameDecoder()
		expect(decode(wire.slice(0, cut))).toEqual([])
		expect(decode(wire.slice(cut))).toEqual([frame])
	})

	it('skips an unparseable line without dropping the next frame', () => {
		const good: Frame = { type: 'register', sessionId: 's', protocolVersion: 1 }
		const decode = createFrameDecoder()
		const wire = `{not json\n${encodeFrame(good)}`
		expect(decode(wire)).toEqual([good])
	})
})
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd broker && pnpm exec vitest run src/protocol.test.ts`
Expected: FAIL — cannot resolve `./protocol.ts` (module not found).

- [ ] **Step 5: Write minimal implementation**

Create `broker/src/protocol.ts`:

```ts
import type { ChannelMessage } from '../../bus/src/message.ts'

export const PROTOCOL_VERSION = 1

export type RegisterFrame = { type: 'register'; sessionId: string; protocolVersion: number }
export type SendFrame = { type: 'send'; to: string; msg: ChannelMessage }
export type DeliverFrame = { type: 'deliver'; msg: ChannelMessage }
export type WelcomeFrame = { type: 'welcome'; protocolVersion: number }
export type StatsRequestFrame = { type: 'stats' }
export type StatsReplyFrame = { type: 'stats_reply'; connected: number }

export type Frame =
	| RegisterFrame
	| SendFrame
	| DeliverFrame
	| WelcomeFrame
	| StatsRequestFrame
	| StatsReplyFrame

const FRAME_TYPES = new Set(['register', 'send', 'deliver', 'welcome', 'stats', 'stats_reply'])

function isFrame(v: unknown): v is Frame {
	if (typeof v !== 'object' || v === null) return false
	const t = (v as { type?: unknown }).type
	return typeof t === 'string' && FRAME_TYPES.has(t)
}

/** One JSON object per line, newline-terminated. */
export function encodeFrame(frame: Frame): string {
	return `${JSON.stringify(frame)}\n`
}

/**
 * Stateful streaming decoder: feed it socket chunks, get back complete frames.
 * Buffers a trailing partial line; skips a line that is not valid frame JSON.
 */
export function createFrameDecoder(): (chunk: string) => Frame[] {
	let buffer = ''
	return (chunk: string): Frame[] => {
		buffer += chunk
		const frames: Frame[] = []
		let idx = buffer.indexOf('\n')
		while (idx !== -1) {
			const line = buffer.slice(0, idx)
			buffer = buffer.slice(idx + 1)
			if (line.length > 0) {
				try {
					const parsed: unknown = JSON.parse(line)
					if (isFrame(parsed)) frames.push(parsed)
				} catch {
					// skip unparseable line
				}
			}
			idx = buffer.indexOf('\n')
		}
		return frames
	}
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd broker && pnpm exec vitest run src/protocol.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Typecheck**

Run: `cd broker && pnpm exec tsc --noEmit`
Expected: clean (no output, exit 0).

- [ ] **Step 8: Commit**

```bash
git add broker/package.json broker/tsconfig.json pnpm-workspace.yaml broker/src/protocol.ts broker/src/protocol.test.ts pnpm-lock.yaml
git commit -m "feat(broker): wire protocol codec + package scaffold"
```

---

### Task 2: Broker router core

**Files:**
- Create: `broker/src/broker.ts`
- Test: `broker/src/broker.test.ts`

**Interfaces:**
- Consumes: `Frame` from `broker/src/protocol.ts`; `ChannelMessage` (type) from `bus/src/message.ts`.
- Produces:
  - `interface Conn { send(frame: Frame): void; close(): void }`
  - `interface BrokerCoreOptions { maxQueuePerSession?: number; log?: (msg: string) => void }`
  - `interface BrokerCore { register(conn: Conn, sessionId: string): void; route(to: string, msg: ChannelMessage): void; disconnect(conn: Conn): void; connectedCount(): number }`
  - `function createBrokerCore(opts?: BrokerCoreOptions): BrokerCore`

- [ ] **Step 1: Write the failing test**

Create `broker/src/broker.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createBrokerCore, type Conn } from './broker.ts'
import type { Frame } from './protocol.ts'
import type { ChannelMessage } from '../../bus/src/message.ts'

function fakeConn(): Conn & { sent: Frame[] } {
	const sent: Frame[] = []
	return { sent, send: (f) => sent.push(f), close: () => {} }
}

function msg(id: string): ChannelMessage {
	return {
		id,
		from: { sessionId: 'x', name: 'x', role: 'none' },
		to: { kind: 'session', value: 'y' },
		text: id,
		createdAt: 0
	}
}

describe('broker core', () => {
	it('delivers to a connected recipient', () => {
		const core = createBrokerCore()
		const b = fakeConn()
		core.register(b, 'B')
		core.route('B', msg('m1'))
		expect(b.sent).toEqual([{ type: 'deliver', msg: msg('m1') }])
	})

	it('queues for an offline recipient and flushes on register (in order)', () => {
		const core = createBrokerCore()
		core.route('B', msg('m1'))
		core.route('B', msg('m2'))
		const b = fakeConn()
		core.register(b, 'B')
		expect(b.sent).toEqual([
			{ type: 'deliver', msg: msg('m1') },
			{ type: 'deliver', msg: msg('m2') }
		])
	})

	it('duplicate register replaces the connection; routing goes to the newest', () => {
		const core = createBrokerCore()
		const b1 = fakeConn()
		const b2 = fakeConn()
		core.register(b1, 'B')
		core.register(b2, 'B')
		core.route('B', msg('m1'))
		expect(b1.sent).toEqual([])
		expect(b2.sent).toEqual([{ type: 'deliver', msg: msg('m1') }])
	})

	it('disconnect drops the mapping but keeps the queue', () => {
		const core = createBrokerCore()
		const b = fakeConn()
		core.register(b, 'B')
		core.disconnect(b)
		expect(core.connectedCount()).toBe(0)
		core.route('B', msg('m1')) // now offline -> queued
		const b2 = fakeConn()
		core.register(b2, 'B')
		expect(b2.sent).toEqual([{ type: 'deliver', msg: msg('m1') }])
	})

	it('a stale conn disconnecting does not clobber a newer conn', () => {
		const core = createBrokerCore()
		const b1 = fakeConn()
		const b2 = fakeConn()
		core.register(b1, 'B')
		core.register(b2, 'B')
		core.disconnect(b1) // b1 is stale; b2 is current
		expect(core.connectedCount()).toBe(1)
		core.route('B', msg('m1'))
		expect(b2.sent).toEqual([{ type: 'deliver', msg: msg('m1') }])
	})

	it('bounded queue drops the oldest on overflow', () => {
		const core = createBrokerCore({ maxQueuePerSession: 2 })
		core.route('B', msg('m1'))
		core.route('B', msg('m2'))
		core.route('B', msg('m3')) // overflow -> drop m1
		const b = fakeConn()
		core.register(b, 'B')
		expect(b.sent).toEqual([
			{ type: 'deliver', msg: msg('m2') },
			{ type: 'deliver', msg: msg('m3') }
		])
	})
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd broker && pnpm exec vitest run src/broker.test.ts`
Expected: FAIL — cannot resolve `./broker.ts`.

- [ ] **Step 3: Write minimal implementation**

Create `broker/src/broker.ts`:

```ts
import type { ChannelMessage } from '../../bus/src/message.ts'
import type { Frame } from './protocol.ts'

export interface Conn {
	send(frame: Frame): void
	close(): void
}

export interface BrokerCoreOptions {
	maxQueuePerSession?: number
	log?: (msg: string) => void
}

export interface BrokerCore {
	register(conn: Conn, sessionId: string): void
	route(to: string, msg: ChannelMessage): void
	disconnect(conn: Conn): void
	connectedCount(): number
}

export function createBrokerCore(opts: BrokerCoreOptions = {}): BrokerCore {
	const maxQueue = opts.maxQueuePerSession ?? 1000
	const log = opts.log ?? (() => {})
	const conns = new Map<string, Conn>() // sessionId -> current conn
	const sessionOf = new Map<Conn, string>() // conn -> sessionId
	const queues = new Map<string, ChannelMessage[]>() // sessionId -> pending

	function register(conn: Conn, sessionId: string): void {
		conns.set(sessionId, conn)
		sessionOf.set(conn, sessionId)
		const q = queues.get(sessionId)
		if (q && q.length > 0) {
			for (const msg of q) conn.send({ type: 'deliver', msg })
			queues.delete(sessionId)
		}
	}

	function route(to: string, msg: ChannelMessage): void {
		const conn = conns.get(to)
		if (conn) {
			conn.send({ type: 'deliver', msg })
			return
		}
		let q = queues.get(to)
		if (!q) {
			q = []
			queues.set(to, q)
		}
		q.push(msg)
		if (q.length > maxQueue) {
			q.shift()
			log(`queue for ${to} overflowed; dropped oldest`)
		}
	}

	function disconnect(conn: Conn): void {
		const sessionId = sessionOf.get(conn)
		if (sessionId === undefined) return
		sessionOf.delete(conn)
		if (conns.get(sessionId) === conn) conns.delete(sessionId)
	}

	function connectedCount(): number {
		return conns.size
	}

	return { register, route, disconnect, connectedCount }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd broker && pnpm exec vitest run src/broker.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck**

Run: `cd broker && pnpm exec tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add broker/src/broker.ts broker/src/broker.test.ts
git commit -m "feat(broker): router/queue core with offline queueing"
```

---

### Task 3: Broker net server + stale-socket reclaim

**Files:**
- Create: `broker/src/server.ts`
- Test: `broker/src/server.test.ts`

**Interfaces:**
- Consumes: `createBrokerCore`, `Conn` from `broker/src/broker.ts`; `PROTOCOL_VERSION`, `createFrameDecoder`, `encodeFrame` from `broker/src/protocol.ts`.
- Produces:
  - `interface BrokerServer { connectedCount(): number; close(): Promise<void> }`
  - `interface StartBrokerOptions { socketPath: string; log?: (msg: string) => void }`
  - `function startBroker(opts: StartBrokerOptions): Promise<BrokerServer>` — rejects if a live broker already owns the socket.

- [ ] **Step 1: Write the failing test**

Create `broker/src/server.test.ts`:

```ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { encodeFrame, createFrameDecoder, type Frame } from './protocol.ts'
import { startBroker, type BrokerServer } from './server.ts'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
	for (const c of cleanups.splice(0)) await c()
})

function tempSocket(): string {
	const dir = mkdtempSync(join(tmpdir(), 'bkr-'))
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
	return join(dir, 's')
}

function track(server: BrokerServer): BrokerServer {
	cleanups.push(() => server.close())
	return server
}

describe('broker server', () => {
	it('accepts a register and replies with a welcome frame', async () => {
		const socketPath = tempSocket()
		track(await startBroker({ socketPath }))
		const welcome = await new Promise<Frame>((resolve) => {
			const sock = connect(socketPath)
			sock.setEncoding('utf8')
			const decode = createFrameDecoder()
			sock.on('connect', () =>
				sock.write(encodeFrame({ type: 'register', sessionId: 'A', protocolVersion: 1 }))
			)
			sock.on('data', (chunk: string) => {
				for (const f of decode(chunk)) {
					sock.destroy()
					resolve(f)
				}
			})
		})
		expect(welcome).toEqual({ type: 'welcome', protocolVersion: 1 })
	})

	it('reclaims a stale socket file left by a dead predecessor', async () => {
		const socketPath = tempSocket()
		writeFileSync(socketPath, 'stale') // leftover file, nothing listening
		const server = track(await startBroker({ socketPath }))
		expect(server.connectedCount()).toBe(0)
	})

	it('rejects a second broker on the same live socket', async () => {
		const socketPath = tempSocket()
		track(await startBroker({ socketPath }))
		await expect(startBroker({ socketPath })).rejects.toThrow(/already running/)
	})
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd broker && pnpm exec vitest run src/server.test.ts`
Expected: FAIL — cannot resolve `./server.ts`.

- [ ] **Step 3: Write minimal implementation**

Create `broker/src/server.ts`:

```ts
import { existsSync, unlinkSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { createBrokerCore, type Conn } from './broker.ts'
import { PROTOCOL_VERSION, createFrameDecoder, encodeFrame } from './protocol.ts'

export interface BrokerServer {
	connectedCount(): number
	close(): Promise<void>
}

export interface StartBrokerOptions {
	socketPath: string
	log?: (msg: string) => void
}

export function startBroker(opts: StartBrokerOptions): Promise<BrokerServer> {
	const log = opts.log ?? (() => {})
	return reclaimSocket(opts.socketPath).then(
		() =>
			new Promise<BrokerServer>((resolve, reject) => {
				const core = createBrokerCore({ log })
				const server = createServer((socket) => {
					const conn: Conn = {
						send: (frame) => {
							socket.write(encodeFrame(frame))
						},
						close: () => socket.destroy()
					}
					const decode = createFrameDecoder()
					socket.setEncoding('utf8')
					socket.on('data', (chunk: string) => {
						for (const frame of decode(chunk)) {
							if (frame.type === 'register') {
								if (frame.protocolVersion !== PROTOCOL_VERSION) {
									log(`rejecting client: protocol ${frame.protocolVersion} != ${PROTOCOL_VERSION}`)
									socket.destroy()
									return
								}
								conn.send({ type: 'welcome', protocolVersion: PROTOCOL_VERSION })
								core.register(conn, frame.sessionId)
							} else if (frame.type === 'send') {
								core.route(frame.to, frame.msg)
							} else if (frame.type === 'stats') {
								conn.send({ type: 'stats_reply', connected: core.connectedCount() })
							}
						}
					})
					const drop = () => core.disconnect(conn)
					socket.on('close', drop)
					socket.on('error', drop)
				})
				server.on('error', reject)
				server.listen(opts.socketPath, () => {
					server.removeListener('error', reject)
					resolve({
						connectedCount: () => core.connectedCount(),
						close: () =>
							new Promise<void>((res) => {
								server.close(() => {
									if (existsSync(opts.socketPath)) {
										try {
											unlinkSync(opts.socketPath)
										} catch {
											// already gone
										}
									}
									res()
								})
							})
					})
				})
			})
	)
}

/** If the socket path is occupied by a live broker, reject; if stale, unlink it. */
function reclaimSocket(socketPath: string): Promise<void> {
	return new Promise((resolve, reject) => {
		if (!existsSync(socketPath)) {
			resolve()
			return
		}
		const probe = connect(socketPath)
		probe.once('connect', () => {
			probe.destroy()
			reject(new Error(`broker already running at ${socketPath}`))
		})
		probe.once('error', () => {
			probe.destroy()
			try {
				unlinkSync(socketPath)
			} catch {
				// nothing to remove
			}
			resolve()
		})
	})
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd broker && pnpm exec vitest run src/server.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck**

Run: `cd broker && pnpm exec tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add broker/src/server.ts broker/src/server.test.ts
git commit -m "feat(broker): net server with stale-socket reclaim"
```

---

### Task 4: Socket transport client

**Files:**
- Create: `bus/src/socket-transport.ts`
- Test: `bus/src/socket-transport.test.ts`

**Interfaces:**
- Consumes: `Transport` (type) from `bus/src/mailbox.ts`; `ChannelMessage` (type) from `bus/src/message.ts`; `PROTOCOL_VERSION`, `createFrameDecoder`, `encodeFrame`, `Frame` from `broker/src/protocol.ts`. For the test only: `startBroker` from `broker/src/server.ts`.
- Produces:
  - `interface SocketTransportOptions { socketPath: string; initialBackoffMs?: number; maxBackoffMs?: number; maxOutbound?: number; log?: (msg: string) => void }`
  - `function createSocketTransport(opts: SocketTransportOptions): Transport`

Behavior recap: `send` enqueues a `send` frame (buffers while disconnected, flushes on connect); `poll` returns `[]` (delivery is push-driven); `watch` connects, sends `register`, invokes `onMessage` per `deliver`, reconnects with capped exponential backoff, and returns a `stop()` that ends reconnection and closes the socket.

- [ ] **Step 1: Write the failing test**

Create `bus/src/socket-transport.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startBroker, type BrokerServer } from '../../broker/src/server.ts'
import type { ChannelMessage } from './message.ts'
import { createSocketTransport } from './socket-transport.ts'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
	for (const c of cleanups.splice(0)) await c()
})

function tempSocket(): string {
	const dir = mkdtempSync(join(tmpdir(), 'bkr-'))
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
	return join(dir, 's')
}

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
	const start = Date.now()
	while (!pred()) {
		if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
		await new Promise((r) => setTimeout(r, 20))
	}
}

function msg(id: string, to: string): ChannelMessage {
	return {
		id,
		from: { sessionId: 'from', name: 'from', role: 'none' },
		to: { kind: 'session', value: to },
		text: id,
		createdAt: 0
	}
}

describe('socket transport', () => {
	it('delivers a message between two connected sessions', async () => {
		const socketPath = tempSocket()
		const server = await startBroker({ socketPath })
		cleanups.push(() => server.close())

		const a = createSocketTransport({ socketPath })
		const b = createSocketTransport({ socketPath })
		const got: ChannelMessage[] = []
		cleanups.push(a.watch('A', () => {}))
		cleanups.push(b.watch('B', (m) => got.push(m)))
		await waitFor(() => server.connectedCount() === 2)

		a.send('B', msg('m1', 'B'))
		await waitFor(() => got.length === 1)
		expect(got[0]).toEqual(msg('m1', 'B'))
	})

	it('queues for an offline session and flushes when it connects', async () => {
		const socketPath = tempSocket()
		const server = await startBroker({ socketPath })
		cleanups.push(() => server.close())

		const a = createSocketTransport({ socketPath })
		cleanups.push(a.watch('A', () => {}))
		await waitFor(() => server.connectedCount() === 1)
		a.send('C', msg('m1', 'C')) // C not connected yet

		const c = createSocketTransport({ socketPath })
		const got: ChannelMessage[] = []
		cleanups.push(c.watch('C', (m) => got.push(m)))
		await waitFor(() => got.length === 1)
		expect(got[0]).toEqual(msg('m1', 'C'))
	})

	it('buffers outbound sent before watch() and flushes after connect', async () => {
		const socketPath = tempSocket()
		const server = await startBroker({ socketPath })
		cleanups.push(() => server.close())

		const b = createSocketTransport({ socketPath })
		const got: ChannelMessage[] = []
		cleanups.push(b.watch('B', (m) => got.push(m)))
		await waitFor(() => server.connectedCount() === 1)

		const d = createSocketTransport({ socketPath })
		d.send('B', msg('m1', 'B')) // sent BEFORE d.watch() -> buffered
		cleanups.push(d.watch('D', () => {}))
		await waitFor(() => got.length === 1)
		expect(got[0]).toEqual(msg('m1', 'B'))
	})

	it('reconnects and re-registers after the broker restarts', async () => {
		const socketPath = tempSocket()
		let server: BrokerServer = await startBroker({ socketPath })

		const a = createSocketTransport({ socketPath, initialBackoffMs: 50 })
		const gotA: ChannelMessage[] = []
		cleanups.push(a.watch('A', (m) => gotA.push(m)))
		await waitFor(() => server.connectedCount() === 1)

		await server.close()
		server = await startBroker({ socketPath })
		cleanups.push(() => server.close())

		const e = createSocketTransport({ socketPath })
		cleanups.push(e.watch('E', () => {}))
		await waitFor(() => server.connectedCount() === 2) // A reconnected + E

		e.send('A', msg('m1', 'A'))
		await waitFor(() => gotA.length === 1)
		expect(gotA[0]).toEqual(msg('m1', 'A'))
	})
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd bus && pnpm exec vitest run src/socket-transport.test.ts`
Expected: FAIL — cannot resolve `./socket-transport.ts`.

- [ ] **Step 3: Write minimal implementation**

Create `bus/src/socket-transport.ts`:

```ts
import { type Socket, connect } from 'node:net'
import {
	PROTOCOL_VERSION,
	createFrameDecoder,
	encodeFrame,
	type Frame
} from '../../broker/src/protocol.ts'
import type { Transport } from './mailbox.ts'
import type { ChannelMessage } from './message.ts'

export interface SocketTransportOptions {
	socketPath: string
	initialBackoffMs?: number
	maxBackoffMs?: number
	maxOutbound?: number
	log?: (msg: string) => void
}

export function createSocketTransport(opts: SocketTransportOptions): Transport {
	const initialBackoff = opts.initialBackoffMs ?? 100
	const maxBackoff = opts.maxBackoffMs ?? 5000
	const maxOutbound = opts.maxOutbound ?? 1000
	const log = opts.log ?? (() => {})

	let socket: Socket | undefined
	let connected = false
	let stopped = false
	let ownSessionId: string | undefined
	let onMessage: ((msg: ChannelMessage) => void) | undefined
	let backoff = initialBackoff
	let reconnectTimer: ReturnType<typeof setTimeout> | undefined
	const outbound: Frame[] = []

	function flush(): void {
		if (!connected || !socket) return
		while (outbound.length > 0) {
			const frame = outbound.shift()
			if (frame) socket.write(encodeFrame(frame))
		}
	}

	function enqueue(frame: Frame): void {
		outbound.push(frame)
		if (outbound.length > maxOutbound) {
			outbound.shift()
			log('outbound buffer overflowed; dropped oldest')
		}
		flush()
	}

	function scheduleReconnect(): void {
		if (stopped || reconnectTimer) return
		reconnectTimer = setTimeout(() => {
			reconnectTimer = undefined
			open()
		}, backoff)
		backoff = Math.min(backoff * 2, maxBackoff)
	}

	function open(): void {
		if (stopped) return
		const sock = connect(opts.socketPath)
		socket = sock
		sock.setEncoding('utf8')
		const decode = createFrameDecoder()
		sock.on('connect', () => {
			connected = true
			backoff = initialBackoff
			if (ownSessionId !== undefined) {
				sock.write(
					encodeFrame({ type: 'register', sessionId: ownSessionId, protocolVersion: PROTOCOL_VERSION })
				)
			}
			flush()
		})
		sock.on('data', (chunk: string) => {
			for (const frame of decode(chunk)) {
				if (frame.type === 'deliver' && onMessage) onMessage(frame.msg)
			}
		})
		sock.on('error', () => {
			// a 'close' event follows; reconnect is scheduled there
		})
		sock.on('close', () => {
			connected = false
			if (!stopped) scheduleReconnect()
		})
	}

	function send(recipientSessionId: string, msg: ChannelMessage): void {
		enqueue({ type: 'send', to: recipientSessionId, msg })
	}

	function poll(): ChannelMessage[] {
		return []
	}

	function watch(sessionId: string, handler: (msg: ChannelMessage) => void): () => void {
		ownSessionId = sessionId
		onMessage = handler
		open()
		return () => {
			stopped = true
			if (reconnectTimer) {
				clearTimeout(reconnectTimer)
				reconnectTimer = undefined
			}
			socket?.destroy()
		}
	}

	return { send, poll, watch }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd bus && pnpm exec vitest run src/socket-transport.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck both packages** (cross-package imports now exist in both directions)

Run: `cd bus && pnpm exec tsc --noEmit && cd ../broker && pnpm exec tsc --noEmit`
Expected: clean in both.

- [ ] **Step 6: Commit**

```bash
git add bus/src/socket-transport.ts bus/src/socket-transport.test.ts
git commit -m "feat(bus): socket transport client with buffer + reconnect"
```

---

### Task 5: Transport factory + index.ts wiring

**Files:**
- Create: `bus/src/transport.ts`
- Test: `bus/src/transport.test.ts`
- Modify: `bus/src/index.ts`

**Interfaces:**
- Consumes: `createFileMailbox`, `Transport` from `bus/src/mailbox.ts`; `createSocketTransport` from `bus/src/socket-transport.ts`.
- Produces:
  - `interface CreateTransportOptions { channelsHome: string; socketPath: string; mode?: string }`
  - `function createTransport(opts: CreateTransportOptions): Transport` — `mode` defaults to `process.env.SESSIONBUS_TRANSPORT ?? 'file'`; `'socket'` selects the socket transport, anything else selects the file mailbox.

- [ ] **Step 1: Write the failing test**

Create `bus/src/transport.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createFileMailbox } from './mailbox.ts'
import type { ChannelMessage } from './message.ts'
import { createTransport } from './transport.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
	for (const c of cleanups.splice(0)) c()
})

function tempHome(): string {
	const dir = mkdtempSync(join(tmpdir(), 'ch-'))
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
	return dir
}

function msg(id: string): ChannelMessage {
	return {
		id,
		from: { sessionId: 'x', name: 'x', role: 'none' },
		to: { kind: 'session', value: 'own' },
		text: id,
		createdAt: 0
	}
}

describe('createTransport', () => {
	it('file mode reads the file mailbox inbox', () => {
		const channelsHome = tempHome()
		createFileMailbox(channelsHome).send('own', msg('m1')) // seed own inbox
		const t = createTransport({ channelsHome, socketPath: join(channelsHome, 'broker.sock'), mode: 'file' })
		expect(t.poll('own').map((m) => m.id)).toEqual(['m1'])
	})

	it('socket mode does not read the file mailbox (poll returns [])', () => {
		const channelsHome = tempHome()
		createFileMailbox(channelsHome).send('own', msg('m1')) // seed own inbox
		const t = createTransport({ channelsHome, socketPath: join(channelsHome, 'broker.sock'), mode: 'socket' })
		expect(t.poll('own')).toEqual([])
	})

	it('defaults to file when SESSIONBUS_TRANSPORT is unset', () => {
		const channelsHome = tempHome()
		createFileMailbox(channelsHome).send('own', msg('m1'))
		const prev = process.env.SESSIONBUS_TRANSPORT
		process.env.SESSIONBUS_TRANSPORT = undefined
		cleanups.push(() => {
			if (prev === undefined) delete process.env.SESSIONBUS_TRANSPORT
			else process.env.SESSIONBUS_TRANSPORT = prev
		})
		delete process.env.SESSIONBUS_TRANSPORT
		const t = createTransport({ channelsHome, socketPath: join(channelsHome, 'broker.sock') })
		expect(t.poll('own').map((m) => m.id)).toEqual(['m1'])
	})
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd bus && pnpm exec vitest run src/transport.test.ts`
Expected: FAIL — cannot resolve `./transport.ts`.

- [ ] **Step 3: Write minimal implementation**

Create `bus/src/transport.ts`:

```ts
import { createFileMailbox, type Transport } from './mailbox.ts'
import { createSocketTransport } from './socket-transport.ts'

export interface CreateTransportOptions {
	channelsHome: string
	socketPath: string
	mode?: string
}

/** Select the transport backend. `mode` defaults to $SESSIONBUS_TRANSPORT, else 'file'. */
export function createTransport(opts: CreateTransportOptions): Transport {
	const mode = opts.mode ?? process.env.SESSIONBUS_TRANSPORT ?? 'file'
	if (mode === 'socket') return createSocketTransport({ socketPath: opts.socketPath })
	return createFileMailbox(opts.channelsHome)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd bus && pnpm exec vitest run src/transport.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire the factory into `index.ts`**

In `bus/src/index.ts`, add the imports (near the existing `createFileMailbox` import) and a socket-path constant, then swap the transport line.

Replace the import line:

```ts
import { createFileMailbox } from './mailbox.ts'
```

with:

```ts
import { createTransport } from './transport.ts'
```

Add a constant next to the existing `CHANNELS_HOME` definition (`bus/src/index.ts:13`):

```ts
const BROKER_SOCK = process.env.BROKER_SOCK ?? join(CHANNELS_HOME, 'broker.sock')
```

Replace the transport construction line (`bus/src/index.ts:48`):

```ts
const transport = createFileMailbox(CHANNELS_HOME)
```

with:

```ts
const transport = createTransport({ channelsHome: CHANNELS_HOME, socketPath: BROKER_SOCK })
```

- [ ] **Step 6: Verify the whole bus suite + typecheck still pass**

Run: `cd bus && pnpm test && pnpm exec tsc --noEmit`
Expected: all tests PASS (existing 47 + new socket-transport + transport tests); typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add bus/src/transport.ts bus/src/transport.test.ts bus/src/index.ts
git commit -m "feat(bus): transport factory + SESSIONBUS_TRANSPORT wiring"
```

---

### Task 6: Daemon control + CLI

**Files:**
- Create: `broker/src/daemon.ts`
- Test: `broker/src/daemon.test.ts`
- Create: `broker/src/index.ts`

**Interfaces:**
- Consumes: `isPidAlive` from `bus/src/registry.ts`; `PROTOCOL_VERSION`, `createFrameDecoder`, `encodeFrame` from `broker/src/protocol.ts`; `startBroker` from `broker/src/server.ts`.
- Produces:
  - `interface DaemonPaths { socketPath: string; pidPath: string; logPath: string }`
  - `function daemonPaths(channelsHome: string): DaemonPaths`
  - `interface DaemonStatus { running: boolean; pid?: number; socketPath: string }`
  - `function daemonStatus(paths: DaemonPaths): DaemonStatus`
  - `function startDaemon(paths: DaemonPaths, entryScript: string): void`
  - `function stopDaemon(paths: DaemonPaths): Promise<void>`
  - `function queryConnected(socketPath: string, timeoutMs?: number): Promise<number | undefined>`

- [ ] **Step 1: Write the failing test**

Create `broker/src/daemon.test.ts`:

```ts
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { daemonPaths, daemonStatus, startDaemon, stopDaemon } from './daemon.ts'

const entryScript = fileURLToPath(new URL('./index.ts', import.meta.url))
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
	for (const c of cleanups.splice(0)) await c()
})

// tempHome keeps the socket path short (macOS sun_path limit ~104 chars)
function tempHome(): string {
	const dir = mkdtempSync(join(tmpdir(), 'ch-'))
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
	return dir
}

async function waitFor(pred: () => boolean, timeoutMs = 4000): Promise<void> {
	const start = Date.now()
	while (!pred()) {
		if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
		await new Promise((r) => setTimeout(r, 30))
	}
}

describe('daemon control', () => {
	it('start writes a pid, brings up the socket; stop tears it down', async () => {
		const paths = daemonPaths(tempHome())
		startDaemon(paths, entryScript)
		cleanups.push(() => stopDaemon(paths))
		await waitFor(() => daemonStatus(paths).running && existsSync(paths.socketPath))
		expect(daemonStatus(paths).running).toBe(true)

		await stopDaemon(paths)
		await waitFor(() => !daemonStatus(paths).running)
		expect(existsSync(paths.pidPath)).toBe(false)
	})

	it('start refuses when a daemon is already running', async () => {
		const paths = daemonPaths(tempHome())
		startDaemon(paths, entryScript)
		cleanups.push(() => stopDaemon(paths))
		await waitFor(() => daemonStatus(paths).running)
		expect(() => startDaemon(paths, entryScript)).toThrow(/already running/)
	})
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd broker && pnpm exec vitest run src/daemon.test.ts`
Expected: FAIL — cannot resolve `./daemon.ts` (and `./index.ts` does not exist yet).

- [ ] **Step 3: Write the daemon module**

Create `broker/src/daemon.ts`:

```ts
import { spawn } from 'node:child_process'
import { mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'
import { isPidAlive } from '../../bus/src/registry.ts'
import { createFrameDecoder, encodeFrame } from './protocol.ts'

export interface DaemonPaths {
	socketPath: string
	pidPath: string
	logPath: string
}

export function daemonPaths(channelsHome: string): DaemonPaths {
	return {
		socketPath: join(channelsHome, 'broker.sock'),
		pidPath: join(channelsHome, 'broker.pid'),
		logPath: join(channelsHome, 'broker.log')
	}
}

function readPid(pidPath: string): number | undefined {
	try {
		const n = Number.parseInt(readFileSync(pidPath, 'utf8').trim(), 10)
		return Number.isInteger(n) ? n : undefined
	} catch {
		return undefined
	}
}

export interface DaemonStatus {
	running: boolean
	pid?: number
	socketPath: string
}

export function daemonStatus(paths: DaemonPaths): DaemonStatus {
	const pid = readPid(paths.pidPath)
	const running = pid !== undefined && isPidAlive(pid)
	return { running, pid: running ? pid : undefined, socketPath: paths.socketPath }
}

export function startDaemon(paths: DaemonPaths, entryScript: string): void {
	if (daemonStatus(paths).running) throw new Error('broker already running')
	const channelsHome = dirname(paths.socketPath)
	mkdirSync(channelsHome, { recursive: true })
	const out = openSync(paths.logPath, 'a')
	const child = spawn(process.execPath, [entryScript, '--foreground'], {
		detached: true,
		stdio: ['ignore', out, out],
		env: { ...process.env, CHANNELS_HOME: channelsHome }
	})
	child.unref()
	const tmp = `${paths.pidPath}.tmp`
	writeFileSync(tmp, String(child.pid))
	renameSync(tmp, paths.pidPath)
}

export async function stopDaemon(paths: DaemonPaths): Promise<void> {
	const pid = readPid(paths.pidPath)
	if (pid !== undefined && isPidAlive(pid)) {
		try {
			process.kill(pid, 'SIGTERM')
		} catch {
			// already gone
		}
		const start = Date.now()
		while (isPidAlive(pid) && Date.now() - start < 5000) {
			await new Promise((r) => setTimeout(r, 50))
		}
	}
	rmSync(paths.pidPath, { force: true })
}

/** Ask a running broker how many sessions are connected (undefined if unreachable). */
export function queryConnected(socketPath: string, timeoutMs = 500): Promise<number | undefined> {
	return new Promise((resolve) => {
		const sock = connect(socketPath)
		sock.setEncoding('utf8')
		const decode = createFrameDecoder()
		const finish = (v: number | undefined) => {
			sock.destroy()
			resolve(v)
		}
		const timer = setTimeout(() => finish(undefined), timeoutMs)
		sock.on('connect', () => sock.write(encodeFrame({ type: 'stats' })))
		sock.on('data', (chunk: string) => {
			for (const frame of decode(chunk)) {
				if (frame.type === 'stats_reply') {
					clearTimeout(timer)
					finish(frame.connected)
				}
			}
		})
		sock.on('error', () => {
			clearTimeout(timer)
			finish(undefined)
		})
	})
}
```

- [ ] **Step 4: Write the CLI entrypoint**

Create `broker/src/index.ts`:

```ts
#!/usr/bin/env node
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	daemonPaths,
	daemonStatus,
	queryConnected,
	startDaemon,
	stopDaemon
} from './daemon.ts'
import { startBroker } from './server.ts'

const CHANNELS_HOME = process.env.CHANNELS_HOME ?? join(homedir(), '.claude', 'channels')
const paths = daemonPaths(CHANNELS_HOME)
const entryScript = fileURLToPath(import.meta.url)

async function runForeground(): Promise<void> {
	const server = await startBroker({
		socketPath: paths.socketPath,
		log: (m) => process.stderr.write(`broker: ${m}\n`)
	})
	const shutdown = () => {
		server.close().finally(() => process.exit(0))
	}
	process.on('SIGINT', shutdown)
	process.on('SIGTERM', shutdown)
	process.stderr.write(`broker: listening on ${paths.socketPath}\n`)
}

async function main(): Promise<void> {
	const cmd = process.argv[2]
	if (cmd === undefined || cmd === '--foreground') {
		await runForeground()
		return
	}
	if (cmd === 'start') {
		startDaemon(paths, entryScript)
		process.stdout.write(`broker started (${paths.socketPath})\n`)
		return
	}
	if (cmd === 'stop') {
		await stopDaemon(paths)
		process.stdout.write('broker stopped\n')
		return
	}
	if (cmd === 'restart') {
		await stopDaemon(paths)
		startDaemon(paths, entryScript)
		process.stdout.write('broker restarted\n')
		return
	}
	if (cmd === 'status') {
		const st = daemonStatus(paths)
		const connected = st.running ? await queryConnected(paths.socketPath) : undefined
		process.stdout.write(`${JSON.stringify({ ...st, connected }, null, 2)}\n`)
		return
	}
	process.stderr.write(
		`unknown command: ${cmd}\nusage: broker [start|stop|status|restart|--foreground]\n`
	)
	process.exit(1)
}

main().catch((err) => {
	process.stderr.write(`broker fatal: ${err instanceof Error ? err.stack : String(err)}\n`)
	process.exit(1)
})
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd broker && pnpm exec vitest run src/daemon.test.ts`
Expected: PASS (2 tests). (Each spawns a real detached broker and tears it down.)

- [ ] **Step 6: Typecheck**

Run: `cd broker && pnpm exec tsc --noEmit`
Expected: clean.

- [ ] **Step 7: Smoke-test the CLI manually**

```bash
cd broker
CHANNELS_HOME="$(mktemp -d)/ch" node src/index.ts start
# note the printed socket path's parent; reuse the same CHANNELS_HOME:
# (run these with the SAME CHANNELS_HOME value)
```

Run the full sequence in one shell:

```bash
cd broker
export CHANNELS_HOME="$(mktemp -d)/ch"
node src/index.ts start
node src/index.ts status   # expect running:true, connected:0
node src/index.ts stop
node src/index.ts status    # expect running:false
unset CHANNELS_HOME
```

Expected: `start` prints "broker started"; first `status` shows `"running": true, "connected": 0`; `stop` prints "broker stopped"; second `status` shows `"running": false`.

- [ ] **Step 8: Commit**

```bash
git add broker/src/daemon.ts broker/src/daemon.test.ts broker/src/index.ts
git commit -m "feat(broker): background daemon control + CLI"
```

---

### Task 7: Docs + full verification

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above. No new code.

- [ ] **Step 1: Append the broker section to `README.md`**

Add the following to the end of `README.md`:

````markdown
## Broker daemon (real-time transport)

By default sessionbus uses the flat-file mailbox. For real-time delivery, run the **broker
daemon** and switch sessions to socket mode.

The broker is one long-lived process per machine, listening on a unix domain socket
(`~/.claude/channels/broker.sock`). It routes messages by sessionId and holds an in-memory
queue for sessions that are momentarily offline. It is a dumb router — identity resolution
still happens client-side, so `whoami`/`list_peers`/`send_message` behave identically.

### Run the broker

```bash
cd broker
node src/index.ts start      # background daemon (logs to ~/.claude/channels/broker.log)
node src/index.ts status     # running? pid? connected sessions?
node src/index.ts stop
node src/index.ts restart
node src/index.ts             # or --foreground: run in this terminal (Ctrl-C to stop)
```

### Switch sessions to socket mode

Set `SESSIONBUS_TRANSPORT=socket` for every session (e.g. in the user-level MCP registration
`env` block). Unset — or `file` — keeps the file mailbox. All sessions on a machine must agree:
socket-mode sessions only talk to other socket-mode sessions through the broker.

While the broker is down, a socket-mode session buffers outgoing messages and reconnects with
backoff; it does not fall back to the file mailbox. In-memory broker queues are dropped if the
broker itself restarts (durable queues are a planned follow-up).
````

- [ ] **Step 2: Run the full test suite across both packages**

Run: `pnpm -r test`
Expected: `bus` and `broker` suites both PASS (existing 47 bus tests + new bus tests; all broker tests).

- [ ] **Step 3: Typecheck across both packages**

Run: `pnpm -r lint`
Expected: clean in both `bus` and `broker` (each runs `tsc --noEmit`).

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document the broker daemon + socket transport"
```

---

## Self-Review

**Spec coverage** (against `docs/superpowers/specs/2026-07-15-sessionbus-broker-daemon-design.md`):

- Language TS/Node, `node:net`, NDJSON, no build → Tasks 1–6. ✓
- Dumb router by sessionId; discovery/beacons untouched → Task 2 core routes by sessionId; only `index.ts` transport line changes (Task 5). ✓
- Wire protocol (`register`/`send`/`deliver`/`welcome`, `PROTOCOL_VERSION`, NDJSON partial-frame handling) → Task 1. `stats`/`stats_reply` added for `status` connected-count → Tasks 1/3/6. ✓
- `protocol.ts`/`broker.ts`/`server.ts`/`daemon.ts`/`index.ts` in `broker/`; `socket-transport.ts`/`transport.ts` in `bus/`; one-line `index.ts` swap → Tasks 1–6. ✓
- `SocketTransport` maps to `{ send, poll, watch }` with send=enqueue, poll=no-op, watch=connect+register+receive+reconnect → Task 4. ✓
- Machine-wide selection via `SESSIONBUS_TRANSPORT` (default `file`) → Task 5. ✓
- Broker-down: buffer outbound + reconnect with backoff, no file fallback → Task 4. ✓
- In-memory queues, dropped on restart; bounded queues → Task 2 (`maxQueuePerSession`), documented in Task 7. ✓
- Lifecycle: foreground + `start`/`stop`/`status`/`restart`, pid/log/socket under `~/.claude/channels/`, stale-socket reclaim, SIGTERM cleanup, `isPidAlive` reuse → Tasks 3 & 6. ✓
- Error handling: partial-frame skip (Task 1), duplicate register replace + queue-move (Task 2), send-to-offline queue (Task 2), reconnect backoff + bounded outbound (Task 4), version mismatch closes (Task 3). ✓
- Testing: protocol round-trip/chunk-split/skip; router/queue units; server bind/reclaim/reject; two-client integration incl. offline-queue, buffered-send, reconnect; factory selection; daemon start/stop/status → Tasks 1–6. ✓
- Out of scope (D2 persistence, launchd, broker-owned presence, version retirement) → correctly omitted; noted in README follow-up line. ✓

**Placeholder scan:** No TBD/TODO/"handle errors appropriately"; every code step shows complete code; every run step shows the exact command and expected result. ✓

**Type consistency:** `Frame`, `Conn`, `BrokerCore`, `startBroker`/`BrokerServer`, `createSocketTransport`/`SocketTransportOptions`, `createTransport`/`CreateTransportOptions`, `daemonPaths`/`DaemonPaths`/`daemonStatus`/`startDaemon`/`stopDaemon`/`queryConnected` are defined once and consumed with matching signatures across tasks. `PROTOCOL_VERSION` is the single version constant. `route(to, msg)` (no `from` param) is used consistently in core and server. ✓
