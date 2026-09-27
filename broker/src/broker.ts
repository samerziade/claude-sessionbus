import type { ChannelMessage } from '../../bus/src/message.ts'
import type { Frame, RegisterMeta } from './protocol.ts'

export interface Conn {
	send(frame: Frame): void
	close(): void
}

export interface RegisteredSession extends RegisterMeta {
	sessionId: string
}

export interface BrokerCoreOptions {
	maxQueuePerSession?: number
	log?: (msg: string) => void
	/**
	 * Called after a session with a project has been bound. Fire-and-forget by contract: the
	 * broker never awaits it and catches whatever it returns, so remote work can never delay
	 * binding, acknowledgement or delivery — nor end the process through an unhandled rejection.
	 */
	onRegistered?: (session: RegisteredSession) => void | Promise<void>
	/**
	 * Called once after every `route()` call, with the message that was routed, whether it was
	 * delivered to a live connection or queued for one. Fire-and-forget on the same contract as
	 * `onRegistered`: never awaited, and whatever it throws or rejects with is caught here.
	 *
	 * It fires once per recipient, so a fan-out whose copies share one id calls it once per
	 * copy. Recognizing that as one message is the observer's job, not routing's — the broker
	 * core has no notion of having seen a message before.
	 */
	onRouted?: (msg: ChannelMessage) => void | Promise<void>
}

export interface BrokerCore {
	register(conn: Conn, sessionId: string, meta?: RegisterMeta): void
	route(to: string, msg: ChannelMessage): void
	disconnect(conn: Conn): void
	connectedCount(): number
	/** The session id currently holding a work identity, or nothing. */
	sessionForIdentity(identity: string): string | undefined
	identityForSession(sessionId: string): string | undefined
}

/**
 * The work identity a registration claims, or nothing when it announces no project. Pure, so
 * both sides of the map agree by construction rather than by convention.
 */
export function workIdentity(meta: RegisterMeta | undefined): string | undefined {
	if (meta?.project === undefined || meta.project.length === 0) return undefined
	return `${meta.project}/${meta.title ?? ''}`
}

export function createBrokerCore(opts: BrokerCoreOptions = {}): BrokerCore {
	const maxQueue = opts.maxQueuePerSession ?? 1000
	const log = opts.log ?? (() => {})
	const conns = new Map<string, Conn>() // sessionId -> current conn
	const sessionOf = new Map<Conn, string>() // conn -> sessionId
	const queues = new Map<string, ChannelMessage[]>() // sessionId -> pending
	const identityOf = new Map<string, string>() // sessionId -> work identity
	const sessionOfIdentity = new Map<string, string>() // work identity -> sessionId

	/**
	 * Rebuild both halves of the identity map, never append to one. A session registers more
	 * than once — a resumed launch corrects its id moments after start — so an entry left
	 * pointing at the discarded id would address a session nobody answers to. Two structures
	 * that name a session move together, or one of them is a silent dead letter.
	 */
	function remapIdentity(sessionId: string, meta: RegisterMeta | undefined): void {
		const previous = identityOf.get(sessionId)
		if (previous !== undefined && sessionOfIdentity.get(previous) === sessionId) {
			sessionOfIdentity.delete(previous)
		}
		identityOf.delete(sessionId)
		const identity = workIdentity(meta)
		if (identity === undefined) return
		const held = sessionOfIdentity.get(identity)
		if (held !== undefined && held !== sessionId) identityOf.delete(held)
		identityOf.set(sessionId, identity)
		sessionOfIdentity.set(identity, sessionId)
	}

	function register(conn: Conn, sessionId: string, meta?: RegisterMeta): void {
		// A conn may register more than once: a session's id is not settled when its bus starts
		// (a `--resume` launch rewrites the registry moments later), so it corrects itself here.
		// Drop the previous binding, or the discarded id keeps resolving to us and outlives the
		// conn — but only if we still own it; another session may have taken it over since.
		const prev = sessionOf.get(conn)
		if (prev !== undefined && prev !== sessionId && conns.get(prev) === conn) {
			conns.delete(prev)
			remapIdentity(prev, undefined)
		}
		remapIdentity(sessionId, meta)

		conns.set(sessionId, conn)
		sessionOf.set(conn, sessionId)
		const q = queues.get(sessionId)
		if (q && q.length > 0) {
			for (const msg of q) conn.send({ type: 'deliver', msg })
			queues.delete(sessionId)
		}
		// Strictly last, and never awaited: everything above is the binding this session
		// depends on, and a hook that is slow, failing or never settling may not touch it. Its
		// own `catch` is what keeps a homeserver outage from reaching the fatal handlers and
		// exiting the broker through the back door.
		if (opts.onRegistered !== undefined && workIdentity(meta) !== undefined) {
			try {
				const pending = opts.onRegistered({ sessionId, ...meta })
				if (pending !== undefined) pending.catch((err: unknown) => log(`onRegistered: ${err}`))
			} catch (err) {
				log(`onRegistered: ${err}`)
			}
		}
	}

	/**
	 * Hand the routed message to the observer, if there is one. Strictly after routing and
	 * never able to affect it: an observer is a mirror of what happened, and a mirror that can
	 * break delivery is worse than no mirror. Its rejection is caught here because the process
	 * hosting this treats an unhandled rejection as fatal, so one un-caught post failure would
	 * end the broker through the back door.
	 */
	function observeRouted(msg: ChannelMessage): void {
		if (opts.onRouted === undefined) return
		try {
			const pending = opts.onRouted(msg)
			if (pending !== undefined) pending.catch((err: unknown) => log(`onRouted: ${err}`))
		} catch (err) {
			log(`onRouted: ${err}`)
		}
	}

	function route(to: string, msg: ChannelMessage): void {
		const conn = conns.get(to)
		if (conn) {
			conn.send({ type: 'deliver', msg })
			observeRouted(msg)
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
		observeRouted(msg)
	}

	function disconnect(conn: Conn): void {
		const sessionId = sessionOf.get(conn)
		if (sessionId === undefined) return
		sessionOf.delete(conn)
		if (conns.get(sessionId) === conn) {
			conns.delete(sessionId)
			remapIdentity(sessionId, undefined)
		}
	}

	function connectedCount(): number {
		return conns.size
	}

	return {
		register,
		route,
		disconnect,
		connectedCount,
		sessionForIdentity: (identity) => sessionOfIdentity.get(identity),
		identityForSession: (sessionId) => identityOf.get(sessionId)
	}
}
