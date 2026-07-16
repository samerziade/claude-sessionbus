import { connect, type Socket } from 'node:net'
import {
	createFrameDecoder,
	encodeFrame,
	type Frame,
	PROTOCOL_VERSION
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
			if (ownSessionId !== undefined) {
				sock.write(
					encodeFrame({
						type: 'register',
						sessionId: ownSessionId,
						protocolVersion: PROTOCOL_VERSION
					})
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
