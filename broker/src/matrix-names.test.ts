import { describe, expect, it } from 'vitest'
import { createNamer, type Namer, projectFromRemote, slug } from './matrix-names.ts'

const DOMAIN = 'host.example'

function namer(domain = DOMAIN): Namer {
	return createNamer({ prefix: 'cc', domain })
}

/** Split a fully qualified identifier into its localpart (without sigil) and its domain. */
function parts(id: string): { sigil: string; localpart: string; domain: string } {
	const colon = id.indexOf(':')
	return { sigil: id.slice(0, 1), localpart: id.slice(1, colon), domain: id.slice(colon + 1) }
}

function segments(id: string): string[] {
	return parts(id).localpart.split('.')
}

describe('slug', () => {
	it('lowercases, drops one trailing .git and collapses separators', () => {
		expect(slug('My Repo.git')).toBe('my-repo')
	})

	it('collapses runs of separators and trims the edges', () => {
		const result = slug('  --Foo__/  Bar!!  ')
		expect(result).toBe('foo-bar')
		expect(result.startsWith('-')).toBe(false)
		expect(result.endsWith('-')).toBe(false)
		expect(result).not.toContain('--')
	})

	it('yields the empty string for a name with no alphanumeric content', () => {
		expect(slug('...')).toBe('')
		expect(slug('///')).toBe('')
	})
})

describe('identifier shapes', () => {
	it('names a PM, a worker and an unstructured session', () => {
		const n = namer()
		expect(n.pmUser('sessionbus', '42')).toBe(`@cc.sessionbus.pm.42:${DOMAIN}`)
		expect(n.workerUser('sessionbus', 'issue-123')).toBe(`@cc.sessionbus.w.issue-123:${DOMAIN}`)
		expect(n.titleUser('sessionbus', 'planning notes')).toBe(
			`@cc.sessionbus.s.planning-notes:${DOMAIN}`
		)
	})

	it('names a space, a lobby and an epic room', () => {
		const n = namer()
		expect(n.spaceAlias('sessionbus')).toBe(`#cc.sessionbus:${DOMAIN}`)
		expect(n.lobbyAlias('sessionbus')).toBe(`#cc.sessionbus.lobby:${DOMAIN}`)
		expect(n.epicRoomAlias('sessionbus', '42')).toBe(`#cc.sessionbus.epic.42:${DOMAIN}`)
	})

	it('names the bridge bot without a project', () => {
		expect(namer().bridgeUser()).toBe(`@cc.bridge:${DOMAIN}`)
	})

	it('falls back to the unnamed identity for a blank title', () => {
		const n = namer()
		expect(n.titleUser('sessionbus', '   ')).toBe(`@cc.sessionbus.s.unnamed:${DOMAIN}`)
		expect(parts(n.titleUser('sessionbus', '')).localpart.endsWith('.s.unnamed')).toBe(true)
	})

	it('falls back to the unnamed identity for a discriminator that slugs to nothing', () => {
		const id = namer().workerUser('sessionbus', '---')
		expect(parts(id).localpart.endsWith('.w.unnamed')).toBe(true)
	})

	it('gives a project a space alias distinct from its lobby alias', () => {
		const n = namer()
		expect(n.spaceAlias('sessionbus')).not.toBe(n.lobbyAlias('sessionbus'))
	})

	it('emits only characters valid in both namespaces', () => {
		const n = namer()
		const ids = [
			n.pmUser('my-project', '42'),
			n.workerUser('my-project', 'issue-123'),
			n.titleUser('my-project', 'planning notes'),
			n.spaceAlias('my-project'),
			n.lobbyAlias('my-project'),
			n.epicRoomAlias('my-project', '42'),
			n.bridgeUser()
		]
		for (const id of ids) expect(id).toMatch(/^[@#][a-z0-9.-]+:/)
	})
})

describe('identifier ambiguity', () => {
	it('keeps a lobby alias apart from a project named like it', () => {
		const n = namer()
		expect(n.lobbyAlias('foo')).toBe(`#cc.foo.lobby:${DOMAIN}`)
		expect(n.spaceAlias('foo-lobby')).toBe(`#cc.foo-lobby:${DOMAIN}`)
		expect(n.lobbyAlias('foo')).not.toBe(n.spaceAlias('foo-lobby'))
	})

	it('keeps an epic room apart from a project named like it', () => {
		const n = namer()
		expect(n.epicRoomAlias('x', '42')).not.toBe(n.spaceAlias('x-epic-42'))
	})

	it('keeps a worker apart from a worker of a project named like it', () => {
		const n = namer()
		expect(n.workerUser('x', 'w-1')).toBe(`@cc.x.w.w-1:${DOMAIN}`)
		expect(n.workerUser('x-w', '1')).toBe(`@cc.x-w.w.1:${DOMAIN}`)
		expect(n.workerUser('x', 'w-1')).not.toBe(n.workerUser('x-w', '1'))
	})

	it('uses a hyphenated project slug verbatim, with no escaping', () => {
		expect(segments(namer().workerUser('a-b-c', '1'))[1]).toBe('a-b-c')
	})

	it('splits back into the prefix, the project and a fixed count per kind', () => {
		const n = namer()
		const cases: Array<[string, number]> = [
			[n.spaceAlias('proj'), 2],
			[n.lobbyAlias('proj'), 3],
			[n.epicRoomAlias('proj', '42'), 4],
			[n.pmUser('proj', '42'), 4],
			[n.workerUser('proj', 'issue-1'), 4],
			[n.titleUser('proj', 'planning notes'), 4]
		]
		for (const [id, count] of cases) {
			const segs = segments(id)
			expect(segs[0]).toBe('cc')
			expect(segs[1]).toBe('proj')
			expect(segs).toHaveLength(count)
		}
	})
})

describe('the 255-byte budget', () => {
	const LONG = 'a'.repeat(400)

	it('truncates an over-long project and appends a hash segment', () => {
		const id = namer().workerUser(LONG, '123')
		expect(Buffer.byteLength(id)).toBeLessThanOrEqual(255)
		expect(id).toContain('.w.123')
		expect(parts(id).localpart).toMatch(/\.[0-9a-f]{8}$/)
	})

	it('never merges two long project names that share a prefix', () => {
		const n = namer()
		const a = `${'a'.repeat(390)}${'b'.repeat(10)}`
		const b = `${'a'.repeat(390)}${'c'.repeat(10)}`
		expect(n.workerUser(a, '123')).not.toBe(n.workerUser(b, '123'))
	})

	it('never merges two long discriminators that differ in their last character', () => {
		const n = namer()
		const one = `${'b'.repeat(399)}x`
		const two = `${'b'.repeat(399)}y`
		expect(n.workerUser(LONG, one)).not.toBe(n.workerUser(LONG, two))
		expect(Buffer.byteLength(n.workerUser(LONG, one))).toBeLessThanOrEqual(255)
	})

	it('truncates deterministically', () => {
		expect(namer().workerUser(LONG, '123')).toBe(namer().workerUser(LONG, '123'))
	})

	it('leaves a short identifier without a hash segment', () => {
		expect(namer().workerUser('sessionbus', '123')).toBe(`@cc.sessionbus.w.123:${DOMAIN}`)
		expect(segments(namer().workerUser('sessionbus', '123'))).toHaveLength(4)
	})

	it('gives a truncated identifier one more segment than an untruncated one of its kind', () => {
		const n = namer()
		expect(segments(n.workerUser(LONG, '123'))).toHaveLength(
			segments(n.workerUser('sessionbus', '123')).length + 1
		)
	})

	it('never leaves the project segment ending in a separator', () => {
		const ragged = `${'a'.repeat(222)}-${'b'.repeat(200)}`
		const id = namer().workerUser(ragged, '123')
		expect(segments(id)[1].endsWith('-')).toBe(false)
		expect(Buffer.byteLength(id)).toBeLessThanOrEqual(255)
	})

	it('stays inside the budget against a domain 100 bytes longer', () => {
		const long = `${'d'.repeat(100)}.${DOMAIN}`
		const id = namer(long).workerUser(LONG, '123')
		expect(Buffer.byteLength(id)).toBeLessThanOrEqual(255)
		expect(id.endsWith(`:${long}`)).toBe(true)
	})
})

describe('projectFromRemote', () => {
	it('parses the SSH shorthand, keeping the owner', () => {
		expect(projectFromRemote('git@host.example:owner/repo.git')?.project).toBe('owner-repo')
	})

	it('parses an https URL with a trailing slash', () => {
		expect(projectFromRemote('https://host.example/owner/repo/')?.project).toBe('owner-repo')
	})

	it('parses an ssh:// URL carrying a port', () => {
		expect(projectFromRemote('ssh://git@host.example/owner/repo.git')?.project).toBe('owner-repo')
		expect(projectFromRemote('ssh://git@host.example:22/owner/repo.git')?.project).toBe(
			'owner-repo'
		)
	})

	it('yields the repository alone when the remote carries no owner', () => {
		expect(projectFromRemote('https://host.example/repo.git')?.project).toBe('repo')
	})

	it('keeps two same-named repositories under different owners apart', () => {
		const one = projectFromRemote('git@host.example:one/api.git')
		const two = projectFromRemote('git@host.example:two/api.git')

		expect(one?.project).not.toBe(two?.project)
		expect([one?.project, two?.project]).toEqual(['one-api', 'two-api'])
	})

	it('reads the owner from the last two segments of a deeper path', () => {
		expect(projectFromRemote('https://host.example/a/group/repo.git')?.project).toBe('group-repo')
	})

	it('names a project the way a person would recognize it', () => {
		expect(projectFromRemote('git@host.example:owner/repo.git')?.name).toBe('owner/repo')
		expect(projectFromRemote('https://host.example/repo.git')?.name).toBe('repo')
	})

	it('keeps the owner out of the slug it cannot survive', () => {
		// The name is what a client shows and has no character rules; the project is what an
		// alias is built from, and slugging it is the caller's job, not the parser's.
		expect(projectFromRemote('git@host.example:My Org/My Repo.git')).toEqual({
			project: 'My Org-My Repo',
			name: 'My Org/My Repo'
		})
		expect(slug('My Org-My Repo')).toBe('my-org-my-repo')
	})

	it('returns nothing for an empty string', () => {
		expect(projectFromRemote('')).toBeUndefined()
		expect(projectFromRemote('   ')).toBeUndefined()
	})

	it('returns nothing for a URL with no path segment', () => {
		expect(projectFromRemote('https://host.example')).toBeUndefined()
	})

	it('is a pure function of the URL, whatever the call order', () => {
		const url = 'git@host.example:owner/repo.git'
		expect(projectFromRemote(url)).toEqual(projectFromRemote(url))
	})
})

describe('determinism', () => {
	it('two separately built namers agree, whatever the call order', () => {
		const first = namer()
		const second = namer()
		const a = [
			first.workerUser('sessionbus', 'issue-1'),
			first.lobbyAlias('sessionbus'),
			first.spaceAlias('sessionbus')
		]
		const b = [
			second.spaceAlias('sessionbus'),
			second.lobbyAlias('sessionbus'),
			second.workerUser('sessionbus', 'issue-1')
		]
		expect(a).toEqual([b[2], b[1], b[0]])
	})
})
