import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { configFilePath, resolveConfig } from './config.ts'
import {
	daemonPaths,
	daemonStatus,
	queryConnected,
	removePid,
	startDaemon,
	stopDaemon,
	writePid
} from './daemon.ts'

const entryScript = fileURLToPath(new URL('./index.ts', import.meta.url))
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
	for (const c of cleanups.splice(0).reverse()) await c()
})

// tempHome keeps the socket path short (macOS sun_path limit ~104 chars)
function tempHome(): string {
	const dir = mkdtempSync(join(tmpdir(), 'ch-'))
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
	return dir
}

async function waitFor(pred: () => boolean, timeoutMs = 4000): Promise<void> {
	const start = Date.now()
	while (!pred()) {
		if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
		await new Promise((r) => setTimeout(r, 30))
	}
}

describe('pid file', () => {
	it('writePid makes daemonStatus report the process as running', () => {
		const paths = daemonPaths(tempHome())
		expect(daemonStatus(paths).running).toBe(false)
		writePid(paths, process.pid) // our own pid is definitionally alive
		expect(daemonStatus(paths)).toMatchObject({ running: true, pid: process.pid })
	})

	it('removePid makes daemonStatus report not running', () => {
		const paths = daemonPaths(tempHome())
		writePid(paths, process.pid)
		removePid(paths)
		expect(daemonStatus(paths).running).toBe(false)
		expect(existsSync(paths.pidPath)).toBe(false)
	})

	it('writePid creates the channels dir if absent and overwrites a stale pid', () => {
		const paths = daemonPaths(join(tempHome(), 'nested'))
		writePid(paths, 999_999_999) // dead pid -> not running
		expect(daemonStatus(paths).running).toBe(false)
		writePid(paths, process.pid) // overwrite with a live one
		expect(daemonStatus(paths)).toMatchObject({ running: true, pid: process.pid })
	})
})

describe('daemon control', () => {
	it('start writes a pid, brings up the socket; stop tears it down', async () => {
		const paths = daemonPaths(tempHome())
		startDaemon(paths, entryScript)
		cleanups.push(() => stopDaemon(paths))
		await waitFor(() => daemonStatus(paths).running && existsSync(paths.socketPath))
		expect(daemonStatus(paths).running).toBe(true)

		await stopDaemon(paths)
		await waitFor(() => !daemonStatus(paths).running)
		expect(existsSync(paths.pidPath)).toBe(false)
	})

	it('start refuses when a daemon is already running', async () => {
		const paths = daemonPaths(tempHome())
		startDaemon(paths, entryScript)
		cleanups.push(() => stopDaemon(paths))
		await waitFor(() => daemonStatus(paths).running)
		expect(() => startDaemon(paths, entryScript)).toThrow(/already running/)
	})
})

describe('a broker whose token command never answers', () => {
	/**
	 * A home holding a bridge configuration whose credential helper does not come back. This is
	 * what a supervisor sees: no terminal to approve anything at, and a helper content to wait
	 * for an approval forever. Well under the token deadline, so nothing is left running.
	 */
	function homeWithHangingHelper(): string {
		const home = tempHome()
		const file = {
			transport: 'socket',
			matrix: {
				enabled: true,
				url: 'https://matrix.invalid',
				domain: 'matrix.invalid',
				owner: '@nobody:matrix.invalid',
				rootSpace: '#nobody:matrix.invalid',
				tokenCommand: ['sleep', '20']
			}
		}
		// Asserted, not assumed: a fixture the bridge rejects would run no command at all, and
		// this case would pass while proving nothing.
		expect(resolveConfig({ file, env: {}, home }).config.matrix.enabled).toBe(true)
		const configPath = configFilePath(home)
		mkdirSync(dirname(configPath), { recursive: true })
		writeFileSync(configPath, JSON.stringify(file))
		return home
	}

	it('binds and serves while the helper is still outstanding', async () => {
		const home = homeWithHangingHelper()
		const paths = daemonPaths(tempHome())
		const realHome = process.env.HOME
		process.env.HOME = home
		cleanups.push(() => {
			if (realHome === undefined) delete process.env.HOME
			else process.env.HOME = realHome
		})

		startDaemon(paths, entryScript)
		cleanups.push(() => stopDaemon(paths))

		// The helper cannot have answered in this window, so a socket here is a socket bound
		// ahead of it. `connected` proves more than the socket file does: the broker answered,
		// so its event loop is free rather than blocked inside the command.
		await waitFor(() => daemonStatus(paths).running && existsSync(paths.socketPath))
		expect(await queryConnected(paths.socketPath)).toBe(0)
	})
})
