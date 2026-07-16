import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { daemonPaths, daemonStatus, startDaemon, stopDaemon } from './daemon.ts'

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
