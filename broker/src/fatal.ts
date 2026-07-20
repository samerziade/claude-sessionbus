export interface FatalGuardDeps {
	log: (msg: string) => void
	exit: (code: number) => void
}

/**
 * Fail-loud policy for the supervised broker. Returns an idempotent `fatal(err)`:
 * it logs the error and exits the process non-zero, at most once even if several
 * unrecoverable errors fire in succession. The supervisor (launchd `KeepAlive` with
 * `SuccessfulExit=false`) restarts only on a non-zero exit, so an unrecoverable error
 * that is caught and swallowed would strand a live-but-dead process. `exit` and `log`
 * are injected so the exit-once and exit-code behavior is testable without ending the
 * test process.
 */
export function createFatalGuard(deps: FatalGuardDeps): (err: Error) => void {
	let exited = false
	return (err: Error) => {
		if (exited) return
		exited = true
		deps.log(`fatal: ${err.stack ?? err.message}`)
		deps.exit(1)
	}
}

export interface FatalEmitter {
	on(event: 'uncaughtException' | 'unhandledRejection', handler: (arg: unknown) => void): void
}

function toError(x: unknown): Error {
	return x instanceof Error ? x : new Error(String(x))
}

/**
 * Route the process-level backstops — `uncaughtException` and `unhandledRejection` — to
 * `guard`, coercing a non-Error rejection reason to an Error. Factored out of `index.ts`
 * so the wiring is testable with a fake emitter, keeping the entry point thin.
 */
export function wireFatalHandlers(proc: FatalEmitter, guard: (err: Error) => void): void {
	proc.on('uncaughtException', (arg) => guard(toError(arg)))
	proc.on('unhandledRejection', (arg) => guard(toError(arg)))
}
