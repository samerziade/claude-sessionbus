# Code Style & TypeScript Hygiene — Design

**Date:** 2026-07-16
**Status:** approved, pending implementation

## Problem

This repo has no written code-style or TypeScript-hygiene conventions beyond a brief "No `any`"
line under **Constraints** and the **Markdown conventions** section in `CLAUDE.md`.

An audit of `bus/src` and `broker/src` (26 files, ~1600 LOC) found the code **already consistent
almost everywhere**:

| Convention                         | State today                                            |
| ---------------------------------- | ------------------------------------------------------ |
| `interface` for object shapes      | 19 interfaces; 6 exceptions (all in `broker/src/protocol.ts`) |
| No `any` / unsafe casts            | zero occurrences                                       |
| `Boolean(x)` over `!!x`            | zero occurrences of `!!`                               |
| `_name` not bare `_` destructuring | zero violations                                        |
| Exact dependency versions          | all exact — but not enforced                           |
| Factory over module-level `let`    | already practiced (`createFrameDecoder`)               |

So the gap is **not cleanup — it is drift prevention**. The conventions hold today by discipline
alone; nothing stops the next change from introducing an `any`, a `!!`, or a caret range.

### The enforcement gap (the load-bearing finding)

Two facts make "just document it" insufficient:

1. `noExplicitAny` already fires, but at Biome's default **`warn`** severity — advisory only.
2. **Biome is in no gate at all.** `pnpm lint` is `pnpm -r lint` → `tsc --noEmit` per package.
   The only thing that runs Biome is `pnpm fmt`, which *auto-writes*.

Raising severities alone therefore changes nothing. The gate itself must change.

## Enforcement mechanism: Biome rules

Conventions can be enforced either by lint rules or by repo-scanning `*.guard.test.ts` files that
fail CI. This repo already runs Biome with the linter enabled, and Biome 2.5.0 ships native rules
covering the mechanical cases:

| Rule                           | Category   | Available from | Fix    |
| ------------------------------ | ---------- | -------------- | ------ |
| `noExplicitAny`                | suspicious | 1.0.0          | none   |
| `useConsistentTypeDefinitions` | style      | 2.1.4          | unsafe |
| `noImplicitCoercions`          | complexity | 2.1.0          | unsafe |

**Decision:** use declarative Biome rules. Guard tests are out of scope — they would add test
infrastructure this two-package repo does not need for rules the linter already expresses.

Conventions Biome *cannot* express stay as prose in `CLAUDE.md`, explicitly marked as such.

## Design

### 1. Enable the three rules as errors (`biome.json`)

Added alongside the existing `correctness` group:

```jsonc
"suspicious": { "noExplicitAny": "error" },
"style":      { "useConsistentTypeDefinitions": "error" },
"complexity": { "noImplicitCoercions": "error" }
```

No `options` blocks are needed: `useConsistentTypeDefinitions.style` already defaults to
`interface`, and `noImplicitCoercions.allowDoubleNegation` already defaults to `false`
(disallow). Both defaults are exactly the intended convention, so only severity is set.

All three sit at zero violations once §3 lands, so this is preventive.

**Wider than strictly needed, deliberately kept:** `noImplicitCoercions` bans implicit coercion
generally (`+x`, `"" + x`, `~arr.indexOf(v)`), not just `!!x`. That is the same explicitness this
design is after, and the repo has zero violations today, so the broader rule is adopted as-is
rather than narrowed.

### 2. Make the gate real (root `package.json`)

```jsonc
"lint": "biome check . && pnpm -r lint"
```

This is what converts the rules from advisory to CI-failing.

**Accepted consequence:** `pnpm lint` now also fails on formatting drift, not just these three
rules. This is intended; `pnpm fmt` fixes it.

### 3. Convert the 6 protocol frames to interfaces

`broker/src/protocol.ts` frames become `interface`; the `Frame` union stays a `type` — object
shape vs. union.

Verified before adoption: both packages `tsc --noEmit` clean and all 14 broker tests pass after
conversion. (Interfaces lack implicit index signatures, so this was checked rather than assumed;
the frames are only `JSON.stringify`'d and narrowed via `isFrame`.)

### 4. Add `.npmrc`

```text
save-exact=true
```

Every version is already exact; this stops the next `pnpm add` from introducing a `^` range.

### 5. Add conventions sections to `CLAUDE.md`

Scoped to the four conventions Biome cannot express:

- **Reuse canonical types; no large inline types** — a shared type has one home and is imported,
  never re-derived; declare a named `interface` rather than a large inline object type in a
  signature. Real example: `protocol.ts` imports `ChannelMessage` instead of restating it.
- **No unsafe casts** — extends No-`any` to `as unknown as` / `<any>`, with an
  `// unavoidable-cast: <reason>` escape hatch for genuine runtime boundaries.
- **Module state: factory + singleton** — shared mutable state lives in a `createX()` closure, not
  a module-level `let`; tests construct fresh instances. No `__resetForTests`, no
  `vi.resetModules()`. Names the convention `createFrameDecoder()` already follows, so the daemon
  work keeps to it.
- **Test coverage: happy path / negative / edge cases / blind spots**, scoped per-function, plus
  test structure (describe blocks, behavior-named tests, early-return type narrowing).

Each rule is marked **Biome-enforced** or **prose-only**, so a reader knows what actually fails.

## Out of scope

- **Guard tests** — superseded by Biome rules (see *Enforcement mechanism*).
- **The `../../bus/src/message.ts` deep relative import** in `protocol.ts`. It is a correct
  *reuse* of a canonical type — the rule this design endorses — but the cross-package mechanism is
  a packaging concern, not a styling one. Possible follow-up; not touched here.

## Verification

1. `pnpm lint` passes (Biome check + both `tsc --noEmit`).
2. `pnpm test` — bus and broker suites still green.
3. Negative probes: a temp file containing `any`, `!!x`, and a `type X = {...}` object alias each
   fail `pnpm lint`, proving the rules gate rather than merely being configured.
