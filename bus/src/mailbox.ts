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
	/**
	 * Point an active `watch` at a different session id.
	 *
	 * Our own id is not settled when we subscribe: a `--resume` launch rewrites the registry
	 * moments after spawning us. Peers address us by the id our beacon advertises, so a
	 * subscription left on the startup id makes us silently unreachable. No-op before `watch`.
	 */
	rekey(ownSessionId: string): void
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

	let watched: string | undefined // the id `watch` is currently draining, if any
	let watcher: FSWatcher | undefined
	let observeCurrent: (() => void) | undefined // re-points the watcher at `watched`
	let stopped = false

	function watch(ownSessionId: string, onMessage: (msg: ChannelMessage) => void): () => void {
		watched = ownSessionId

		const drain = () => {
			if (watched === undefined || stopped) return
			for (const m of poll(watched)) onMessage(m)
		}

		// fs.watch is bound to one directory, so re-point it whenever the id changes; the
		// interval below is the safety net either way.
		const observe = () => {
			watcher?.close()
			watcher = undefined
			if (watched === undefined) return
			const dir = inboxDir(watched)
			mkdirSync(dir, { recursive: true })
			try {
				watcher = fsWatch(dir, () => drain()) // low-latency nudge
			} catch {
				// fs.watch unsupported here; interval still covers us
			}
			drain() // pick up anything already queued (offline messages)
		}

		observeCurrent = observe
		observe()
		const interval = setInterval(drain, POLL_MS)

		return () => {
			stopped = true
			clearInterval(interval)
			watcher?.close()
			watcher = undefined
		}
	}

	function rekey(ownSessionId: string): void {
		if (watched === ownSessionId) return
		watched = ownSessionId
		// Re-point the watcher and sweep the corrected inbox: peers have been addressing our
		// beacon id all along, so messages may already be waiting there.
		if (!stopped) observeCurrent?.()
	}

	return { send, poll, watch, rekey }
}
