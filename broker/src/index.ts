#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSessionName } from '../../bus/src/identity.ts'
import type {
	HistoryQuery,
	HistoryResult,
	MatrixReplyRequest,
	MatrixReplyResult
} from '../../bus/src/mailbox.ts'
import type { BridgeState } from './bridge-state.ts'
import { createBridgeState } from './bridge-state.ts'
import type { RegisteredSession } from './broker.ts'
import {
	type ConfigProblem,
	formatConfigReport,
	hasFatalProblem,
	loadConfig,
	type MatrixEnabled,
	pickConfigEnv,
	type ResolvedConfig,
	resolveMatrixToken,
	type TokenChild
} from './config.ts'
import {
	type DaemonPaths,
	daemonPaths,
	daemonStatus,
	queryConnected,
	removePid,
	startDaemon,
	stopDaemon,
	writePid
} from './daemon.ts'
import { createFatalGuard, wireFatalHandlers } from './fatal.ts'
import { createMatrixClient } from './matrix-client.ts'
import { createHistoryReader } from './matrix-history.ts'
import { createMatrixMirror, type MatrixMirror } from './matrix-mirror.ts'
import { createNamer } from './matrix-names.ts'
import { createPoster } from './matrix-post.ts'
import { createProvisioner, sessionUser } from './matrix-provisioner.ts'
import { createMatrixRelay, type MatrixRelay, type RelayIdentity } from './matrix-relay.ts'
import { type BrokerServer, startBroker, UNAVAILABLE } from './server.ts'

/**
 * Everything the bridge contributes to the broker's wiring. Absent when the bridge is off or
 * its configuration was rejected, and every path a session can reach then answers
 * `unavailable` — the broker itself serves exactly as it does with no bridge configured.
 */
interface Bridge {
	onRegistered: (session: RegisteredSession) => void
	onHistory: (sessionId: string, query: HistoryQuery) => Promise<HistoryResult>
	onMatrixReply: (sessionId: string, req: MatrixReplyRequest) => Promise<MatrixReplyResult>
	relay: MatrixRelay
	mirror: MatrixMirror
}

/**
 * Start a token command. Asynchronous on purpose: the broker is already serving by the time
 * this runs, and a synchronous spawn would block its event loop for as long as the helper
 * takes — a bound socket that answers nothing is barely better than an unbound one.
 *
 * Killing closes the child's pipes and lets go of it, so a helper that ignores the signal
 * cannot keep a broker that has already given up on it holding one end of a pipe.
 */
function runTokenCommand(cmd: string[]): TokenChild {
	let deliver: (text: string) => void = () => {}
	let fail: (err: unknown) => void = () => {}
	const output = new Promise<string>((resolve, reject) => {
		deliver = resolve
		fail = reject
	})
	const child = execFile(cmd[0], cmd.slice(1), { encoding: 'utf8' }, (error, stdout) => {
		if (error === null) deliver(stdout)
		else fail(error)
	})
	return {
		output,
		kill: () => {
			child.kill()
			child.stdin?.destroy()
			child.stdout?.destroy()
			child.stderr?.destroy()
			child.unref()
		}
	}
}

/**
 * Build the inbound bridge, or nothing. Glue: every decision it makes has been made and tested
 * in the module it belongs to, and what is left here is which pieces are handed to which.
 *
 * `route` and `sessionForIdentity` are read through a server reference rather than the server
 * itself: both are called per wake, which is the rule the relay exists to keep — the identity →
 * session map is never cached.
 */
async function buildBridge(
	resolved: ResolvedConfig,
	matrix: MatrixEnabled,
	state: BridgeState,
	serverRef: () => BrokerServer,
	log: (msg: string) => void
): Promise<Bridge | undefined> {
	const token = await resolveMatrixToken(matrix, {
		env: { SESSIONBUS_MATRIX_AS_TOKEN: process.env.SESSIONBUS_MATRIX_AS_TOKEN },
		run: runTokenCommand
	})
	if (!token.ok) {
		log(describeProblem(token.problem))
		return undefined
	}
	if (matrix.url === undefined || matrix.domain === undefined) {
		log('config invalid: matrix.url and matrix.domain are required for the bridge')
		return undefined
	}

	const client = createMatrixClient({ fetch, baseUrl: matrix.url, token: token.token, log })
	const namer = createNamer({ prefix: matrix.namespacePrefix, domain: matrix.domain })
	const provisioner = createProvisioner({
		client,
		namer,
		config: resolved.config,
		clock: { sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
		random: Math.random,
		log
	})
	const botUser = namer.bridgeUser()
	// Where each registered identity lives remotely. Rebuilt on every register and read, never
	// snapshotted into the relay.
	const identities = new Map<string, RelayIdentity>()
	const rooms = new Map<string, string>() // alias -> room id

	async function roomFor(alias: string): Promise<string | undefined> {
		const known = rooms.get(alias)
		if (known !== undefined) return known
		const resolvedAlias = await client.resolveAlias(alias, botUser)
		if (!resolvedAlias.ok) return undefined
		rooms.set(alias, resolvedAlias.value.roomId)
		return resolvedAlias.value.roomId
	}

	const relay = createMatrixRelay({
		client,
		state,
		route: (to, msg) => serverRef().route(to, msg),
		identities: () => [...identities.values()],
		sessionForIdentity: (identity) => serverRef().sessionForIdentity(identity),
		botUser,
		operator: matrix.owner,
		namespacePrefix: matrix.namespacePrefix,
		caps: { messages: matrix.unreadCap.messages, chars: matrix.unreadCap.chars },
		now: Date.now,
		// A transcript's clock reads in the operator's own time, not UTC.
		tzOffsetMinutes: -new Date().getTimezoneOffset(),
		log
	})

	const history = createHistoryReader({
		client,
		botUser,
		namespacePrefix: matrix.namespacePrefix,
		identities: () => [...identities.values()],
		isBridgeRoom: (roomId) => [...rooms.values()].includes(roomId),
		markRead: (identity, room, token_) => relay.markRead(identity, room, token_),
		log
	})

	/** Provision a newly registered session, then hand it any catch-up it is owed. */
	async function bind(session: RegisteredSession): Promise<void> {
		const project = session.project
		if (project === undefined || project.length === 0) return
		const title = session.title ?? ''
		const provisioned = await provisioner.provisionSession({
			project,
			projectName: session.projectName,
			title
		})
		if (!provisioned.ok) {
			log(`bridge: provisioning ${project}/${title} failed (${provisioned.message})`)
			return
		}
		const parsed = parseSessionName(title)
		const lobbyRoomId = await roomFor(namer.lobbyAlias(project))
		const epicRoomId =
			parsed.epic === undefined
				? undefined
				: await roomFor(namer.epicRoomAlias(project, parsed.epic))
		const identity = `${project}/${title}`
		identities.set(identity, {
			identity,
			userId: sessionUser(namer, project, title),
			name: title,
			epicRoomId,
			lobbyRoomId
		})
		// Strictly after the map is complete: a catch-up wake routed before the identity has a
		// room would have nowhere to read from.
		relay.onRegistered(identity)
	}

	function identityOf(sessionId: string): string | undefined {
		for (const [identity] of identities) {
			if (serverRef().sessionForIdentity(identity) === sessionId) return identity
		}
		return undefined
	}

	// Outbound half. It reaches the same rooms the relay reads, as the sending session's own
	// user: a post made as the bridge's user would be dropped by the relay's own namespace
	// filter, so it would vanish rather than merely carry the wrong name.
	const mirror = createMatrixMirror({
		identify: (sessionId) => {
			const identity = identityOf(sessionId)
			return identity === undefined ? undefined : identities.get(identity)
		},
		post: createPoster({ client, log }),
		threads: {
			resolve: (handle) => state.resolveThread(handle),
			remember: (handle, rootEventId) => {
				state.rememberThread(handle, rootEventId)
			}
		},
		random: Math.random,
		log
	})

	return {
		relay,
		mirror,
		// Fire-and-forget with its own handler, like every other async path here: an escaped
		// rejection would reach the fatal guard and end the broker over a homeserver hiccup.
		onRegistered: (session) => {
			bind(session).catch((err: unknown) => log(`bridge: binding failed: ${err}`))
		},
		onHistory: async (sessionId, query) => {
			const identity = identityOf(sessionId)
			if (identity === undefined) return { ok: false, reason: 'unavailable' }
			return history.read(identity, query)
		},
		onMatrixReply: async (sessionId, req) => {
			const identity = identityOf(sessionId)
			if (identity === undefined) return { ok: false, reason: 'unavailable' }
			return relay.replyToHuman(identity, req)
		}
	}
}

const entryScript = fileURLToPath(import.meta.url)

function describeProblem(p: ConfigProblem): string {
	return `config ${p.severity}: ${p.path}: ${p.message}`
}

async function runForeground(paths: DaemonPaths, resolved: ResolvedConfig): Promise<void> {
	const log = (m: string) => process.stderr.write(`broker: ${m}\n`)
	// Fail loud: an unrecoverable error exits non-zero so the launchd agent
	// (KeepAlive, SuccessfulExit=false) restarts us, instead of leaving a
	// live-but-dead process the supervisor never sees. Idempotent — exits once.
	const guard = createFatalGuard({ log, exit: process.exit })
	wireFatalHandlers(process, guard)
	// Warnings and a disabled Matrix bridge are logged and survived; unusable core
	// configuration exits before the socket is ever bound.
	for (const p of resolved.problems) log(describeProblem(p))
	if (hasFatalProblem(resolved.problems)) {
		const fatal = resolved.problems.filter((p) => p.severity === 'fatal').map(describeProblem)
		guard(new Error(`unusable configuration — ${fatal.join('; ')}`))
		return
	}
	// Durable bridge bookkeeping. Reads are memory-backed and writes are debounced, so the
	// deliberate-shutdown path below flushes it; the fatal path deliberately does not, because a
	// fatal exit must stay fast and everything in here is reconstructible.
	const bridgeState = createBridgeState({
		path: join(resolved.config.channelsHome, 'bridge-state.json')
	})
	const matrix = resolved.config.matrix
	let bridge: Bridge | undefined
	// Both directions are late-bound: the relay reads the broker back through `server`, and
	// every broker hook reads the bridge back through `bridge`. Neither waits on the other.
	const server = await startBroker({
		socketPath: paths.socketPath,
		log,
		onFatal: guard,
		onRegistered: (session) => bridge?.onRegistered(session),
		onRouted: (msg) => bridge?.mirror.onRouted(msg),
		onHistory: (sessionId, query) =>
			bridge?.onHistory(sessionId, query) ?? Promise.resolve(UNAVAILABLE),
		onMatrixReply: (sessionId, req) =>
			bridge?.onMatrixReply(sessionId, req) ?? Promise.resolve(UNAVAILABLE)
	})
	// Claim the pid file for ourselves: under a launchd agent (or a bare
	// `--foreground` run) nothing else records it, and without it `status`
	// would report "not running" and `stop` would be a no-op.
	writePid(paths, process.pid)
	// Deliberate shutdown stays a clean exit(0), so SuccessfulExit=false leaves
	// us stopped rather than respawning a process the operator stopped.
	const shutdown = () => {
		removePid(paths)
		bridge?.relay.stop()
		bridgeState.flush()
		server.close().finally(() => process.exit(0))
	}
	process.on('SIGINT', shutdown)
	process.on('SIGTERM', shutdown)
	process.stderr.write(`broker: listening on ${paths.socketPath}\n`)
	// Strictly last, and never awaited by anything a session depends on: building the bridge
	// resolves a credential by running an external command whose duration we do not control.
	// A helper that waits for an approval nobody can give must leave a bound socket behind it.
	if (!matrix.enabled) {
		log(`matrix bridge off: ${matrix.disabledReason}`)
		return
	}
	const built = await buildBridge(resolved, matrix, bridgeState, () => server, log)
	if (built === undefined) return
	bridge = built
	// Only once the broker is serving: the relay's first wake has to have somewhere to go.
	built.relay.start().then(
		() => built.relay.run(),
		(err: unknown) => log(`relay: start failed: ${err}`)
	)
}

async function main(): Promise<void> {
	// Resolved once, before dispatch, so every subcommand sees the same configuration. Only the
	// serving path exits on a fatal problem: `config`, `stop` and `status` must keep working
	// against a misconfigured broker, since they are how you find and fix it.
	const resolved = loadConfig({
		home: homedir(),
		env: pickConfigEnv(process.env),
		readText: (path) => readFileSync(path, 'utf8')
	})
	const paths = daemonPaths(resolved.config.channelsHome)
	const cmd = process.argv[2]
	if (cmd === undefined || cmd === '--foreground') {
		await runForeground(paths, resolved)
		return
	}
	if (cmd === 'config') {
		process.stdout.write(formatConfigReport(resolved))
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
		`unknown command: ${cmd}\nusage: broker [start|stop|status|restart|config|--foreground]\n`
	)
	process.exit(1)
}

main().catch((err) => {
	process.stderr.write(`broker fatal: ${err instanceof Error ? err.stack : String(err)}\n`)
	process.exit(1)
})
