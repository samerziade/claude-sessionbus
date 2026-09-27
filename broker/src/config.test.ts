import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	CONFIG_FILE_LABEL,
	type ConfigProblem,
	configFilePath,
	formatConfigReport,
	hasFatalProblem,
	loadConfig,
	pickConfigEnv,
	type ResolvedConfig,
	resolveConfig,
	resolveMatrixToken,
	TOKEN_DEADLINE_MS,
	type TokenChild
} from './config.ts'

const HOME = '/home/tester'
const DEFAULT_CHANNELS = join(HOME, '.claude', 'channels')

/** A well-formed, enabled `matrix` block — every required field present and well-typed. */
function goodMatrix(): Record<string, unknown> {
	return {
		enabled: true,
		url: 'https://matrix.example',
		tokenCommand: ['op', 'read', 'op://vault/item/field'],
		rootSpace: '#claude:example',
		owner: '@operator:example',
		domain: 'matrix.example'
	}
}

function resolve(file: unknown, env: Record<string, string> = {}): ResolvedConfig {
	return resolveConfig({ file, env, home: HOME })
}

function problemsAt(resolved: ResolvedConfig, prefix: string): ConfigProblem[] {
	return resolved.problems.filter((p) => p.path.startsWith(prefix))
}

describe('resolveConfig — precedence', () => {
	const prev = process.env.SESSIONBUS_TRANSPORT
	afterEach(() => {
		if (prev === undefined) delete process.env.SESSIONBUS_TRANSPORT
		else process.env.SESSIONBUS_TRANSPORT = prev
	})

	it('applies built-in defaults when neither file nor env supply a value', () => {
		const r = resolve(undefined)
		expect(r.config.transport).toBe('file')
		expect(r.config.channelsHome).toBe(DEFAULT_CHANNELS)
		expect(r.config.projects).toEqual({})
		expect(r.config.matrix.namespacePrefix).toBe('cc')
		expect(r.config.matrix.unreadCap).toEqual({ messages: 20, chars: 2000 })
		expect(r.sources.transport).toBe('default')
		expect(r.sources.channelsHome).toBe('default')
		expect(r.problems).toEqual([])
	})

	it('lets a file value override the default', () => {
		const r = resolve({ transport: 'socket', channelsHome: '/srv/channels' })
		expect(r.config.transport).toBe('socket')
		expect(r.config.channelsHome).toBe('/srv/channels')
		expect(r.sources.transport).toBe('file')
		expect(r.sources.channelsHome).toBe('file')
	})

	it('lets an env value override both the file and the default', () => {
		const r = resolve(
			{ transport: 'socket', channelsHome: '/srv/channels' },
			{ SESSIONBUS_TRANSPORT: 'file', CHANNELS_HOME: '/env/channels' }
		)
		expect(r.config.transport).toBe('file')
		expect(r.config.channelsHome).toBe('/env/channels')
		expect(r.sources.transport).toBe('env')
		expect(r.sources.channelsHome).toBe('env')
	})

	it('overrides field by field, not layer by layer', () => {
		const r = resolve({ transport: 'socket' }, { CHANNELS_HOME: '/env/channels' })
		expect(r.config.transport).toBe('socket')
		expect(r.sources.transport).toBe('file')
		expect(r.config.channelsHome).toBe('/env/channels')
		expect(r.sources.channelsHome).toBe('env')
	})

	it('expands a leading ~ in channelsHome against the given home', () => {
		expect(resolve({ channelsHome: '~/.claude/channels' }).config.channelsHome).toBe(
			DEFAULT_CHANNELS
		)
		expect(resolve({ channelsHome: '~' }).config.channelsHome).toBe(HOME)
		// `~user` is not ours to expand: left alone.
		expect(resolve({ channelsHome: '~other/x' }).config.channelsHome).toBe('~other/x')
	})

	it('is deterministic regardless of ambient process.env', () => {
		const input = { file: { transport: 'socket' }, env: {}, home: HOME }
		process.env.SESSIONBUS_TRANSPORT = 'file'
		const first = resolveConfig(input)
		process.env.SESSIONBUS_TRANSPORT = 'carrier-pigeon'
		const second = resolveConfig(input)
		expect(second).toEqual(first)
		expect(first.config.transport).toBe('socket')
	})

	it('does not mutate its file argument', () => {
		const file = { transport: 'socket', spelling: 'wrong', matrix: goodMatrix() }
		const snapshot = structuredClone(file)
		resolve(file)
		expect(file).toEqual(snapshot)
	})
})

describe('resolveConfig — problems are data', () => {
	it.each([
		['an array', []],
		['a string', 'oops'],
		['null', null],
		['a number', 42]
	])('never throws on %s and falls back to all-defaults with one warning', (_label, file) => {
		const r = resolve(file)
		expect(r.config).toEqual(resolve(undefined).config)
		expect(r.problems).toHaveLength(1)
		expect(r.problems[0].severity).toBe('warning')
	})

	it('reports no problem for a missing file', () => {
		expect(resolve(undefined).problems).toEqual([])
	})

	it('reports no problem for an empty file object', () => {
		expect(resolve({}).problems).toEqual([])
	})

	it('reports every independent problem, not just the first', () => {
		const r = resolve({ spelling: 'wrong', matrix: { enabled: true } })
		expect(r.problems.some((p) => p.path === 'spelling')).toBe(true)
		expect(problemsAt(r, 'matrix').some((p) => p.severity === 'invalid')).toBe(true)
	})

	it('gives every problem a non-empty message', () => {
		const r = resolve({ spelling: 1, channelsHome: '', transport: 7, matrix: { enabled: true } })
		expect(r.problems.length).toBeGreaterThan(0)
		for (const p of r.problems) expect(p.message.length).toBeGreaterThan(0)
	})
})

describe('resolveConfig — core fatal', () => {
	it('treats an empty-string channelsHome as fatal', () => {
		const r = resolve({ channelsHome: '' })
		expect(r.problems).toContainEqual(
			expect.objectContaining({ severity: 'fatal', path: 'channelsHome' })
		)
		expect(r.config.channelsHome).toBe(DEFAULT_CHANNELS)
	})

	it.each([
		['a number', 42],
		['an array', ['/a']],
		['an object', { path: '/a' }],
		['null', null]
	])('treats a channelsHome of %s as fatal and falls back to the default', (_label, value) => {
		const r = resolve({ channelsHome: value })
		expect(r.problems).toContainEqual(
			expect.objectContaining({ severity: 'fatal', path: 'channelsHome' })
		)
		expect(r.config.channelsHome).toBe(DEFAULT_CHANNELS)
		expect(r.sources.channelsHome).toBe('default')
	})

	it('treats an empty CHANNELS_HOME from the environment as fatal', () => {
		const r = resolve({ channelsHome: '/srv/channels' }, { CHANNELS_HOME: '' })
		expect(r.problems).toContainEqual(
			expect.objectContaining({ severity: 'fatal', path: 'channelsHome' })
		)
	})

	it('treats an unrecognized transport as a warning and falls back to file', () => {
		const r = resolve({ transport: 'carrier-pigeon' })
		expect(r.problems).toContainEqual(
			expect.objectContaining({ severity: 'warning', path: 'transport' })
		)
		expect(r.config.transport).toBe('file')
		expect(r.problems.some((p) => p.severity === 'fatal')).toBe(false)
	})

	it('treats an unrecognized SESSIONBUS_TRANSPORT as a warning and falls back to file', () => {
		const r = resolve({ transport: 'socket' }, { SESSIONBUS_TRANSPORT: 'bogus' })
		expect(r.problems).toContainEqual(
			expect.objectContaining({ severity: 'warning', path: 'transport' })
		)
		expect(r.config.transport).toBe('file')
	})

	it('produces no fatal problem from any field other than channelsHome', () => {
		const r = resolve({
			transport: 12,
			projects: 'nope',
			matrix: 'nope',
			extra: true
		})
		expect(r.problems.filter((p) => p.severity === 'fatal')).toEqual([])
	})
})

describe('resolveConfig — matrix', () => {
	it('treats an enabled but incomplete matrix block as invalid and forces it off', () => {
		const r = resolve({ matrix: { enabled: true, url: 'https://example.test' } })
		const matrixProblems = problemsAt(r, 'matrix')
		expect(matrixProblems.some((p) => p.severity === 'invalid')).toBe(true)
		expect(matrixProblems.some((p) => p.severity === 'fatal')).toBe(false)
		expect(r.config.matrix.enabled).toBe(false)
	})

	it('names each missing required field', () => {
		const r = resolve({ matrix: { enabled: true, url: 'https://example.test' } })
		const paths = problemsAt(r, 'matrix').map((p) => p.path)
		expect(paths).toEqual(
			expect.arrayContaining([
				'matrix.tokenCommand',
				'matrix.rootSpace',
				'matrix.owner',
				'matrix.domain'
			])
		)
		expect(paths).not.toContain('matrix.url')
	})

	it('disables the bridge when the homeserver domain is missing', () => {
		const { domain: _omitted, ...withoutDomain } = goodMatrix()

		const r = resolve({ matrix: withoutDomain })

		expect(problemsAt(r, 'matrix.domain')).toHaveLength(1)
		expect(problemsAt(r, 'matrix.domain')[0].severity).toBe('invalid')
		expect(r.config.matrix.enabled).toBe(false)
	})

	it('disables the bridge when the homeserver domain is malformed', () => {
		for (const domain of [12345, '', null, ['matrix.example']]) {
			const r = resolve({ matrix: { ...goodMatrix(), domain } })

			expect(problemsAt(r, 'matrix.domain')).toHaveLength(1)
			expect(r.config.matrix.enabled).toBe(false)
		}
	})

	it('never infers the homeserver domain from the url or the owner', () => {
		// A server name is not reliably its URL host, and the operator need not live on the
		// homeserver the bridge talks to. Both guesses are silent when wrong, and a wrong
		// domain mints a different identifier for every user and room.
		const { domain: _omitted, ...withoutDomain } = goodMatrix()

		const r = resolve({ matrix: withoutDomain })

		expect(r.config.matrix.domain).toBeUndefined()
	})

	it('does not take the homeserver domain from the environment', () => {
		const { domain: _omitted, ...withoutDomain } = goodMatrix()

		const r = resolve(
			{ matrix: withoutDomain },
			{
				CHANNELS_HOME: '/tmp/ch',
				SESSIONBUS_TRANSPORT: 'socket',
				SESSIONBUS_MATRIX_DOMAIN: 'matrix.example'
			}
		)

		expect(r.config.matrix.domain).toBeUndefined()
		expect(r.config.matrix.enabled).toBe(false)
		expect(r.sources['matrix.domain']).toBe('default')
	})

	it('produces no problem for a malformed but disabled matrix block', () => {
		const r = resolve({ matrix: { enabled: false, url: 12345 } })
		expect(problemsAt(r, 'matrix')).toEqual([])
		expect(r.config.matrix.enabled).toBe(false)
		expect(r.config.matrix.url).toBeUndefined()
	})

	it('resolves a well-formed enabled matrix block cleanly', () => {
		const r = resolve({ matrix: goodMatrix() })
		expect(problemsAt(r, 'matrix')).toEqual([])
		expect(r.config.matrix).toEqual({
			enabled: true,
			url: 'https://matrix.example',
			tokenCommand: ['op', 'read', 'op://vault/item/field'],
			rootSpace: '#claude:example',
			owner: '@operator:example',
			domain: 'matrix.example',
			namespacePrefix: 'cc',
			unreadCap: { messages: 20, chars: 2000 }
		})
		expect(r.sources['matrix.enabled']).toBe('file')
		expect(r.sources['matrix.url']).toBe('file')
		expect(r.sources['matrix.namespacePrefix']).toBe('default')
	})

	it('takes namespacePrefix and unreadCap overrides from the file', () => {
		const r = resolve({
			matrix: { ...goodMatrix(), namespacePrefix: 'zz', unreadCap: { messages: 5, chars: 99 } }
		})
		expect(r.config.matrix.namespacePrefix).toBe('zz')
		expect(r.config.matrix.unreadCap).toEqual({ messages: 5, chars: 99 })
		expect(r.sources['matrix.unreadCap.messages']).toBe('file')
		expect(r.sources['matrix.unreadCap.chars']).toBe('file')
	})

	it.each([
		['an empty tokenCommand', { tokenCommand: [] }, 'matrix.tokenCommand'],
		['a string tokenCommand', { tokenCommand: 'op read x' }, 'matrix.tokenCommand'],
		['a tokenCommand with a non-string', { tokenCommand: ['op', 3] }, 'matrix.tokenCommand'],
		['an empty url', { url: '' }, 'matrix.url'],
		['an empty namespacePrefix', { namespacePrefix: '' }, 'matrix.namespacePrefix'],
		['a zero unreadCap.messages', { unreadCap: { messages: 0 } }, 'matrix.unreadCap.messages'],
		['a fractional unreadCap.chars', { unreadCap: { chars: 1.5 } }, 'matrix.unreadCap.chars'],
		['a non-object unreadCap', { unreadCap: 20 }, 'matrix.unreadCap']
	])('treats %s in an enabled block as invalid', (_label, patch, path) => {
		const r = resolve({ matrix: { ...goodMatrix(), ...patch } })
		expect(r.problems).toContainEqual(expect.objectContaining({ severity: 'invalid', path }))
		expect(r.config.matrix.enabled).toBe(false)
	})

	it('treats a non-object matrix value as invalid', () => {
		const r = resolve({ matrix: 'on' })
		expect(r.problems).toContainEqual(
			expect.objectContaining({ severity: 'invalid', path: 'matrix' })
		)
		expect(r.config.matrix.enabled).toBe(false)
	})

	it('treats a non-boolean matrix.enabled as invalid rather than guessing', () => {
		const r = resolve({ matrix: { ...goodMatrix(), enabled: 'yes' } })
		expect(r.problems).toContainEqual(
			expect.objectContaining({ severity: 'invalid', path: 'matrix.enabled' })
		)
		expect(r.config.matrix.enabled).toBe(false)
	})

	it('keeps the partial unreadCap defaults when only one cap is given', () => {
		const r = resolve({ matrix: { ...goodMatrix(), unreadCap: { messages: 3 } } })
		expect(r.config.matrix.unreadCap).toEqual({ messages: 3, chars: 2000 })
		expect(r.sources['matrix.unreadCap.chars']).toBe('default')
	})
})

describe('resolveConfig — matrix disabled reason', () => {
	it('marks a bridge nobody enabled as not-enabled', () => {
		const r = resolve(undefined)
		expect(r.config.matrix.enabled).toBe(false)
		if (r.config.matrix.enabled) return
		expect(r.config.matrix.disabledReason).toBe('not-enabled')
	})

	it('marks an explicitly disabled bridge as not-enabled', () => {
		const r = resolve({ matrix: { ...goodMatrix(), enabled: false } })
		if (r.config.matrix.enabled) throw new Error('expected disabled')
		expect(r.config.matrix.disabledReason).toBe('not-enabled')
	})

	it('marks a bridge forced off by a malformed block as invalid-config', () => {
		const r = resolve({ matrix: { enabled: true, url: 'https://example.test' } })
		expect(r.config.matrix.enabled).toBe(false)
		if (r.config.matrix.enabled) return
		expect(r.config.matrix.disabledReason).toBe('invalid-config')
	})

	it('marks a non-object matrix value as invalid-config', () => {
		const r = resolve({ matrix: ['enabled'] })
		if (r.config.matrix.enabled) throw new Error('expected disabled')
		expect(r.config.matrix.disabledReason).toBe('invalid-config')
	})

	it('gives an enabled bridge no disabled reason', () => {
		const r = resolve({ matrix: goodMatrix() })
		expect(r.config.matrix.enabled).toBe(true)
		expect('disabledReason' in r.config.matrix).toBe(false)
	})
})

describe('resolveConfig — unknown keys', () => {
	it('warns about and drops an unknown top-level key, still resolving the rest', () => {
		const r = resolve({ transport: 'socket', spelling: 'wrong' })
		expect(r.problems).toEqual([expect.objectContaining({ severity: 'warning', path: 'spelling' })])
		expect(r.config.transport).toBe('socket')
		expect('spelling' in r.config).toBe(false)
	})

	it('warns once per unknown key', () => {
		const r = resolve({ a: 1, b: 2 })
		expect(r.problems.map((p) => p.path).sort()).toEqual(['a', 'b'])
	})

	it('warns about an unknown key inside matrix without disabling a good bridge', () => {
		const r = resolve({ matrix: { ...goodMatrix(), homeserverColour: 'blue' } })
		expect(r.problems).toEqual([
			expect.objectContaining({ severity: 'warning', path: 'matrix.homeserverColour' })
		])
		expect(r.config.matrix.enabled).toBe(true)
		expect('homeserverColour' in r.config.matrix).toBe(false)
	})

	it('warns about an unknown key inside a disabled matrix block too', () => {
		const r = resolve({ matrix: { enabled: false, homeserverColour: 'blue' } })
		expect(r.problems).toEqual([
			expect.objectContaining({ severity: 'warning', path: 'matrix.homeserverColour' })
		])
	})
})

describe('resolveConfig — projects', () => {
	it('resolves a string-to-string projects map from the file', () => {
		const r = resolve({ projects: { '/abs/repo': 'sessionbus' } })
		expect(r.config.projects).toEqual({ '/abs/repo': 'sessionbus' })
		expect(r.sources.projects).toBe('file')
	})

	it('drops a non-string entry with a warning and keeps the rest', () => {
		const r = resolve({ projects: { '/a': 'alpha', '/b': 7 } })
		expect(r.config.projects).toEqual({ '/a': 'alpha' })
		expect(r.problems).toEqual([
			expect.objectContaining({ severity: 'warning', path: 'projects./b' })
		])
	})

	it('warns about a non-object projects value and resolves an empty map', () => {
		const r = resolve({ projects: ['/a'] })
		expect(r.config.projects).toEqual({})
		expect(r.problems).toEqual([expect.objectContaining({ severity: 'warning', path: 'projects' })])
		expect(r.sources.projects).toBe('default')
	})
})

describe('formatConfigReport', () => {
	function lineFor(report: string, path: string): string | undefined {
		return report.split('\n').find((l) => l.startsWith(`${path} = `))
	}

	it('names each field and the source it came from', () => {
		const r = resolve({}, { CHANNELS_HOME: '/env/channels' })
		const report = formatConfigReport(r)
		expect(lineFor(report, 'channelsHome')).toBe('channelsHome = "/env/channels" (env)')
		expect(lineFor(report, 'transport')).toBe('transport = "file" (default)')
	})

	it('reports a file source', () => {
		const report = formatConfigReport(resolve({ transport: 'socket' }))
		expect(lineFor(report, 'transport')).toBe('transport = "socket" (file)')
	})

	it('reports the homeserver domain with its source', () => {
		const report = formatConfigReport(resolve({ matrix: goodMatrix() }))

		expect(lineFor(report, 'matrix.domain')).toBe('matrix.domain = "matrix.example" (file)')
	})

	it('reports every leaf the resolver can set', () => {
		const r = resolve({ matrix: goodMatrix() })
		const report = formatConfigReport(r)
		for (const path of Object.keys(r.sources)) {
			expect(lineFor(report, path), path).toMatch(/\((default|file|env)\)$/)
		}
	})

	it('marks unset optional fields rather than omitting them', () => {
		const report = formatConfigReport(resolve(undefined))
		expect(lineFor(report, 'matrix.url')).toBe('matrix.url = (unset) (default)')
	})

	it('still renders a full report alongside a fatal problem', () => {
		const r = resolve({ channelsHome: '' })
		const fatal = r.problems.find((p) => p.severity === 'fatal')
		expect(fatal).toBeDefined()
		if (!fatal) return
		const report = formatConfigReport(r)
		expect(report).toContain(`fatal: ${fatal.path}: ${fatal.message}`)
		expect(lineFor(report, 'channelsHome')).toMatch(/\(default\)$/)
		expect(lineFor(report, 'transport')).toMatch(/\(default\)$/)
	})

	it('lists problems of every severity', () => {
		const r = resolve({ spelling: 1, channelsHome: 3, matrix: { enabled: true } })
		const report = formatConfigReport(r)
		expect(report).toMatch(/^ {2}warning: spelling: /m)
		expect(report).toMatch(/^ {2}fatal: channelsHome: /m)
		expect(report).toMatch(/^ {2}invalid: matrix\./m)
	})

	it('says so when there are no problems', () => {
		expect(formatConfigReport(resolve(undefined))).toMatch(/^problems: none$/m)
	})

	it('states why a disabled bridge is off', () => {
		const report = formatConfigReport(resolve({ matrix: { enabled: true } }))
		expect(report).toMatch(/^matrix\.disabledReason = "invalid-config"$/m)
		const idle = formatConfigReport(resolve(undefined))
		expect(idle).toMatch(/^matrix\.disabledReason = "not-enabled"$/m)
	})

	it('prints no disabled reason for an enabled bridge', () => {
		expect(formatConfigReport(resolve({ matrix: goodMatrix() }))).not.toContain('disabledReason')
	})

	it('prints the token command but never a resolved secret', () => {
		const r = resolve({ matrix: goodMatrix() })
		const report = formatConfigReport(r)
		expect(lineFor(report, 'matrix.tokenCommand')).toBe(
			'matrix.tokenCommand = ["op","read","op://vault/item/field"] (file)'
		)
		// `Config` has no field that can carry a token, so no report line can name one.
		expect(report.toLowerCase()).not.toMatch(/^matrix\.token\s/m)
		expect(Object.keys(r.config.matrix)).not.toContain('token')
	})

	it('is a pure function of its input', () => {
		const r = resolve({ transport: 'socket', matrix: goodMatrix() })
		const snapshot = structuredClone(r)
		expect(formatConfigReport(r)).toBe(formatConfigReport(r))
		expect(r).toEqual(snapshot)
	})
})

describe('resolveMatrixToken', () => {
	function enabledMatrix() {
		const m = resolve({ matrix: goodMatrix() }).config.matrix
		if (!m.enabled) throw new Error('fixture must resolve enabled')
		return m
	}

	/** A command whose stdout settles as `output`, and which records being killed. */
	function command(output: Promise<string>) {
		const kill = vi.fn()
		const run = vi.fn((_cmd: string[]): TokenChild => ({ output, kill }))
		return { run, kill }
	}

	/** A command that answers at once. */
	function answers(text: string) {
		return command(Promise.resolve(text))
	}

	/** A command that fails at once. Its rejection is always consumed by the race. */
	function refuses(err: unknown) {
		return command(Promise.reject(err))
	}

	/** A clock that never ticks, so only the command itself can settle the race. */
	const stopped = () => new Promise<void>(() => {})

	it("uses the token command's trimmed output as the token", async () => {
		const { run } = answers('  secret-value\n')
		const result = await resolveMatrixToken(enabledMatrix(), { env: {}, run, wait: stopped })
		expect(result).toEqual({ ok: true, token: 'secret-value' })
		expect(run).toHaveBeenCalledWith(['op', 'read', 'op://vault/item/field'])
		expect(run).toHaveBeenCalledTimes(1)
	})

	it('lets SESSIONBUS_MATRIX_AS_TOKEN override the command without running it', async () => {
		const { run } = answers('from-command')
		const result = await resolveMatrixToken(enabledMatrix(), {
			env: { SESSIONBUS_MATRIX_AS_TOKEN: 'override-token' },
			run
		})
		expect(result).toEqual({ ok: true, token: 'override-token' })
		expect(run).not.toHaveBeenCalled()
	})

	it('ignores an empty SESSIONBUS_MATRIX_AS_TOKEN and runs the command', async () => {
		const { run } = answers('from-command')
		const result = await resolveMatrixToken(enabledMatrix(), {
			env: { SESSIONBUS_MATRIX_AS_TOKEN: '' },
			run,
			wait: stopped
		})
		expect(result).toEqual({ ok: true, token: 'from-command' })
		expect(run).toHaveBeenCalledTimes(1)
	})

	it('reports a throwing command as an invalid problem instead of throwing', async () => {
		const run = vi.fn((_cmd: string[]): TokenChild => {
			throw new Error('spawn op ENOENT')
		})
		const call = () => resolveMatrixToken(enabledMatrix(), { env: {}, run, wait: stopped })
		expect(call).not.toThrow()
		const result = await call()
		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.problem.severity).toBe('invalid')
		expect(result.problem.path).toBe('matrix.tokenCommand')
	})

	it('reports a command that fails after it started as invalid', async () => {
		const { run } = refuses(new Error('spawn op ENOENT'))
		const result = await resolveMatrixToken(enabledMatrix(), { env: {}, run, wait: stopped })
		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.problem).toMatchObject({ severity: 'invalid', path: 'matrix.tokenCommand' })
	})

	it('includes the exit status of a failed command when there is one', async () => {
		const { run } = refuses(Object.assign(new Error('Command failed'), { status: 3 }))
		const result = await resolveMatrixToken(enabledMatrix(), { env: {}, run, wait: stopped })
		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.problem.message).toContain('3')
		expect(result.problem.message).toContain('op read')
	})

	it("includes the exit status when the failure names it 'code' instead", async () => {
		// `execFile` reports the status as `code`, `execFileSync` as `status`; a real failure
		// arrives under whichever name the call site used.
		const { run } = refuses(Object.assign(new Error('Command failed'), { code: 3 }))
		const result = await resolveMatrixToken(enabledMatrix(), { env: {}, run, wait: stopped })
		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.problem.message).toContain('3')
	})

	it('prints no status at all when the failure only names an errno', async () => {
		const { run } = refuses(Object.assign(new Error('spawn op ENOENT'), { code: 'ENOENT' }))
		const result = await resolveMatrixToken(enabledMatrix(), { env: {}, run, wait: stopped })
		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.problem.message).toContain('failed to run')
		expect(result.problem.message).not.toContain('ENOENT')
	})

	it('never puts the command output or error text in the failure message', async () => {
		const fixture = 'partial-secret-7f3a'
		const { run } = refuses(
			Object.assign(new Error(`Command failed: ${fixture}`), {
				status: 1,
				stdout: fixture,
				stderr: fixture
			})
		)
		const result = await resolveMatrixToken(enabledMatrix(), { env: {}, run, wait: stopped })
		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.problem.message).not.toContain(fixture)
	})

	it('treats a command that prints only whitespace as invalid', async () => {
		const { run } = answers(' \n\t')
		const result = await resolveMatrixToken(enabledMatrix(), { env: {}, run, wait: stopped })
		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.problem).toMatchObject({ severity: 'invalid', path: 'matrix.tokenCommand' })
	})

	it('treats a missing token command as invalid without running anything', async () => {
		const { run } = answers('unused')
		const { tokenCommand: _omit, ...rest } = enabledMatrix()
		const result = await resolveMatrixToken({ ...rest }, { env: {}, run, wait: stopped })
		expect(result.ok).toBe(false)
		expect(run).not.toHaveBeenCalled()
		if (result.ok) return
		expect(result.problem).toMatchObject({ severity: 'invalid', path: 'matrix.tokenCommand' })
	})
})

describe('resolveMatrixToken — the deadline', () => {
	function enabledMatrix() {
		const m = resolve({ matrix: goodMatrix() }).config.matrix
		if (!m.enabled) throw new Error('fixture must resolve enabled')
		return m
	}

	function command(output: Promise<string>) {
		const kill = vi.fn()
		const run = vi.fn((_cmd: string[]): TokenChild => ({ output, kill }))
		return { run, kill }
	}

	/** A helper that wants an approval no supervisor can give: it never answers at all. */
	function hangs() {
		return command(new Promise<string>(() => {}))
	}

	/** A clock whose deadline has already expired, so the command is given no time. */
	const expired = () => Promise.resolve()
	/** A clock that never ticks, so only the command itself can settle the race. */
	const stopped = () => new Promise<void>(() => {})

	it('reports a command that never answers as invalid, rather than waiting on it', async () => {
		const { run } = hangs()

		const result = await resolveMatrixToken(enabledMatrix(), { env: {}, run, wait: expired })

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.problem).toMatchObject({ severity: 'invalid', path: 'matrix.tokenCommand' })
	})

	it('kills the child it gave up on', async () => {
		const { run, kill } = hangs()

		await resolveMatrixToken(enabledMatrix(), { env: {}, run, wait: expired })

		expect(kill).toHaveBeenCalledTimes(1)
	})

	it('names the command that timed out and never what it printed', async () => {
		// A helper can print the secret and then hang waiting for something else entirely.
		const printed = 'half-a-secret-9c21'
		const { run } = command(new Promise<string>(() => {}))

		const result = await resolveMatrixToken(enabledMatrix(), { env: {}, run, wait: expired })

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.problem.message).toContain('op read op://vault/item/field')
		expect(result.problem.message).not.toContain(printed)
	})

	it('leaves a command that answers within its deadline alone, and kills nothing', async () => {
		const { run, kill } = command(Promise.resolve('secret-value'))

		const result = await resolveMatrixToken(enabledMatrix(), { env: {}, run, wait: stopped })

		expect(result).toEqual({ ok: true, token: 'secret-value' })
		expect(kill).not.toHaveBeenCalled()
	})

	it('gives a command ten seconds when no deadline is injected', async () => {
		const { run } = hangs()
		const waited: number[] = []

		await resolveMatrixToken(enabledMatrix(), {
			env: {},
			run,
			wait: (ms) => {
				waited.push(ms)
				return Promise.resolve()
			}
		})

		expect(waited).toEqual([TOKEN_DEADLINE_MS])
		expect(TOKEN_DEADLINE_MS).toBe(10_000)
	})

	it('reports the deadline it gave up after', async () => {
		const { run } = hangs()

		const result = await resolveMatrixToken(enabledMatrix(), {
			env: {},
			run,
			wait: expired,
			deadlineMs: 250
		})

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.problem.message).toContain('250')
	})

	it('never runs a command at all when the environment already holds the token', async () => {
		const { run, kill } = hangs()

		const result = await resolveMatrixToken(enabledMatrix(), {
			env: { SESSIONBUS_MATRIX_AS_TOKEN: 'override-token' },
			run,
			wait: expired
		})

		expect(result).toEqual({ ok: true, token: 'override-token' })
		expect(run).not.toHaveBeenCalled()
		expect(kill).not.toHaveBeenCalled()
	})
})

describe('hasFatalProblem', () => {
	const at = (severity: ConfigProblem['severity']): ConfigProblem => ({
		severity,
		path: 'x',
		message: 'm'
	})

	it('is false for no problems', () => {
		expect(hasFatalProblem([])).toBe(false)
	})

	it('is false for warning and invalid problems only', () => {
		expect(hasFatalProblem([at('warning'), at('invalid'), at('warning')])).toBe(false)
	})

	it('is true when any problem is fatal, wherever it sits', () => {
		expect(hasFatalProblem([at('fatal')])).toBe(true)
		expect(hasFatalProblem([at('warning'), at('invalid'), at('fatal')])).toBe(true)
	})

	it('agrees with resolveConfig on a fatal channelsHome', () => {
		expect(hasFatalProblem(resolve({ channelsHome: '' }).problems)).toBe(true)
		expect(hasFatalProblem(resolve({ matrix: { enabled: true } }).problems)).toBe(false)
	})
})

describe('configFilePath', () => {
	it('lives under ~/.claude/sessionbus', () => {
		expect(configFilePath(HOME)).toBe(join(HOME, '.claude', 'sessionbus', 'config.json'))
	})
})

describe('pickConfigEnv', () => {
	it('keeps only the recognized configuration variables', () => {
		const picked = pickConfigEnv({
			CHANNELS_HOME: '/c',
			SESSIONBUS_TRANSPORT: 'socket',
			SESSIONBUS_MATRIX_AS_TOKEN: 'secret',
			PATH: '/bin'
		})
		expect(picked).toEqual({ CHANNELS_HOME: '/c', SESSIONBUS_TRANSPORT: 'socket' })
	})

	it('omits variables that are unset', () => {
		expect(pickConfigEnv({})).toEqual({})
		expect('CHANNELS_HOME' in pickConfigEnv({ SESSIONBUS_TRANSPORT: 'file' })).toBe(false)
	})

	it('keeps a variable set to the empty string, so resolveConfig can judge it', () => {
		expect(pickConfigEnv({ CHANNELS_HOME: '' })).toEqual({ CHANNELS_HOME: '' })
	})
})

describe('loadConfig', () => {
	function errno(code: string): Error {
		return Object.assign(new Error(`${code}: boom`), { code })
	}

	it('reads the config file under home and resolves it', () => {
		const readText = vi.fn((_path: string) => JSON.stringify({ transport: 'socket' }))
		const r = loadConfig({ home: HOME, env: {}, readText })
		expect(readText).toHaveBeenCalledWith(configFilePath(HOME))
		expect(r.config.transport).toBe('socket')
		expect(r.sources.transport).toBe('file')
		expect(r.problems).toEqual([])
	})

	it('applies the environment over the file', () => {
		const r = loadConfig({
			home: HOME,
			env: { SESSIONBUS_TRANSPORT: 'file' },
			readText: () => JSON.stringify({ transport: 'socket' })
		})
		expect(r.config.transport).toBe('file')
	})

	it('treats a missing file as no file, with no problem', () => {
		const r = loadConfig({
			home: HOME,
			env: {},
			readText: () => {
				throw errno('ENOENT')
			}
		})
		expect(r.problems).toEqual([])
		expect(r.config).toEqual(resolve(undefined).config)
	})

	it('treats an unreadable file as no file, with a warning', () => {
		const r = loadConfig({
			home: HOME,
			env: {},
			readText: () => {
				throw errno('EACCES')
			}
		})
		expect(r.problems).toEqual([
			expect.objectContaining({ severity: 'warning', path: CONFIG_FILE_LABEL })
		])
		expect(r.config).toEqual(resolve(undefined).config)
	})

	it('treats corrupt JSON as no file, with one warning', () => {
		const r = loadConfig({ home: HOME, env: {}, readText: () => '{ "transport": ' })
		expect(r.problems).toEqual([
			expect.objectContaining({ severity: 'warning', path: CONFIG_FILE_LABEL })
		])
		expect(r.config).toEqual(resolve(undefined).config)
	})

	it('treats an empty file as corrupt rather than silently valid', () => {
		const r = loadConfig({ home: HOME, env: {}, readText: () => '' })
		expect(r.problems).toHaveLength(1)
		expect(r.problems[0].severity).toBe('warning')
	})

	it('still reports a fatal environment value when the file is corrupt', () => {
		const r = loadConfig({ home: HOME, env: { CHANNELS_HOME: '' }, readText: () => 'nope' })
		expect(hasFatalProblem(r.problems)).toBe(true)
		expect(r.problems.some((p) => p.path === CONFIG_FILE_LABEL)).toBe(true)
	})
})
