# broker-lifecycle

## ADDED Requirements

### Requirement: The broker binds before any bridge work begins

The broker SHALL bind its socket and begin serving before it resolves the appservice token or
constructs the bridge. Resolving a credential runs an external command whose duration the broker
does not control; performing it first means a slow or hung helper leaves the socket unbound, so
sessions cannot reach each other at all. A Matrix problem may disable the bridge and SHALL NOT
affect local delivery, which includes the delivery that has not started yet.

#### Scenario: A token command that never returns leaves local messaging working

- **WHEN** the broker starts with a bridge enabled whose token command never returns
- **THEN** the socket is bound, two sessions register, and a message between them is delivered

#### Scenario: The bridge still starts when the token resolves

- **WHEN** the broker starts with a bridge enabled whose token command returns a token
- **THEN** the socket is bound and the bridge is constructed
