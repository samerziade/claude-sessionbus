import { join } from 'node:path'

/**
 * Layered configuration for the broker and bus: built-in defaults, then
 * `~/.claude/sessionbus/config.json`, then a deliberately narrow set of environment variables.
 *
 * Everything here is pure. Callers read the file and the environment themselves and pass the
 * values in, so precedence and validation are testable without disk or `process.env`.
 * Problems are returned as severity-tagged data instead of thrown:
 *
 * - `warning` — log it, otherwise ignore it.
 * - `invalid` — the Matrix bridge is disabled; the broker keeps serving.
 * - `fatal`   — core configuration is unusable; a broker about to serve must exit non-zero.
 */

export type ConfigSource = 'default' | 'file' | 'env'

export type ConfigSeverity = 'warning' | 'invalid' | 'fatal'

export interface ConfigProblem {
	severity: ConfigSeverity
	/** Dotted path of the field concerned, e.g. `channelsHome` or `matrix.url`. */
	path: string
	message: string
}

export type Transport = 'file' | 'socket'

/**
 * Why the Matrix bridge is off. Every route that disables the bridge converges on this one
 * field, so a diagnostic can say *why* and not only *that* it is off.
 */
export type MatrixDisabledReason = 'not-enabled' | 'invalid-config'

export interface UnreadCap {
	messages: number
	chars: number
}

export interface MatrixFields {
	url?: string
	/** The command whose trimmed stdout is the secret — never the secret itself. */
	tokenCommand?: string[]
	rootSpace?: string
	owner?: string
	/**
	 * The homeserver's server name — the `:`-suffix every identifier carries. Configured
	 * explicitly and never inferred: a server name is not reliably its URL host, and taking it
	 * from `owner` assumes the operator lives on the homeserver the bridge talks to. Neither
	 * guess is checkable where it would be made, and a wrong domain does not fail — it mints a
	 * different user and room for everything, which is unrecoverable once history hangs off them.
	 */
	domain?: string
	namespacePrefix: string
	unreadCap: UnreadCap
}

export interface MatrixEnabled extends MatrixFields {
	enabled: true
}

export interface MatrixDisabled extends MatrixFields {
	enabled: false
	disabledReason: MatrixDisabledReason
}

export type MatrixConfig = MatrixEnabled | MatrixDisabled

export interface Config {
	channelsHome: string
	transport: Transport
	matrix: MatrixConfig
	/** Absolute repo path → project slug override. */
	projects: Record<string, string>
}

export interface ResolvedConfig {
	config: Config
	/** Source of each independently settable leaf, keyed by the dotted path problems use. */
	sources: Record<string, ConfigSource>
	problems: ConfigProblem[]
}

/** The only environment variables that override `Config` fields. */
export interface ConfigEnv {
	CHANNELS_HOME?: string
	SESSIONBUS_TRANSPORT?: string
}

export interface ResolveConfigInput {
	/** Already-parsed file content; `undefined` when there is no file. */
	file: unknown
	env: ConfigEnv
	home: string
}

/** Path used for problems about the file as a whole rather than one field in it. */
export const CONFIG_FILE_LABEL = '(file)'

const DEFAULT_NAMESPACE_PREFIX = 'cc'
const DEFAULT_UNREAD_CAP: UnreadCap = { messages: 20, chars: 2000 }
const TOP_LEVEL_KEYS = new Set(['channelsHome', 'transport', 'matrix', 'projects'])
const MATRIX_KEYS = new Set([
	'enabled',
	'url',
	'tokenCommand',
	'rootSpace',
	'owner',
	'domain',
	'namespacePrefix',
	'unreadCap'
])

function isPlainObject(x: unknown): x is Record<string, unknown> {
	return typeof x === 'object' && x !== null && !Array.isArray(x)
}

function isNonEmptyString(x: unknown): x is string {
	return typeof x === 'string' && x.length > 0
}

function isTransport(x: unknown): x is Transport {
	return x === 'file' || x === 'socket'
}

function isPositiveInteger(x: unknown): x is number {
	return typeof x === 'number' && Number.isInteger(x) && x > 0
}

function isCommand(x: unknown): x is string[] {
	return Array.isArray(x) && x.length > 0 && x.every(isNonEmptyString)
}

/** Expand a leading `~` or `~/` against `home`. `~user` forms are left alone. */
function expandHome(p: string, home: string): string {
	if (p === '~') return home
	if (p.startsWith('~/')) return join(home, p.slice(2))
	return p
}

function describeValue(x: unknown): string {
	if (x === null) return 'null'
	if (Array.isArray(x)) return 'an array'
	if (typeof x === 'string') return `"${x}"`
	return typeof x
}

interface Resolution {
	sources: Record<string, ConfigSource>
	problems: ConfigProblem[]
}

function resolveChannelsHome(
	file: Record<string, unknown>,
	env: ConfigEnv,
	home: string,
	out: Resolution
): string {
	const fallback = join(home, '.claude', 'channels')
	out.sources.channelsHome = 'default'
	let candidate: unknown
	let source: ConfigSource | undefined
	if ('channelsHome' in file) {
		candidate = file.channelsHome
		source = 'file'
	}
	if (env.CHANNELS_HOME !== undefined) {
		candidate = env.CHANNELS_HOME
		source = 'env'
	}
	if (source === undefined) return fallback
	if (!isNonEmptyString(candidate)) {
		const where = source === 'env' ? 'CHANNELS_HOME' : 'channelsHome in the config file'
		out.problems.push({
			severity: 'fatal',
			path: 'channelsHome',
			message: `${where} must be a non-empty string, got ${describeValue(candidate)}; the broker cannot form its socket path`
		})
		return fallback
	}
	out.sources.channelsHome = source
	return expandHome(candidate, home)
}

function resolveTransport(
	file: Record<string, unknown>,
	env: ConfigEnv,
	out: Resolution
): Transport {
	out.sources.transport = 'default'
	let transport: Transport = 'file'
	if ('transport' in file) {
		if (isTransport(file.transport)) {
			transport = file.transport
			out.sources.transport = 'file'
		} else {
			out.problems.push({
				severity: 'warning',
				path: 'transport',
				message: `transport in the config file must be "file" or "socket", got ${describeValue(file.transport)}; using "file"`
			})
		}
	}
	if (env.SESSIONBUS_TRANSPORT !== undefined) {
		if (isTransport(env.SESSIONBUS_TRANSPORT)) {
			transport = env.SESSIONBUS_TRANSPORT
			out.sources.transport = 'env'
		} else {
			out.problems.push({
				severity: 'warning',
				path: 'transport',
				message: `SESSIONBUS_TRANSPORT must be "file" or "socket", got ${describeValue(env.SESSIONBUS_TRANSPORT)}; using "file"`
			})
			transport = 'file'
			out.sources.transport = 'default'
		}
	}
	return transport
}

function resolveProjects(file: Record<string, unknown>, out: Resolution): Record<string, string> {
	out.sources.projects = 'default'
	const projects: Record<string, string> = {}
	if (!('projects' in file)) return projects
	if (!isPlainObject(file.projects)) {
		out.problems.push({
			severity: 'warning',
			path: 'projects',
			message: `projects must be an object mapping repo paths to slugs, got ${describeValue(file.projects)}; ignored`
		})
		return projects
	}
	out.sources.projects = 'file'
	for (const [repo, slug] of Object.entries(file.projects)) {
		if (isNonEmptyString(slug)) {
			projects[repo] = slug
		} else {
			out.problems.push({
				severity: 'warning',
				path: `projects.${repo}`,
				message: `project slug must be a non-empty string, got ${describeValue(slug)}; entry ignored`
			})
		}
	}
	return projects
}

/** One matrix leaf: a type guard, whether an enabled bridge needs it, and what it means. */
interface MatrixLeaf {
	key: 'url' | 'tokenCommand' | 'rootSpace' | 'owner' | 'domain' | 'namespacePrefix'
	required: boolean
	valid: (x: unknown) => boolean
	expected: string
}

const MATRIX_LEAVES: MatrixLeaf[] = [
	{ key: 'url', required: true, valid: isNonEmptyString, expected: 'a non-empty string' },
	{
		key: 'tokenCommand',
		required: true,
		valid: isCommand,
		expected: 'a non-empty array of non-empty strings'
	},
	{ key: 'rootSpace', required: true, valid: isNonEmptyString, expected: 'a non-empty string' },
	{ key: 'owner', required: true, valid: isNonEmptyString, expected: 'a non-empty string' },
	{ key: 'domain', required: true, valid: isNonEmptyString, expected: 'a non-empty string' },
	{
		key: 'namespacePrefix',
		required: false,
		valid: isNonEmptyString,
		expected: 'a non-empty string'
	}
]

function defaultMatrixFields(): MatrixFields {
	return { namespacePrefix: DEFAULT_NAMESPACE_PREFIX, unreadCap: { ...DEFAULT_UNREAD_CAP } }
}

function setMatrixLeaf(fields: MatrixFields, key: MatrixLeaf['key'], value: unknown): void {
	if (key === 'tokenCommand') {
		if (isCommand(value)) fields.tokenCommand = [...value]
		return
	}
	if (!isNonEmptyString(value)) return
	if (key === 'url') fields.url = value
	else if (key === 'rootSpace') fields.rootSpace = value
	else if (key === 'owner') fields.owner = value
	else if (key === 'domain') fields.domain = value
	else fields.namespacePrefix = value
}

function resolveMatrix(file: Record<string, unknown>, out: Resolution): MatrixConfig {
	const fields = defaultMatrixFields()
	for (const k of ['enabled', ...MATRIX_LEAVES.map((l) => l.key)]) {
		out.sources[`matrix.${k}`] = 'default'
	}
	out.sources['matrix.unreadCap.messages'] = 'default'
	out.sources['matrix.unreadCap.chars'] = 'default'

	if (!('matrix' in file)) return { enabled: false, disabledReason: 'not-enabled', ...fields }
	const block = file.matrix
	if (!isPlainObject(block)) {
		out.problems.push({
			severity: 'invalid',
			path: 'matrix',
			message: `matrix must be an object, got ${describeValue(block)}; the Matrix bridge is disabled`
		})
		return { enabled: false, disabledReason: 'invalid-config', ...fields }
	}

	for (const key of Object.keys(block)) {
		if (!MATRIX_KEYS.has(key)) {
			out.problems.push({
				severity: 'warning',
				path: `matrix.${key}`,
				message: `unknown key matrix.${key}; ignored`
			})
		}
	}

	// A disabled bridge is not validated: take what is well-typed, silently drop the rest.
	const invalid: ConfigProblem[] = []
	let wantsEnabled = false
	if ('enabled' in block) {
		if (typeof block.enabled === 'boolean') {
			wantsEnabled = block.enabled
			out.sources['matrix.enabled'] = 'file'
		} else {
			invalid.push({
				severity: 'invalid',
				path: 'matrix.enabled',
				message: `matrix.enabled must be true or false, got ${describeValue(block.enabled)}`
			})
		}
	}

	for (const leaf of MATRIX_LEAVES) {
		const present = leaf.key in block
		const value = block[leaf.key]
		if (present && leaf.valid(value)) {
			setMatrixLeaf(fields, leaf.key, value)
			out.sources[`matrix.${leaf.key}`] = 'file'
		} else if (present) {
			invalid.push({
				severity: 'invalid',
				path: `matrix.${leaf.key}`,
				message: `matrix.${leaf.key} must be ${leaf.expected}, got ${describeValue(value)}`
			})
		} else if (leaf.required) {
			invalid.push({
				severity: 'invalid',
				path: `matrix.${leaf.key}`,
				message: `matrix.${leaf.key} is required when the bridge is enabled`
			})
		}
	}

	if ('unreadCap' in block) {
		const cap = block.unreadCap
		if (!isPlainObject(cap)) {
			invalid.push({
				severity: 'invalid',
				path: 'matrix.unreadCap',
				message: `matrix.unreadCap must be an object, got ${describeValue(cap)}`
			})
		} else {
			for (const k of ['messages', 'chars'] as const) {
				if (!(k in cap)) continue
				const v = cap[k]
				if (isPositiveInteger(v)) {
					fields.unreadCap[k] = v
					out.sources[`matrix.unreadCap.${k}`] = 'file'
				} else {
					invalid.push({
						severity: 'invalid',
						path: `matrix.unreadCap.${k}`,
						message: `matrix.unreadCap.${k} must be a positive integer, got ${describeValue(v)}`
					})
				}
			}
		}
	}

	const enabledIsMalformed = invalid.some((p) => p.path === 'matrix.enabled')
	if (!wantsEnabled && !enabledIsMalformed) {
		return { enabled: false, disabledReason: 'not-enabled', ...fields }
	}
	if (invalid.length === 0) return { enabled: true, ...fields }

	// A required field missing on a disabled-by-malformed-`enabled` block is noise; report
	// only what is actually wrong with what was written.
	const reported = wantsEnabled ? invalid : invalid.filter((p) => p.path === 'matrix.enabled')
	for (const p of reported) {
		out.problems.push({ ...p, message: `${p.message}; the Matrix bridge is disabled` })
	}
	return { enabled: false, disabledReason: 'invalid-config', ...fields }
}

/** Layer defaults → file → env into a typed `Config`. Never throws, never reads ambient state. */
export function resolveConfig(input: ResolveConfigInput): ResolvedConfig {
	const out: Resolution = { sources: {}, problems: [] }
	let file: Record<string, unknown> = {}
	if (isPlainObject(input.file)) {
		file = input.file
	} else if (input.file !== undefined) {
		out.problems.push({
			severity: 'warning',
			path: CONFIG_FILE_LABEL,
			message: `the config file must hold a JSON object, got ${describeValue(input.file)}; using defaults`
		})
	}

	for (const key of Object.keys(file)) {
		if (!TOP_LEVEL_KEYS.has(key)) {
			out.problems.push({ severity: 'warning', path: key, message: `unknown key ${key}; ignored` })
		}
	}

	const config: Config = {
		channelsHome: resolveChannelsHome(file, input.env, input.home, out),
		transport: resolveTransport(file, input.env, out),
		matrix: resolveMatrix(file, out),
		projects: resolveProjects(file, out)
	}
	return { config, sources: out.sources, problems: out.problems }
}

function formatValue(value: unknown): string {
	return value === undefined ? '(unset)' : JSON.stringify(value)
}

/**
 * Render a `ResolvedConfig` for `broker config`: one `<path> = <value> (<source>)` line per
 * settable leaf, the Matrix disabled reason when the bridge is off, then every problem.
 *
 * Nothing needs redacting here: `Config` carries only the token *command*, never its output,
 * so the secret cannot reach this function.
 */
export function formatConfigReport(resolved: ResolvedConfig): string {
	const { config, sources, problems } = resolved
	const { matrix } = config
	const leaves: Array<[string, unknown]> = [
		['channelsHome', config.channelsHome],
		['transport', config.transport],
		['matrix.enabled', matrix.enabled],
		['matrix.url', matrix.url],
		['matrix.tokenCommand', matrix.tokenCommand],
		['matrix.rootSpace', matrix.rootSpace],
		['matrix.owner', matrix.owner],
		['matrix.domain', matrix.domain],
		['matrix.namespacePrefix', matrix.namespacePrefix],
		['matrix.unreadCap.messages', matrix.unreadCap.messages],
		['matrix.unreadCap.chars', matrix.unreadCap.chars],
		['projects', config.projects]
	]
	const lines: string[] = []
	for (const [path, value] of leaves) {
		lines.push(`${path} = ${formatValue(value)} (${sources[path] ?? 'default'})`)
		if (path === 'matrix.enabled' && !matrix.enabled) {
			lines.push(`matrix.disabledReason = ${formatValue(matrix.disabledReason)}`)
		}
	}
	lines.push('')
	if (problems.length === 0) {
		lines.push('problems: none')
	} else {
		lines.push('problems:')
		for (const p of problems) lines.push(`  ${p.severity}: ${p.path}: ${p.message}`)
	}
	return `${lines.join('\n')}\n`
}

export interface TokenEnv {
	SESSIONBUS_MATRIX_AS_TOKEN?: string
}

/**
 * How long a token command may take. Not configurable: the only correct value is "shorter than
 * a human's patience and longer than a network-backed secret manager needs", and a knob for it
 * would be one more thing to get wrong in the configuration that is already failing.
 */
export const TOKEN_DEADLINE_MS = 10_000

/** A token command that has been started. */
export interface TokenChild {
	/** Settles with the command's stdout, or rejects when it fails. */
	output: Promise<string>
	/** Ends the child. Called only when the deadline expires. */
	kill: () => void
}

export interface TokenResolutionDeps {
	env: TokenEnv
	/**
	 * Starts `cmd[0]` with `cmd.slice(1)` as arguments. Injected so tests never spawn a process,
	 * and asynchronous so a slow helper cannot block the broker that is already serving.
	 */
	run: (cmd: string[]) => TokenChild
	/** Resolves after `ms`. Injected so a deadline is tested without waiting one out. */
	wait?: (ms: number) => Promise<void>
	/** How long the command may take. Defaults to `TOKEN_DEADLINE_MS`. */
	deadlineMs?: number
}

export type TokenResolution = { ok: true; token: string } | { ok: false; problem: ConfigProblem }

/** What the race between a token command and its deadline settled as. */
interface CommandOutput {
	kind: 'output'
	text: string
}
interface CommandFailure {
	kind: 'failure'
	error: unknown
}
interface CommandTimeout {
	kind: 'timeout'
}
type CommandOutcome = CommandOutput | CommandFailure | CommandTimeout

/**
 * The exit status a failed command reported, under either of the two names node gives it:
 * `status` on a synchronous failure, `code` on an asynchronous one. A `code` that names an
 * errno (`ENOENT`) is not a status and is left out, rather than printed as one.
 */
function exitStatusOf(err: unknown): number | undefined {
	if (typeof err !== 'object' || err === null) return undefined
	if ('status' in err && typeof err.status === 'number') return err.status
	if ('code' in err && typeof err.code === 'number') return err.code
	return undefined
}

/** How a command failed, named without quoting anything it wrote. */
function howItFailed(err: unknown): string {
	const status = exitStatusOf(err)
	return status === undefined ? 'failed to run' : `exited with status ${status}`
}

function tokenProblem(message: string): TokenResolution {
	return {
		ok: false,
		problem: {
			severity: 'invalid',
			path: 'matrix.tokenCommand',
			message: `${message}; the Matrix bridge is disabled`
		}
	}
}

/**
 * Resolve the bridge's secret. `SESSIONBUS_MATRIX_AS_TOKEN` wins and skips the command;
 * otherwise `tokenCommand` runs and its trimmed stdout is the token. Every failure is an
 * `invalid` problem — the bridge goes off, the broker keeps serving — and no failure message
 * ever carries the command's output or error text, which could hold part of the secret.
 *
 * The command is bounded by a deadline and killed when it exceeds one. A credential helper may
 * be waiting for an interaction that cannot happen under a supervisor — there is no terminal to
 * prompt at — and an unbounded wait leaves the bridge permanently about to start, with nothing
 * to diagnose it by.
 */
export async function resolveMatrixToken(
	matrix: MatrixConfig,
	deps: TokenResolutionDeps
): Promise<TokenResolution> {
	const override = deps.env.SESSIONBUS_MATRIX_AS_TOKEN
	if (isNonEmptyString(override)) return { ok: true, token: override }

	const cmd = matrix.tokenCommand
	if (cmd === undefined || !isCommand(cmd)) {
		return tokenProblem('matrix.tokenCommand is not set and SESSIONBUS_MATRIX_AS_TOKEN is empty')
	}
	const shown = cmd.join(' ')
	const deadlineMs = deps.deadlineMs ?? TOKEN_DEADLINE_MS
	const wait = deps.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
	let child: TokenChild
	try {
		child = deps.run(cmd)
	} catch (err) {
		return tokenProblem(`token command \`${shown}\` ${howItFailed(err)}`)
	}
	// The command comes first in the race, so one that has already answered beats a deadline
	// that has already expired. Both branches are attached here, which is also what keeps a
	// rejection arriving after the deadline from escaping as an unhandled one.
	const outcome = await Promise.race<CommandOutcome>([
		child.output.then(
			(text): CommandOutcome => ({ kind: 'output', text }),
			(error: unknown): CommandOutcome => ({ kind: 'failure', error })
		),
		wait(deadlineMs).then((): CommandOutcome => ({ kind: 'timeout' }))
	])
	if (outcome.kind === 'timeout') {
		child.kill()
		return tokenProblem(`token command \`${shown}\` did not answer within ${deadlineMs}ms`)
	}
	if (outcome.kind === 'failure') {
		return tokenProblem(`token command \`${shown}\` ${howItFailed(outcome.error)}`)
	}
	const token = outcome.text.trim()
	if (token.length === 0) return tokenProblem(`token command \`${shown}\` printed nothing`)
	return { ok: true, token }
}

/** True when any problem means core configuration is unusable and a serving broker must exit. */
export function hasFatalProblem(problems: readonly ConfigProblem[]): boolean {
	return problems.some((p) => p.severity === 'fatal')
}

/** Where the config file lives for a given home directory. */
export function configFilePath(home: string): string {
	return join(home, '.claude', 'sessionbus', 'config.json')
}

/**
 * Pick the recognized configuration variables out of an environment. Only these two override
 * `Config` fields; every other field is file-only.
 */
export function pickConfigEnv(env: Readonly<Record<string, string | undefined>>): ConfigEnv {
	const picked: ConfigEnv = {}
	if (env.CHANNELS_HOME !== undefined) picked.CHANNELS_HOME = env.CHANNELS_HOME
	if (env.SESSIONBUS_TRANSPORT !== undefined) {
		picked.SESSIONBUS_TRANSPORT = env.SESSIONBUS_TRANSPORT
	}
	return picked
}

export interface LoadConfigDeps {
	home: string
	env: ConfigEnv
	/** Returns the file's text, throwing (with an errno `code`) when it cannot be read. */
	readText: (path: string) => string
}

function errorCode(err: unknown): unknown {
	return typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
}

/**
 * The entrypoints' shared glue: read the config file through `readText`, parse it, and
 * resolve. A missing file is the normal unconfigured state and produces no problem; an
 * unreadable or corrupt file is treated as absent, with a `warning`, so a bad file never stops
 * the broker by itself.
 */
export function loadConfig(deps: LoadConfigDeps): ResolvedConfig {
	const path = configFilePath(deps.home)
	const fileProblems: ConfigProblem[] = []
	let file: unknown
	let text: string | undefined
	try {
		text = deps.readText(path)
	} catch (err) {
		if (errorCode(err) !== 'ENOENT') {
			fileProblems.push({
				severity: 'warning',
				path: CONFIG_FILE_LABEL,
				message: `cannot read ${path} (${errorMessage(err)}); using defaults`
			})
		}
	}
	if (text !== undefined) {
		try {
			file = JSON.parse(text)
		} catch (err) {
			fileProblems.push({
				severity: 'warning',
				path: CONFIG_FILE_LABEL,
				message: `${path} is not valid JSON (${errorMessage(err)}); using defaults`
			})
		}
	}
	const resolved = resolveConfig({ file, env: deps.env, home: deps.home })
	return { ...resolved, problems: [...fileProblems, ...resolved.problems] }
}
