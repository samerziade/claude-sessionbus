## MODIFIED Requirements

### Requirement: Invalid Matrix configuration disables the bridge without being fatal

`resolveConfig` SHALL produce a `ConfigProblem` with `severity: 'invalid'` and SHALL force the resolved `config.matrix.enabled` to `false` when `matrix.enabled` resolves to `true` but the rest of the `matrix` block is malformed (a required field for an enabled bridge is missing or of the wrong type). When `matrix.enabled` resolves to `false`, the rest of the `matrix` block SHALL NOT be validated and SHALL produce no problems regardless of its content.

`matrix.domain` — the homeserver's server name, the `:`-suffix every identifier carries — SHALL be one of those required fields. It SHALL NOT be derived from `matrix.url` or from `matrix.owner`: a homeserver's server name is not reliably its URL host, and taking it from the operator's identifier assumes the operator lives on the homeserver the bridge talks to. Neither assumption is checkable at the point it would be made, and both are silent when wrong — a wrong domain does not fail, it mints a different identifier for every user and room, which is unrecoverable once history is attributed to them.

`matrix.domain` SHALL be settable from the configuration file only, like every other field in the `matrix` block; the environment layer SHALL remain exactly the two variables it recognizes today.

#### Scenario: An enabled but incomplete matrix block is invalid, not fatal

- **WHEN** `resolveConfig` is called with
  `file: { matrix: { enabled: true, url: 'https://example.test' } }` (missing `tokenCommand`,
  `rootSpace`, `owner`, `domain`)
- **THEN** `problems` contains an entry with `severity: 'invalid'` and `path` starting with
  `'matrix'`, and the resolved `config.matrix.enabled` is `false`

#### Scenario: A missing homeserver domain disables the bridge

- **WHEN** `resolveConfig` is called with an enabled `matrix` block in which every other
  required field is present and well-typed but `domain` is absent
- **THEN** `problems` contains an entry with `severity: 'invalid'` and `path: 'matrix.domain'`,
  and the resolved `config.matrix.enabled` is `false`

#### Scenario: A malformed homeserver domain disables the bridge

- **WHEN** `resolveConfig` is called with an enabled `matrix` block whose `domain` is not a
  non-empty string
- **THEN** `problems` contains an entry with `severity: 'invalid'` and `path: 'matrix.domain'`,
  and the resolved `config.matrix.enabled` is `false`

#### Scenario: The homeserver domain is never inferred from another field

- **WHEN** `resolveConfig` is called with an enabled `matrix` block carrying a `url` and an
  `owner` but no `domain`
- **THEN** the resolved `config.matrix.domain` is absent rather than a value taken from either
  of them

#### Scenario: The homeserver domain is not settable from the environment

- **WHEN** `resolveConfig` is called with an enabled, otherwise well-formed `matrix` block that
  omits `domain`, and an `env` carrying a domain-shaped value
- **THEN** the resolved `config.matrix.domain` is still absent and the bridge is still disabled

#### Scenario: A malformed but disabled matrix block produces no problem

- **WHEN** `resolveConfig` is called with `file: { matrix: { enabled: false, url: 12345 } }`
- **THEN** `problems` contains no entry whose `path` starts with `'matrix'`

#### Scenario: A well-formed enabled matrix block resolves cleanly

- **WHEN** `resolveConfig` is called with a `file.matrix` block that sets `enabled: true` and
  every other required field — `url`, `tokenCommand`, `rootSpace`, `owner` and `domain` — to a
  well-typed value
- **THEN** `problems` contains no entry whose `path` starts with `'matrix'`, and the resolved
  `config.matrix.enabled` is `true`

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

#### Scenario: The homeserver domain is reported like every other leaf

- **WHEN** `formatConfigReport` is given a `ResolvedConfig` resolved from a file that set
  `matrix.domain`
- **THEN** the output has a line for `matrix.domain` carrying its value and `'file'` as its
  source

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
