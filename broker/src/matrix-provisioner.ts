import { parseSessionName } from '../../bus/src/identity.ts'
import type { Config } from './config.ts'
import type {
	CreateRoomRequest,
	MatrixClient,
	MatrixErr,
	MatrixResult,
	RoomRef
} from './matrix-client.ts'
import { type Namer, slug } from './matrix-names.ts'

/**
 * Idempotent provisioning of the users, spaces and rooms a session is grouped into.
 *
 * Three properties carry the weight here:
 *
 * - **The bridge's own user gates everything.** Every room and space is created *as* that user,
 *   so on a fresh homeserver nothing else can succeed until it exists. Being permitted to act
 *   as a name in the namespace does not create the account, and `whoami` cannot tell you —
 *   it answers for the credential's idle sender identity, which is a different account
 *   entirely. Registration's own "already in use" answer is the only real check.
 * - **In-flight attempts are shared, failures are not remembered.** Two sessions registering at
 *   once issue one create; a transient failure is retried by the next caller rather than
 *   leaving a session without its room for the life of the process.
 * - **A room is never reported provisioned unless the bridge's user is in it.** The relay sees
 *   only rooms that user has joined, so a room without it is a room whose every mention is
 *   silently never seen — while provisioning, posting and the operator's client all report
 *   success. That is the failure shape this repo has shipped once already.
 *
 * Nothing here throws: every outcome is a value, because an escaped rejection reaches the
 * broker's fatal handlers and would turn a homeserver outage into a crash-loop.
 */

/** Injected so backoff is tested exactly, without sleeping. */
export interface Clock {
	sleep(ms: number): Promise<void>
}

export interface SpaceRef {
	roomId: string
	/** False when nesting under the root space was refused — a supported degraded state. */
	linked: boolean
}

export interface EnsureRoomOptions {
	name?: string
	/** Room id of the space to nest this room under, when it is known. */
	parentSpace?: string
}

export interface SessionProvisionInput {
	project?: string
	/** The project as a person recognizes it, when the session announced one. */
	projectName?: string
	title?: string
}

export interface Provisioner {
	ensureUser(userId: string, title?: string): Promise<MatrixResult<void>>
	/**
	 * `name` is what a client shows — `<owner>/<repo>` for a project derived from a remote. The
	 * alias is built from the project either way; a display name has no character rules to
	 * survive, which is why the readable form belongs there and not in the alias.
	 */
	ensureSpace(project: string, name?: string): Promise<MatrixResult<SpaceRef>>
	ensureRoom(alias: string, opts?: EnsureRoomOptions): Promise<MatrixResult<RoomRef>>
	ensureMember(roomId: string, userId: string): Promise<MatrixResult<void>>
	provisionSession(input: SessionProvisionInput): Promise<MatrixResult<void>>
}

export interface ProvisionerDeps {
	client: MatrixClient
	namer: Namer
	config: Config
	clock: Clock
	/** Jitter source in [0, 1); injected so a backoff sequence is exact in a test. */
	random: () => number
	log?: (msg: string) => void
}

const BASE_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 60_000
const OK: MatrixResult<void> = { ok: true, value: undefined }

/** Errcodes a homeserver uses for "that alias is already claimed". */
const ALIAS_IN_USE = new Set(['M_ROOM_IN_USE', 'M_ROOM_ALIAS_IN_USE', 'M_UNKNOWN_ALIAS_IN_USE'])

function isAliasInUse(err: MatrixErr): boolean {
	return err.errcode !== undefined && ALIAS_IN_USE.has(err.errcode)
}

/**
 * The Matrix user a session acts as. Exported because provisioning is not the only caller: the
 * inbound relay has to name the same user to recognise a mention of it, and two copies of this
 * rule would drift into a session that can be written to but never woken.
 */
export function sessionUser(namer: Namer, project: string, title: string): string {
	const parsed = parseSessionName(title)
	if (parsed.role === 'pm' && parsed.epic !== undefined) return namer.pmUser(project, parsed.epic)
	if (parsed.role === 'worker' && parsed.issue !== undefined) {
		return namer.workerUser(project, parsed.issue)
	}
	return namer.titleUser(project, title)
}

export function createProvisioner(deps: ProvisionerDeps): Provisioner {
	const log = deps.log ?? (() => {})
	const bridgeUser = deps.namer.bridgeUser()
	const operator = deps.config.matrix.owner
	const rootSpace = deps.config.matrix.rootSpace

	// One in-flight map per kind, so sharing an attempt needs no cast to a common value type.
	const users = new Map<string, Promise<MatrixResult<void>>>()
	const rooms = new Map<string, Promise<MatrixResult<RoomRef>>>()
	const spaces = new Map<string, Promise<MatrixResult<SpaceRef>>>()
	const members = new Map<string, Promise<MatrixResult<void>>>()
	/** Last display name we set per user, so an unchanged title costs no request. */
	const displayNames = new Map<string, string>()
	/** Rooms the bridge's user is known to be in — created, joined, or seen in the listing. */
	const bridgeJoined = new Set<string>()
	/**
	 * Parents under which nesting has been refused. Keyed on the **parent**, not the pair: the
	 * power level to nest a child belongs to the parent space and is the operator's to grant,
	 * so it does not vary by child. One refusal therefore settles it for the run, instead of
	 * one doomed request per space per registration.
	 */
	const linkFailed = new Set<string>()
	let joinedListing: Promise<Set<string> | undefined> | undefined
	let rootSpaceId: Promise<string | undefined> | undefined

	/**
	 * Share one in-flight attempt per key and evict a failed one. A cached failure would leave
	 * a session permanently without its room — indistinguishable, from the operator's seat,
	 * from the bridge being switched off.
	 */
	function memoize<T>(
		map: Map<string, Promise<MatrixResult<T>>>,
		key: string,
		run: () => Promise<MatrixResult<T>>
	): Promise<MatrixResult<T>> {
		const existing = map.get(key)
		if (existing !== undefined) return existing
		const attempt = run().then((result) => {
			if (!result.ok) map.delete(key)
			return result
		})
		map.set(key, attempt)
		return attempt
	}

	/**
	 * Register the bridge's own user, retrying a transient refusal with capped exponential
	 * backoff and full jitter. Never memoized as failed — the promise simply stays pending
	 * while retries run, so a session that registers early waits instead of being provisioned
	 * out of order or dropped. An authentication refusal is not transient: retrying a revoked
	 * credential only spins, so the gate resolves as a failure and provisioning stays off until
	 * the broker is restarted.
	 */
	async function bootstrapBridgeUser(): Promise<MatrixResult<void>> {
		for (let attempt = 0; ; attempt++) {
			let result: MatrixResult<void>
			try {
				result = await deps.client.registerUser(bridgeUser)
			} catch {
				result = { ok: false, kind: 'network', message: 'bridge user registration threw' }
			}
			if (result.ok) return result
			// The normal outcome on every start after the first.
			if (result.errcode === 'M_USER_IN_USE') return OK
			if (result.kind === 'auth') {
				log('bridge user registration refused; provisioning is off until restart')
				return result
			}
			const backoff = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS)
			const delay = Math.max(backoff * deps.random(), result.retryAfterMs ?? 0)
			log(`bridge user registration failed; retrying in ${Math.round(delay)}ms`)
			try {
				await deps.clock.sleep(delay)
			} catch {
				// A clock that throws must not end the process either.
			}
		}
	}

	// Started at construction, and caught here so an unexpected throw can never surface as an
	// unhandled rejection on a promise nobody has awaited yet.
	const readiness: Promise<MatrixResult<void>> = bootstrapBridgeUser().catch(() => ({
		ok: false,
		kind: 'network',
		message: 'bridge user bootstrap failed'
	}))

	function joinedRoomsOnce(): Promise<Set<string> | undefined> {
		joinedListing ??= deps.client.listJoinedRooms(bridgeUser).then((result) => {
			// Unknown rather than empty: guessing "not joined" costs one redundant join, while
			// guessing "joined" would leave a room the bridge cannot hear.
			if (!result.ok) return undefined
			return new Set(result.value.rooms)
		})
		return joinedListing
	}

	/** The bridge's own participation — not a setting of the room, a precondition of the system. */
	async function ensureBridgeMembership(roomId: string): Promise<MatrixResult<void>> {
		if (bridgeJoined.has(roomId)) return OK
		const listing = await joinedRoomsOnce()
		if (listing?.has(roomId)) {
			bridgeJoined.add(roomId)
			return OK
		}
		const joined = await deps.client.joinRoom(roomId, bridgeUser)
		if (!joined.ok) return joined
		bridgeJoined.add(roomId)
		return OK
	}

	/**
	 * Create the room, or adopt the one already holding its alias. A created room has the
	 * bridge's user as its creator — joined by construction, and holding the power to invite —
	 * and carries the operator invite. An adopted room is used exactly as found: no operator
	 * invite and no reconciliation of its join rule, history visibility or topic. Its only
	 * change is the bridge's own membership.
	 */
	async function createOrAdopt(
		alias: string,
		space: boolean,
		name?: string
	): Promise<MatrixResult<RoomRef>> {
		const request: CreateRoomRequest = {
			alias,
			name,
			invite: operator === undefined ? undefined : [operator]
		}
		const created = space
			? await deps.client.createSpace(request, bridgeUser)
			: await deps.client.createRoom(request, bridgeUser)
		if (created.ok) {
			bridgeJoined.add(created.value.roomId)
			return created
		}
		if (!isAliasInUse(created)) return created

		const resolved = await deps.client.resolveAlias(alias, bridgeUser)
		if (!resolved.ok) return resolved
		const member = await ensureBridgeMembership(resolved.value.roomId)
		if (!member.ok) return member
		return resolved
	}

	function resolveRootSpace(): Promise<string | undefined> {
		if (rootSpace === undefined) return Promise.resolve(undefined)
		if (!rootSpace.startsWith('#')) return Promise.resolve(rootSpace)
		rootSpaceId ??= deps.client
			.resolveAlias(rootSpace, bridgeUser)
			.then((r) => (r.ok ? r.value.roomId : undefined))
		return rootSpaceId
	}

	/** Nest `childId` under `parentId`. A refusal is recorded and never retried in this run. */
	async function link(parentId: string, childId: string): Promise<boolean> {
		if (linkFailed.has(parentId)) return false
		const linked = await deps.client.linkSpaceChild(parentId, childId, bridgeUser)
		if (linked.ok) return true
		linkFailed.add(parentId)
		log('nesting under a space was refused; the rooms stay usable, only unnested')
		return false
	}

	async function ensureUser(userId: string, title?: string): Promise<MatrixResult<void>> {
		const ready = await readiness
		if (!ready.ok) return ready
		const registered = await memoize(users, userId, async () => {
			const result = await deps.client.registerUser(userId)
			// The normal outcome for the second and every later session of one work identity.
			if (!result.ok && result.errcode === 'M_USER_IN_USE') return OK
			return result
		})
		if (!registered.ok) return registered
		if (title === undefined || displayNames.get(userId) === title) return OK
		// Claim the name before the call so two concurrent ensures do not both issue it; drop
		// the claim again if the homeserver refuses, so the next ensure retries.
		displayNames.set(userId, title)
		const named = await deps.client.setDisplayName(userId, title, userId)
		if (!named.ok) displayNames.delete(userId)
		return named
	}

	function ensureRoom(alias: string, opts: EnsureRoomOptions = {}): Promise<MatrixResult<RoomRef>> {
		return readiness.then((ready) => {
			if (!ready.ok) return ready
			return memoize(rooms, alias, async () => {
				const room = await createOrAdopt(alias, false, opts.name)
				if (!room.ok) return room
				if (opts.parentSpace !== undefined) await link(opts.parentSpace, room.value.roomId)
				return room
			})
		})
	}

	function ensureSpace(project: string, name?: string): Promise<MatrixResult<SpaceRef>> {
		return readiness.then((ready) => {
			if (!ready.ok) return ready
			return memoize(spaces, project, async () => {
				const alias = deps.namer.spaceAlias(project)
				const space = await createOrAdopt(alias, true, name ?? project)
				if (!space.ok) return space
				const root = await resolveRootSpace()
				const linked = root === undefined ? false : await link(root, space.value.roomId)
				return { ok: true, value: { roomId: space.value.roomId, linked } }
			})
		})
	}

	function ensureMember(roomId: string, userId: string): Promise<MatrixResult<void>> {
		return readiness.then((ready) => {
			if (!ready.ok) return ready
			return memoize(members, `${roomId}|${userId}`, async () => {
				// The room is invite-only, so the bridge invites and the user then joins. An
				// invite refused because the user is already in the room is not a failure: the
				// join below is what actually decides membership.
				const invited = await deps.client.invite(roomId, userId, bridgeUser)
				if (!invited.ok) log('invite refused; attempting the join anyway')
				const joined = await deps.client.joinRoom(roomId, userId)
				return joined.ok ? OK : joined
			})
		})
	}

	function userFor(project: string, title: string): string {
		return sessionUser(deps.namer, project, title)
	}

	async function provisionSession(input: SessionProvisionInput): Promise<MatrixResult<void>> {
		// No project is a supported state, not a failure: nothing is ensured and nothing is
		// invented to stand in for it.
		if (input.project === undefined || slug(input.project).length === 0) return OK
		const ready = await readiness
		if (!ready.ok) return ready

		const project = input.project
		const title = input.title ?? ''
		const parsed = parseSessionName(title)
		const userId = userFor(project, title)

		const space = await ensureSpace(project, input.projectName)
		if (!space.ok) return space
		const user = await ensureUser(userId, input.title)
		if (!user.ok) return user

		const lobby = await ensureRoom(deps.namer.lobbyAlias(project), {
			name: `${project} lobby`,
			parentSpace: space.value.roomId
		})
		if (!lobby.ok) return lobby
		const inLobby = await ensureMember(lobby.value.roomId, userId)
		if (!inLobby.ok) return inLobby

		if (parsed.epic === undefined) return OK
		const epicRoom = await ensureRoom(deps.namer.epicRoomAlias(project, parsed.epic), {
			name: `${project} epic ${parsed.epic}`,
			parentSpace: space.value.roomId
		})
		if (!epicRoom.ok) return epicRoom
		return ensureMember(epicRoom.value.roomId, userId)
	}

	return { ensureUser, ensureSpace, ensureRoom, ensureMember, provisionSession }
}
