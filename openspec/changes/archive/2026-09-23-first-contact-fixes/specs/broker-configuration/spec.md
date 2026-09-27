# broker-configuration

## ADDED Requirements

### Requirement: The token command is bounded by a deadline

Resolving the appservice token SHALL be bounded by a timeout, and exceeding it SHALL produce a
`ConfigProblem` with `severity: 'invalid'` so the bridge is disabled while the broker keeps
serving. The child process SHALL be killed rather than left running. A credential helper may wait
for an interaction that cannot happen under a supervisor — there is no terminal to prompt at — and
an unbounded wait leaves the bridge permanently about to start, with nothing to diagnose it by.

The problem's message SHALL name the command that timed out and SHALL NOT carry the command's
output, which may already contain the secret it printed before hanging.

#### Scenario: A command that never returns is an invalid configuration, not a hang

- **WHEN** the token command produces nothing before its deadline
- **THEN** resolution reports `ok: false` with a problem of severity `invalid`

#### Scenario: The timed-out child is killed

- **WHEN** the token command produces nothing before its deadline
- **THEN** the child process is killed

#### Scenario: The message names the command but never its output

- **WHEN** the token command times out after printing the secret
- **THEN** the problem's message contains the command and does not contain its output

#### Scenario: A command that answers in time is unaffected

- **WHEN** the token command returns a token before its deadline
- **THEN** resolution reports `ok: true` and the child is not killed
