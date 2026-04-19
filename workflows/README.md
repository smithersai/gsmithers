# gstack workflows (smithers port)

Each `.tsx` file here is a smithers workflow ported from a gstack Claude Code
skill. Every workflow starts with a two-line header:

```tsx
// Ported from https://github.com/garrytan/gstack/blob/main/<skill>/SKILL.md.tmpl
// See workflows/README.md for the full port changelog.
```

The full changelog for every skill lives in this README — keeping it out of
the individual source files avoids rot and keeps the code readable.

## How to run

```bash
# list workflow files
bun run workflow:list

# run a workflow by file path, network-allowed so git/gh/curl work
bun run workflow:run workflows/retro.tsx --input '{"window":"7d"}' --allow-network
# equivalently:
./node_modules/.bin/smithers up workflows/retro.tsx --input '...' --allow-network
```

Always use the **pinned local CLI** (`./node_modules/.bin/smithers`). A
global `smithers` binary may be an older version that is missing newer
verbs (e.g. `signal`). Ad-hoc `bunx smithers-orchestrator` invocations are
not supported because the package relies on peer deps (`@mdx-js/esbuild`,
`@effect/sql-sqlite-bun`) that are only installed inside this repo.

`--allow-network` is required for any workflow that shells out to
git/gh/curl. The smithers `bashTool` defaults to network-isolated; we only
break that isolation when the run operator opts in.

## Known issues

- **Smithers 0.16.1 + bun 1.3.x + react-reconciler upstream bug.** Running
  any workflow via `smithers up` currently fails with
  `resolveEventTimeStamp is not a function` inside
  `react-reconciler/cjs/react-reconciler.development.js`. The reconciler's
  host config doesn't expose that method but bun's bundle of
  `react-reconciler` expects it. This is not fixable from gstack — it's a
  smithers / react-reconciler / bun interop issue. Reproduced with:
  - `smithers-orchestrator@0.16.1`
  - `bun@1.3.12` (macOS arm64, darwin 25.2.0)
  - `react-reconciler@0.33.x` (pulled transitively)

  Typecheck passes. Schema DDL checks clean (per-workflow `dbPath`, no
  reserved-column collisions). Workflow composition renders far enough to
  submit the first frame before the reconciler error fires. Runtime
  behavior beyond that first frame is unverified until upstream ships a
  fix — review the port with this caveat in mind.

- **Per-workflow smithers.db.** Each workflow writes to its own
  `./executions/<workflow-name>.db` (set via `dbPath` in `createSmithers`).
  A single shared `./smithers.db` would collide across workflows since each
  registers a different `input` table schema — the second workflow to boot
  against the same DB fails with `table input has no column named X`.

### Speculative workflows

Two workflows depend on gui-side primitives (custom-GUI and hijacked-session)
that are not yet exported from `smithers-orchestrator`. They live in
`../examples/experimental/` and are **not** part of the runnable workflow
set. They throw at render time with a specific error message so the
speculative dependency is obvious if someone points the runner at them.
Once the gui features ship, move these back into `workflows/` and replace
the placeholders with the real imports.

## Conventions

- **MDX prompts** live in `../prompts/` (no underscore prefix). Workflows
  import them directly; no TSX wrappers.
- **Shared partials** (`preamble.mdx`, `base-branch-detect.mdx`, `browse-setup.mdx`,
  `learnings-search.mdx`, `gbrain-context-load.mdx`) are consumed as MDX
  components with typed props — no build-time string expansion.
- **Deterministic Tasks** use smithers' `bashTool` via `lib/smithers/shell.ts`
  so shell calls pick up sandboxing, network policy, and tool-call
  observability. A spawn fallback covers test contexts without a smithers
  runtime.
- **Schema identity matters.** Smithers resolves output targets by Zod object
  identity, so any workflow that registers the same "shape" under multiple
  keys clones with `.extend({})` per key (see `autoplan`, `canary`, `cso`,
  `design-shotgun`, `benchmark`).
- **Human gates** use `needsApproval: true` on the Task instead of
  `dangerouslyAllow*` booleans. Ship's push and PR-create, land-and-deploy's
  merge and deploy, setup-deploy's low-confidence confirmation all pause for
  human approval.

## Preamble pattern

Every workflow starts with:

```tsx
<Task id="preamble" output={outputs.preamble} timeoutMs={15_000}>
  {async () => gatherPreambleContext({ skillName: "foo", tier: N, runId: ctx.runId })}
</Task>
```

`tier` (1–4) comes from the upstream `preamble-tier` frontmatter. Downstream
agent Tasks consume the preamble via `needs`/`deps` and render
`<PreamblePrompt {...deps.preamble} />` at the top of their children.

This replaces the ~850-line build-time preamble resolver in
`scripts/resolvers/preamble.ts`. See `lib/smithers/preamble.ts` for the
`PreambleContext` schema — it captures skill name, tier, branch, repo mode,
user config, and run metadata so smithers observability has typed data to
track per run.

## Triage (30 workflows + 2 speculative sketches)

| Skill | File | Pattern showcased | Notes |
|---|---|---|---|
| autoplan | `autoplan.tsx` | `Parallel` over 4 review tasks | Per-reviewer `.extend({})` schemas; `continueOnFail` for partial synthesis |
| benchmark | `benchmark.tsx` | Deterministic gather + agent interpretation | Baseline/current schemas cloned; raw `spawn` for stdout-only JSON parsing |
| canary | `canary.tsx` | `Loop` monitoring with verdict-driven exit | `shouldContinueMonitoring` honored in done predicate |
| codex | `codex.tsx` | Single-agent pin (no fallback) | Pinned to `providers.codex` to preserve the "second opinion" contract |
| context-restore | `context-restore.tsx` | Simple input-driven Task | |
| context-save | `context-save.tsx` | Session-to-markdown | Session duration from preamble `startedAt` |
| cso | `cso.tsx` | `Parallel` OWASP + STRIDE | Per-pass + merged-report schemas cloned |
| design-consultation | `design-consultation.tsx` | Long-form brainstorm | |
| design-html | `design-html.tsx` | Iterative Loop | Pre-read Task feeds typed deps; `until` includes `!nextFeedback` |
| design-review | `design-review.tsx` | `Loop` audit + fix | `until` = success only; `Loop.maxIterations` caps iterations |
| design-shotgun | `design-shotgun.tsx` | `Parallel` variants + compare | Per-variant `.extend({})` schemas; `continueOnFail` per variant |
| devex-review | `devex-review.tsx` | Live DX audit | |
| document-release | `document-release.tsx` | Post-ship doc sync | |
| gstack-upgrade | `gstack-upgrade.tsx` | **All-deterministic workflow** | Demo: smithers observability + resume for setup scripts, no agents in the loop |
| health | `health.tsx` | Deterministic checks + agent summary | |
| investigate | `investigate.tsx` | Iterative hypothesis Loop | `until` = success only |
| land-and-deploy | `land-and-deploy.tsx` | Gated merge → deploy | `needsApproval` on merge and deploy; `ctx.outputMaybe` reads |
| learn | `learn.tsx` | Minimal single-Task | |
| office-hours | `office-hours.tsx` | `Branch` on mode decision | Flat union-by-`mode` diagnostic schema (discriminatedUnion isn't a valid output target); typed deps on design-doc |
| plan-ceo-review | `plan-ceo-review.tsx` | Shared `ReviewOutput` schema | |
| plan-design-review | `plan-design-review.tsx` | Shared `ReviewOutput` schema | |
| plan-devex-review | `plan-devex-review.tsx` | Shared `ReviewOutput` schema | |
| plan-eng-review | `plan-eng-review.tsx` | Shared `ReviewOutput` schema | |
| plan-tune | `plan-tune.tsx` | Config mutation via typed output | |
| qa | `qa.tsx` | `Loop` test + fix + verify | `until` = `allClear`; `Loop.maxIterations` caps |
| qa-only | `qa-only.tsx` | Report-only single-Task | |
| retro | `retro.tsx` | Deterministic gather → narrative | |
| review | `review.tsx` | Pre-landing PR review | Reuses `ReviewOutput` from review family |
| setup-browser-cookies | `setup-browser-cookies.tsx` | Single-Task human-handoff | Single Task: launches Playwright, polls a filesystem sentinel for the user's "done" signal, captures session cookies before closing. `<WaitForEvent/>` wasn't viable here — session cookies live only in the running BrowserContext, and smithers Tasks can't share a Playwright handle across boundaries. |
| setup-deploy | `setup-deploy.tsx` | Detect + `needsApproval` | High-confidence detection auto-confirms; low-confidence pauses |
| ship | `ship.tsx` | Multi-phase Sequence | Split into durable Tasks: write → commit → push → PR. `needsApproval` on push + PR-create. Idempotent PR create. |

## Not ported — stay as Claude Code skills

| Skill | Reason |
|---|---|
| `careful` | PreToolUse hook — needs a smithers tool-interceptor primitive that doesn't exist today. A workflow shell would just describe what the hook does. |
| `freeze` / `unfreeze` | Hook-based read-only mode — same reason as careful. |
| `guard` | PreToolUse hook on `git push` — same reason. |

These four skills all want the same thing: per-tool-call policy inside an
agent Task. See `docs/smithers-feature-requests.md` (TODO) for the tool-
interceptor feature request. Porting any of them today would be ceremony
around a skill whose value IS the hook registration.

## Per-skill port changelog

Fine-grained notes on every port — the "Changes from upstream" blocks that
used to live in each `.tsx` file.

### autoplan
- Four plan reviews run in actual `<Parallel/>` instead of sequential bash dispatch.
- Each review produces a typed `ReviewOutput`; `.extend({})` per reviewer so
  smithers' object-identity-keyed output store gives each its own row.
- `continueOnFail` on each reviewer so the decision Task can synthesize from
  the survivors if one branch fails.
- Final approval gate (upstream's single AskUserQuestion at the end) is the
  `needsUserApproval` array in the decision output — the calling harness
  decides how to present it.

### benchmark
- Baseline + current schemas cloned per key (object-identity rule).
- Baseline cached to `.gstack/benchmark/baseline.json`; re-running with
  `mode="baseline"` overwrites.
- Interpretation is a single agent Task that consumes typed deltas.

### canary
- Continuous monitoring implemented as smithers `<Loop/>` with
  `maxIterations`. Upstream runs a bash sleep loop inline.
- `shouldContinueMonitoring` from the verdict is honored in the done
  predicate — a verdict saying "stop watching" actually stops the loop.

### codex
- `CodexAgent` used directly (`providers.codex`, no fallback) — the
  product-contract of "independent second opinion" is weakened by silent
  fallback to Claude.

### context-save / context-restore
- Session duration comes from the preamble's `startedAt`, not PPID tracking.
- Saved-context discovery is a deterministic Task returning the list
  pre-sorted by mtime.

### cso
- OWASP + STRIDE in actual `<Parallel/>`.
- Synthesis Task de-duplicates findings across the two frameworks.
- Per-pass `.extend({})` schemas for owasp, stride, and the merged report.
- `continueOnFail` per pass.

### design-consultation
- Upstream is a long-form AskUserQuestion sequence; pilot collapses to one
  agent Task with a structured output. A follow-up could use `<Loop/>` with
  `needsApproval` gates per section.

### design-html
- Pre-read Task fetches the previous iteration's HTML and passes it via
  typed deps (fixes the async-prompt bug from review round 1).
- `until` predicate includes `!ctx.input.nextFeedback` so the loop stops
  when the user stops providing feedback.

### design-review
- `until` = `allClear` only; `Loop.maxIterations` handles the ceiling.
- Shares `reviewFindingSchema` with the plan-review family.

### design-shotgun
- Four variants in `<Parallel/>`.
- Per-variant schema clones so smithers' object-identity rule gives each
  variant its own row.
- `continueOnFail` per variant — compare can still run with 3 of 4.

### devex-review
- Separate from plan-devex-review: runs against a shipped tool (actually
  invokes `--help`, attempts install).
- Reuses `reviewOutputSchema`.

### document-release
- Diff analysis lifted to a deterministic Task returning changed-files list.

### gstack-upgrade
- All-deterministic-Tasks workflow: detect → pull → migrations → build →
  verify → summary (agent Task for the summary is `skipIf: skipSummary`).
- Migrations tracked in `~/.gstack/migrations-applied.json`.
- Demo value: shows smithers observability + resume-from-last-success for
  a pure setup script.

### health
- Mechanical checks (test count, deps count, CI status, open PR count) all
  lifted to a deterministic Task producing a typed `RepoHealth` payload.
- Agent Task is summarize-and-rank only.

### investigate
- Hypothesis-test-rule-out cycle as a `<Loop/>` producing typed per-iteration results.
- `until` = success only; `Loop.maxIterations` handles the ceiling.

### land-and-deploy
- Upstream's readiness-gate sub-steps collapsed to one gate Task with a
  typed decision.
- `needsApproval` on merge and deploy (replaces `dangerouslyAllow*` booleans).
- `ctx.outputMaybe` for non-loop reads.
- Rollback compensation (`<Saga/>`) is a TODO once the undo path is codified.

### learn
- Single-Task skill. Smallest workflow in the set — demonstrates the
  minimum viable smithers shape.

### office-hours
- Mode selection (startup vs builder) is a `<Branch/>` over a typed
  mode-decision output.
- Diagnostic is a discriminated-union schema — both branches land in one
  output table, and the design-doc Task reads the correct variant via
  typed deps (no closure-scoped `ctx.latest`).

### open-gstack-browser, pair-agent (speculative — not in workflows/)
Both live in `examples/experimental/`. They depend on gui-side primitives
(`CustomUi`, `HijackedSession`) that aren't yet exported from
`smithers-orchestrator`, so each workflow throws at render time with an
explicit "primitive not shipped" error. Once the gui features land, move
them back to `workflows/` and swap the placeholders for the real imports.

### plan-{ceo,eng,design,devex}-review
- Structured `ReviewOutput` replaces mid-run AskUserQuestion dialog.
  Findings + openQuestions are emitted as typed data a calling workflow
  (autoplan) can route to user input.

### plan-tune
- Profile entry counts + recent-question counts gathered deterministically
  so the agent focuses on conversation, not data fetching.

### qa
- Iterative test-fix-test cycle as `<Loop/>`.
- `until` = `allClear` only; `Loop.maxIterations` handles the ceiling.

### qa-only
- Single Task, no Loop, no fix step — contrast with qa.tsx's test-fix-verify
  dance. Reuses the same `QaReport` shape.

### retro
- Git data gathering lifted from ~15 embedded bash blocks to one
  deterministic Task returning a typed `GatherOutput`.
- Compare mode + Global mode not yet ported — tracked as
  retro-compare.tsx and retro-global.tsx (TODO).
- testLoc heuristic is by commit subject; upstream counts test files by
  path.

### review
- Diff collection lifted to a deterministic Task.
- SCOPE_DRIFT and PLAN_COMPLETION_AUDIT_REVIEW logic pending — should
  become extra deterministic Tasks that the review Task consumes via
  `needs`.

### setup-browser-cookies
- Single-Task architecture. Opens a Playwright persistent context, polls
  a filesystem sentinel every second until the user runs the generated
  `~/.gstack/signals/signal-cookies-done-<site>.sh` (which just `touch`es
  the sentinel), then captures `context.cookies()` from the LIVE context
  before closing.
- Why not `<WaitForEvent/>` across three Tasks? Session cookies live only
  in the running Chromium process. If we close the context, those cookies
  are gone — reopening the same persistent context dir only returns
  expiry-bearing persistent cookies. Many auth flows rely on session
  cookies, so the whole lifecycle has to stay in one Task.
- Uses Playwright directly, not the `browse` CLI — `browse` has no
  `launch`/`cookies export --user-data-dir` commands.

### setup-deploy
- Detect → confirm-with-user → persist.
- `needsApproval` is computed from detection confidence — high confidence
  auto-confirms, low confidence pauses for the human.

### ship
- Upstream's 19 bash-heavy steps collapsed to 12 smithers Tasks:
  preamble → preflight → preflight-decide (agent) → tests → review →
  changelog (agent) → pr-body (agent) → release-write → release-commit →
  push → pr-create.
- Final action split into durable per-side-effect Tasks (was one
  resume-unsafe Task that did CHANGELOG write + commit + push + PR all at
  once).
- `needsApproval` on push and pr-create; idempotent PR create (returns
  existing PR if already present).
- Greptile triage, eval suites, plan-completion audit, TODOS.md updates
  are out of scope for this pilot.
