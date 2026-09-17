import { PolicyViolation } from "@dem/protocol";
import type { Provider } from "@dem/protocol";
import { FakeProvider, OpenAICompatibleProvider } from "@dem/adapters";

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
  /** Must be "1" to permit a non-loopback endpoint. */
  DEM_ALLOW_REMOTE?: string | undefined;
}

export function resolveProvider(env: ProviderEnv): ProviderSelection {
  if (!env.DEM_BASE_URL) {
    return { provider: new FakeProvider(), local: true, label: "fake (no provider configured)" };
  }

  const provider = new OpenAICompatibleProvider({
    baseUrl: env.DEM_BASE_URL,
    model: env.DEM_MODEL ?? "default",
    ...(env.DEM_API_KEY ? { apiKey: env.DEM_API_KEY } : {}),
  });

  const local = provider.isLocal();
  if (!local && env.DEM_ALLOW_REMOTE !== "1") {
    throw new PolicyViolation(
      `DEM_BASE_URL points to ${env.DEM_BASE_URL}, which is not loopback. ` +
        `Everything this harness sends would leave the machine. ` +
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
