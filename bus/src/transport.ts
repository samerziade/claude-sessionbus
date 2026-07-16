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
	if (mode === 'socket') {
		return createSocketTransport({
			socketPath: opts.socketPath,
			log: (m) => process.stderr.write(`sessionbus: ${m}\n`)
		})
	}
	if (mode !== 'file') {
		process.stderr.write(`sessionbus: unknown SESSIONBUS_TRANSPORT "${mode}"; using file mailbox\n`)
	}
	return createFileMailbox(opts.channelsHome)
}
