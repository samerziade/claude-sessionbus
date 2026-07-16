#!/usr/bin/env node
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	daemonPaths,
	daemonStatus,
	queryConnected,
	startDaemon,
	stopDaemon
} from './daemon.ts'
import { startBroker } from './server.ts'

const CHANNELS_HOME = process.env.CHANNELS_HOME ?? join(homedir(), '.claude', 'channels')
const paths = daemonPaths(CHANNELS_HOME)
const entryScript = fileURLToPath(import.meta.url)

async function runForeground(): Promise<void> {
	const server = await startBroker({
		socketPath: paths.socketPath,
		log: (m) => process.stderr.write(`broker: ${m}\n`)
	})
	const shutdown = () => {
		server.close().finally(() => process.exit(0))
	}
	process.on('SIGINT', shutdown)
	process.on('SIGTERM', shutdown)
	process.stderr.write(`broker: listening on ${paths.socketPath}\n`)
}

async function main(): Promise<void> {
	const cmd = process.argv[2]
	if (cmd === undefined || cmd === '--foreground') {
		await runForeground()
		return
	}
	if (cmd === 'start') {
		startDaemon(paths, entryScript)
		process.stdout.write(`broker started (${paths.socketPath})\n`)
		return
	}
	if (cmd === 'stop') {
		await stopDaemon(paths)
		process.stdout.write('broker stopped\n')
		return
	}
	if (cmd === 'restart') {
		await stopDaemon(paths)
		startDaemon(paths, entryScript)
		process.stdout.write('broker restarted\n')
		return
	}
	if (cmd === 'status') {
		const st = daemonStatus(paths)
		const connected = st.running ? await queryConnected(paths.socketPath) : undefined
		process.stdout.write(`${JSON.stringify({ ...st, connected }, null, 2)}\n`)
		return
	}
	process.stderr.write(
		`unknown command: ${cmd}\nusage: broker [start|stop|status|restart|--foreground]\n`
	)
	process.exit(1)
}

main().catch((err) => {
	process.stderr.write(`broker fatal: ${err instanceof Error ? err.stack : String(err)}\n`)
	process.exit(1)
})
