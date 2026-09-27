import { basename } from 'node:path'
import { projectFromRemote, slug } from '../../broker/src/matrix-names.ts'

export interface DeriveProjectInput {
	/** The session's working directory. */
	cwd: string
	/** Reads the `origin` remote for a directory, or nothing when there is none. Injected, so
	 * the derivation itself is pure and testable without a repository. */
	readRemote: (cwd: string) => string | undefined
	/** Absolute repo path → project slug, from configuration. */
	overrides?: Record<string, string>
}

/** The project a session announces, and the name a person would recognize it by. */
export interface DerivedProject {
	/** The slug every remote identifier for this project is built from. */
	project: string
	/**
	 * `<owner>/<repo>`, when the project came from a remote carrying both. Absent for a
	 * directory name or a configured override: neither has an owner half to show.
	 */
	name?: string
}

/**
 * The project a session announces: a configured override, else the owner and repository from
 * the `origin` remote, else the directory's own name — slugged.
 *
 * Nothing is invented when none of those yields a name. A session with no project is already a
 * supported state, while a hash-derived one would mint `#cc.3f9a1c22` and its lobby: rooms no
 * human scrolling a client can match to anything, and that nothing later can rename.
 */
export function deriveProject(input: DeriveProjectInput): DerivedProject | undefined {
	const remote = input.readRemote(input.cwd)
	const parsed = remote === undefined ? undefined : projectFromRemote(remote)
	const candidates: DerivedProject[] = []
	const override = input.overrides?.[input.cwd]
	if (override !== undefined) candidates.push({ project: override })
	if (parsed !== undefined) candidates.push({ project: parsed.project, name: parsed.name })
	candidates.push({ project: basename(input.cwd) })
	for (const candidate of candidates) {
		const slugged = slug(candidate.project)
		// The name travels with the candidate it came from, so a remote that slugs to nothing
		// cannot lend its owner to the directory name that stands in for it.
		if (slugged.length > 0) {
			return candidate.name === undefined
				? { project: slugged }
				: { project: slugged, name: candidate.name }
		}
	}
	return undefined
}
