# gstack Workflows On Smithers

Each file in this directory is a runnable
[Smithers](https://smithers.sh) workflow port of a gstack AI-engineering skill.
The generated `SKILL.md` files still exist for host-native skill loading, while
these `.tsx` files provide the durable workflow implementation.

Every workflow follows the same shape:

```tsx
// Ported from https://github.com/garrytan/gstack/blob/main/<skill>/SKILL.md.tmpl
// See workflows/README.md for the full port changelog.
```

## Run

```bash
bun install
bun run workflow:list
./node_modules/.bin/smithers graph workflows/retro.tsx --input '{"window":"7d"}'
./node_modules/.bin/smithers up workflows/retro.tsx --input '{"window":"7d"}' --allow-network
```

Use the pinned local CLI at `./node_modules/.bin/smithers`. These workflows are
tested against the repo-pinned `smthrs` version and the local
MDX/SQLite dependencies installed by Bun.

`--allow-network` is required for workflows that call `git`, `gh`, `glab`,
`curl`, or deployment CLIs through Smithers' bash tooling.

## Runtime Contract

- Each workflow has its own `./executions/<workflow>.db` so different input
  schemas never collide in a shared SQLite database.
- `executions/.gitkeep` is tracked so a fresh clone can open workflow
  databases immediately; generated `.db` files remain ignored.
- Deterministic tasks use `lib/smithers/shell.ts`, which routes shell work
  through Smithers tooling when a runtime is present and falls back to direct
  process execution in tests.
- Agent tasks render MDX prompt components from `prompts/` and persist their
  structured Zod outputs.
- Human gates use Smithers task approvals for side effects such as pushing,
  PR creation, merging, deployment, and low-confidence setup persistence.

## Shared Patterns

### Preamble

Every workflow starts with a typed preamble task:

```tsx
<Task id="preamble" output={outputs.preamble} timeoutMs={15_000}>
  {async () => gatherPreambleContext({ skillName: "foo", tier: N, runId: ctx.runId })}
</Task>
```

The resulting `PreambleContext` replaces the generated shell preamble with a
typed row containing the skill name, tier, branch, repo root, repo mode, user
config, update message, run id, and start time.

### Output Reads

Workflows read prior outputs with `readOutput`, `readOutputMaybe`, and
`readLatest` from `lib/smithers/ctx.ts`. The helper centralizes the narrow cast
needed because Smithers' schema registry and Zod object identity intentionally
keep output targets strict.

### Schema Identity

When one workflow writes the same Zod shape under multiple output keys, the
schema is cloned with `.extend({})` for each key. This keeps Smithers' output
registry unambiguous for parallel reviewers, variants, and baselines.

### Host-Native Skills

Some gstack capabilities are intentionally host-native skills rather than
Smithers workflows. `careful`, `freeze`, `guard`, and `unfreeze` install
PreToolUse hooks; `browse`, `open-gstack-browser`, and `pair-agent` drive the
browser CLI and host setup directly. They remain generated and tested by the
repo while the AI workflow layer lives here.

## Workflow Matrix

| Workflow | File | Smithers pattern |
|---|---|---|
| autoplan | `autoplan.tsx` | parallel CEO/eng/design/devex reviews plus synthesis |
| benchmark | `benchmark.tsx` | deterministic metric gather plus agent interpretation |
| canary | `canary.tsx` | monitoring loop with typed verdicts |
| codex | `codex.tsx` | pinned Codex second-opinion agent |
| context-restore | `context-restore.tsx` | saved-context discovery and restore guidance |
| context-save | `context-save.tsx` | session state to durable context artifact |
| cso | `cso.tsx` | parallel OWASP and STRIDE security passes |
| design-consultation | `design-consultation.tsx` | structured design-system consultation |
| design-html | `design-html.tsx` | iterative HTML generation loop |
| design-review | `design-review.tsx` | audit/fix loop with bounded iterations |
| design-shotgun | `design-shotgun.tsx` | parallel design variants and comparison |
| devex-review | `devex-review.tsx` | live developer-experience audit |
| document-release | `document-release.tsx` | changed-file analysis plus release docs update |
| gstack-upgrade | `gstack-upgrade.tsx` | all-deterministic upgrade pipeline with resumable steps |
| health | `health.tsx` | repo checks plus prioritized health report |
| investigate | `investigate.tsx` | hypothesis loop for root-cause debugging |
| land-and-deploy | `land-and-deploy.tsx` | readiness gate, approval, merge polling, deploy |
| learn | `learn.tsx` | structured learning capture |
| office-hours | `office-hours.tsx` | branch between startup and builder diagnostics |
| plan-ceo-review | `plan-ceo-review.tsx` | structured CEO-level product review |
| plan-design-review | `plan-design-review.tsx` | structured design review |
| plan-devex-review | `plan-devex-review.tsx` | structured developer-experience review |
| plan-eng-review | `plan-eng-review.tsx` | structured engineering review |
| plan-tune | `plan-tune.tsx` | config/profile mutation through typed decisions |
| qa | `qa.tsx` | browser QA loop with fix and verify phases |
| qa-only | `qa-only.tsx` | report-only browser QA |
| retro | `retro.tsx` | git-data gather plus narrative retrospective |
| review | `review.tsx` | pre-landing PR review |
| setup-browser-cookies | `setup-browser-cookies.tsx` | single-task Playwright session-cookie capture |
| setup-deploy | `setup-deploy.tsx` | deployment detection with approval when confidence is low |
| ship | `ship.tsx` | preflight, tests, review, changelog, commit, push, PR |

## Port Changelog

### Core Orchestration

- Markdown step order became explicit Smithers task graphs.
- Build-time prompt substitution became MDX components rendered per run.
- Shell-only state became Zod outputs persisted to SQLite.
- Long-running loops gained `maxIterations` bounds and typed convergence
  checks.
- Parallel review and design work now uses actual `<Parallel>` branches rather
  than sequential dispatch hidden in prose.

### Safety And Release

- `land-and-deploy` polls GitHub until the merge is complete before deploy.
- `land-and-deploy` maps `gh pr checks` through valid current fields:
  `bucket`, `state`, and `name`.
- merge, deploy, push, PR creation, and low-confidence deploy setup use
  approval-gated Smithers tasks.
- `gstack-upgrade` stashes before reset and refuses to reset when the checkout
  stays dirty.
- `canary` validates same-origin page resolution and hashes fetched bodies
  without shell interpolation.

### Browser And Auth

- `setup-browser-cookies` keeps the Playwright browser context alive until the
  user signals completion, then captures session cookies before closing.
- browser command skills remain host-native because their value is direct CLI
  integration with the headed browser, extension, and remote-agent token flow.

### Reviewability

- All review-family workflows share `reviewOutputSchema`.
- `agents.ts` centralizes Claude, Codex, Gemini, Kimi, Pi, and Amp providers.
- `lib/smithers/config.ts` reads `~/.gstack/config.yaml` without truncating
  quoted values, URL fragments, colors, or deploy commands.
- `lib/smithers/preamble.ts` centralizes repo probing so workflow runs expose
  the same context through Smithers observability.
