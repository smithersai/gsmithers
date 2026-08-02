// Ported from https://github.com/garrytan/gstack/blob/main/gstack-upgrade/SKILL.md.tmpl
// See workflows/README.md for the full port changelog.
//
// This is the most deterministic workflow in the port — a multi-step setup
// script that gains smithers observability and resume-from-last-success
// without needing any agent Task for the mechanical work. Demo-value: shows
// that smithers is useful for orchestration even without LLMs in the loop.
/** @jsxImportSource smthrs */
import { createSmithers } from "smthrs";
import { z } from "zod/v4";
import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { agents } from "../agents";
import PreamblePrompt from "../prompts/preamble.mdx";
import GstackUpgradeSummaryPrompt from "../prompts/gstack-upgrade-summary.mdx";
import {
  gatherPreambleContext,
  preambleContextSchema,
} from "../lib/smithers/preamble";
import { readOutput } from "../lib/smithers/ctx";
import { sh } from "../lib/smithers/shell";

const inputSchema = z.object({
  /** Path to the gstack install — defaults to ~/.claude/skills/gstack. */
  installPath: z.string().default(
    path.join(process.env.HOME ?? "", ".claude", "skills", "gstack"),
  ),
  /** Skip the summary agent Task (e.g. in CI). */
  skipSummary: z.boolean().default(false),
});

const detectedSchema = z.object({
  installPath: z.string(),
  previousVersion: z.string(),
  isSymlinkToWorkingCopy: z.boolean(),
});

const pullResultSchema = z.object({
  pulled: z.boolean(),
  previousHead: z.string(),
  newHead: z.string(),
  commitsPulled: z.number(),
  /**
   * When the install checkout had local changes at pull time, those are
   * stashed before the hard reset. The summary surfaces this so the user
   * can `git stash pop` them back later if needed.
   */
  stashed: z.boolean(),
  stashMessage: z.string().nullable().default(null),
});

const migrationSchema = z.object({
  migrationsAvailable: z.array(z.string()),
  migrationsRun: z.array(z.string()),
  skipped: z.array(z.string()),
});

const buildResultSchema = z.object({
  built: z.boolean(),
  duration: z.number(),
  stdout: z.string(),
});

const verifyResultSchema = z.object({
  versionAfter: z.string(),
  browseBinaryOk: z.boolean(),
  designBinaryOk: z.boolean(),
});

const summarySchema = z.object({
  summary: z.string(),
  tryNext: z.array(z.string()).default([]),
});

const changelogDeltaSchema = z.object({
  delta: z.string(),
});

const { Workflow, Task, smithers, outputs } = createSmithers(
  {
    input: inputSchema,
    preamble: preambleContextSchema,
    detected: detectedSchema,
    pull: pullResultSchema,
    migrations: migrationSchema,
    build: buildResultSchema,
    verify: verifyResultSchema,
    changelogDelta: changelogDeltaSchema,
    summary: summarySchema,
  },
  {
    readableName: "gstack Upgrade",
    description: "Pull latest gstack, run migrations, rebuild binaries, verify.",
    dbPath: "./executions/gstack-upgrade.db",
  },
);

export default smithers((ctx) => (
  <Workflow name="gstack-upgrade">
    <Task id="preamble" output={outputs.preamble} timeoutMs={15_000}>
      {async () =>
        gatherPreambleContext({
          skillName: "gstack-upgrade",
          tier: 2,
          runId: ctx.runId,
        })
      }
    </Task>

    <Task id="detected" output={outputs.detected} timeoutMs={15_000}>
      {async () => {
        const inputPath = ctx.input.installPath;
        // Canonicalize via realpath. Smithers' bashTool sandboxes `cwd` by
        // checking it is *inside* the workflow root before following
        // symlinks. When the global install (`~/.claude/skills/gstack`) is
        // a symlink back to the dev checkout, the raw path would look
        // outside the root and get rejected. The real path resolves into
        // the root (or stays outside if this really is a separate checkout,
        // which we also want to record faithfully).
        let installPath = inputPath;
        let isSymlinkToWorkingCopy = false;
        try {
          const resolved = await realpath(inputPath);
          isSymlinkToWorkingCopy = resolved !== inputPath;
          installPath = resolved;
        } catch {
          // Install path doesn't exist yet — leave as the user provided it
          // so the downstream error mentions the actual requested path.
        }
        let previousVersion = "unknown";
        try {
          previousVersion = (
            await readFile(path.join(installPath, "VERSION"), "utf-8")
          ).trim();
        } catch {
          // VERSION missing — leave as unknown
        }
        return {
          installPath,
          previousVersion,
          isSymlinkToWorkingCopy,
        };
      }}
    </Task>

    <Task
      id="pull"
      output={outputs.pull}
      dependsOn={["detected"]}
      timeoutMs={120_000}
    >
      {async () => {
        const detected = readOutput(ctx, detectedSchema, "detected");
        const before = (
          await sh("git", ["rev-parse", "HEAD"], { cwd: detected.installPath })
        ).trim();

        // Stash local modifications before the hard reset so an upgrade
        // never silently destroys in-progress work in the install checkout.
        // Upstream gstack-upgrade does the same via `git stash` — the port
        // has to match that contract.
        //
        // Strictness: this whole block is fail-closed. If the stash command
        // fails, or the tree still has tracked changes afterwards, we throw
        // before touching HEAD. Localizing the irreversible `reset --hard`
        // behind that gate keeps upgrades from silently discarding work.
        const dirtyBefore = (
          await sh("git", ["status", "--porcelain"], {
            cwd: detected.installPath,
          })
        ).trim();
        let stashed = false;
        let stashMessage: string | null = null;
        if (dirtyBefore.length > 0) {
          const stashRef = `gstack-upgrade-${ctx.runId}`;
          // Strict sh() — any non-zero exit throws. No tolerateFailure here:
          // a stash that failed to save would leave the tree dirty AND a
          // `reset --hard` about to run, which is exactly the data-loss
          // window we're closing.
          await sh("git", [
            "stash",
            "push",
            "--include-untracked",
            "-m",
            stashRef,
          ], { cwd: detected.installPath });
          const dirtyAfter = (
            await sh("git", ["status", "--porcelain"], {
              cwd: detected.installPath,
            })
          ).trim();
          if (dirtyAfter.length > 0) {
            throw new Error(
              `gstack-upgrade: stash did not clear the working tree (still dirty: ${dirtyAfter.split("\n").length} entries). Refusing to reset --hard — fix the checkout manually and re-run.`,
            );
          }
          stashed = true;
          stashMessage = stashRef;
        }

        await sh("git", ["fetch", "origin", "--tags", "--prune"], {
          cwd: detected.installPath,
        });
        await sh("git", ["reset", "--hard", "origin/main"], {
          cwd: detected.installPath,
        });
        const after = (
          await sh("git", ["rev-parse", "HEAD"], { cwd: detected.installPath })
        ).trim();
        const countRaw = await sh(
          "git",
          ["rev-list", "--count", `${before}..${after}`],
          { cwd: detected.installPath, tolerateFailure: true },
        );
        return {
          pulled: before !== after,
          previousHead: before,
          newHead: after,
          commitsPulled: Number(countRaw.trim()) || 0,
          stashed,
          stashMessage,
        };
      }}
    </Task>

    <Task
      id="migrations"
      output={outputs.migrations}
      dependsOn={["detected", "pull"]}
      timeoutMs={600_000}
    >
      {async () => {
        const detected = readOutput(ctx, detectedSchema, "detected");
        const migrationsDir = path.join(
          detected.installPath,
          "gstack-upgrade",
          "migrations",
        );
        const stateFile = path.join(
          process.env.HOME ?? "",
          ".gstack",
          "migrations-applied.json",
        );

        let alreadyApplied: string[] = [];
        try {
          const state = JSON.parse(await readFile(stateFile, "utf-8")) as {
            applied?: string[];
          };
          alreadyApplied = state.applied ?? [];
        } catch {
          // first-ever run
        }

        let available: string[] = [];
        try {
          available = (await readdir(migrationsDir))
            .filter((n) => n.startsWith("v") && n.endsWith(".sh"))
            .sort();
        } catch {
          return { migrationsAvailable: [], migrationsRun: [], skipped: [] };
        }

        const toRun = available.filter((n) => !alreadyApplied.includes(n));
        const ran: string[] = [];
        for (const m of toRun) {
          await sh("bash", [path.join(migrationsDir, m)], {
            cwd: detected.installPath,
          });
          ran.push(m);
        }

        try {
          await mkdir(path.dirname(stateFile), { recursive: true });
          await writeFile(
            stateFile,
            JSON.stringify({ applied: [...alreadyApplied, ...ran] }),
          );
        } catch {
          // tolerate failure — next run re-reads state; no shell interpolation
          // risk since mkdir/writeFile use node APIs with validated paths.
        }

        return {
          migrationsAvailable: available,
          migrationsRun: ran,
          skipped: alreadyApplied,
        };
      }}
    </Task>

    <Task
      id="build"
      output={outputs.build}
      dependsOn={["detected", "migrations"]}
      timeoutMs={600_000}
    >
      {async () => {
        const detected = readOutput(ctx, detectedSchema, "detected");
        const start = Date.now();
        const stdout = await sh("bun", ["run", "build"], {
          cwd: detected.installPath,
        });
        return { built: true, duration: Date.now() - start, stdout };
      }}
    </Task>

    <Task
      id="verify"
      output={outputs.verify}
      dependsOn={["detected", "build"]}
      timeoutMs={30_000}
    >
      {async () => {
        const detected = readOutput(ctx, detectedSchema, "detected");
        const versionAfter = (
          await readFile(path.join(detected.installPath, "VERSION"), "utf-8")
            .catch(() => "")
        ).trim() || "unknown";
        const browseOk = await sh(
          path.join(detected.installPath, "browse", "dist", "browse"),
          ["--version"],
          { tolerateFailure: true },
        );
        const designOk = await sh(
          path.join(detected.installPath, "design", "dist", "design"),
          ["--version"],
          { tolerateFailure: true },
        );
        return {
          versionAfter,
          browseBinaryOk: browseOk.trim().length > 0,
          designBinaryOk: designOk.trim().length > 0,
        };
      }}
    </Task>

    <Task
      id="changelog-delta"
      output={outputs.changelogDelta}
      dependsOn={["detected", "pull"]}
      timeoutMs={15_000}
    >
      {async () => {
        const detected = readOutput(ctx, detectedSchema, "detected");
        const pull = readOutput(ctx, pullResultSchema, "pull");
        // Pull already reset HEAD to newHead, so diff against the captured
        // previousHead rather than HEAD — otherwise the delta is always empty.
        const delta = await sh(
          "git",
          [
            "log",
            `${pull.previousHead}..${pull.newHead}`,
            "--format=%s",
            "--",
            "CHANGELOG.md",
          ],
          { cwd: detected.installPath, tolerateFailure: true },
        );
        return { delta: delta.slice(0, 4_000) };
      }}
    </Task>

    <Task
      id="summary"
      output={outputs.summary}
      needs={{
        preamble: "preamble",
        detected: "detected",
        pull: "pull",
        migrations: "migrations",
        verify: "verify",
        changelogDelta: "changelog-delta",
      }}
      deps={{
        preamble: preambleContextSchema,
        detected: detectedSchema,
        pull: pullResultSchema,
        migrations: migrationSchema,
        verify: verifyResultSchema,
        changelogDelta: changelogDeltaSchema,
      }}
      agent={agents.cheapFast}
      timeoutMs={300_000}
      skipIf={ctx.input.skipSummary}
    >
      {(deps) => {
        return (
          <>
            <PreamblePrompt {...deps.preamble} />
            <GstackUpgradeSummaryPrompt
              previousVersion={deps.detected.previousVersion}
              newVersion={deps.verify.versionAfter}
              installPath={deps.detected.installPath}
              migrationsRun={deps.migrations.migrationsRun}
              changelogDelta={deps.changelogDelta.delta}
              stashed={deps.pull.stashed}
              stashMessage={deps.pull.stashMessage}
            />
          </>
        );
      }}
    </Task>
  </Workflow>
));
