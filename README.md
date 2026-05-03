# gsmithers

gsmithers is a Smithers-powered fork of
[garrytan/gstack](https://github.com/garrytan/gstack). It keeps the gstack
product surface: planning reviews, QA, browser automation, release work,
retros, safety guardrails, and multi-agent review. The difference is that the
AI-engineering workflows are implemented as typed
[Smithers](https://smithers.sh) workflows instead of long generated Markdown
scripts.

The goal of this fork is to show what happens when a prompt-and-skill system is
rebuilt on durable orchestration primitives: every meaningful step has a stable
node id, a Zod-typed output, a SQLite checkpoint, and an event log that can be
inspected or resumed.

## What Smithers Adds

| gstack concern | upstream shape | gsmithers shape |
|---|---|---|
| workflow source | generated `SKILL.md` from `SKILL.md.tmpl` | `workflows/*.tsx` with JSX control flow |
| task boundaries | prose steps and shell snippets | [`<Task>`](https://smithers.sh/components/task) nodes with typed outputs |
| sequencing | agent follows Markdown order | Smithers [`<Workflow>`](https://smithers.sh/docs/workflow) execution model |
| branching and loops | bash variables plus instructions | [`<Branch>`](https://smithers.sh/components/branch), [`<Parallel>`](https://smithers.sh/components/parallel), and loop components |
| state | re-read shell state and temp files | Zod rows persisted to SQLite checkpoints |
| human approval | `AskUserQuestion` inside the transcript | Smithers approval gates and resumable decisions |
| observability | terminal output | persisted events, logs, node outputs, and inspectable runs |
| agent routing | repeated per-skill prose | one typed roster in `agents.ts` |

Concretely, here is the body of `workflows/retro.tsx` — the entire orchestration
surface for the weekly retrospective skill:

```tsx
<Workflow name="retro">
  <Task id="preamble" output={outputs.preamble} timeoutMs={15_000}>
    {async () => gatherPreambleContext({ skillName: "retro", tier: 2, runId: ctx.runId })}
  </Task>

  <Task id="gather" output={outputs.gather} timeoutMs={60_000}>
    {async () => gatherRetroData(ctx.input, await detectBaseBranch())}
  </Task>

  <Task
    id="narrative"
    output={outputs.narrative}
    needs={{ preamble: "preamble", data: "gather" }}
    deps={{ preamble: preambleContextSchema, data: gatherOutputSchema }}
    agent={agents.smart}
  >
    {(deps) => (
      <>
        <PreamblePrompt {...deps.preamble} />
        <RetroNarrativePrompt data={deps.data} />
      </>
    )}
  </Task>
</Workflow>
```

Each `<Task>` is a checkpointed node: typed output schema, declared
dependencies, and a render function that returns either data or an MDX prompt
the agent will execute. The upstream `retro/SKILL.md` expressed the same flow
as ~400 lines of Markdown the agent had to interpret in order.

Useful Smithers docs:

- [Quickstart](https://smithers.sh/quickstart)
- [Execution model](https://smithers.sh/concepts/execution-model)
- [Suspend and resume](https://smithers.sh/concepts/suspend-and-resume)
- [Approvals](https://smithers.sh/concepts/approvals)
- [Observability](https://smithers.sh/guides/monitoring-logs)
- [CLI reference](https://smithers.sh/cli/overview)

## What Is Implemented

The repo has 31 runnable Smithers workflows in `workflows/`, backed by 45 MDX
prompt modules and shared helpers in `lib/smithers/`.

Core flows:

- product framing: `office-hours`, `autoplan`
- planning reviews: `plan-ceo-review`, `plan-eng-review`,
  `plan-design-review`, `plan-devex-review`
- implementation support: `codex`, `investigate`, `learn`, `context-save`,
  `context-restore`
- quality gates: `review`, `qa`, `qa-only`, `cso`, `health`
- design workflows: `design-consultation`, `design-html`, `design-shotgun`,
  `design-review`
- release and operations: `ship`, `document-release`, `setup-deploy`,
  `land-and-deploy`, `canary`, `benchmark`, `gstack-upgrade`, `retro`
- browser/auth workflows: `setup-browser-cookies`

Host-native gstack skills such as `careful`, `freeze`, `guard`, `unfreeze`,
`browse`, `open-gstack-browser`, and `pair-agent` remain generated
`SKILL.md` skills because they install shell hooks or drive the browser binary
directly. They are still built, tested, and shipped by this repo; they are not
duplicated as Smithers workflows when the host integration itself is the
runtime.

## Why This Is More Robust

This port turned several instruction-level assumptions into executable checks:

- `land-and-deploy` waits until GitHub reports the PR is actually merged before
  deploying.
- CI gates read current `gh pr checks` fields (`bucket`, `state`, `name`) and
  map pass/fail/pending deterministically.
- `setup-deploy` and `land-and-deploy` use approval gates for low-confidence or
  destructive actions.
- `canary` rejects off-origin page paths and hashes response bodies with
  `node:crypto` instead of shell interpolation.
- `gstack-upgrade` refuses to run `git reset --hard` unless stashing actually
  cleaned the install checkout.
- `setup-browser-cookies` keeps one Playwright context open for the whole
  login flow so session cookies are captured before the browser closes.
- shared repo/config probing lives in `lib/smithers/preamble.ts`, replacing a
  large generated shell preamble with typed data.

## Run It

Install dependencies:

```bash
bun install
```

List workflows:

```bash
bun run workflow:list
```

Render a workflow graph without executing it:

```bash
./node_modules/.bin/smithers graph workflows/retro.tsx --input '{"window":"7d"}'
```

This prints the node DAG (`preamble → gather → narrative`), each task's input
and output schemas, and the agent assignment — useful for catching wiring
mistakes before spending tokens.

Run a workflow:

```bash
./node_modules/.bin/smithers up workflows/retro.tsx \
  --input '{"window":"7d"}' \
  --allow-network
```

You'll see per-task status updates as each node enters, succeeds, or suspends,
with the typed output for every completed task written to
`./executions/<workflow>.db`. If a run fails or is interrupted mid-flight,
re-running the same `smithers up` command resumes from the last successful
checkpoint instead of starting over — the long-running planning and review
workflows are designed to survive crashes, network blips, and human
intervention.

Use the pinned local Smithers CLI from `node_modules`; this repo depends on the
package versions installed by `bun install`.

## Verify

```bash
bun run typecheck
bun run test
bun run build
```

`bun run build` regenerates all host-specific `SKILL.md` files and compiles the
browser/design binaries. `bun run test` runs the fast unit and integration
suite and regenerates host skill fixtures as part of its checks.

## Repo Layout

```text
workflows/           Smithers workflow definitions
prompts/             MDX prompt modules rendered by workflow tasks
lib/smithers/        shared typed helpers for shell, config, preamble, outputs
agents.ts            shared Smithers agent provider roster
smithers.config.ts   repo command metadata
browse/              Playwright browser CLI and tests
design/              design workflow CLI and tests
*/SKILL.md.tmpl      upstream-compatible generated skill templates
```

## Upstream And License

This fork is based on [garrytan/gstack](https://github.com/garrytan/gstack) by
Garry Tan and keeps the same MIT license. The Smithers workflow layer is here
to demonstrate that the same AI-engineering tool can be easier to inspect,
resume, test, and extend when the agent work is expressed as typed durable
orchestration.
