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
