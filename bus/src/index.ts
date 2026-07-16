#!/usr/bin/env node
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { createHandlers } from './handlers.ts'
import { type PeerIdentity, resolveIdentity } from './identity.ts'
import { readSessionEntries, refreshBeacon, removeBeacon, writeBeacon } from './registry.ts'
import { createTransport } from './transport.ts'

const SESSIONS_DIR = process.env.SESSIONS_DIR ?? join(homedir(), '.claude', 'sessions')
const CHANNELS_HOME = process.env.CHANNELS_HOME ?? join(homedir(), '.claude', 'channels')
const BROKER_SOCK = process.env.BROKER_SOCK ?? join(CHANNELS_HOME, 'broker.sock')
const BEACON_REFRESH_MS = 30_000

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

	// Resolve identity from the registry; fall back to a name-less peer if absent.
	const entries = readSessionEntries(SESSIONS_DIR)
	const self: PeerIdentity = (sessionId ? resolveIdentity(sessionId, entries) : null) ?? {
		sessionId: sessionId ?? 'unknown',
		name: sessionId ?? 'unknown',
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

	// Presence beacon: announce, refresh, and clean up on exit.
	if (sessionId) {
		writeBeacon(CHANNELS_HOME, {
			sessionId,
			pid: process.pid,
			name: self.name,
			role: self.role,
			epic: self.epic,
			startedAt: Date.now()
		})
		const refresh = setInterval(() => refreshBeacon(CHANNELS_HOME, sessionId), BEACON_REFRESH_MS)
		refresh.unref?.()
		const cleanup = () => {
			removeBeacon(CHANNELS_HOME, sessionId)
			process.exit(0)
		}
		process.on('SIGINT', cleanup)
		process.on('SIGTERM', cleanup)
		process.on('exit', () => removeBeacon(CHANNELS_HOME, sessionId))
	}

	// Begin watching our inbox -> inject incoming messages as channel events.
	handlers.start()
}

main().catch((err) => {
	process.stderr.write(`sessionbus fatal: ${err instanceof Error ? err.stack : String(err)}\n`)
	process.exit(1)
})
