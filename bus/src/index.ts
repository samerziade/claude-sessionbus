#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { loadConfig, pickConfigEnv } from '../../broker/src/config.ts'
import type { RegisterMeta } from '../../broker/src/protocol.ts'
import { createHandlers, type ThreadArg } from './handlers.ts'
import { findSelfEntry, type PeerIdentity, resolveSelf } from './identity.ts'
import type { HistoryQuery } from './mailbox.ts'
import { deriveProject } from './project.ts'
import { createBeaconKeeper, readSessionEntries } from './registry.ts'
import { createTransport } from './transport.ts'

const SESSIONS_DIR = process.env.SESSIONS_DIR ?? join(homedir(), '.claude', 'sessions')
const BEACON_REFRESH_MS = 30_000
/** A `--resume` launch rewrites the registry just after spawning us; re-publish once it lands. */
const BEACON_SETTLE_MS = 1_000
const UNKNOWN = 'unknown'

/**
 * The `origin` remote of a directory, or nothing. The only I/O in the project derivation;
 * everything it feeds is pure. A directory that is not a repository, or a machine with no
 * `git`, simply has no remote — never an error.
 */
function readOriginRemote(cwd: string): string | undefined {
	try {
		const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
			cwd,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore']
		})
		return url.trim()
	} catch {
		return undefined
	}
}

const INSTRUCTIONS =
	'Messages tagged <channel source="sessionbus" ...> are from ANOTHER Claude Code session on this machine. ' +
	'Use the list_peers tool to see reachable sessions and send_message to reach one. The `to` argument accepts ' +
	'a session id (full or short), a session-name substring, "pm" (the PM of your epic), or "epic" (broadcast to ' +
	'your epic), or a list of those to reach several sessions at once — a list may not mix "epic" with named ' +
	'recipients. When you receive a message, decide whether to act on it or reply with send_message addressed to ' +
	'the from_id in the tag. Sessions named "epic:<n>" are PMs; "<issue> epic:<n>" are workers — routing hints, not ' +
	'hard rules. If send_message returns ambiguous/not_found, call list_peers and retry with a precise session id. ' +
	'A message with origin="human" was written by a person in a chat room, not by another session: its from_id is ' +
	"a full Matrix user id, and passing that id as send_message's `to` answers that person in the room and thread " +
	'they used — nothing is delivered to any session. A relayed message also carries `room` (where it happened), ' +
	'`since` (a cursor) and `unread`/`omitted` (how much of the backlog came with it, and how much the cap dropped). ' +
	'Call read_history({ room, since }) to read what was dropped, or read_history({}) for your own room; any room ' +
	'the bridge owns is readable, so you can look up how another group solved something. Mention someone by their ' +
	'name in the room to reach them. Where there is no bridge, read_history and a Matrix-addressed send_message ' +
	'answer { ok: false, reason: "unavailable" } and local messaging is unaffected.'

/** The `to` argument as the handlers take it, or nothing when it is neither shape. */
function toArgument(raw: unknown): string | string[] | undefined {
	if (typeof raw === 'string') return raw
	if (Array.isArray(raw) && raw.every((e) => typeof e === 'string')) return raw
	return undefined
}

/** Distinguishes "no thread asked for" from "a thread asked for in a shape we cannot read". */
const INVALID_THREAD = Symbol('invalid thread argument')

function threadArgument(raw: unknown): ThreadArg | undefined | typeof INVALID_THREAD {
	if (raw === undefined) return undefined
	if (typeof raw === 'string') return raw
	if (typeof raw === 'object' && raw !== null && 'new' in raw && typeof raw.new === 'string') {
		return { new: raw.new }
	}
	return INVALID_THREAD
}

async function main(): Promise<void> {
	// The same resolver the broker uses, so the transport mode and socket path this session
	// uses cannot drift from the ones the broker binds. Problems are logged, never fatal here:
	// a session with a bad config still gets the defaults.
	const { config, problems } = loadConfig({
		home: homedir(),
		env: pickConfigEnv(process.env),
		readText: (path) => readFileSync(path, 'utf8')
	})
	for (const p of problems) {
		process.stderr.write(`sessionbus: config ${p.severity}: ${p.path}: ${p.message}\n`)
	}
	const channelsHome = config.channelsHome
	const brokerSock = process.env.BROKER_SOCK ?? join(channelsHome, 'broker.sock')

	const sessionId = process.env.CLAUDE_CODE_SESSION_ID
	if (!sessionId) {
		process.stderr.write(
			'sessionbus: CLAUDE_CODE_SESSION_ID not set; not running inside a Claude Code session.\n'
		)
	}

	// Resolved fresh on every use, never cached: our identity is not settled at startup (a
	// `--resume` launch rewrites the registry moments after spawning us) and the session can be
	// renamed at any time afterwards. Keyed on our parent — the Claude Code process — because
	// CLAUDE_CODE_SESSION_ID can name a session that resume discarded.
	const self = (): PeerIdentity =>
		resolveSelf(process.ppid, sessionId, readSessionEntries(SESSIONS_DIR)) ?? {
			sessionId: sessionId ?? UNKNOWN,
			name: sessionId ?? UNKNOWN,
			role: 'none'
		}

	// Announced on every register frame and read afresh each time, on the same never-cached
	// path as identity: a session can be renamed at any moment, and a `--resume` rewrite lands
	// just after we start. `project` is omitted rather than filled in when nothing can be
	// derived — a session with no project is a supported state, and no placeholder is invented.
	const announce = (): RegisterMeta => {
		const me = self()
		const entry = findSelfEntry(process.ppid, sessionId, readSessionEntries(SESSIONS_DIR))
		const derived = deriveProject({
			cwd: entry?.cwd ?? process.cwd(),
			readRemote: readOriginRemote,
			overrides: config.projects
		})
		if (derived === undefined) return { title: me.name }
		return { project: derived.project, projectName: derived.name, title: me.name }
	}

	const server = new Server(
		{ name: 'sessionbus', version: '0.0.1' },
		{
			capabilities: { experimental: { 'claude/channel': {} }, tools: {} },
			instructions: INSTRUCTIONS
		}
	)

	const transport = createTransport({
		channelsHome,
		socketPath: brokerSock,
		mode: config.transport,
		announce
	})
	const handlers = createHandlers({
		self,
		channelsHome,
		sessionsDir: SESSIONS_DIR,
		transport,
		notify: (n) => server.notification({ method: 'notifications/claude/channel', params: n })
	})

	// Tool discovery
	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: [
			{
				name: 'whoami',
				description: "Return this session's own identity (sessionId, name, role, epic, issue).",
				inputSchema: { type: 'object', properties: {}, additionalProperties: false }
			},
			{
				name: 'list_peers',
				description:
					'List reachable Claude Code sessions (other than this one) with their role/epic/status.',
				inputSchema: {
					type: 'object',
					properties: {
						scope: {
							type: 'string',
							enum: ['epic', 'all'],
							description: 'epic = same epic only (default when in an epic); all = every session'
						}
					},
					additionalProperties: false
				}
			},
			{
				name: 'send_message',
				description:
					'Send a message to another session. `to` = session id, name substring, "pm", or "epic", ' +
					'or a list of those to reach several sessions at once.',
				inputSchema: {
					type: 'object',
					properties: {
						to: {
							description:
								'Recipient: session id (full/short), name substring, "pm", or "epic"/"epic:N", ' +
								'or a full Matrix user id such as "@samer:example.org" to answer a person. ' +
								'A list may name several sessions, but may not mix a broadcast target with named ones.',
							anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }]
						},
						text: { type: 'string', description: 'The message body' },
						thread: {
							description:
								'Which conversation thread to file this under: a thread handle, or { "new": "<title>" } to start one.',
							anyOf: [
								{ type: 'string' },
								{
									type: 'object',
									properties: { new: { type: 'string' } },
									required: ['new'],
									additionalProperties: false
								}
							]
						}
					},
					required: ['to', 'text'],
					additionalProperties: false
				}
			},
			{
				name: 'read_history',
				description:
					"Read a chat room's history. Defaults to your own room; any room the bridge owns is " +
					'readable. Use the `since` from a relayed message to read what its cap dropped.',
				inputSchema: {
					type: 'object',
					properties: {
						room: {
							type: 'string',
							description:
								'Room id or alias. Defaults to your epic room, or your project lobby when you have no epic.'
						},
						thread: {
							type: 'string',
							description: 'Restrict to one thread, by the handle a message reported.'
						},
						since: {
							type: 'string',
							description:
								'An opaque cursor from a relayed message or an earlier read. Pass it back unchanged.'
						},
						limit: { type: 'number', description: 'Maximum messages to return.' },
						search: { type: 'string', description: 'Only messages containing this text.' }
					},
					additionalProperties: false
				}
			}
		]
	}))

	// Tool calls
	server.setRequestHandler(CallToolRequestSchema, async (req) => {
		const { name, arguments: rawArgs } = req.params
		const args = (rawArgs ?? {}) as Record<string, unknown>
		if (name === 'whoami') {
			return { content: [{ type: 'text', text: JSON.stringify(handlers.whoami(), null, 2) }] }
		}
		if (name === 'list_peers') {
			const scope = args.scope === 'all' || args.scope === 'epic' ? args.scope : undefined
			return {
				content: [{ type: 'text', text: JSON.stringify(handlers.listPeers({ scope }), null, 2) }]
			}
		}
		if (name === 'send_message') {
			const to = toArgument(args.to)
			if (to === undefined || typeof args.text !== 'string') {
				return {
					isError: true,
					content: [
						{
							type: 'text',
							text: 'send_message requires "text" and a "to" that is a string or a list of strings.'
						}
					]
				}
			}
			const thread = threadArgument(args.thread)
			if (thread === INVALID_THREAD) {
				return {
					isError: true,
					content: [
						{
							type: 'text',
							text: 'send_message\'s "thread" must be a thread handle or { "new": "<title>" }.'
						}
					]
				}
			}
			const result = await handlers.sendMessage({ to, text: args.text, thread })
			return {
				content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
				isError: result.ok ? undefined : true
			}
		}
		if (name === 'read_history') {
			const query: HistoryQuery = {}
			if (typeof args.room === 'string') query.room = args.room
			if (typeof args.thread === 'string') query.thread = args.thread
			if (typeof args.since === 'string') query.since = args.since
			if (typeof args.limit === 'number') query.limit = args.limit
			if (typeof args.search === 'string') query.search = args.search
			const result = await handlers.readHistory(query)
			return {
				content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
				isError: result.ok ? undefined : true
			}
		}
		throw new Error(`unknown tool: ${name}`)
	})

	await server.connect(new StdioServerTransport())

	// Presence beacon: announce under our live registry id, re-key as our identity settles, and
	// clean up on exit. Peers join their registry read against these beacons on session id, so a
	// beacon keyed by anything the registry does not publish makes us unreachable.
	const beacons = createBeaconKeeper(channelsHome)
	const startedAt = Date.now()
	// Our beacon and our inbox subscription must name the same session id: peers discover us via
	// the beacon and address messages there, and the transport only delivers what is addressed to
	// the id we subscribed with. Move them together, or we advertise an address we do not answer.
	const publish = () => {
		const me = self()
		if (me.sessionId === UNKNOWN) return
		beacons.sync({
			sessionId: me.sessionId,
			pid: process.pid,
			name: me.name,
			role: me.role,
			epic: me.epic,
			startedAt
		})
		transport.rekey(me.sessionId)
	}

	// Subscribe before advertising, so we are already answering at whatever id we publish.
	handlers.start() // watch our inbox -> inject incoming messages as channel events
	publish()
	// A `--resume` rewrite lands just after we start; catch it well before the slow refresh.
	setTimeout(publish, BEACON_SETTLE_MS).unref?.()
	const refresh = setInterval(publish, BEACON_REFRESH_MS)
	refresh.unref?.()

	const cleanup = () => {
		beacons.remove()
		process.exit(0)
	}
	process.on('SIGINT', cleanup)
	process.on('SIGTERM', cleanup)
	process.on('exit', () => beacons.remove())
}

main().catch((err) => {
	process.stderr.write(`sessionbus fatal: ${err instanceof Error ? err.stack : String(err)}\n`)
	process.exit(1)
})
