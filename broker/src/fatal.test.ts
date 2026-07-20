import { describe, expect, it } from 'vitest'
import { createFatalGuard, wireFatalHandlers } from './fatal.ts'

describe('createFatalGuard', () => {
	it('exits non-zero and forwards the error to log', () => {
		const codes: number[] = []
		const logs: string[] = []
		const fatal = createFatalGuard({ log: (m) => logs.push(m), exit: (c) => codes.push(c) })

		fatal(new Error('boom'))

		expect(codes).toEqual([1])
		expect(logs.join('\n')).toContain('boom')
	})

	it('exits exactly once under repeated errors (idempotent)', () => {
		const codes: number[] = []
		const fatal = createFatalGuard({ log: () => {}, exit: (c) => codes.push(c) })

		fatal(new Error('first'))
		fatal(new Error('second'))
		fatal(new Error('third'))

		expect(codes).toEqual([1])
	})

	it('each guard tracks its own exited state', () => {
		const a: number[] = []
		const b: number[] = []
		const guardA = createFatalGuard({ log: () => {}, exit: (c) => a.push(c) })
		const guardB = createFatalGuard({ log: () => {}, exit: (c) => b.push(c) })

		guardA(new Error('a1'))
		guardA(new Error('a2'))
		guardB(new Error('b1'))

		expect(a).toEqual([1])
		expect(b).toEqual([1])
	})
})

describe('wireFatalHandlers', () => {
	it('routes uncaughtException and unhandledRejection (Error and non-Error) to the guard', () => {
		const handlers: Record<string, (arg: unknown) => void> = {}
		const fake = {
			on: (event: string, handler: (arg: unknown) => void) => {
				handlers[event] = handler
			}
		}
		const fatals: Error[] = []
		wireFatalHandlers(fake, (e) => fatals.push(e))

		const boom = new Error('boom')
		handlers.uncaughtException(boom)
		expect(fatals[0]).toBe(boom)

		handlers.unhandledRejection('string reason') // non-Error reason is coerced
		expect(fatals[1]).toBeInstanceOf(Error)
		expect(fatals[1].message).toContain('string reason')
	})
})
