/**
 * Provider and tool adapters. Adapters own vendor-specific detail so Core
 * never learns a model name (SPEC section 29).
 */
export { FakeProvider } from "./fake-provider.js";
export type { FakeTurn } from "./fake-provider.js";
export { OpenAICompatibleProvider } from "./openai-compatible.js";
export type { OpenAICompatibleConfig } from "./openai-compatible.js";
export { ClaudeCliProvider } from "./claude-cli.js";
export type { ClaudeCliConfig } from "./claude-cli.js";
export { ClaudeCodeAgent } from "./claude-code-agent.js";
export type { ClaudeCodeAgentConfig } from "./claude-code-agent.js";
export { CodexAgent } from "./codex-agent.js";
export type { CodexAgentConfig } from "./codex-agent.js";
export { AnthropicProvider } from "./anthropic.js";
export type { AnthropicConfig } from "./anthropic.js";
