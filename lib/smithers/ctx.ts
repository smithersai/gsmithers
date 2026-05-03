// Typed helpers around SmithersCtx.output / outputMaybe.
//
// Smithers ships its zod typedefs under two paths in node_modules (the public
// facade and the inner components package), so TypeScript sees the schema we
// pass to `ctx.output` as a different type from what the typed overloads
// expect. The schema at runtime is fine — this helper keeps the call sites
// clean and types correct without scattering `as z.infer<...>` casts.
import type { z } from "zod";

type OutputReadableCtx = {
  output: (schema: any, key: { nodeId: string }) => unknown;
  outputMaybe: (schema: any, key: { nodeId: string }) => unknown;
  latest: (schema: any, nodeId: string) => unknown;
};

/** Read a completed task's typed output. Throws if the output isn't present. */
export function readOutput<T extends z.ZodTypeAny>(
  ctx: OutputReadableCtx,
  schema: T,
  nodeId: string,
): z.infer<T> {
  return (ctx.output as (s: T, k: { nodeId: string }) => unknown)(schema, {
    nodeId,
  }) as z.infer<T>;
}

/** Read a completed task's typed output, or undefined if missing / failed. */
export function readOutputMaybe<T extends z.ZodTypeAny>(
  ctx: OutputReadableCtx,
  schema: T,
  nodeId: string,
): z.infer<T> | undefined {
  return (ctx.outputMaybe as (s: T, k: { nodeId: string }) => unknown)(schema, {
    nodeId,
  }) as z.infer<T> | undefined;
}

/** Read a loop task's most recent iteration output. */
export function readLatest<T extends z.ZodTypeAny>(
  ctx: OutputReadableCtx,
  schema: T,
  nodeId: string,
): z.infer<T> | undefined {
  return (ctx.latest as (s: T, n: string) => unknown)(schema, nodeId) as
    | z.infer<T>
    | undefined;
}
