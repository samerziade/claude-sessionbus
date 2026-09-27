import { describe, expect, it } from 'vitest'
import type { Config } from './config.ts'
import type {
	CreateRoomRequest,
	JoinedRooms,
	MatrixClient,
	MatrixErr,
	MatrixResult,
	RoomRef
} from './matrix-client.ts'
import { createNamer, localpartOf, type Namer, projectFromRemote, slug } from './matrix-names.ts'
import { createProvisioner, type Provisioner } from './matrix-provisioner.ts'

const DOMAIN = 'host.example'
const BRIDGE = `@cc.bridge:${DOMAIN}`
const OPERATOR = `@operator:${DOMAIN}`
const ROOT_SPACE = `!root:${DOMAIN}`
const PROJECT = 'sessionbus'

const namer: Namer = createNamer({ prefix: 'cc', domain: DOMAIN })

interface Call {
	op: string
	asUser?: string
	target?: string
	detail?: string
	request?: CreateRoomRequest
}

interface FakeBehaviour {
	/** Aliases whose creation is refused because the alias is already claimed. */
	aliasInUse: Set<string>
	/** Alias → room id, as the directory would answer. */
	directory: Map<string, string>
	/** Users whose registration is refused with `M_USER_IN_USE`. */
	usersInUse: Set<string>
	/** Queued failures per user id, consumed one per registration attempt. */
	registerFailures: Map<string, MatrixErr[]>
	/** Rooms the joined-rooms listing reports for the bridge's user. */
	bridgeJoinedRooms: string[]
	failListJoinedRooms: boolean
	refuseBridgeJoin: boolean
	failResolveAlias: boolean
	failLink: boolean
	failInvite: boolean
}

interface Fake {
	client: MatrixClient
	calls: Call[]
	behaviour: FakeBehaviour
}

function err(kind: MatrixErr['kind'], status: number, errcode?: string): MatrixErr {
	return { ok: false, kind, status, errcode, message: `fake failure: ${status}` }
}

function roomIdFor(alias: string): string {
	return `!${localpartOf(alias)}:${DOMAIN}`
}

function createFake(overrides: Partial<FakeBehaviour> = {}): Fake {
	const behaviour: FakeBehaviour = {
		aliasInUse: new Set(),
		directory: new Map(),
		usersInUse: new Set(),
		registerFailures: new Map(),
		bridgeJoinedRooms: [],
		failListJoinedRooms: false,
		refuseBridgeJoin: false,
		failResolveAlias: false,
		failLink: false,
		failInvite: false,
		...overrides
	}
	const calls: Call[] = []

	function create(req: CreateRoomRequest, asUser: string, space: boolean): MatrixResult<RoomRef> {
		calls.push({
			op: space ? 'createSpace' : 'createRoom',
			asUser,
			target: req.alias,
			request: req
		})
		if (behaviour.aliasInUse.has(req.alias)) return err('matrix', 400, 'M_ROOM_IN_USE')
		return { ok: true, value: { roomId: roomIdFor(req.alias) } }
	}

	const client: MatrixClient = {
		registerUser: async (userId) => {
			calls.push({ op: 'registerUser', target: userId })
			const queued = behaviour.registerFailures.get(userId)
			const next = queued?.shift()
			if (next) return next
			if (behaviour.usersInUse.has(userId)) return err('matrix', 400, 'M_USER_IN_USE')
			return { ok: true, value: undefined }
		},
		setDisplayName: async (userId, displayName, asUser) => {
			calls.push({ op: 'setDisplayName', asUser, target: userId, detail: displayName })
			return { ok: true, value: undefined }
		},
		createRoom: async (req, asUser) => create(req, asUser, false),
		createSpace: async (req, asUser) => create(req, asUser, true),
		resolveAlias: async (alias, asUser) => {
			calls.push({ op: 'resolveAlias', asUser, target: alias })
			if (behaviour.failResolveAlias) return err('server', 500)
			const roomId = behaviour.directory.get(alias)
			if (roomId === undefined) return err('matrix', 404, 'M_NOT_FOUND')
			return { ok: true, value: { roomId } }
		},
		joinRoom: async (roomIdOrAlias, asUser) => {
			calls.push({ op: 'joinRoom', asUser, target: roomIdOrAlias })
			if (asUser === BRIDGE && behaviour.refuseBridgeJoin) return err('auth', 403, 'M_FORBIDDEN')
			return { ok: true, value: { roomId: roomIdOrAlias } }
		},
		invite: async (roomId, userId, asUser) => {
			calls.push({ op: 'invite', asUser, target: roomId, detail: userId })
			if (behaviour.failInvite) return err('matrix', 403, 'M_FORBIDDEN')
			return { ok: true, value: undefined }
		},
		linkSpaceChild: async (spaceId, childRoomId, asUser) => {
			calls.push({ op: 'linkSpaceChild', asUser, target: spaceId, detail: childRoomId })
			if (behaviour.failLink) return err('matrix', 403, 'M_FORBIDDEN')
			return { ok: true, value: undefined }
		},
		listJoinedRooms: async (asUser): Promise<MatrixResult<JoinedRooms>> => {
			calls.push({ op: 'listJoinedRooms', asUser })
			if (behaviour.failListJoinedRooms) return err('server', 500)
			return { ok: true, value: { rooms: [...behaviour.bridgeJoinedRooms] } }
		},
		// Provisioning makes none of these; they exist so the fake satisfies the interface the
		// relay widened, and calling one here is a test bug rather than a supported path.
		sync: async () => err('server', 500),
		leaveRoom: async () => err('server', 500),
		roomMessages: async () => err('server', 500),
		sendMessage: async () => err('server', 500)
	}
	return { client, calls, behaviour }
}

interface ManualClock {
	delays: number[]
	/** Release the oldest outstanding sleep. */
	release(): void
	sleep(ms: number): Promise<void>
}

function manualClock(): ManualClock {
	const delays: number[] = []
	const waiting: Array<() => void> = []
	return {
		delays,
		release: () => waiting.shift()?.(),
		sleep: (ms) =>
			new Promise<void>((resolve) => {
				delays.push(ms)
				waiting.push(resolve)
			})
	}
}

/** Let every already-scheduled microtask and timer callback run. */
function settle(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0))
}

/** Drive `n` backoff rounds: wait for the sleep to be scheduled, then let it elapse. */
async function pump(clock: ManualClock, n: number): Promise<void> {
	for (let i = 0; i < n; i++) {
		await settle()
		clock.release()
	}
	await settle()
}

interface ConfigOverrides {
	owner?: string
	rootSpace?: string
}

function testConfig(overrides: ConfigOverrides = {}): Config {
	return {
		channelsHome: '/tmp/channels',
		transport: 'socket',
		matrix: {
			enabled: true,
			url: 'https://hs.example',
			tokenCommand: ['echo', 'token'],
			rootSpace: 'rootSpace' in overrides ? overrides.rootSpace : ROOT_SPACE,
			owner: 'owner' in overrides ? overrides.owner : OPERATOR,
			// The same domain the namer is built with: an identifier and the server it names
			// must agree, and nothing derives one from the other.
			domain: DOMAIN,
			namespacePrefix: 'cc',
			unreadCap: { messages: 20, chars: 2000 }
		},
		projects: {}
	}
}

interface Harness {
	provisioner: Provisioner
	fake: Fake
	clock: ManualClock
	logs: string[]
}

function harness(fake = createFake(), overrides: ConfigOverrides = {}): Harness {
	const clock = manualClock()
	const logs: string[] = []
	const provisioner = createProvisioner({
		client: fake.client,
		namer,
		config: testConfig(overrides),
		clock,
		random: () => 1,
		log: (m) => logs.push(m)
	})
	return { provisioner, fake, clock, logs }
}

function ops(fake: Fake, op: string): Call[] {
	return fake.calls.filter((c) => c.op === op)
}

/** Everything the bridge-user bootstrap did not do. */
function afterBootstrap(fake: Fake): Call[] {
	return fake.calls.filter((c) => !(c.op === 'registerUser' && c.target === BRIDGE))
}

function unwrap<T>(result: MatrixResult<T>): T {
	if (!result.ok) throw new Error(`expected success, got ${result.message}`)
	return result.value
}

const LOBBY = namer.lobbyAlias(PROJECT)
const SPACE = namer.spaceAlias(PROJECT)
const EPIC = namer.epicRoomAlias(PROJECT, '42')
const WORKER = namer.workerUser(PROJECT, '123')

describe('provisioner (happy path)', () => {
	it('ensures a user, a space, a lobby, an epic room and a membership', async () => {
		const h = harness()

		expect((await h.provisioner.ensureUser(WORKER, '123 epic:42')).ok).toBe(true)
		const space = unwrap(await h.provisioner.ensureSpace(PROJECT))
		const lobby = unwrap(await h.provisioner.ensureRoom(LOBBY))
		const epic = unwrap(await h.provisioner.ensureRoom(EPIC))
		expect((await h.provisioner.ensureMember(lobby.roomId, WORKER)).ok).toBe(true)

		expect(space.roomId).toBe(roomIdFor(SPACE))
		expect(epic.roomId).toBe(roomIdFor(EPIC))
	})

	it('gives a project a space and a lobby as two distinct objects', async () => {
		const h = harness()

		const space = unwrap(await h.provisioner.ensureSpace(PROJECT))
		const lobby = unwrap(await h.provisioner.ensureRoom(LOBBY))

		expect(space.roomId).not.toBe(lobby.roomId)
		expect(ops(h.fake, 'createSpace').map((c) => c.target)).toEqual([SPACE])
		expect(ops(h.fake, 'createRoom').map((c) => c.target)).toEqual([LOBBY])
	})
})

describe('provisioner (idempotency)', () => {
	it('creates a user once however often it is ensured', async () => {
		const h = harness()

		expect((await h.provisioner.ensureUser(WORKER, 't')).ok).toBe(true)
		expect((await h.provisioner.ensureUser(WORKER, 't')).ok).toBe(true)

		expect(ops(h.fake, 'registerUser').filter((c) => c.target === WORKER)).toHaveLength(1)
	})

	it('treats a user that already exists as a success', async () => {
		const h = harness(createFake({ usersInUse: new Set([WORKER]) }))

		expect((await h.provisioner.ensureUser(WORKER, 't')).ok).toBe(true)
	})

	it('returns the same room from one create when ensured twice', async () => {
		const h = harness()

		const first = unwrap(await h.provisioner.ensureRoom(LOBBY))
		const second = unwrap(await h.provisioner.ensureRoom(LOBBY))

		expect(second.roomId).toBe(first.roomId)
		expect(ops(h.fake, 'createRoom')).toHaveLength(1)
	})

	it('succeeds when the member is already in the room', async () => {
		// An invite refused because the user is already there is not a failure: the join is what
		// actually decides membership.
		const h = harness(createFake({ failInvite: true }))

		const lobby = unwrap(await h.provisioner.ensureRoom(LOBBY))
		expect((await h.provisioner.ensureMember(lobby.roomId, WORKER)).ok).toBe(true)
		expect((await h.provisioner.ensureMember(lobby.roomId, WORKER)).ok).toBe(true)
	})
})

describe('provisioner (adoption)', () => {
	it('adopts the existing room when the alias is already claimed', async () => {
		const existing = `!already-there:${DOMAIN}`
		const h = harness(
			createFake({
				aliasInUse: new Set([LOBBY]),
				directory: new Map([[LOBBY, existing]]),
				bridgeJoinedRooms: [existing]
			})
		)

		expect(unwrap(await h.provisioner.ensureRoom(LOBBY)).roomId).toBe(existing)
	})

	it('reports a failure when the alias is claimed and cannot be resolved', async () => {
		const h = harness(createFake({ aliasInUse: new Set([LOBBY]), failResolveAlias: true }))

		expect((await h.provisioner.ensureRoom(LOBBY)).ok).toBe(false)
	})
})

describe('provisioner (memoization)', () => {
	it('shares one attempt between two concurrent ensures of the same room', async () => {
		const h = harness()

		const [a, b] = await Promise.all([
			h.provisioner.ensureRoom(LOBBY),
			h.provisioner.ensureRoom(LOBBY)
		])

		expect(unwrap(a).roomId).toBe(unwrap(b).roomId)
		expect(ops(h.fake, 'createRoom')).toHaveLength(1)
	})

	it('does not cache a failure: the next ensure tries again', async () => {
		const h = harness(createFake({ aliasInUse: new Set([LOBBY]), failResolveAlias: true }))

		expect((await h.provisioner.ensureRoom(LOBBY)).ok).toBe(false)
		h.fake.behaviour.aliasInUse.delete(LOBBY)
		h.fake.behaviour.failResolveAlias = false

		expect((await h.provisioner.ensureRoom(LOBBY)).ok).toBe(true)
	})

	it('does not share an attempt between two different rooms', async () => {
		const h = harness()

		const [a, b] = await Promise.all([
			h.provisioner.ensureRoom(LOBBY),
			h.provisioner.ensureRoom(EPIC)
		])

		expect(unwrap(a).roomId).not.toBe(unwrap(b).roomId)
		expect(ops(h.fake, 'createRoom')).toHaveLength(2)
	})
})

describe('provisioner (room properties and the operator)', () => {
	it('creates the room under the alias it was asked for', async () => {
		// What the creation asks the homeserver for — invite-only, unencrypted, history
		// readable by later joiners — is the client's request body, and is asserted there.
		const h = harness()

		await h.provisioner.ensureRoom(LOBBY)

		expect(ops(h.fake, 'createRoom')[0].request?.alias).toBe(LOBBY)
	})

	it('invites the operator to a room it creates', async () => {
		const h = harness()

		await h.provisioner.ensureRoom(LOBBY)

		expect(ops(h.fake, 'createRoom')[0].request?.invite).toEqual([OPERATOR])
	})

	it('invites nobody when no operator is configured', async () => {
		const h = harness(createFake(), { owner: undefined })

		await h.provisioner.ensureRoom(LOBBY)

		expect(ops(h.fake, 'createRoom')[0].request?.invite).toBeUndefined()
	})

	it('leaves an adopted room alone: no operator invite and no settings reconciled', async () => {
		const existing = `!hand-made:${DOMAIN}`
		const h = harness(
			createFake({
				aliasInUse: new Set([LOBBY]),
				directory: new Map([[LOBBY, existing]]),
				bridgeJoinedRooms: [existing]
			})
		)

		await h.provisioner.ensureRoom(LOBBY)

		expect(ops(h.fake, 'invite')).toEqual([])
		// The only calls an adoption may make: the refused create, the directory lookup and the
		// one membership check. Nothing that could change a join rule, history or topic.
		expect(afterBootstrap(h.fake).map((c) => c.op)).toEqual([
			'createRoom',
			'resolveAlias',
			'listJoinedRooms'
		])
	})
})

describe('provisioner (space linking)', () => {
	it('reports a space as linked when nesting it succeeds', async () => {
		const h = harness()

		const space = unwrap(await h.provisioner.ensureSpace(PROJECT))

		expect(space.linked).toBe(true)
		expect(ops(h.fake, 'linkSpaceChild')).toHaveLength(1)
	})

	it('still yields a usable space when nesting is refused', async () => {
		const h = harness(createFake({ failLink: true }))

		const space = unwrap(await h.provisioner.ensureSpace(PROJECT))

		expect(space.roomId).toBe(roomIdFor(SPACE))
		expect(space.linked).toBe(false)
	})

	it('makes no further attempt under a root that refused one', async () => {
		// Two *different* spaces, so the assertion cannot pass on the memo alone: the second
		// ensure genuinely reaches the link step and must decline to issue a request. The
		// privilege is the operator's and does not vary by child, so one refusal settles it.
		const h = harness(createFake({ failLink: true }))

		const first = unwrap(await h.provisioner.ensureSpace('alpha'))
		const second = unwrap(await h.provisioner.ensureSpace('beta'))

		expect(ops(h.fake, 'linkSpaceChild')).toHaveLength(1)
		expect([first.linked, second.linked]).toEqual([false, false])
	})

	it('does not retry the link when the same space is ensured again', async () => {
		const h = harness(createFake({ failLink: true }))

		await h.provisioner.ensureSpace(PROJECT)
		await h.provisioner.ensureSpace(PROJECT)

		expect(ops(h.fake, 'linkSpaceChild')).toHaveLength(1)
	})

	it('makes no link request when no root space is configured', async () => {
		const h = harness(createFake(), { rootSpace: undefined })

		expect(unwrap(await h.provisioner.ensureSpace(PROJECT)).linked).toBe(false)
		expect(ops(h.fake, 'linkSpaceChild')).toEqual([])
	})
})

describe('provisioner (display names)', () => {
	it('sets the display name to the title on the first ensure', async () => {
		const h = harness()

		await h.provisioner.ensureUser(WORKER, '123 epic:42')

		expect(ops(h.fake, 'setDisplayName').map((c) => c.detail)).toEqual(['123 epic:42'])
	})

	it('does not rewrite an unchanged title', async () => {
		const h = harness()

		await h.provisioner.ensureUser(WORKER, '123 epic:42')
		await h.provisioner.ensureUser(WORKER, '123 epic:42')

		expect(ops(h.fake, 'setDisplayName')).toHaveLength(1)
	})

	it('rewrites the display name when the title changed', async () => {
		const h = harness()

		await h.provisioner.ensureUser(WORKER, '123 epic:42')
		await h.provisioner.ensureUser(WORKER, '124 epic:42')

		expect(ops(h.fake, 'setDisplayName').map((c) => c.detail)).toEqual([
			'123 epic:42',
			'124 epic:42'
		])
	})
})

describe("provisioner (a space's name)", () => {
	/** What a session announces for a directory whose `origin` remote is `url`. */
	function announced(url: string): { project: string; projectName?: string } {
		const parsed = projectFromRemote(url)
		if (parsed === undefined) throw new Error('fixture must parse')
		return { project: slug(parsed.project), projectName: parsed.name }
	}

	it('shows the owner and the repository for a project derived from a remote', async () => {
		const h = harness()
		const { project, projectName } = announced('git@host.example:owner/repo.git')

		await h.provisioner.ensureSpace(project, projectName)

		expect(project).toBe('owner-repo') // the alias keeps the slug...
		expect(ops(h.fake, 'createSpace')[0].request?.alias).toBe(namer.spaceAlias('owner-repo'))
		expect(ops(h.fake, 'createSpace')[0].request?.name).toBe('owner/repo') // ...the name does not
	})

	it('shows its slug for a project that has no owner to show', async () => {
		const h = harness()

		await h.provisioner.ensureSpace('scratch')

		expect(ops(h.fake, 'createSpace')[0].request?.name).toBe('scratch')
	})

	it('shows its slug for a project announced without a name', async () => {
		const h = harness()

		await h.provisioner.provisionSession({ project: 'scratch', title: 'notes' })

		expect(ops(h.fake, 'createSpace')[0].request?.name).toBe('scratch')
	})

	it('carries the name a session announced all the way to the creation request', async () => {
		const h = harness()
		const { project, projectName } = announced('https://host.example/My Org/My Repo/')

		await h.provisioner.provisionSession({ project, projectName, title: '123 epic:42' })

		expect(ops(h.fake, 'createSpace')[0].request?.name).toBe('My Org/My Repo')
		expect(ops(h.fake, 'createSpace')[0].request?.alias).toBe(namer.spaceAlias('my-org-my-repo'))
	})

	it('names a room after its own alias, never after the project', async () => {
		const h = harness()

		await h.provisioner.provisionSession({
			project: 'owner-repo',
			projectName: 'owner/repo',
			title: '123 epic:42'
		})

		// Only the space carries the readable name; a lobby and an epic room are named where
		// they always were, by the alias they were asked for.
		expect(ops(h.fake, 'createSpace').map((c) => c.request?.name)).toEqual(['owner/repo'])
		expect(ops(h.fake, 'createRoom').every((c) => c.request?.name !== 'owner/repo')).toBe(true)
	})
})

describe('provisioner (grouping)', () => {
	it('joins a worker to its epic room and its project lobby', async () => {
		const h = harness()

		expect(
			(await h.provisioner.provisionSession({ project: PROJECT, title: '123 epic:42' })).ok
		).toBe(true)

		const joinedRooms = ops(h.fake, 'joinRoom')
			.filter((c) => c.asUser === WORKER)
			.map((c) => c.target)
		expect(joinedRooms).toEqual([roomIdFor(LOBBY), roomIdFor(EPIC)])
	})

	it('joins an unstructured session to the lobby only, ensuring no epic room', async () => {
		const h = harness()

		await h.provisioner.provisionSession({ project: PROJECT, title: 'planning notes' })

		const user = namer.titleUser(PROJECT, 'planning notes')
		expect(
			ops(h.fake, 'joinRoom')
				.filter((c) => c.asUser === user)
				.map((c) => c.target)
		).toEqual([roomIdFor(LOBBY)])
		expect(ops(h.fake, 'createRoom').map((c) => c.target)).toEqual([LOBBY])
	})

	it('ensures nothing at all for a session with no project', async () => {
		const h = harness()

		expect((await h.provisioner.provisionSession({ title: '123 epic:42' })).ok).toBe(true)

		expect(afterBootstrap(h.fake)).toEqual([])
	})
})

describe('provisioner (bridge membership)', () => {
	it('creates rooms and spaces as the bridge own user, needing no separate join', async () => {
		const h = harness()

		await h.provisioner.ensureRoom(LOBBY)
		await h.provisioner.ensureSpace(PROJECT)

		expect(ops(h.fake, 'createRoom')[0].asUser).toBe(BRIDGE)
		expect(ops(h.fake, 'createSpace')[0].asUser).toBe(BRIDGE)
		expect(ops(h.fake, 'joinRoom').filter((c) => c.asUser === BRIDGE)).toEqual([])
	})

	it('joins an adopted room the bridge is not already in', async () => {
		const existing = `!hand-made:${DOMAIN}`
		const h = harness(
			createFake({ aliasInUse: new Set([LOBBY]), directory: new Map([[LOBBY, existing]]) })
		)

		expect(unwrap(await h.provisioner.ensureRoom(LOBBY)).roomId).toBe(existing)
		expect(ops(h.fake, 'joinRoom').map((c) => [c.asUser, c.target])).toEqual([[BRIDGE, existing]])
	})

	it('issues no join for an adopted room the listing already reports', async () => {
		const existing = `!hand-made:${DOMAIN}`
		const h = harness(
			createFake({
				aliasInUse: new Set([LOBBY]),
				directory: new Map([[LOBBY, existing]]),
				bridgeJoinedRooms: [existing]
			})
		)

		await h.provisioner.ensureRoom(LOBBY)

		expect(ops(h.fake, 'joinRoom')).toEqual([])
	})

	it('issues no join for a room this run already created under another alias', async () => {
		const h = harness(
			createFake({ aliasInUse: new Set([EPIC]), directory: new Map([[EPIC, roomIdFor(LOBBY)]]) })
		)

		await h.provisioner.ensureRoom(LOBBY) // created, so the bridge is its creator
		await h.provisioner.ensureRoom(EPIC) // adopts the very same room

		expect(ops(h.fake, 'joinRoom')).toEqual([])
		expect(ops(h.fake, 'listJoinedRooms')).toEqual([])
	})

	it('fetches the joined-rooms listing at most once per run', async () => {
		const a = `!a:${DOMAIN}`
		const b = `!b:${DOMAIN}`
		const h = harness(
			createFake({
				aliasInUse: new Set([LOBBY, EPIC]),
				directory: new Map([
					[LOBBY, a],
					[EPIC, b]
				]),
				bridgeJoinedRooms: [a, b]
			})
		)

		await h.provisioner.ensureRoom(LOBBY)
		await h.provisioner.ensureRoom(EPIC)

		expect(ops(h.fake, 'listJoinedRooms')).toHaveLength(1)
	})

	it('fails the ensure when the bridge join is refused', async () => {
		const existing = `!hand-made:${DOMAIN}`
		const h = harness(
			createFake({
				aliasInUse: new Set([LOBBY]),
				directory: new Map([[LOBBY, existing]]),
				refuseBridgeJoin: true
			})
		)

		expect((await h.provisioner.ensureRoom(LOBBY)).ok).toBe(false)
	})

	it('retries the refused join on the next ensure and then succeeds', async () => {
		const existing = `!hand-made:${DOMAIN}`
		const h = harness(
			createFake({
				aliasInUse: new Set([LOBBY]),
				directory: new Map([[LOBBY, existing]]),
				refuseBridgeJoin: true
			})
		)

		expect((await h.provisioner.ensureRoom(LOBBY)).ok).toBe(false)
		h.fake.behaviour.refuseBridgeJoin = false

		expect(unwrap(await h.provisioner.ensureRoom(LOBBY)).roomId).toBe(existing)
		expect(ops(h.fake, 'joinRoom').filter((c) => c.asUser === BRIDGE)).toHaveLength(2)
	})

	it('joins an adopted room at most once across repeated ensures', async () => {
		const existing = `!hand-made:${DOMAIN}`
		const h = harness(
			createFake({ aliasInUse: new Set([LOBBY]), directory: new Map([[LOBBY, existing]]) })
		)

		await h.provisioner.ensureRoom(LOBBY)
		await h.provisioner.ensureRoom(LOBBY)

		expect(ops(h.fake, 'joinRoom').filter((c) => c.asUser === BRIDGE)).toHaveLength(1)
	})

	it('joins rather than guessing when the joined-rooms listing cannot be read', async () => {
		const existing = `!hand-made:${DOMAIN}`
		const h = harness(
			createFake({
				aliasInUse: new Set([LOBBY]),
				directory: new Map([[LOBBY, existing]]),
				failListJoinedRooms: true
			})
		)

		expect(unwrap(await h.provisioner.ensureRoom(LOBBY)).roomId).toBe(existing)
		expect(ops(h.fake, 'joinRoom').filter((c) => c.asUser === BRIDGE)).toHaveLength(1)
	})
})

describe('provisioner (bridge-user bootstrap)', () => {
	it('registers the bridge user before the first room or space create', async () => {
		const h = harness()

		await h.provisioner.provisionSession({ project: PROJECT, title: '123 epic:42' })

		const first = h.fake.calls[0]
		expect([first.op, first.target]).toEqual(['registerUser', BRIDGE])
		const creates = h.fake.calls.findIndex((c) => c.op === 'createRoom' || c.op === 'createSpace')
		expect(creates).toBeGreaterThan(0)
	})

	it('treats an existing bridge user as success and provisions anyway', async () => {
		const h = harness(createFake({ usersInUse: new Set([BRIDGE]) }))

		expect((await h.provisioner.provisionSession({ project: PROJECT, title: 'notes' })).ok).toBe(
			true
		)
		expect(ops(h.fake, 'registerUser').filter((c) => c.target === BRIDGE)).toHaveLength(1)
	})

	it('bootstraps once however many sessions are provisioned', async () => {
		const h = harness()

		await h.provisioner.provisionSession({ project: PROJECT, title: 'a' })
		await h.provisioner.provisionSession({ project: PROJECT, title: 'b' })

		expect(ops(h.fake, 'registerUser').filter((c) => c.target === BRIDGE)).toHaveLength(1)
	})

	it('never registers a session user ahead of the bridge user', async () => {
		const fake = createFake({
			registerFailures: new Map([[BRIDGE, [err('server', 500), err('server', 500)]]])
		})
		const h = harness(fake)

		const provisioning = h.provisioner.provisionSession({ project: PROJECT, title: '123 epic:42' })
		await pump(h.clock, 2)
		expect((await provisioning).ok).toBe(true)

		const registrations = ops(h.fake, 'registerUser').map((c) => c.target)
		expect(registrations.indexOf(WORKER)).toBeGreaterThan(registrations.lastIndexOf(BRIDGE))
	})

	it('makes no other request while the bridge registration is failing', async () => {
		const fake = createFake({
			registerFailures: new Map([[BRIDGE, [err('server', 500)]]])
		})
		const h = harness(fake)

		const provisioning = h.provisioner.provisionSession({ project: PROJECT, title: '123 epic:42' })
		await settle()
		expect(afterBootstrap(h.fake)).toEqual([])

		await pump(h.clock, 1)
		expect((await provisioning).ok).toBe(true)
		expect(afterBootstrap(h.fake).length).toBeGreaterThan(0)
	})

	it('grows the retry delay to a cap it never exceeds', async () => {
		const failures = Array.from({ length: 10 }, () => err('server', 500))
		const h = harness(createFake({ registerFailures: new Map([[BRIDGE, failures]]) }))

		await pump(h.clock, 10)

		expect(h.clock.delays).toHaveLength(10)
		for (let i = 1; i < h.clock.delays.length; i++) {
			expect(h.clock.delays[i]).toBeGreaterThanOrEqual(h.clock.delays[i - 1])
		}
		expect(Math.max(...h.clock.delays)).toBe(60_000)
		expect(h.clock.delays.at(-1)).toBe(60_000)
	})

	it('waits at least as long as a rate limit asked for', async () => {
		const limited: MatrixErr = {
			ok: false,
			kind: 'rate_limited',
			status: 429,
			retryAfterMs: 45_000,
			message: 'fake failure: 429'
		}
		const h = harness(createFake({ registerFailures: new Map([[BRIDGE, [limited]]]) }))

		await pump(h.clock, 1)

		expect(h.clock.delays[0]).toBeGreaterThanOrEqual(45_000)
	})

	it('stops trying after an authentication refusal and provisions nothing', async () => {
		const h = harness(
			createFake({ registerFailures: new Map([[BRIDGE, [err('auth', 401, 'M_UNKNOWN_TOKEN')]]]) })
		)

		const result = await h.provisioner.provisionSession({ project: PROJECT, title: 'notes' })

		expect(result.ok).toBe(false)
		expect(ops(h.fake, 'registerUser')).toHaveLength(1)
		expect(afterBootstrap(h.fake)).toEqual([])
		expect(h.clock.delays).toEqual([])
	})

	it('leaves a session unprovisioned, not rejected, while registration keeps failing', async () => {
		const failures = Array.from({ length: 20 }, () => err('server', 500))
		const h = harness(createFake({ registerFailures: new Map([[BRIDGE, failures]]) }))

		let settled = false
		let rejected = false
		h.provisioner
			.provisionSession({ project: PROJECT, title: '123 epic:42' })
			.then(() => {
				settled = true
			})
			.catch(() => {
				rejected = true
			})
		await pump(h.clock, 3)

		expect(settled).toBe(false)
		expect(rejected).toBe(false)
		expect(afterBootstrap(h.fake)).toEqual([])
	})

	it('starts no ensure of any kind while the gate is still outstanding', async () => {
		const failures = Array.from({ length: 5 }, () => err('server', 500))
		const h = harness(createFake({ registerFailures: new Map([[BRIDGE, failures]]) }))

		const pending = [
			h.provisioner.ensureUser(WORKER, '123 epic:42'),
			h.provisioner.ensureSpace(PROJECT),
			h.provisioner.ensureRoom(LOBBY),
			h.provisioner.ensureMember(roomIdFor(LOBBY), WORKER)
		]
		await pump(h.clock, 2)
		expect(afterBootstrap(h.fake)).toEqual([])

		h.fake.behaviour.registerFailures.set(BRIDGE, [])
		await pump(h.clock, 1)
		for (const result of await Promise.all(pending)) expect(result.ok).toBe(true)
		expect(afterBootstrap(h.fake).length).toBeGreaterThan(0)
	})

	it('never sets or reads the bridge user display name', async () => {
		const h = harness()

		await h.provisioner.provisionSession({ project: PROJECT, title: '123 epic:42' })

		expect(ops(h.fake, 'setDisplayName').map((c) => c.target)).toEqual([WORKER])
		expect(ops(h.fake, 'setDisplayName').map((c) => c.detail)).toEqual(['123 epic:42'])
	})
})
