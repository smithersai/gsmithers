// Ported from https://github.com/garrytan/gstack/blob/main/benchmark/SKILL.md.tmpl
// See workflows/README.md for the full port changelog.
/** @jsxImportSource smthrs */
import { createSmithers } from "smthrs";
import { z } from "zod/v4";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { agents } from "../agents";
import PreamblePrompt from "../prompts/preamble.mdx";
import BenchmarkInterpretPrompt from "../prompts/benchmark-interpret.mdx";
import {
  gatherPreambleContext,
  preambleContextSchema,
} from "../lib/smithers/preamble";

const inputSchema = z.object({
  /**
   * Shell command that runs the benchmark and emits JSON on stdout:
   *   { "metrics": [{ "name": "load_ms", "value": 123 }, ...] }
   *
   * **TRUST BOUNDARY:** this is an explicit "run arbitrary shell command"
   * contract — the value flows directly into `spawn("sh", ["-c", cmd])`.
   * Callers must treat `benchCommand` as trusted operator input. Do NOT
   * wire untrusted values (HTTP params, LLM output, etc.) into this field.
   */
  benchCommand: z
    .string()
    .describe(
      "Trusted operator shell command. Runs via sh -c; do not pass untrusted input.",
    ),
  mode: z.enum(["baseline", "compare"]).default("compare"),
});

const metricSchema = z.object({
  name: z.string(),
  value: z.number(),
  unit: z.string().nullable().default(null),
});

const measurementShape = {
  capturedAt: z.string(),
  metrics: z.array(metricSchema),
} as const;
// Clone per key — smithers resolves output targets by object identity, so
// baseline and current measurements need distinct schema instances to persist
// separately.
const baselineMeasurementSchema = z.object(measurementShape);
const currentMeasurementSchema = z.object(measurementShape);
type Measurement = z.infer<typeof baselineMeasurementSchema>;

const deltaSchema = z.object({
  metric: z.string(),
  baselineValue: z.number(),
  currentValue: z.number(),
  delta: z.number(),
  deltaPct: z.number(),
});

const verdictSchema = z.object({
  verdict: z.enum(["regression", "improvement", "noop"]),
  headline: z.string(),
  details: z.array(
    z.object({
      metric: z.string(),
      status: z.enum(["better", "worse", "same"]),
      note: z.string(),
    }),
  ),
  recommendedAction: z.string(),
});

function runBench(cmd: string): Promise<Measurement> {
  return new Promise((resolve, reject) => {
    const proc = spawn("sh", ["-c", cmd], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    proc.stdout.on("data", (c) => (out += c.toString()));
    proc.stderr.on("data", (c) => (err += c.toString()));
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`bench command failed: ${err}`));
      try {
        const parsed = JSON.parse(out) as {
          metrics: z.infer<typeof metricSchema>[];
        };
        resolve({
          capturedAt: new Date().toISOString(),
          metrics: parsed.metrics,
        });
      } catch {
        reject(new Error(`bench output not JSON: ${out.slice(0, 200)}`));
      }
    });
  });
}

function computeDeltas(
  baseline: Measurement,
  current: Measurement,
): z.infer<typeof deltaSchema>[] {
  const baselineMap = new Map(baseline.metrics.map((m) => [m.name, m.value]));
  return current.metrics.map((cur) => {
    const baseVal = baselineMap.get(cur.name) ?? 0;
    const delta = cur.value - baseVal;
    const deltaPct = baseVal === 0 ? 0 : (delta / baseVal) * 100;
    return {
      metric: cur.name,
      baselineValue: baseVal,
      currentValue: cur.value,
      delta,
      deltaPct,
    };
  });
}

const { Workflow, Task, smithers, outputs } = createSmithers(
  {
    input: inputSchema,
    preamble: preambleContextSchema,
    baseline: baselineMeasurementSchema,
    current: currentMeasurementSchema,
    verdict: verdictSchema,
  },
  {
    readableName: "Benchmark",
    description: "Run a benchmark twice and flag regressions or improvements.",
    dbPath: "./executions/benchmark.db",
  },
);

export default smithers((ctx) => (
  <Workflow name="benchmark">
    <Task id="preamble" output={outputs.preamble} timeoutMs={15_000}>
      {async () =>
        gatherPreambleContext({
          skillName: "benchmark",
          tier: 1,
          runId: ctx.runId,
        })
      }
    </Task>

    <Task id="baseline" output={outputs.baseline} timeoutMs={600_000}>
      {async () => {
        const cachePath = path.join(
          process.cwd(),
          ".gstack",
          "benchmark",
          "baseline.json",
        );
        if (ctx.input.mode === "baseline") {
          await mkdir(path.dirname(cachePath), { recursive: true });
          const fresh = await runBench(ctx.input.benchCommand);
          await writeFile(cachePath, JSON.stringify(fresh, null, 2));
          return fresh;
        }
        try {
          const text = await readFile(cachePath, "utf-8");
          return baselineMeasurementSchema.parse(JSON.parse(text));
        } catch {
          await mkdir(path.dirname(cachePath), { recursive: true });
          const fresh = await runBench(ctx.input.benchCommand);
          await writeFile(cachePath, JSON.stringify(fresh, null, 2));
          return fresh;
        }
      }}
    </Task>

    <Task id="current" output={outputs.current} timeoutMs={600_000}>
      {async () => runBench(ctx.input.benchCommand)}
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
        baseline: baselineMeasurementSchema,
        current: currentMeasurementSchema,
      }}
      agent={agents.cheapFast}
      timeoutMs={120_000}
    >
      {(deps) => (
        <>
          <PreamblePrompt {...deps.preamble} />
          <BenchmarkInterpretPrompt
            baseline={deps.baseline}
            current={deps.current}
            deltas={computeDeltas(deps.baseline, deps.current)}
          />
        </>
      )}
    </Task>
  </Workflow>
));
