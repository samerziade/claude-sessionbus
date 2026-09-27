import { connect, type Socket } from 'node:net'
import {
	createFrameDecoder,
	encodeFrame,
	type Frame,
	PROTOCOL_VERSION,
	type RegisterMeta
} from '../../broker/src/protocol.ts'
import type {
	HistoryQuery,
	HistoryResult,
	MatrixReplyRequest,
	MatrixReplyResult,
	Transport
} from './mailbox.ts'
import type { ChannelMessage } from './message.ts'

export interface SocketTransportOptions {
	socketPath: string
	initialBackoffMs?: number
	maxBackoffMs?: number
	maxOutbound?: number
	/**
	 * How long a request/reply waits for the broker. It expires rather than hanging: the caller
	 * is a session's turn, and "there is no bridge" is a complete answer where waiting forever
	 * is not.
	 */
	requestTimeoutMs?: number
	log?: (msg: string) => void
	/**
	 * What to announce beside the session id. Read afresh for every register frame and never
	 * cached, for the same reason identity is not: a title can change at any time, and a
	 * `--resume` rewrite lands moments after we start.
	 */
	announce?: () => RegisterMeta
}

const UNAVAILABLE = { ok: false, reason: 'unavailable' } as const
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000

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
	const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
	// One map per reply kind, keyed by correlation id. Two maps rather than one of a union: a
	// single map would need a cast to hand a waiter the kind it asked for, and a reply of the
	// wrong kind then finds no waiter instead of resolving the wrong promise.
	const pendingHistory = new Map<string, (value: HistoryResult) => void>()
	const pendingReply = new Map<string, (value: MatrixReplyResult) => void>()
	let requestCount = 0

	function registerFrame(sessionId: string): Frame {
		return {
			type: 'register',
			sessionId,
			protocolVersion: PROTOCOL_VERSION,
			...opts.announce?.()
		}
	}

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
		log(`broker unreachable; reconnecting in ${backoff}ms`)
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
			if (ownSessionId !== undefined) sock.write(encodeFrame(registerFrame(ownSessionId)))
			flush()
		})
		sock.on('data', (chunk: string) => {
			for (const frame of decode(chunk)) {
				if (frame.type === 'deliver' && onMessage) onMessage(frame.msg)
				// An id nobody holds is a reply to a request that has already expired; dropping it
				// is right, because resolving something twice is worse than answering late.
				else if (frame.type === 'history_reply') pendingHistory.get(frame.id)?.(frame.result)
				else if (frame.type === 'matrix_reply_result') pendingReply.get(frame.id)?.(frame.result)
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

	function awaitReply<T>(
		waiters: Map<string, (value: T) => void>,
		id: string,
		fallback: T
	): Promise<T> {
		return new Promise<T>((resolve) => {
			const timer = setTimeout(() => {
				waiters.delete(id)
				resolve(fallback)
			}, requestTimeoutMs)
			// A request in flight is not a reason to keep the process alive.
			timer.unref?.()
			waiters.set(id, (value) => {
				clearTimeout(timer)
				waiters.delete(id)
				resolve(value)
			})
		})
	}

	function nextRequestId(): string {
		requestCount += 1
		return `r-${requestCount}`
	}

	function history(query: HistoryQuery): Promise<HistoryResult> {
		const id = nextRequestId()
		const waiting = awaitReply<HistoryResult>(pendingHistory, id, UNAVAILABLE)
		enqueue({ type: 'history', id, query })
		return waiting
	}

	function replyToHuman(req: MatrixReplyRequest): Promise<MatrixReplyResult> {
		const id = nextRequestId()
		const waiting = awaitReply<MatrixReplyResult>(pendingReply, id, UNAVAILABLE)
		enqueue({ type: 'matrix_reply', id, request: req })
		return waiting
	}

	function send(recipientSessionId: string, msg: ChannelMessage): void {
		enqueue({ type: 'send', to: recipientSessionId, msg })
	}

	function rekey(sessionId: string): void {
		if (ownSessionId === sessionId) return
		ownSessionId = sessionId
		// Before 'connect' there is nothing to correct: the register frame is built from
		// ownSessionId when the socket opens, and on every reconnect after that.
		if (!connected || !socket) return
		socket.write(encodeFrame(registerFrame(sessionId)))
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

	return { send, poll, watch, rekey, history, replyToHuman }
}
