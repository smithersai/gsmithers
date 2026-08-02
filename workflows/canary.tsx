// Ported from https://github.com/garrytan/gstack/blob/main/canary/SKILL.md.tmpl
// See workflows/README.md for the full port changelog.
/** @jsxImportSource smthrs */
import { createSmithers } from "smthrs";
import { z } from "zod/v4";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { agents } from "../agents";
import PreamblePrompt from "../prompts/preamble.mdx";
import CanaryReportPrompt from "../prompts/canary-report.mdx";
import {
  gatherPreambleContext,
  preambleContextSchema,
} from "../lib/smithers/preamble";
import { readLatest } from "../lib/smithers/ctx";
import { sh } from "../lib/smithers/shell";

const inputSchema = z
  .object({
    baseUrl: z
      .string()
      .url()
      .refine((u) => u.startsWith("http://") || u.startsWith("https://"), {
        message: "baseUrl must be http:// or https://",
      }),
    /**
     * Paths under baseUrl to monitor. Rejected unless every entry starts with
     * a single `/` (to block absolute URLs and protocol-relative `//host`
     * values that would let a page escape the target origin via
     * `new URL(page, baseUrl)`).
     */
    pages: z
      .array(z.string().regex(/^\/(?!\/)/, "page must start with a single '/'"))
      .default(["/"]),
    maxIterations: z.number().default(6),
    intervalSeconds: z.number().default(60),
    mode: z.enum(["baseline", "monitor"]).default("monitor"),
  });

const pageSnapshotSchema = z.object({
  path: z.string(),
  statusCode: z.number().nullable(),
  loadMs: z.number().nullable(),
  hash: z.string().nullable(),
});

const snapshotShape = {
  capturedAt: z.string(),
  baseUrl: z.string(),
  pages: z.array(pageSnapshotSchema),
} as const;
// Clone per key — smithers resolves output targets by object identity, so the
// baseline and current snapshots must be distinct schema instances to land in
// distinct tables.
const baselineSnapshotSchema = z.object(snapshotShape);
const currentSnapshotSchema = z.object(snapshotShape);
type Snapshot = z.infer<typeof baselineSnapshotSchema>;

const comparisonSchema = z.object({
  path: z.string(),
  statusChanged: z.boolean(),
  loadMsDelta: z.number().nullable(),
  loadMsDeltaPct: z.number().nullable(),
  hashChanged: z.boolean(),
});

const canaryVerdictSchema = z.object({
  status: z.enum(["healthy", "degraded", "broken"]),
  summary: z.string(),
  regressions: z.array(z.string()).default([]),
  shouldContinueMonitoring: z.boolean(),
  rollbackRecommended: z.boolean(),
});

async function captureSnapshot(
  baseUrl: string,
  pages: string[],
): Promise<Snapshot> {
  const snapshots: z.infer<typeof pageSnapshotSchema>[] = [];
  const base = new URL(baseUrl);
  for (const p of pages) {
    // Origin check is the security boundary — the schema regex blocks
    // `//host` at input time, but WHATWG URL parsing treats backslashes as
    // slashes on http(s), so `/\evil.com/path` resolves to evil.com. Rejecting
    // any page that resolves off-origin closes both classes of bypass.
    const resolved = new URL(p, base);
    if (resolved.origin !== base.origin) {
      throw new Error(
        `canary page escapes baseUrl origin: ${JSON.stringify(p)} → ${resolved.origin}`,
      );
    }
    const url = resolved.toString();
    const start = Date.now();
    // Status probe — curl with argv, no shell interpolation.
    const curlOut = await sh(
      "curl",
      ["-s", "-o", "/dev/null", "-w", "%{http_code}", "-m", "30", url],
      { tolerateFailure: true },
    );
    const status = Number(curlOut.trim()) || null;
    const loadMs = Date.now() - start;
    // Body hash — fetch with argv, hash in JS. An earlier revision piped
    // through `sh -c "curl '${url}' | shasum"` which was shell-injectable
    // via a page path containing a single quote (e.g. `/a';id;#`).
    const body = await sh("curl", ["-s", "-m", "30", url], {
      tolerateFailure: true,
    });
    const bodyHash =
      body.length > 0 ? createHash("sha1").update(body).digest("hex") : null;
    snapshots.push({
      path: p,
      statusCode: status,
      loadMs,
      hash: bodyHash,
    });
  }
  return {
    capturedAt: new Date().toISOString(),
    baseUrl,
    pages: snapshots,
  };
}

function compareSnapshots(
  baseline: Snapshot,
  current: Snapshot,
): z.infer<typeof comparisonSchema>[] {
  const baselineByPath = new Map(baseline.pages.map((p) => [p.path, p]));
  return current.pages.map((cur) => {
    const base = baselineByPath.get(cur.path);
    const loadDelta =
      base?.loadMs != null && cur.loadMs != null ? cur.loadMs - base.loadMs : null;
    const loadDeltaPct =
      base?.loadMs && cur.loadMs ? ((cur.loadMs - base.loadMs) / base.loadMs) * 100 : null;
    return {
      path: cur.path,
      statusChanged: base?.statusCode !== cur.statusCode,
      loadMsDelta: loadDelta,
      loadMsDeltaPct: loadDeltaPct,
      hashChanged: base?.hash !== cur.hash,
    };
  });
}

const { Workflow, Task, Loop, smithers, outputs } = createSmithers(
  {
    input: inputSchema,
    preamble: preambleContextSchema,
    baseline: baselineSnapshotSchema,
    current: currentSnapshotSchema,
    verdict: canaryVerdictSchema,
  },
  {
    readableName: "Canary",
    description: "Post-deploy health monitoring loop.",
    dbPath: "./executions/canary.db",
  },
);

export default smithers((ctx) => {
  const iteration = ctx.iterationCount(canaryVerdictSchema, "verdict");
  const latestVerdict = readLatest(ctx, canaryVerdictSchema, "verdict");
  // Baseline mode is capture-and-exit: the baseline Task writes
  // .gstack/canary/baseline.json and the monitoring Loop is skipped. This
  // matches the upstream `/canary --baseline` contract (capture before
  // deploy; re-run without --baseline after deploy to monitor against it).
  const isBaselineMode = ctx.input.mode === "baseline";
  const loopDone =
    isBaselineMode ||
    latestVerdict?.status === "broken" ||
    latestVerdict?.shouldContinueMonitoring === false ||
    (latestVerdict?.status === "healthy" && iteration >= ctx.input.maxIterations);

  return (
    <Workflow name="canary">
      <Task id="preamble" output={outputs.preamble} timeoutMs={15_000}>
        {async () =>
          gatherPreambleContext({
            skillName: "canary",
            tier: 2,
            runId: ctx.runId,
          })
        }
      </Task>

      <Task id="baseline" output={outputs.baseline} timeoutMs={300_000}>
        {async () => {
          const root = process.cwd();
          const baselinePath = path.join(root, ".gstack", "canary", "baseline.json");
          // Baseline mode: always overwrite. Monitor mode: load existing,
          // or capture+persist if absent so the second `/canary` run has
          // something to compare against.
          if (ctx.input.mode === "baseline") {
            const snap = await captureSnapshot(ctx.input.baseUrl, ctx.input.pages);
            await mkdir(path.dirname(baselinePath), { recursive: true });
            await writeFile(baselinePath, JSON.stringify(snap, null, 2));
            return snap;
          }
          try {
            const text = await readFile(baselinePath, "utf-8");
            return baselineSnapshotSchema.parse(JSON.parse(text));
          } catch {
            await mkdir(path.dirname(baselinePath), { recursive: true });
            const snap = await captureSnapshot(ctx.input.baseUrl, ctx.input.pages);
            await writeFile(baselinePath, JSON.stringify(snap, null, 2));
            return snap;
          }
        }}
      </Task>

      <Loop until={loopDone} maxIterations={ctx.input.maxIterations}>
        <Task
          id="current"
          output={outputs.current}
          timeoutMs={ctx.input.intervalSeconds * 1000 + 300_000}
        >
          {async () => {
            // Pace monitoring iterations. First iteration fires immediately
            // (no prior verdict); subsequent iterations wait so we're
            // sampling the live app at `intervalSeconds` cadence instead of
            // back-to-back curl bursts.
            if (iteration > 0 && ctx.input.intervalSeconds > 0) {
              await new Promise((resolve) =>
                setTimeout(resolve, ctx.input.intervalSeconds * 1000),
              );
            }
            return captureSnapshot(ctx.input.baseUrl, ctx.input.pages);
          }}
        </Task>

        <Task
          id="verdict"
          output={outputs.verdict}
          needs={{
            preamble: "preamble",
            baseline: "baseline",
            current: "current",
          }}
          deps={{
            preamble: preambleContextSchema,
            baseline: baselineSnapshotSchema,
            current: currentSnapshotSchema,
          }}
          agent={agents.cheapFast}
          timeoutMs={120_000}
        >
          {(deps) => (
            <>
              <PreamblePrompt {...deps.preamble} />
              <CanaryReportPrompt
                baseline={deps.baseline}
                current={deps.current}
                comparisons={compareSnapshots(deps.baseline, deps.current)}
                iteration={iteration + 1}
                maxIterations={ctx.input.maxIterations}
              />
            </>
          )}
        </Task>
      </Loop>
    </Workflow>
  );
});
