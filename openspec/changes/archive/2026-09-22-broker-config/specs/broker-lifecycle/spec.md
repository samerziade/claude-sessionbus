## MODIFIED Requirements

### Requirement: Supervised broker fails loud on unrecoverable errors

The broker SHALL exit the process with a non-zero status on any unrecoverable runtime
error — a listen-socket `error` raised after the broker has begun serving, an uncaught
exception, an unhandled promise rejection, or a `fatal`-severity configuration problem
detected during startup before the broker has begun serving — rather than continue running
in a non-serving state. The supervisor restarts the broker only on a non-zero exit, so an
unrecoverable error that is caught and swallowed would strand a live-but-dead process the
supervisor never restarts.

#### Scenario: A post-listen listener error is fatal

- **WHEN** the listening server raises an `error` event after the broker has begun
  serving clients
- **THEN** the broker exits the process with a non-zero status rather than only logging
  and continuing

#### Scenario: An uncaught exception is fatal

- **WHEN** an uncaught exception reaches the process-level backstop
- **THEN** the broker exits the process with a non-zero status

#### Scenario: An unhandled promise rejection is fatal

- **WHEN** an unhandled promise rejection reaches the process-level backstop
- **THEN** the broker exits the process with a non-zero status

#### Scenario: A fatal configuration problem exits before the broker serves

- **WHEN** the broker starts in foreground mode and configuration resolution produces a
  `ConfigProblem` with `severity: 'fatal'`
- **THEN** the broker exits the process with a non-zero status without opening its
  listening socket
