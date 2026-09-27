import { describe, expect, it } from 'vitest'
import { deriveProject } from './project.ts'

/** A remote lookup that answers for one directory only — nothing here shells out to git. */
function remoteFor(dir: string, url: string): (cwd: string) => string | undefined {
	return (cwd) => (cwd === dir ? url : undefined)
}

const noRemote = (): undefined => undefined

describe('deriveProject', () => {
	it('uses the owner and the repository from the origin remote', () => {
		const derived = deriveProject({
			cwd: '/work/checkout',
			readRemote: remoteFor('/work/checkout', 'git@host.example:owner/My Repo.git')
		})

		expect(derived?.project).toBe('owner-my-repo')
		expect(derived?.name).toBe('owner/My Repo')
	})

	it('keeps two same-named repositories under different owners apart', () => {
		const one = deriveProject({
			cwd: '/work/a',
			readRemote: remoteFor('/work/a', 'git@host.example:one/api.git')
		})
		const two = deriveProject({
			cwd: '/work/b',
			readRemote: remoteFor('/work/b', 'git@host.example:two/api.git')
		})

		expect(one?.project).toBe('one-api')
		expect(two?.project).toBe('two-api')
		expect(one?.project).not.toBe(two?.project)
	})

	it('uses the repository alone when the remote carries no owner', () => {
		const derived = deriveProject({
			cwd: '/work/checkout',
			readRemote: remoteFor('/work/checkout', 'https://host.example/repo.git')
		})

		expect(derived).toEqual({ project: 'repo', name: 'repo' })
	})

	it('falls back to the slugged directory name when there is no remote', () => {
		const derived = deriveProject({ cwd: '/tmp/some/Work Dir', readRemote: noRemote })

		expect(derived?.project).toBe('work-dir')
		// A directory name has no owner to keep, so there is no other form to show.
		expect(derived?.name).toBeUndefined()
	})

	it('falls back to the directory name when the remote is unparseable', () => {
		expect(
			deriveProject({ cwd: '/tmp/some/Work Dir', readRemote: () => 'https://host.example' })
				?.project
		).toBe('work-dir')
		expect(deriveProject({ cwd: '/tmp/some/Work Dir', readRemote: () => '' })?.project).toBe(
			'work-dir'
		)
	})

	it('announces nothing when the directory name slugs to nothing', () => {
		expect(deriveProject({ cwd: '/srv/...', readRemote: noRemote })).toBeUndefined()
		expect(deriveProject({ cwd: '/', readRemote: noRemote })).toBeUndefined()
	})

	it('invents no placeholder and no hash for a directory it cannot name', () => {
		const derived = deriveProject({ cwd: '/work/%%%', readRemote: noRemote })

		expect(derived).toBeUndefined()
		expect(derived?.project).not.toBe('')
	})

	it('prefers a configured override for the directory', () => {
		const derived = deriveProject({
			cwd: '/work/checkout',
			readRemote: remoteFor('/work/checkout', 'git@host.example:owner/repo.git'),
			overrides: { '/work/checkout': 'House Style' }
		})

		// An override is the whole name: it has no owner half, and the remote's is not borrowed.
		expect(derived).toEqual({ project: 'house-style' })
	})

	it('ignores an override belonging to another directory', () => {
		const derived = deriveProject({
			cwd: '/work/other',
			readRemote: noRemote,
			overrides: { '/work/checkout': 'house-style' }
		})

		expect(derived?.project).toBe('other')
	})

	it('is a pure function of its inputs', () => {
		const input = { cwd: '/work/checkout', readRemote: remoteFor('/work/checkout', 'x:o/repo') }

		expect(deriveProject(input)).toEqual(deriveProject(input))
	})
})
