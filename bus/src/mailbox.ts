import {
	existsSync,
	type FSWatcher,
	watch as fsWatch,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import type { ChannelMessage } from './message.ts'

export interface Transport {
	/** Write a message into the recipient's inbox (atomic). */
	send(recipientSessionId: string, msg: ChannelMessage): void
	/** One inbox scan: return newly-seen messages and archive their files. */
	poll(ownSessionId: string): ChannelMessage[]
	/** Poll continuously (interval + fs.watch); returns a stop function. */
	watch(ownSessionId: string, onMessage: (msg: ChannelMessage) => void): () => void
}

const POLL_MS = 1000

export function createFileMailbox(channelsHome: string): Transport {
	const delivered = new Set<string>() // per-instance dedup across polls

	function inboxDir(sessionId: string): string {
		return join(channelsHome, 'bus', sessionId)
	}

	function send(recipientSessionId: string, msg: ChannelMessage): void {
		const dir = inboxDir(recipientSessionId)
		mkdirSync(dir, { recursive: true })
		const tmp = join(dir, `.${msg.id}.tmp`)
		const final = join(dir, `${msg.id}.json`)
		writeFileSync(tmp, JSON.stringify(msg))
		renameSync(tmp, final) // atomic on same filesystem: readers never see partial
	}

	function poll(ownSessionId: string): ChannelMessage[] {
		const dir = inboxDir(ownSessionId)
		if (!existsSync(dir)) return []
		const consumed = join(dir, 'consumed')
		mkdirSync(consumed, { recursive: true })

		const files = readdirSync(dir)
			.filter((f) => f.endsWith('.json'))
			.sort() // id has a base36 time prefix, so name order ~= arrival order

		const out: ChannelMessage[] = []
		for (const file of files) {
			const path = join(dir, file)
			let msg: ChannelMessage
			try {
				msg = JSON.parse(readFileSync(path, 'utf8')) as ChannelMessage
			} catch {
				continue // partially written; a later poll will catch it
			}
			if (!delivered.has(msg.id)) {
				delivered.add(msg.id)
				out.push(msg)
			}
			try {
				renameSync(path, join(consumed, file))
			} catch {
				// if archival races with another mover, ignore
			}
		}
		return out
	}

	function watch(ownSessionId: string, onMessage: (msg: ChannelMessage) => void): () => void {
		const dir = inboxDir(ownSessionId)
		mkdirSync(dir, { recursive: true })

		const drain = () => {
			for (const m of poll(ownSessionId)) onMessage(m)
		}

		drain() // pick up anything already queued (offline messages)
		const interval = setInterval(drain, POLL_MS)

		let watcher: FSWatcher | undefined
		try {
			watcher = fsWatch(dir, () => drain()) // low-latency nudge; poll is the safety net
		} catch {
			// fs.watch unsupported here; interval still covers us
		}

		return () => {
			clearInterval(interval)
			watcher?.close()
		}
	}

	return { send, poll, watch }
}
