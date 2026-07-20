## ADDED Requirements

### Requirement: Broker starts, reclaims a stale socket, and refuses to double-bind

On start the broker SHALL bind its unix-domain socket and accept client connections. A
stale socket file left by a previous instance SHALL NOT prevent startup: when no live
broker is listening on the path, the broker SHALL reclaim it and start. When a live
broker already holds the path, a second start on the same path SHALL fail rather than
bind a second listener.

#### Scenario: Starts and accepts a registering client

- **WHEN** the broker starts on an unused socket path and a client connects and sends a
  protocol-matching `register`
- **THEN** the client receives a `welcome` and the broker reports it as one connected
  client

#### Scenario: Stale socket file is reclaimed

- **WHEN** a socket file exists on the path but no broker is listening on it, and a
  broker starts on that path
- **THEN** the broker starts listening successfully and accepts a client

#### Scenario: Refuses to bind over a live broker

- **WHEN** a broker is already listening on a path and a second broker is started on the
  same path
- **THEN** the second start fails rather than producing two listeners

### Requirement: Supervised broker fails loud on unrecoverable errors

The broker SHALL exit the process with a non-zero status on any unrecoverable runtime
error — a listen-socket `error` raised after the broker has begun serving, an uncaught
exception, or an unhandled promise rejection — rather than continue running in a
non-serving state. The supervisor restarts the broker only on a non-zero exit, so an
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

### Requirement: Deliberate shutdown exits cleanly

The broker SHALL treat a deliberate shutdown as a clean exit: on `SIGTERM`, `SIGINT`, or a
`stop` / close request it SHALL close its server and exit with status zero, and SHALL NOT
take the fail-loud non-zero path. A zero exit lets a supervisor configured to restart only
on unsuccessful exit leave the broker stopped instead of respawning a process the operator
deliberately stopped.

#### Scenario: Closing a running broker does not signal a fatal exit

- **WHEN** a running broker is closed
- **THEN** the close completes AND no non-zero exit is signalled

#### Scenario: Shutdown removes the socket file

- **WHEN** a running broker is closed
- **THEN** its socket file no longer exists on disk

### Requirement: A single client failure is isolated from broker liveness

An `error` or disconnect on one client connection SHALL drop only that connection and
SHALL NOT be treated as an unrecoverable broker error. The broker SHALL keep serving its
other clients and SHALL NOT exit.

#### Scenario: One client erroring does not bring down the broker

- **WHEN** one connected client's socket errors while another client stays connected
- **THEN** the erroring client is dropped, the broker does not exit, and a newly
  connecting client can still register

#### Scenario: Connected count reflects a dropped client

- **WHEN** one of two connected clients disconnects
- **THEN** the broker reports exactly one remaining connected client

### Requirement: Fail-loud is idempotent and leaves the socket path reclaimable

The fail-loud path SHALL exit at most once even if several unrecoverable errors fire in
succession. After a fatal exit, a freshly started broker on the same socket path SHALL be
able to start — a stale socket left behind SHALL NOT block the respawn.

#### Scenario: Repeated unrecoverable errors exit exactly once

- **WHEN** two unrecoverable errors fire before the process ends
- **THEN** the broker exits exactly once

#### Scenario: The socket path is reclaimable after a fatal exit

- **WHEN** a broker has failed loud and a new broker is then started on the same socket
  path
- **THEN** the new broker starts listening successfully
