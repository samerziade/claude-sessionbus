import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
	daemonPaths,
	daemonStatus,
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
