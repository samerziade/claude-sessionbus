# session-grouping

## MODIFIED Requirements

### Requirement: A project is derived from the session's working directory

A session SHALL announce a project derived from its working directory: **the owner and repository
taken from the `origin` remote**, joined as `<owner>-<repo>`, when the directory is a repository
with such a remote, and otherwise the directory's own name. A repository name alone does not
identify a project: two repositories of the same name in different organizations would share one
space, and the name a person sees in a client would carry no owner. Parsing a remote URL SHALL be
a pure function of the URL string, so it is testable without a repository, and SHALL accept the
SSH shorthand, an `ssh://` URL and an `https://` URL, ignoring any trailing `/` and one trailing
`.git`. A remote carrying no owner segment SHALL yield the repository name alone.

The joining character SHALL be `-`, which carries no structural meaning: `.` separates an
identifier's segments, so a project remains exactly one segment however many dashes it contains,
and segment counts stay fixed per identifier kind.

When no project can be derived — no usable remote and a directory whose name slugs to nothing —
the session SHALL announce no project, and SHALL NOT substitute a placeholder or a name derived
from a hash. A session that announces no project is not provisioned at all, which is already a
supported state; a hash-named project would instead create a space and rooms that no human can
recognize in a client, and every session whose directory name happens to slug to nothing would
land in a different unrecognizable one.

#### Scenario: SSH shorthand remote

- **WHEN** the remote URL `git@host.example:owner/repo.git` is parsed
- **THEN** the project is `owner-repo`

#### Scenario: HTTPS remote with a trailing slash

- **WHEN** the remote URL `https://host.example/owner/repo/` is parsed
- **THEN** the project is `owner-repo`

#### Scenario: An ssh:// URL keeps its owner

- **WHEN** the remote URL `ssh://git@host.example/owner/repo.git` is parsed
- **THEN** the project is `owner-repo`

#### Scenario: A remote with no owner segment yields the repository alone

- **WHEN** the remote URL `https://host.example/repo.git` is parsed
- **THEN** the project is `repo`

#### Scenario: Two repositories of one name in different organizations are different projects

- **WHEN** the remotes `git@host.example:one/api.git` and `git@host.example:two/api.git` are parsed
- **THEN** the projects differ

#### Scenario: A directory with no usable remote falls back to its own name

- **WHEN** a session's directory has no `origin` remote and is named `scratch`
- **THEN** the project is `scratch`

#### Scenario: A project that slugs to nothing is announced as no project

- **WHEN** a session's directory has no usable remote and is named `...`
- **THEN** the session announces no project and no substitute is invented

## ADDED Requirements

### Requirement: A project space carries a human-readable name

A project space SHALL be created with a display name of `<owner>/<repo>` when the project was
derived from a remote carrying both, and the project's own slug otherwise. An alias must satisfy
the identifier character rules; a display name has no such constraint and is what a client shows,
so the form a person recognizes belongs there.

#### Scenario: The space shows owner and repository

- **WHEN** a space is created for the project `owner-repo` derived from `git@host.example:owner/repo.git`
- **THEN** the creation request carries the display name `owner/repo`

#### Scenario: A project with no owner shows its slug

- **WHEN** a space is created for the project `scratch`, derived from a directory name
- **THEN** the creation request carries the display name `scratch`
