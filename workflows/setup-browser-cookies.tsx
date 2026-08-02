// Ported from https://github.com/garrytan/gstack/blob/main/setup-browser-cookies/SKILL.md.tmpl
// See workflows/README.md for the full port changelog.
//
// Session cookies only exist in the live BrowserContext — closing Chromium
// drops them from disk. That forces this workflow's three logical phases
// (launch → wait-for-user → capture) into a single Task body: the Task
// opens Playwright, polls a filesystem sentinel for the user's "done"
// signal, and reads `context.storageState()` / `context.cookies()` BEFORE
// closing the context.
//
// We lose smithers' native `<WaitForEvent/>` showcase for this workflow —
// that primitive would be fine if sessions persisted on disk, but they
// don't. Trade-off recorded in workflows/README.md.
/** @jsxImportSource smthrs */
import { createSmithers } from "smthrs";
import { z } from "zod/v4";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";
import PreamblePrompt from "../prompts/preamble.mdx";
import {
  gatherPreambleContext,
  preambleContextSchema,
} from "../lib/smithers/preamble";
import { sh, shQuote } from "../lib/smithers/shell";

const inputSchema = z.object({
  /**
   * Slug for the site to capture cookies for (e.g. "gmail", "slack").
   * Restricted to [a-z0-9-]+ so the value is safe to use in filesystem
   * paths, shell commands, and signal names without escaping.
   */
  site: z
    .string()
    .regex(/^[a-z0-9-]+$/, "site must match /^[a-z0-9-]+$/"),
  /**
   * URL to open in the browser for the login flow. WHATWG URL parsing is
   * the boundary here; Playwright's goto() ultimately validates too.
   */
  loginUrl: z.string().url(),
  /** Where to save the captured cookies. */
  outputPath: z.string().nullable().default(null),
  /** Seconds to wait for the user to finish login before giving up. */
  waitTimeoutSeconds: z.number().default(600),
});

const captureResultSchema = z.object({
  outputPath: z.string(),
  cookieCount: z.number(),
  site: z.string(),
  sentinelPath: z.string(),
  doneScriptPath: z.string(),
});

const { Workflow, Task, smithers, outputs } = createSmithers(
  {
    input: inputSchema,
    preamble: preambleContextSchema,
    capture: captureResultSchema,
  },
  {
    readableName: "Setup Browser Cookies",
    description: "Open a browser for the user to log in, then capture cookies.",
    dbPath: "./executions/setup-browser-cookies.db",
  },
);

export default smithers((ctx) => (
  <Workflow name="setup-browser-cookies">
    <Task id="preamble" output={outputs.preamble} timeoutMs={15_000}>
      {async () =>
        gatherPreambleContext({
          skillName: "setup-browser-cookies",
          tier: 1,
          runId: ctx.runId,
        })
      }
    </Task>

    {/*
     * Single-Task phase: launch → wait for sentinel → capture. The
     * BrowserContext stays alive the whole time so session cookies are
     * readable at export.
     *
     * Why not WaitForEvent between two Tasks? Session cookies are
     * in-memory; closing Chromium drops them. Smithers Tasks can't share
     * a BrowserContext handle across boundaries (Tasks run in isolated
     * iterations, may resume in a different process). Polling a
     * filesystem sentinel file keeps the browser alive in the same Task.
     *
     * The generated done-script runs `touch <sentinelPath>` — no
     * smithers CLI call needed, no PATH dependency, no signal CLI
     * version mismatch risk.
     */}
    <Task
      id="capture"
      output={outputs.capture}
      dependsOn={["preamble"]}
      timeoutMs={ctx.input.waitTimeoutSeconds * 1000 + 60_000}
    >
      {async () => {
        const userDataDir = path.join(
          process.env.HOME ?? "",
          ".gstack",
          "browser-profiles",
          ctx.input.site,
        );
        await mkdir(userDataDir, { recursive: true });

        const sentinelDir = path.join(
          process.env.HOME ?? "",
          ".gstack",
          "signals",
        );
        await mkdir(sentinelDir, { recursive: true });
        const sentinelPath = path.join(
          sentinelDir,
          `cookies-done-${ctx.input.site}-${ctx.runId}`,
        );
        // Clean up any stale sentinel from a previous run so the poll
        // starts from a known state.
        await rm(sentinelPath, { force: true });

        // runId in the script name so concurrent runs for the same site
        // don't stomp each other's done-scripts.
        const doneScriptPath = path.join(
          sentinelDir,
          `signal-cookies-done-${ctx.input.site}-${ctx.runId}.sh`,
        );
        // Convenience script for the user. shQuote handles any $/backtick/
        // quote shenanigans in the sentinel path.
        await writeFile(
          doneScriptPath,
          [
            "#!/bin/sh",
            "# Run this after finishing login. It touches the sentinel the",
            `# setup-browser-cookies workflow is polling for ${ctx.input.site}.`,
            `touch ${shQuote(sentinelPath)}`,
            `echo "signaled — workflow will capture cookies now"`,
          ].join("\n") + "\n",
        );
        await sh("chmod", ["+x", doneScriptPath]);

        // Surface the command the user needs to run BEFORE we open the
        // browser and start blocking. Printed to stderr so it shows up in
        // the smithers run log without polluting the Task's structured
        // output.
        process.stderr.write(
          [
            "",
            `setup-browser-cookies: browser launching for site '${ctx.input.site}'.`,
            "When you've finished logging in, run:",
            `  bash ${doneScriptPath}`,
            `(or: touch ${sentinelPath})`,
            `Timeout: ${ctx.input.waitTimeoutSeconds}s.`,
            "",
          ].join("\n"),
        );

        const context = await chromium.launchPersistentContext(userDataDir, {
          headless: false,
          acceptDownloads: false,
          serviceWorkers: "block",
        });
        try {
          const page = context.pages()[0] ?? (await context.newPage());
          await page.goto(ctx.input.loginUrl);

          // Poll for the sentinel. 1Hz is plenty; login flows take seconds
          // to minutes. Respects the task-level timeoutMs via the loop cap.
          const deadline = Date.now() + ctx.input.waitTimeoutSeconds * 1000;
          while (Date.now() < deadline) {
            if (existsSync(sentinelPath)) break;
            await sleep(1_000);
          }
          if (!existsSync(sentinelPath)) {
            throw new Error(
              `setup-browser-cookies: timed out after ${ctx.input.waitTimeoutSeconds}s waiting for ${sentinelPath}. Run the generated script to signal completion.`,
            );
          }

          // Capture cookies from the SAME live context — session cookies
          // (no explicit expires) only exist in memory and would be lost
          // if we closed and reopened.
          const cookies = await context.cookies();
          const outputPath =
            ctx.input.outputPath ??
            path.join(
              process.env.HOME ?? "",
              ".gstack",
              "cookies",
              `${ctx.input.site}.json`,
            );
          await mkdir(path.dirname(outputPath), { recursive: true });
          await writeFile(outputPath, JSON.stringify({ cookies }, null, 2));
          await rm(sentinelPath, { force: true });

          return {
            outputPath,
            cookieCount: cookies.length,
            site: ctx.input.site,
            sentinelPath,
            doneScriptPath,
          };
        } finally {
          await context.close();
        }
      }}
    </Task>
  </Workflow>
));
