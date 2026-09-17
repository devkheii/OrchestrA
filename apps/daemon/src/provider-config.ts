import { PolicyViolation } from "@dem/protocol";
import type { Provider } from "@dem/protocol";
import {
  AnthropicProvider,
  ClaudeCliProvider,
  FakeProvider,
  OpenAICompatibleProvider,
} from "@dem/adapters";

/**
 * Choosing the provider a daemon runs with.
 *
 * Local-first is a default that has to be enforced somewhere concrete, or it
 * stays a slogan. Here it means: pointing the harness at a non-loopback
 * endpoint is refused unless the user said so in as many words. Getting a
 * clear error is better than discovering later that a workspace has been
 * going to a third party since the day someone set an environment variable.
 */

export interface ProviderSelection {
  provider: Provider;
  local: boolean;
  /** Shown in the CLI header so the privacy posture is never a guess. */
  label: string;
}

export interface ProviderEnv {
  DEM_BASE_URL?: string | undefined;
  DEM_MODEL?: string | undefined;
  DEM_API_KEY?: string | undefined;
  /** "claude-cli", "anthropic", or unset for an OpenAI-compatible endpoint. */
  DEM_PROVIDER?: string | undefined;
  /** Read when DEM_API_KEY is unset, matching the SDK convention. */
  ANTHROPIC_API_KEY?: string | undefined;
  /** Must be "1" to permit anything that sends context off this machine. */
  DEM_ALLOW_REMOTE?: string | undefined;
}

/**
 * Choose a provider from resolved settings rather than raw environment.
 *
 * `resolveProvider` below still takes the environment directly, because a
 * daemon started without a workspace has nothing else to read. This is the
 * form the CLI uses once it has loaded config files (SPEC §33), so a user can
 * write the model down once instead of re-typing five variables.
 */
export function providerFromSettings(settings: {
  provider?: string | undefined;
  model?: string | undefined;
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
  allowRemote: boolean;
}): ProviderSelection {
  return resolveProvider({
    ...(settings.provider ? { DEM_PROVIDER: settings.provider } : {}),
    ...(settings.model ? { DEM_MODEL: settings.model } : {}),
    ...(settings.baseUrl ? { DEM_BASE_URL: settings.baseUrl } : {}),
    ...(settings.apiKey ? { DEM_API_KEY: settings.apiKey } : {}),
    ...(settings.allowRemote ? { DEM_ALLOW_REMOTE: "1" } : {}),
  });
}

export function resolveProvider(env: ProviderEnv): ProviderSelection {
  if (env.DEM_PROVIDER === "anthropic") {
    const key = env.DEM_API_KEY ?? env.ANTHROPIC_API_KEY;
    if (!key) {
      throw new PolicyViolation(
        "DEM_PROVIDER=anthropic needs an API key in DEM_API_KEY or ANTHROPIC_API_KEY. " +
          "Unlike the Claude CLI, which draws on a subscription's rate-limit window, " +
          "this provider bills per request.",
        1,
      );
    }
    return gate(
      new AnthropicProvider({ apiKey: key, ...(env.DEM_MODEL ? { model: env.DEM_MODEL } : {}) }),
      env,
      "the Anthropic API is not on this machine, and bills per request",
    );
  }

  if (env.DEM_PROVIDER === "claude-cli") {
    return gate(
      new ClaudeCliProvider(env.DEM_MODEL ? { model: env.DEM_MODEL } : {}),
      env,
      "the Claude Code CLI relays every prompt to Anthropic",
    );
  }

  if (!env.DEM_BASE_URL) {
    return { provider: new FakeProvider(), local: true, label: "fake (no provider configured)" };
  }

  return gate(
    new OpenAICompatibleProvider({
      baseUrl: env.DEM_BASE_URL,
      model: env.DEM_MODEL ?? "default",
      ...(env.DEM_API_KEY ? { apiKey: env.DEM_API_KEY } : {}),
    }),
    env,
    `${env.DEM_BASE_URL} is not loopback`,
  );
}

/**
 * One gate for every provider, asking the provider itself whether the data
 * leaves the machine.
 *
 * The Claude CLI is why this is a shared gate rather than a URL check: it is a
 * local binary, so a URL-shaped test would wave it through while it forwards
 * the entire context to a third party. Egress follows the data, not the
 * executable.
 */
function gate(
  provider: Provider & { isLocal(): boolean },
  env: ProviderEnv,
  why: string,
): ProviderSelection {
  const local = provider.isLocal();

  if (!local && env.DEM_ALLOW_REMOTE !== "1") {
    throw new PolicyViolation(
      `${why}. Everything this harness sends would leave the machine. ` +
        `Set DEM_ALLOW_REMOTE=1 to accept that.`,
      1,
    );
  }

  return {
    provider,
    local,
    label: local ? `${provider.id} (local)` : `${provider.id} (REMOTE)`,
  };
}
