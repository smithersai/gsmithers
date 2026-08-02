// Ported from https://github.com/garrytan/gstack/blob/main/retro/SKILL.md.tmpl
// See workflows/README.md for the full port changelog.
/** @jsxImportSource smthrs */
import { createSmithers } from "smthrs";
import { z } from "zod/v4";
import { agents } from "../agents";
import RetroNarrativePrompt from "../prompts/retro-narrative.mdx";
import PreamblePrompt from "../prompts/preamble.mdx";
import {
  gatherPreambleContext,
  preambleContextSchema,
  detectBaseBranch,
} from "../lib/smithers/preamble";
import { sh } from "../lib/smithers/shell";

const inputSchema = z.object({
  window: z.string().default("7d"),
});

const commitSchema = z.object({
  hash: z.string(),
  author: z.string(),
  email: z.string(),
  timestamp: z.string(),
  subject: z.string(),
  insertions: z.number().default(0),
  deletions: z.number().default(0),
  filesChanged: z.number().default(0),
});

const authorStatsSchema = z.object({
  commits: z.number(),
  insertions: z.number(),
  deletions: z.number(),
  topArea: z.string().nullable().default(null),
});

const gatherOutputSchema = z.object({
  window: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  baseBranch: z.string(),
  currentUser: z.string(),
  commits: z.array(commitSchema),
  totals: z.object({
    commits: z.number(),
    contributors: z.number(),
    insertions: z.number(),
    deletions: z.number(),
    testLoc: z.number(),
  }),
  metrics: z.object({
    feat: z.number(),
    fix: z.number(),
    refactor: z.number(),
    test: z.number(),
    chore: z.number(),
    docs: z.number(),
  }),
  authors: z.record(z.string(), authorStatsSchema),
  hotspots: z.array(z.object({ file: z.string(), changes: z.number() })),
  peakHour: z.number().nullable(),
  hourlyHistogram: z.record(z.string(), z.number()),
});

const narrativeOutputSchema = z.object({
  tweetable: z.string(),
  narrative: z.string(),
});

type GatherOutput = z.infer<typeof gatherOutputSchema>;

function parseWindow(window: string): { sinceIso: string; startDate: string } {
  const match = /^(\d+)([dhw])$/.exec(window);
  if (!match) {
    throw new Error(`Invalid window: ${window} (expected format: 7d, 24h, 2w)`);
  }
  const n = Number(match[1]);
  const unit = match[2];
  const now = new Date();
  const start = new Date(now);
  if (unit === "h") {
    start.setHours(start.getHours() - n);
  } else {
    const days = unit === "w" ? n * 7 : n;
    start.setDate(start.getDate() - days);
    start.setHours(0, 0, 0, 0);
  }
  const sinceIso = start.toISOString().replace(/\.\d+Z$/, "");
  return { sinceIso, startDate: start.toISOString().slice(0, 10) };
}

function categorizeCommit(subject: string): keyof GatherOutput["metrics"] | null {
  const s = subject.toLowerCase();
  if (s.startsWith("feat")) return "feat";
  if (s.startsWith("fix")) return "fix";
  if (s.startsWith("refactor")) return "refactor";
  if (s.startsWith("test")) return "test";
  if (s.startsWith("chore")) return "chore";
  if (s.startsWith("docs")) return "docs";
  return null;
}

async function gatherRetroData(
  input: z.infer<typeof inputSchema>,
  baseBranch: string,
): Promise<GatherOutput> {
  const { sinceIso, startDate } = parseWindow(input.window);
  const endDate = new Date().toISOString().slice(0, 10);
  const currentUser = (await sh("git", ["config", "user.name"])).trim() || "you";

  await sh("git", ["fetch", "origin", baseBranch, "--quiet"], {
    tolerateFailure: true,
  });

  const logRaw = await sh("git", [
    "log",
    `origin/${baseBranch}`,
    `--since=${sinceIso}`,
    "--format=%H|%aN|%ae|%ai|%s",
    "--shortstat",
  ]);

  const commits: z.infer<typeof commitSchema>[] = [];
  const blocks = logRaw.split(/\n(?=[a-f0-9]{40}\|)/);
  for (const block of blocks) {
    if (!block.trim()) continue;
    const [header, stats] = block.split("\n", 2);
    if (!header) continue;
    const [hash, author, email, timestamp, ...rest] = header.split("|");
    if (!hash || !author) continue;
    let insertions = 0;
    let deletions = 0;
    let filesChanged = 0;
    if (stats) {
      const ins = /(\d+) insertion/.exec(stats);
      const del = /(\d+) deletion/.exec(stats);
      const fc = /(\d+) file/.exec(stats);
      if (ins) insertions = Number(ins[1]);
      if (del) deletions = Number(del[1]);
      if (fc) filesChanged = Number(fc[1]);
    }
    commits.push({
      hash,
      author: author!,
      email: email ?? "",
      timestamp: timestamp ?? "",
      subject: rest.join("|"),
      insertions,
      deletions,
      filesChanged,
    });
  }

  const authors: Record<string, z.infer<typeof authorStatsSchema>> = {};
  const hourly: Record<string, number> = {};
  const metrics = { feat: 0, fix: 0, refactor: 0, test: 0, chore: 0, docs: 0 };

  for (const c of commits) {
    if (!authors[c.author]) {
      authors[c.author] = { commits: 0, insertions: 0, deletions: 0, topArea: null };
    }
    authors[c.author]!.commits += 1;
    authors[c.author]!.insertions += c.insertions;
    authors[c.author]!.deletions += c.deletions;
    const hour = new Date(c.timestamp).getHours().toString().padStart(2, "0");
    hourly[hour] = (hourly[hour] ?? 0) + 1;
    const category = categorizeCommit(c.subject);
    if (category) metrics[category] += 1;
  }

  const peakEntry = Object.entries(hourly).sort((a, b) => b[1] - a[1])[0];
  const peakHour = peakEntry ? Number(peakEntry[0]) : null;

  const filesRaw = await sh("git", [
    "log",
    `origin/${baseBranch}`,
    `--since=${sinceIso}`,
    "--format=",
    "--name-only",
  ]);
  const fileCounts = new Map<string, number>();
  for (const line of filesRaw.split("\n")) {
    const f = line.trim();
    if (!f) continue;
    fileCounts.set(f, (fileCounts.get(f) ?? 0) + 1);
  }
  const hotspots = Array.from(fileCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([file, changes]) => ({ file, changes }));

  let testLoc = 0;
  for (const c of commits) {
    if (/\b(test|spec)\b/i.test(c.subject)) testLoc += c.insertions;
  }

  return {
    window: input.window,
    startDate,
    endDate,
    baseBranch,
    currentUser,
    commits,
    totals: {
      commits: commits.length,
      contributors: Object.keys(authors).length,
      insertions: commits.reduce((sum, c) => sum + c.insertions, 0),
      deletions: commits.reduce((sum, c) => sum + c.deletions, 0),
      testLoc,
    },
    metrics,
    authors,
    hotspots,
    peakHour,
    hourlyHistogram: hourly,
  };
}

const { Workflow, Task, smithers, outputs } = createSmithers(
  {
    input: inputSchema,
    preamble: preambleContextSchema,
    gather: gatherOutputSchema,
    narrative: narrativeOutputSchema,
  },
  {
    readableName: "Retro",
    description: "Weekly engineering retrospective — git-data gather + narrative.",
    dbPath: "./executions/retro.db",
  },
);

export default smithers((ctx) => (
  <Workflow name="retro">
    <Task id="preamble" output={outputs.preamble} timeoutMs={15_000}>
      {async () =>
        gatherPreambleContext({ skillName: "retro", tier: 2, runId: ctx.runId })
      }
    </Task>

    <Task id="gather" output={outputs.gather} timeoutMs={60_000}>
      {async () => {
        const baseBranch = await detectBaseBranch();
        return gatherRetroData(ctx.input, baseBranch);
      }}
    </Task>

    <Task
      id="narrative"
      output={outputs.narrative}
      needs={{ preamble: "preamble", data: "gather" }}
      deps={{ preamble: preambleContextSchema, data: gatherOutputSchema }}
      agent={agents.smart}
      timeoutMs={600_000}
    >
      {(deps) => (
        <>
          <PreamblePrompt {...deps.preamble} />
          <RetroNarrativePrompt data={deps.data} />
        </>
      )}
    </Task>
  </Workflow>
));
