import { spawn } from 'node:child_process'
import {
	closeSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync
} from 'node:fs'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'
import { isPidAlive } from '../../bus/src/registry.ts'
import { createFrameDecoder, encodeFrame } from './protocol.ts'

export interface DaemonPaths {
	socketPath: string
	pidPath: string
	logPath: string
}

export function daemonPaths(channelsHome: string): DaemonPaths {
	return {
		socketPath: join(channelsHome, 'broker.sock'),
		pidPath: join(channelsHome, 'broker.pid'),
		logPath: join(channelsHome, 'broker.log')
	}
}

function readPid(pidPath: string): number | undefined {
	try {
		const n = Number.parseInt(readFileSync(pidPath, 'utf8').trim(), 10)
		return Number.isInteger(n) ? n : undefined
	} catch {
		return undefined
	}
}

export interface DaemonStatus {
	running: boolean
	pid?: number
	socketPath: string
}

export function daemonStatus(paths: DaemonPaths): DaemonStatus {
	const pid = readPid(paths.pidPath)
	const running = pid !== undefined && isPidAlive(pid)
	return { running, pid: running ? pid : undefined, socketPath: paths.socketPath }
}

export function startDaemon(paths: DaemonPaths, entryScript: string): void {
	if (daemonStatus(paths).running) throw new Error('broker already running')
	const channelsHome = dirname(paths.socketPath)
	mkdirSync(channelsHome, { recursive: true })
	const out = openSync(paths.logPath, 'a')
	const child = spawn(process.execPath, [entryScript, '--foreground'], {
		detached: true,
		stdio: ['ignore', out, out],
		env: { ...process.env, CHANNELS_HOME: channelsHome }
	})
	child.unref()
	closeSync(out)
	const tmp = `${paths.pidPath}.tmp`
	writeFileSync(tmp, String(child.pid))
	renameSync(tmp, paths.pidPath)
}

export async function stopDaemon(paths: DaemonPaths): Promise<void> {
	const pid = readPid(paths.pidPath)
	if (pid !== undefined && isPidAlive(pid)) {
		try {
			process.kill(pid, 'SIGTERM')
		} catch {
			// already gone
		}
		const start = Date.now()
		while (isPidAlive(pid) && Date.now() - start < 5000) {
			await new Promise((r) => setTimeout(r, 50))
		}
	}
	rmSync(paths.pidPath, { force: true })
}

/** Ask a running broker how many sessions are connected (undefined if unreachable). */
export function queryConnected(socketPath: string, timeoutMs = 500): Promise<number | undefined> {
	return new Promise((resolve) => {
		const sock = connect(socketPath)
		sock.setEncoding('utf8')
		const decode = createFrameDecoder()
		const finish = (v: number | undefined) => {
			sock.destroy()
			resolve(v)
		}
		const timer = setTimeout(() => finish(undefined), timeoutMs)
		sock.on('connect', () => sock.write(encodeFrame({ type: 'stats' })))
		sock.on('data', (chunk: string) => {
			for (const frame of decode(chunk)) {
				if (frame.type === 'stats_reply') {
					clearTimeout(timer)
					finish(frame.connected)
				}
			}
		})
		sock.on('error', () => {
			clearTimeout(timer)
			finish(undefined)
		})
	})
}
