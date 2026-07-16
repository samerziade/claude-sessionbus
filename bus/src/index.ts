#!/usr/bin/env node
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { createHandlers } from './handlers.ts'
import { type PeerIdentity, resolveSelf } from './identity.ts'
import { createBeaconKeeper, readSessionEntries } from './registry.ts'
import { createTransport } from './transport.ts'

const SESSIONS_DIR = process.env.SESSIONS_DIR ?? join(homedir(), '.claude', 'sessions')
const CHANNELS_HOME = process.env.CHANNELS_HOME ?? join(homedir(), '.claude', 'channels')
const BROKER_SOCK = process.env.BROKER_SOCK ?? join(CHANNELS_HOME, 'broker.sock')
const BEACON_REFRESH_MS = 30_000
/** A `--resume` launch rewrites the registry just after spawning us; re-publish once it lands. */
const BEACON_SETTLE_MS = 1_000
const UNKNOWN = 'unknown'

const INSTRUCTIONS =
	'Messages tagged <channel source="sessionbus" ...> are from ANOTHER Claude Code session on this machine. ' +
	'Use the list_peers tool to see reachable sessions and send_message to reach one. The `to` argument accepts ' +
	'a session id (full or short), a session-name substring, "pm" (the PM of your epic), or "epic" (broadcast to ' +
	'your epic). When you receive a message, decide whether to act on it or reply with send_message addressed to ' +
	'the from_id in the tag. Sessions named "epic:<n>" are PMs; "<issue> epic:<n>" are workers — routing hints, not ' +
	'hard rules. If send_message returns ambiguous/not_found, call list_peers and retry with a precise session id.'

async function main(): Promise<void> {
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

	const server = new Server(
		{ name: 'sessionbus', version: '0.0.1' },
		{
			capabilities: { experimental: { 'claude/channel': {} }, tools: {} },
			instructions: INSTRUCTIONS
		}
	)

	const transport = createTransport({ channelsHome: CHANNELS_HOME, socketPath: BROKER_SOCK })
	const handlers = createHandlers({
		self,
		channelsHome: CHANNELS_HOME,
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
					'Send a message to another session. `to` = session id, name substring, "pm", or "epic".',
				inputSchema: {
					type: 'object',
					properties: {
						to: {
							type: 'string',
							description:
								'Recipient: session id (full/short), name substring, "pm", or "epic"/"epic:N"'
						},
						text: { type: 'string', description: 'The message body' }
					},
					required: ['to', 'text'],
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
			if (typeof args.to !== 'string' || typeof args.text !== 'string') {
				return {
					isError: true,
					content: [{ type: 'text', text: 'send_message requires string "to" and "text".' }]
				}
			}
			const result = handlers.sendMessage({ to: args.to, text: args.text })
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
	const beacons = createBeaconKeeper(CHANNELS_HOME)
	const startedAt = Date.now()
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
	}

	publish()
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

	// Begin watching our inbox -> inject incoming messages as channel events.
	handlers.start()
}

main().catch((err) => {
	process.stderr.write(`sessionbus fatal: ${err instanceof Error ? err.stack : String(err)}\n`)
	process.exit(1)
})
