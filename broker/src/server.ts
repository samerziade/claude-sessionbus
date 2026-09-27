import { existsSync, unlinkSync } from 'node:fs'
import { connect, createServer, type Socket } from 'node:net'
import type {
	HistoryQuery,
	HistoryResult,
	MatrixReplyRequest,
	MatrixReplyResult
} from '../../bus/src/mailbox.ts'
import type { ChannelMessage } from '../../bus/src/message.ts'
import { type Conn, createBrokerCore, type RegisteredSession } from './broker.ts'
import { createFrameDecoder, encodeFrame, PROTOCOL_VERSION } from './protocol.ts'

export interface BrokerServer {
	connectedCount(): number
	/**
	 * The core's own `route`, exposed so the inbound relay can use it rather than open a second
	 * delivery path. A relayed wake converges on exactly the call a local send makes.
	 */
	route(to: string, msg: ChannelMessage): void
	/** The session id currently holding a work identity — re-read per wake, never cached. */
	sessionForIdentity(identity: string): string | undefined
	close(): Promise<void>
}

export interface StartBrokerOptions {
	socketPath: string
	log?: (msg: string) => void
	// Invoked on an unrecoverable post-listen listener error. Optional and log-only by
	// default so `startBroker` stays embeddable; the supervised broker (index.ts) wires
	// this to a fatal guard that exits non-zero so launchd restarts it.
	onFatal?: (err: Error) => void
	// Invoked after a session announcing a project has been bound and acknowledged. Never
	// awaited: remote provisioning may not delay local binding or delivery.
	onRegistered?: (session: RegisteredSession) => void | Promise<void>
	/**
	 * Called once per routed message, with the message that was routed. This is the outbound
	 * mirror's seam. Like `onRegistered` it is fire-and-forget: the core catches whatever it
	 * throws or rejects with, so a homeserver outage can never delay or break local delivery.
	 */
	onRouted?: (msg: ChannelMessage) => void | Promise<void>
	/**
	 * Answer a session's history read. Absent means there is no bridge, which is answered as
	 * `unavailable` — a complete answer, not an error, so a session's turn is never broken by
	 * the bridge being off.
	 */
	onHistory?: (sessionId: string, query: HistoryQuery) => Promise<HistoryResult>
	/** Post a session's reply to a person. Absent means there is no bridge. */
	onMatrixReply?: (sessionId: string, req: MatrixReplyRequest) => Promise<MatrixReplyResult>
}

/**
 * The complete answer to any bridge request made while there is no bridge — the bridge is off,
 * its configuration was rejected, or it has not been constructed yet. Exported because it is
 * the one canonical shape of that answer, and a second copy of it could drift.
 */
export const UNAVAILABLE = { ok: false, reason: 'unavailable' } as const

export interface ServerErrorDeps {
	log: (msg: string) => void
	onFatal?: (err: Error) => void
}

/**
 * Handle a listen-socket `error` raised after the broker is serving. Always logs; when an
 * `onFatal` is wired, forwards the error so the owner can fail loud. Named (not an inline
 * closure) so the fail-loud routing is unit-testable without a real listener error.
 */
export function handleServerError(err: Error, deps: ServerErrorDeps): void {
	deps.log(`server error: ${err.message}`)
	deps.onFatal?.(err)
}

/**
 * Run a bridge handler if there is one and the connection is bound to a session. An unbound
 * connection has not registered, so there is no identity to answer for.
 */
function answer<Req, Res extends { ok: false; reason: 'unavailable' } | { ok: boolean }>(
	handler: ((sessionId: string, req: Req) => Promise<Res>) | undefined,
	sessionId: string | undefined,
	req: Req
): Promise<Res | typeof UNAVAILABLE> {
	if (handler === undefined || sessionId === undefined) return Promise.resolve(UNAVAILABLE)
	return handler(sessionId, req)
}

export function startBroker(opts: StartBrokerOptions): Promise<BrokerServer> {
	const log = opts.log ?? (() => {})
	const onFatal = opts.onFatal
	return reclaimSocket(opts.socketPath).then(
		() =>
			new Promise<BrokerServer>((resolve, reject) => {
				const core = createBrokerCore({
					log,
					onRegistered: opts.onRegistered,
					onRouted: opts.onRouted
				})
				const sockets = new Set<Socket>()
				const server = createServer((socket) => {
					sockets.add(socket)
					socket.once('close', () => sockets.delete(socket))
					const conn: Conn = {
						send: (frame) => {
							socket.write(encodeFrame(frame))
						},
						close: () => socket.destroy()
					}
					const decode = createFrameDecoder()
					socket.setEncoding('utf8')
					// Which session this connection speaks for, so a bridge request is attributed
					// without the client having to name itself on every frame.
					let bound: string | undefined
					socket.on('data', (chunk: string) => {
						for (const frame of decode(chunk)) {
							if (frame.type === 'register') {
								if (frame.protocolVersion !== PROTOCOL_VERSION) {
									log(`rejecting client: protocol ${frame.protocolVersion} != ${PROTOCOL_VERSION}`)
									socket.destroy()
									return
								}
								// Acknowledge first, bind second, announce third — in that order, so a
								// session is never waiting on anything remote to become reachable.
								conn.send({ type: 'welcome', protocolVersion: PROTOCOL_VERSION })
								bound = frame.sessionId
								core.register(conn, frame.sessionId, {
									project: frame.project,
									projectName: frame.projectName,
									title: frame.title
								})
							} else if (frame.type === 'send') {
								core.route(frame.to, frame.msg)
							} else if (frame.type === 'stats') {
								conn.send({ type: 'stats_reply', connected: core.connectedCount() })
							} else if (frame.type === 'history') {
								const id = frame.id
								const query = frame.query
								// Every bridge call carries its own handler: an escaped rejection here
								// would reach the process's fatal handlers and end the broker.
								answer(opts.onHistory, bound, query)
									.then((result) => conn.send({ type: 'history_reply', id, result }))
									.catch((err: unknown) => {
										log(`history request failed: ${err}`)
										conn.send({ type: 'history_reply', id, result: UNAVAILABLE })
									})
							} else if (frame.type === 'matrix_reply') {
								const id = frame.id
								const request = frame.request
								answer(opts.onMatrixReply, bound, request)
									.then((result) => conn.send({ type: 'matrix_reply_result', id, result }))
									.catch((err: unknown) => {
										log(`matrix reply failed: ${err}`)
										conn.send({ type: 'matrix_reply_result', id, result: UNAVAILABLE })
									})
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
					server.on('error', (err) =>
						handleServerError(err instanceof Error ? err : new Error(String(err)), {
							log,
							onFatal
						})
					)
					resolve({
						connectedCount: () => core.connectedCount(),
						route: (to, msg) => core.route(to, msg),
						sessionForIdentity: (identity) => core.sessionForIdentity(identity),
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
								// net.Server.close() only finishes once every open connection has
								// ended; nothing ends them on its own, so force-close the ones
								// still live rather than hang waiting for a client to disconnect.
								for (const socket of sockets) socket.destroy()
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
