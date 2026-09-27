## ADDED Requirements

### Requirement: Layered configuration resolves defaults, file, and environment, purely

`resolveConfig({ file, env, home })` SHALL layer three sources in this precedence order —
built-in defaults, then the already-parsed config file content, then the recognized
environment values — with a later layer overriding an earlier one field-by-field. It SHALL
perform no I/O and SHALL NOT read `process.env`, the filesystem, or any other ambient state
itself; its result SHALL depend only on its arguments.

#### Scenario: Defaults apply when neither file nor env supply a value

- **WHEN** `resolveConfig` is called with `file: undefined` and `env: {}`
- **THEN** the resolved `config.transport` is `'file'` and `config.channelsHome` is
  `join(home, '.claude', 'channels')`

#### Scenario: A file value overrides the default

- **WHEN** `resolveConfig` is called with `file: { transport: 'socket' }` and `env: {}`
- **THEN** the resolved `config.transport` is `'socket'`

#### Scenario: An environment value overrides both the file and the default

- **WHEN** `resolveConfig` is called with `file: { transport: 'socket' }` and
  `env: { SESSIONBUS_TRANSPORT: 'file' }`
- **THEN** the resolved `config.transport` is `'file'`

#### Scenario: Resolution is deterministic regardless of ambient process state

- **WHEN** `resolveConfig` is called twice with the identical `{ file, env, home }` arguments,
  while the real `process.env.SESSIONBUS_TRANSPORT` is set to a different value than either
  call's `env` argument between the two calls
- **THEN** both calls return an identical resolved `config`

### Requirement: Configuration problems are reported as severity-tagged data, never thrown

`resolveConfig` SHALL NOT throw on malformed input. Every departure from a clean, fully
recognized configuration SHALL be reported as one `ConfigProblem` in the returned `problems`
list, each carrying a `severity` of `'warning'`, `'invalid'`, or `'fatal'`, a dotted `path`
identifying the field, and a human-readable `message`. `resolveConfig` SHALL always return a
usable `config` alongside `problems`, even when `problems` is non-empty.

#### Scenario: An unparseable file falls back to defaults with a warning

- **WHEN** `resolveConfig` is called with a `file` value that is not a plain object (for
  example, an array or a string — the shape produced when the entrypoint's own JSON parse of
  a corrupt file failed and it passed through a non-object placeholder)
- **THEN** the resolved `config` equals the all-defaults config, and `problems` contains one
  entry with `severity: 'warning'`

#### Scenario: A missing file produces no problem

- **WHEN** `resolveConfig` is called with `file: undefined`
- **THEN** `problems` contains no entry whose `path` concerns the file's absence

#### Scenario: Multiple independent problems are all reported, not just the first

- **WHEN** `resolveConfig` is called with a `file` containing both an unknown top-level key
  and a malformed `matrix` block
- **THEN** `problems` contains at least one entry for the unknown key and at least one entry
  for the malformed `matrix` block

### Requirement: Unusable core configuration is fatal

`resolveConfig` SHALL report a `ConfigProblem` with `severity: 'fatal'` when the resolved `channelsHome` is not a non-empty string — an empty string, or a value of a non-string JSON type supplied by the file. No other field SHALL, in isolation, produce a `fatal` problem.

#### Scenario: An empty-string channelsHome is fatal

- **WHEN** `resolveConfig` is called with `file: { channelsHome: '' }`
- **THEN** `problems` contains an entry with `severity: 'fatal'` and `path: 'channelsHome'`

#### Scenario: A wrong-typed channelsHome is fatal

- **WHEN** `resolveConfig` is called with `file: { channelsHome: 42 }`
- **THEN** `problems` contains an entry with `severity: 'fatal'` and `path: 'channelsHome'`,
  and the resolved `config.channelsHome` falls back to the default so a caller can still
  print a report

#### Scenario: An unrecognized transport value is a warning, not fatal

- **WHEN** `resolveConfig` is called with `file: { transport: 'carrier-pigeon' }`
- **THEN** `problems` contains an entry with `severity: 'warning'` and `path: 'transport'`,
  and the resolved `config.transport` falls back to `'file'`

### Requirement: Invalid Matrix configuration disables the bridge without being fatal

`resolveConfig` SHALL produce a `ConfigProblem` with `severity: 'invalid'` and SHALL force the resolved `config.matrix.enabled` to `false` when `matrix.enabled` resolves to `true` but the rest of the `matrix` block is malformed (a required field for an enabled bridge is missing or of the wrong type). When `matrix.enabled` resolves to `false`, the rest of the `matrix` block SHALL NOT be validated and SHALL produce no problems regardless of its content.

#### Scenario: An enabled but incomplete matrix block is invalid, not fatal

- **WHEN** `resolveConfig` is called with
  `file: { matrix: { enabled: true, url: 'https://example.test' } }` (missing `tokenCommand`,
  `rootSpace`, `owner`)
- **THEN** `problems` contains an entry with `severity: 'invalid'` and `path` starting with
  `'matrix'`, and the resolved `config.matrix.enabled` is `false`

#### Scenario: A malformed but disabled matrix block produces no problem

- **WHEN** `resolveConfig` is called with `file: { matrix: { enabled: false, url: 12345 } }`
- **THEN** `problems` contains no entry whose `path` starts with `'matrix'`

#### Scenario: A well-formed enabled matrix block resolves cleanly

- **WHEN** `resolveConfig` is called with a `file.matrix` block that sets `enabled: true` and
  every other required field to a well-typed value
- **THEN** `problems` contains no entry whose `path` starts with `'matrix'`, and the resolved
  `config.matrix.enabled` is `true`

### Requirement: A disabled Matrix bridge carries the reason it is disabled

Whenever the resolved `config.matrix.enabled` is `false`, `resolveConfig` SHALL also set `config.matrix.disabledReason` to a machine-readable reason: `'not-enabled'` when `matrix.enabled` did not resolve to `true` from any layer, or `'invalid-config'` when the configuration asked for the bridge but the `matrix` block was malformed and the bridge was forced off. When the resolved `config.matrix.enabled` is `true`, `disabledReason` SHALL be absent. The reason is data on the resolved configuration, so every route that disables the bridge converges on one disabled state; only the configuration route exists today. `formatConfigReport` SHALL print the reason whenever the bridge is disabled.

#### Scenario: A bridge nobody enabled is disabled as not-enabled

- **WHEN** `resolveConfig` is called with `file: undefined` and `env: {}`
- **THEN** the resolved `config.matrix.enabled` is `false` and `config.matrix.disabledReason`
  is `'not-enabled'`

#### Scenario: A bridge forced off by a malformed block is disabled as invalid-config

- **WHEN** `resolveConfig` is called with
  `file: { matrix: { enabled: true, url: 'https://example.test' } }`
- **THEN** the resolved `config.matrix.enabled` is `false` and `config.matrix.disabledReason`
  is `'invalid-config'`

#### Scenario: An enabled bridge carries no disabled reason

- **WHEN** `resolveConfig` is called with a well-formed, enabled `file.matrix` block
- **THEN** the resolved `config.matrix.enabled` is `true` and `config.matrix` has no
  `disabledReason`

#### Scenario: The report states why the bridge is off

- **WHEN** `formatConfigReport` is given a `ResolvedConfig` whose `config.matrix` is disabled
  with `disabledReason: 'invalid-config'`
- **THEN** the output contains `'invalid-config'` as the reason the bridge is disabled

### Requirement: Unknown configuration keys warn instead of failing

`resolveConfig` SHALL report one `ConfigProblem` with `severity: 'warning'` for each unrecognized top-level key in the config file, or unrecognized key inside its `matrix` object, and SHALL drop each such key from the resolved `config`. Every other, recognized key in the same file SHALL still resolve normally.

#### Scenario: An unknown top-level key warns and is dropped

- **WHEN** `resolveConfig` is called with `file: { transport: 'socket', spelling: 'wrong' }`
- **THEN** `problems` contains an entry with `severity: 'warning'` and `path: 'spelling'`, and
  the resolved `config.transport` is `'socket'`

#### Scenario: An unknown key inside matrix warns without disabling the bridge

- **WHEN** `resolveConfig` is called with a well-formed, enabled `file.matrix` block that also
  has one extra, unrecognized key
- **THEN** `problems` contains a `severity: 'warning'` entry for that key, and the resolved
  `config.matrix.enabled` remains `true`

### Requirement: `broker config` reports every field's source and redacts secrets

Given a `ResolvedConfig`, `formatConfigReport` SHALL produce a report that states, for every
field the resolver can independently set, whether its value came from `'default'`, `'file'`,
or `'env'`. The report SHALL include every entry in `problems`, regardless of severity, and
SHALL NOT be prevented from rendering by the presence of a `fatal` problem. The report SHALL
NOT contain the Matrix bridge secret in any form.

#### Scenario: Each field's source is reported

- **WHEN** `formatConfigReport` is given a `ResolvedConfig` whose `sources` map has
  `channelsHome: 'env'` and `transport: 'default'`
- **THEN** the output names `'env'` as the source for `channelsHome` and `'default'` as the
  source for `transport`

#### Scenario: A fatal problem still produces a full report

- **WHEN** `formatConfigReport` is given a `ResolvedConfig` whose `problems` includes one
  entry with `severity: 'fatal'`
- **THEN** the output includes that problem's `path` and `message`, and also includes every
  field's source as in the non-fatal case

#### Scenario: The report never contains a secret

- **WHEN** `formatConfigReport` is given a `ResolvedConfig` whose `config.matrix.tokenCommand`
  is `['op', 'read', 'op://vault/item/field']`
- **THEN** the output contains the literal command array for diagnostic purposes but contains
  no field resembling a resolved secret value — `formatConfigReport` is never given a
  resolved token because `Config` never carries one

### Requirement: The Matrix bridge secret is resolved via tokenCommand, overridable by environment

`resolveMatrixToken(matrix, deps)` SHALL resolve the bridge's secret token: when
`deps.env.SESSIONBUS_MATRIX_AS_TOKEN` is set, it SHALL be used directly and `deps.run` SHALL
NOT be invoked. Otherwise, `deps.run(matrix.tokenCommand)` SHALL be invoked and its trimmed
output SHALL become the token. A `deps.run` that throws SHALL be caught and reported as a
`ConfigProblem` with `severity: 'invalid'`, never as a thrown exception escaping
`resolveMatrixToken`.

#### Scenario: The token command's trimmed output becomes the token

- **WHEN** `resolveMatrixToken` is called with `deps.run` returning `'  secret-value\n'` for
  the configured `tokenCommand`, and `deps.env` has no `SESSIONBUS_MATRIX_AS_TOKEN`
- **THEN** the result is `{ ok: true, token: 'secret-value' }`

#### Scenario: SESSIONBUS_MATRIX_AS_TOKEN overrides tokenCommand and skips running it

- **WHEN** `resolveMatrixToken` is called with `deps.env.SESSIONBUS_MATRIX_AS_TOKEN` set to
  `'override-token'`
- **THEN** the result is `{ ok: true, token: 'override-token' }` and `deps.run` is never
  called

#### Scenario: A failing token command is reported, not thrown

- **WHEN** `resolveMatrixToken` is called with a `deps.run` that throws
- **THEN** `resolveMatrixToken` returns (does not throw) a result of
  `{ ok: false, problem }` where `problem.severity` is `'invalid'`

#### Scenario: A failure message never contains a secret

- **WHEN** `deps.run` throws an error whose message happens to include a fixture string
  standing in for the token attempt's partial output
- **THEN** the returned `problem.message` does not contain that fixture string

### Requirement: bus's transport selection is driven by the same resolved configuration

`bus`'s `createTransport`, when called with a `mode` sourced from `resolveConfig`'s resolved `config.transport`, SHALL behave identically to being called with that same string passed directly as `mode` — the config layer supplies the value, `createTransport` itself is unchanged.

#### Scenario: A config-resolved socket mode selects the socket transport

- **WHEN** `resolveConfig` resolves `config.transport` to `'socket'` from a file with no
  environment override, and that value is passed as `createTransport`'s `mode` option
- **THEN** the resulting transport does not read the file mailbox (matching the existing
  `'socket mode does not read the file mailbox'` behavior)

#### Scenario: A config-resolved file mode selects the file transport

- **WHEN** `resolveConfig` resolves `config.transport` to `'file'` with nothing set anywhere,
  and that value is passed as `createTransport`'s `mode` option
- **THEN** the resulting transport reads from the file mailbox inbox
