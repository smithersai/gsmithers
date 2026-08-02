// Shared agent providers for every gstack workflow.
//
// smthrs ships two copies of its `AgentLike` type under the
// same flat node_modules layout (root package + @smthrs/*
// sub-packages). TypeScript sees them as distinct nominal types, so the
// concrete agent classes from the root package don't unify with the AgentLike
// the scheduler expects. We cast at this boundary so downstream workflows
// stay clean — the runtime shape is identical.
import {
  AmpAgent,
  ClaudeCodeAgent,
  CodexAgent,
  GeminiAgent,
  KimiAgent,
  PiAgent,
  type AgentLike,
} from "smthrs";

const rawProviders = {
  claude: new ClaudeCodeAgent({ model: "claude-opus-4-6" }),
  codex: new CodexAgent({ model: "gpt-5.3-codex", skipGitRepoCheck: true }),
  gemini: new GeminiAgent({ model: "gemini-3.1-pro-preview" }),
  pi: new PiAgent({ provider: "openai", model: "gpt-5.3-codex" }),
  kimi: new KimiAgent({ model: "kimi-latest" }),
  amp: new AmpAgent(),
  claudeSonnet: new ClaudeCodeAgent({ model: "claude-sonnet-4-6" }),
};

export const providers = rawProviders as unknown as {
  [K in keyof typeof rawProviders]: AgentLike;
};

export const agents = {
  cheapFast: [providers.claudeSonnet],
  smart: [providers.codex, providers.claude],
  smartTool: [providers.claude, providers.codex],
} satisfies Record<string, AgentLike[]>;
