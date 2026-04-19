// Ported from https://github.com/garrytan/gstack/blob/main/open-gstack-browser/SKILL.md.tmpl
// See workflows/README.md for the full port changelog.
//
// SPECULATIVE: this workflow depends on the gui-side custom-GUI feature
// (workflows can declare their own UI surface instead of using the default
// smithers runner). The import path `smithers-orchestrator/ui` and the
// <CustomUi/> component shown below are placeholders for that upcoming API.
// When the feature lands, swap the imports and remove this note.
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import {
  gatherPreambleContext,
  preambleContextSchema,
} from "../../lib/smithers/preamble";

// Placeholder for the forthcoming gui custom-GUI component. It throws at
// render time so the workflow fails loudly instead of fabricating success —
// the real import is expected to be
// `import { CustomUi } from "smithers-orchestrator/ui"` once the feature lands.
function CustomUi(_props: {
  id: string;
  component: string;
  props: Record<string, unknown>;
}): never {
  throw new Error(
    "open-gstack-browser requires the gui custom-GUI primitive, which is not " +
      "yet shipped in smithers-orchestrator. Replace the CustomUi placeholder " +
      "with the real import once the feature lands.",
  );
}

const inputSchema = z.object({
  initialUrl: z.string().default("about:blank"),
});

const { Workflow, Task, smithers, outputs } = createSmithers(
  {
    input: inputSchema,
    preamble: preambleContextSchema,
  },
  {
    readableName: "Open gstack Browser",
    description: "Launch GStack Browser and hand the GUI to the user.",
    dbPath: "./executions/open-gstack-browser.db",
  },
);

export default smithers((ctx) => (
  <Workflow name="open-gstack-browser">
    <Task id="preamble" output={outputs.preamble} timeoutMs={15_000}>
      {async () =>
        gatherPreambleContext({
          skillName: "open-gstack-browser",
          tier: 1,
          runId: ctx.runId,
        })
      }
    </Task>

    {/*
      CustomUi hands the workflow's visible surface to the browser process.
      The placeholder throws, so the workflow fails loudly until the real
      gui-side primitive is wired in. That's intentional — we won't fabricate
      a launch/close pair that doesn't reflect what a real run would do.
     */}
    <CustomUi
      id="browser-gui"
      component="gstack-browser"
      props={{ initialUrl: ctx.input.initialUrl }}
    />
  </Workflow>
));
