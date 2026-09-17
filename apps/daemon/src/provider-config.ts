import { PolicyViolation } from "@dem/protocol";
import type { Provider } from "@dem/protocol";
import { ClaudeCliProvider, FakeProvider, OpenAICompatibleProvider } from "@dem/adapters";

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
  /** "claude-cli" to drive the locally installed Claude Code binary. */
  DEM_PROVIDER?: string | undefined;
  /** Must be "1" to permit anything that sends context off this machine. */
  DEM_ALLOW_REMOTE?: string | undefined;
}

export function resolveProvider(env: ProviderEnv): ProviderSelection {
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
