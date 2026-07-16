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
		// A conn may register more than once: a session's id is not settled when its bus starts
		// (a `--resume` launch rewrites the registry moments later), so it corrects itself here.
		// Drop the previous binding, or the discarded id keeps resolving to us and outlives the
		// conn — but only if we still own it; another session may have taken it over since.
		const prev = sessionOf.get(conn)
		if (prev !== undefined && prev !== sessionId && conns.get(prev) === conn) conns.delete(prev)

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
