import { createHash } from 'node:crypto'

/**
 * Deterministic naming for every remote identifier: given a project and a work identity, the
 * same inputs always produce byte-identical output. Nothing here reads a clock, a pid, a
 * session id or a random source — an identifier attributes history, so one that moved would
 * strand everything already posted under it.
 *
 * Identifiers are dot-separated segments: `<prefix>.<project>.<kind>[.<discriminator>]`.
 * Slugging collapses every character outside `a-z0-9` to `-`, so `.` cannot occur inside a
 * segment and an identifier therefore splits back into its segments unambiguously. That is
 * what makes `#cc.foo.lobby` (foo's lobby) and `#cc.foo-lobby` (a project named `foo-lobby`)
 * different by construction, with no escaping rule for anyone to remember.
 */

/** A fully qualified Matrix identifier — sigil, localpart, `:` and domain — may not exceed this. */
const MAX_ID_BYTES = 255
/** 32 bits of SHA-256: ample for one machine's projects, short enough to stay readable. */
const HASH_HEX_LENGTH = 8
/** A discriminator that slugs to nothing still has to land somewhere inside its project. */
const UNNAMED = 'unnamed'

export interface NamerOptions {
	/** Namespace prefix claimed by the appservice registration, e.g. `cc`. */
	prefix: string
	/** Homeserver domain — the `:`-suffix of every identifier, and part of the byte budget. */
	domain: string
}

export interface Namer {
	spaceAlias(project: string): string
	lobbyAlias(project: string): string
	epicRoomAlias(project: string, epic: string): string
	pmUser(project: string, epic: string): string
	workerUser(project: string, issue: string): string
	titleUser(project: string, title: string): string
	bridgeUser(): string
}

/**
 * Lowercase, drop one trailing `.git`, collapse every run of non-alphanumerics to a single
 * `-`, trim the edges. The result MAY be empty and nothing is invented to cover that: an empty
 * project means the session has no project, which is already a supported state.
 */
export function slug(text: string): string {
	const withoutGit = text
		.trim()
		.toLowerCase()
		.replace(/\.git$/, '')
	return withoutGit.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/** What a remote URL says about the project it points at. Neither field is slugged. */
export interface RemoteProject {
	/**
	 * What the project is identified by: `<owner>-<repo>`, or the repository alone when the
	 * remote carries no owner. Joined with `-` because `.` separates an identifier's segments,
	 * so a dash keeps a project one segment however many owners and dashes it contains.
	 */
	project: string
	/** The form a person recognizes in a client: `<owner>/<repo>`, or the repository alone. */
	name: string
}

/**
 * The project a remote URL names — pure, so it is testable without a repository. Accepts the
 * SSH shorthand, an `ssh://` URL and an `https://` URL; one trailing `.git` and any trailing
 * `/` are removed. Returns nothing when there is no path segment to take.
 *
 * The owner is kept: a repository name alone would put two repositories of one name in
 * different organizations into a single space, under a name carrying no owner at all.
 */
export function projectFromRemote(url: string): RemoteProject | undefined {
	const trimmed = url.trim()
	if (trimmed.length === 0) return undefined
	let path: string
	const schemeAt = trimmed.indexOf('://')
	if (schemeAt !== -1) {
		const afterScheme = trimmed.slice(schemeAt + 3)
		const firstSlash = afterScheme.indexOf('/')
		if (firstSlash === -1) return undefined
		path = afterScheme.slice(firstSlash + 1)
	} else {
		const colonAt = trimmed.indexOf(':')
		path = colonAt === -1 ? trimmed : trimmed.slice(colonAt + 1)
	}
	const segments = path.split('/').filter((s) => s.length > 0)
	const last = segments.at(-1)
	if (last === undefined) return undefined
	const repo = last.replace(/\.git$/, '')
	if (repo.length === 0) return undefined
	const owner = segments.at(-2)
	if (owner === undefined) return { project: repo, name: repo }
	return { project: `${owner}-${repo}`, name: `${owner}/${repo}` }
}

/** The localpart of a fully qualified identifier: everything between the sigil and the `:`. */
export function localpartOf(id: string): string {
	const colonAt = id.indexOf(':')
	return colonAt === -1 ? id.slice(1) : id.slice(1, colonAt)
}

function discriminator(text: string): string {
	const slugged = slug(text)
	return slugged.length > 0 ? slugged : UNNAMED
}

export function createNamer(opts: NamerOptions): Namer {
	const prefix = opts.prefix
	const domain = opts.domain
	/** Everything the localpart is not: the sigil and `:<domain>`. */
	const envelope = 2 + Buffer.byteLength(domain)

	/**
	 * Assemble `<prefix>.<project>.<tail...>`, truncating into the byte budget when it
	 * overflows. Truncation appends the first eight hex characters of SHA-256 of the
	 * **untruncated** localpart as a further segment — hashing the truncated form would be
	 * constant across exactly the inputs that need telling apart — and recovers space from the
	 * project segment first, so the kind marker and its discriminator always survive.
	 */
	function assemble(sigil: string, project: string, tail: string[]): string {
		const projectSlug = slug(project)
		const plain = [prefix, projectSlug, ...tail].join('.')
		if (Buffer.byteLength(plain) + envelope <= MAX_ID_BYTES) return `${sigil}${plain}:${domain}`

		const hash = createHash('sha256').update(plain).digest('hex').slice(0, HASH_HEX_LENGTH)
		const budget = MAX_ID_BYTES - envelope
		// Everything but the project segment's own content: prefix, the dots around the project,
		// the tail, and the hash segment with its dot.
		const fixed = prefix.length + 2 + tail.join('.').length + 1 + HASH_HEX_LENGTH
		const room = budget - fixed
		if (room > 0) {
			const shortened = projectSlug.slice(0, room).replace(/-+$/, '')
			return `${sigil}${[prefix, shortened, ...tail, hash].join('.')}:${domain}`
		}
		// Not even the kind marker and its discriminator fit beside an empty project segment:
		// shorten the discriminator from its end. The kind marker is never touched.
		const marker = tail[0] ?? ''
		const discRoom = budget - (prefix.length + 3 + marker.length + HASH_HEX_LENGTH) - 1
		const kept = tail.length > 1 ? [marker, tail[1].slice(0, Math.max(0, discRoom))] : [marker]
		return `${sigil}${[prefix, '', ...kept, hash].join('.')}:${domain}`
	}

	return {
		spaceAlias: (project) => assemble('#', project, []),
		lobbyAlias: (project) => assemble('#', project, ['lobby']),
		epicRoomAlias: (project, epic) => assemble('#', project, ['epic', discriminator(epic)]),
		pmUser: (project, epic) => assemble('@', project, ['pm', discriminator(epic)]),
		workerUser: (project, issue) => assemble('@', project, ['w', discriminator(issue)]),
		titleUser: (project, title) => assemble('@', project, ['s', discriminator(title)]),
		bridgeUser: () => `@${prefix}.bridge:${domain}`
	}
}
