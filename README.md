# smithersai/gstack

A port of [garrytan/gstack](https://github.com/garrytan/gstack) to
[smithers-orchestrator](https://smithers.sh). Every skill that gstack shipped
as a generated `SKILL.md.tmpl` is rebuilt here as a typed smithers workflow —
a single `.tsx` file composing deterministic Tasks (git/gh/curl) and agent
Tasks (MDX prompts) with shared zod schemas.

> **Upstream:** [`garrytan/gstack`](https://github.com/garrytan/gstack) by
> Garry Tan. This repo is a showcase of how gstack's AI-engineering workflows
> look when ported onto smithers' typed orchestration primitives — Garry's
> skills, Garry's prompts, Garry's YC voice, all preserved. This fork exists
> to exercise smithers against real, non-trivial workflows, not to replace
> upstream.

## What changed

Upstream gstack skills live in `<skill>/SKILL.md.tmpl` files that get
preprocessed into static `SKILL.md` documents by `scripts/gen-skill-docs.ts`.
Claude Code reads the generated Markdown and walks the bash blocks inside.

The port keeps every feature but replaces the pipeline with smithers:

| aspect | upstream gstack | smithersai/gstack |
|---|---|---|
| skill source | `*/SKILL.md.tmpl` + `scripts/resolvers/*.ts` | `workflows/*.tsx` + `prompts/*.mdx` |
| skill output | generated `SKILL.md` (static) | JSX graph of `<Task/>`, `<Loop/>`, `<Parallel/>`, `<Branch/>` |
| state between steps | bash variables re-reading shell state | zod-typed Task outputs, persisted to SQLite |
| prompts | `{{PLACEHOLDER}}` substitution at build time | MDX components rendered per-run with typed props |
| config/repo probe | ~850 lines of inline bash preamble | `lib/smithers/preamble.ts` → deterministic Task output |
| agent roster | decided implicitly per skill | `agents.ts` — one place to swap models/providers |
| human gates | `AskUserQuestion` mid-skill | `needsApproval` + `requiresConfirmation` on specific Tasks |
| observability | none beyond shell logs | smithers persists every Task input/output + agent transcript |

### Concrete improvements the port forced

Every one of these started as a codex finding during review and ended up in the
port:

- **Merge-completion polling.** `gh pr merge --auto` returns immediately;
  upstream land-and-deploy would race the deploy against a PR that hadn't
  landed yet. The port polls `gh pr view --json state,mergeCommit` until
  `state === "MERGED"` before handing off.
- **`gh pr checks` field fix.** Upstream requested `conclusion`, which isn't
  a valid field in current gh — the call silently failed and the gate
  reported `unknown`. Fixed to `bucket,state,name` with proper
  pass/fail/pending mapping.
- **YAML scalar parser.** `gstack-config get` uses `awk '{print $2}'`, which
  truncates `deploy_command: "vercel deploy --prod"` to `"vercel`. The port
  reads `~/.gstack/config.yaml` directly with an escape-aware parser that
  preserves URL fragments (`https://x/#/dashboard`), hex colors (`"#ff0000"`),
  and setup-deploy's JSON-stringified values.
- **Deterministic merge/deploy guards.** Upstream relied on the LLM gate for
  merge/deploy approval. The port computes `mergeAllowed` and `deployAllowed`
  in code from typed signals (`ci.state === "passing"`,
  `review.decision !== "CHANGES_REQUESTED"`, `merge.merged === true`) and
  `autoApprove` can't bypass a `requiresConfirmation: true` from the gate.
- **Origin check for `/canary`.** Upstream accepted page paths via
  `new URL(page, baseUrl)`. A path like `/\evil.com/path` resolves to a
  different origin because WHATWG URL treats backslashes as slashes on
  http(s). The port rejects any page that resolves off-origin.
- **Shell-injection closure for canary body hash.** Upstream piped
  `curl "${url}" | shasum` — a single-quote in a path argument broke out.
  The port fetches with argv and hashes with `node:crypto`.
- **Stash-gate before hard reset.** `/gstack-upgrade` runs `git reset --hard
  origin/main` on the install checkout. If a stash fails to save, upstream
  would reset anyway and delete in-progress work. The port throws before
  the reset if the tree is still dirty after stashing.
- **Sandbox-safe `cwd`.** `smithers bashTool` sandboxes `cwd` against the
  workflow root before following symlinks. The default install path
  `~/.claude/skills/gstack` is a symlink into this checkout; the port calls
  `fs.realpath` first so the sandbox sees an in-root path.
- **Session-cookie lifecycle.** `/setup-browser-cookies` can't split
  launch/wait/capture across Task boundaries — session cookies only live in
  the Playwright `BrowserContext`. The port uses a single Task that holds
  the context open while polling a filesystem sentinel for the user's
  "done" signal.

Every call-out above corresponds to a commit or diff in this repo. The full
review log, round by round, is in `workflows/README.md`.

### Review workflow

Four adversarial rounds by OpenAI Codex (`codex exec`) against the port,
each one reading `https://smithers.sh/llms-full.txt` before reviewing and
grading P1/P2/P3 findings with confidence scores. Every finding was either
fixed in code or documented as an upstream blocker. Round 18 returned:

> Pre-Landing Review: No issues found. LGTM.
> The only remaining blocker I see is the documented upstream
> Smithers/Bun/react-reconciler runtime bug in workflows/README.md:38.

## Repo layout

```
workflows/          31 ported skills, each a single .tsx file
  README.md         per-skill port changelog + triage table
prompts/            44 MDX prompt templates, rendered with typed props
lib/smithers/       shared helpers
  preamble.ts       repo probe + gstack-config reader (Task output)
  shell.ts          sh, sh -c exec + resolveGstackBin
  config.ts         YAML scalar parser for ~/.gstack/config.yaml
  ctx.ts            readOutput / readOutputMaybe / readLatest
  review.ts         shared ReviewOutput schema
agents.ts           Claude + Codex provider roster
examples/experimental/   speculative patterns that don't render under 0.16.1
smithers.config.ts  entry point
```

Everything outside `workflows/`, `prompts/`, `lib/smithers/`, `agents.ts`,
`examples/`, `smithers.config.ts`, and the `.tsx`-related `package.json`
additions is **unmodified from upstream**. The original SKILL.md files still
work with the Claude Code skill loader; the smithers workflows are an
orthogonal path.

## Running a workflow

```bash
bun install
bun run typecheck
bun run workflow:list
bun run workflow:run workflows/retro.tsx --input '{"window":"7d"}' --allow-network
```

See [`workflows/README.md`](workflows/README.md) for the per-skill contract,
the `--allow-network` convention, the per-workflow `dbPath` rationale, and
the full port changelog.

## Known blocker

`smithers up` currently fails with
`resolveEventTimeStamp is not a function` from inside
`react-reconciler/cjs/react-reconciler.development.js`. This is an interop
bug between `smithers-orchestrator@0.16.1`, `bun@1.3.12`, and
`react-reconciler@0.33.x` — the host config doesn't expose
`resolveEventTimeStamp` but bun's bundled reconciler expects it. Typecheck
passes, schema DDL checks clean, workflow composition renders through the
first frame before the reconciler error fires. Runtime behavior past the
first frame is unverified until upstream ships a fix.

Details + reproduction steps: [`workflows/README.md`](workflows/README.md#known-issues).

## Credits

- [garrytan/gstack](https://github.com/garrytan/gstack) — Garry Tan's
  original skill library. Every prompt, every voice choice, every YC
  reference in this repo came from there. Please read the upstream README
  for the builder philosophy behind these workflows.
- [smithers-orchestrator](https://smithers.sh) — the TypeScript/JSX
  workflow runtime that made the port viable.
- The port itself was built by Claude Code (Opus 4.7, 1M context) with
  adversarial review by OpenAI Codex.

## License

MIT, same as upstream.
