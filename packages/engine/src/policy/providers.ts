import { homedir } from "node:os";
import { createSecretBroker, isSecretRef } from "../secrets/broker.js";
import type { Settings } from "./load-config.js";
import { runtimeById, type RuntimeId, type StartOptions } from "./runtime.js";

/**
 * Named providers (SPEC §33.2).
 *
 * `dem auth add` stores a key and nothing else, which is right — it is the
 * secret store. On its own it is half a configuration: a credential with no
 * endpoint cannot be used, and settings held one `baseUrl` and one `model`, so
 * a second endpoint had nowhere to go at all.
 *
 * For this project that is not an edge case. A council is several models from
 * several places by definition, so the configuration has to express more than
 * one provider or the central feature cannot be configured.
 *
 * The split is deliberate. Endpoints, model names and which credential to use
 * are not secret and belong in a file that can be committed and reviewed. The
 * credential itself is not in that file, only its name.
 */

export interface ProviderConfig {
  /**
   * Who serves this model (SPEC 33.5).
   *
   * Absent in configurations written before runtimes existed, which still
   * work: an endpoint with no runtime is an OpenAI-compatible one, which is
   * what they all were.
   */
  runtime?: RuntimeId | undefined;
  /** Start options, for a runtime the harness serves itself. */
  options?: StartOptions | undefined;
  /** A built-in kind: `anthropic`, `claude-cli`. Absent means OpenAI-compatible. */
  kind?: string | undefined;
  baseUrl?: string | undefined;
  model?: string | undefined;
  /** A reference — `secret://name` or `env://NAME` — never a literal. */
  apiKey?: string | undefined;
  /**
   * Weights the harness serves at this endpoint.
   *
   * Paired with the endpoint, not global. At the top level it applied to
   * whichever provider happened to be selected, so choosing a remote one
   * loaded 5.8GB of local weights first, waited for them, and then talked to
   * the remote endpoint anyway.
   */
  modelPath?: string | undefined;
}

export interface ChosenProvider {
  /** Which entry this came from, for the error messages and the header. */
  name: string;
  kind?: string | undefined;
  baseUrl?: string | undefined;
  model?: string | undefined;
  /** Resolved value, not the reference. Never written back into settings. */
  apiKey?: string | undefined;
  /** Set only when this endpoint's weights are ours to serve. */
  modelPath?: string | undefined;
  runtime?: RuntimeId | undefined;
  options?: StartOptions | undefined;
}

/**
 * Built-in kinds, which are not configured entries and cannot be shadowed.
 *
 * `fake` is here so that asking for the deterministic test provider is an
 * explicit act. It used to be what a user got for configuring nothing, which
 * meant a first run answered by echoing the question back and nothing said so.
 */
const BUILT_IN = new Set(["anthropic", "claude-cli", "fake"]);

/**
 * The provider to run with, and its credential resolved.
 *
 * @param requested a configured name, a built-in kind, or nothing.
 */
export async function effectiveProvider(
  settings: Settings,
  requested?: string | undefined,
  home: string = homedir(),
): Promise<ChosenProvider> {
  const configured = settings.providers ?? {};
  const names = Object.keys(configured);
  const asked = requested ?? settings.provider;

  // A built-in kind is answered before the configured entries, so that
  // `--provider anthropic` keeps working for someone who has configured
  // nothing, and so a configured entry cannot quietly take over a kind's name.
  if (asked && BUILT_IN.has(asked)) {
    // A built-in kind brings its own transport, so a `baseUrl` left in config
    // for the OpenAI-compatible path must not follow it. It did, and a
    // `--provider fake` run went to a real endpoint.
    const { baseUrl: _url, modelPath: _weights, ...rest } = topLevel(settings);
    return withKey({ name: asked, ...rest, kind: asked }, home);
  }

  if (asked) {
    const entry = configured[asked];
    if (!entry) {
      throw new Error(
        names.length
          ? `no provider named "${asked}". Configured: ${names.join(", ")}.`
          : `no provider named "${asked}", and none is configured. ` +
            `Add one under "providers" in .dem/config.json.`,
      );
    }
    return withKey(withRuntime({ name: asked, ...entry }), home);
  }

  if (names.length === 1) {
    // Making someone name the single thing they configured is ceremony.
    const only = names[0]!;
    return withKey(withRuntime({ name: only, ...configured[only]! }), home);
  }

  if (names.length > 1) {
    // Choosing silently would send this workspace to an endpoint the user did
    // not select, which is the kind of thing found out months later.
    throw new Error(
      `several providers are configured and none is chosen: ${names.join(", ")}. ` +
        `Pick one with --provider <name>, or set "provider" in .dem/config.json.`,
    );
  }

  // Nothing named: the flat settings, which is what a single-endpoint setup
  // and every existing config still look like.
  return withKey({ name: "default", ...topLevel(settings) }, home);
}


/**
 * Fill in what the runtime implies.
 *
 * A runtime that knows its own endpoint should not make someone type it, and
 * one the harness serves should start with the options that were measured
 * rather than with the server's defaults.
 */
function withRuntime(chosen: ChosenProvider & ProviderConfig): ChosenProvider & ProviderConfig {
  const runtime = runtimeById(chosen.runtime);
  if (!runtime) return chosen;

  return {
    ...chosen,
    ...(chosen.baseUrl || !runtime.defaultBaseUrl ? {} : { baseUrl: runtime.defaultBaseUrl }),
    // A built-in kind and a runtime are the same statement from two eras.
    ...(runtime.id === "anthropic" || runtime.id === "claude-cli" ? { kind: runtime.id } : {}),
  };
}

function topLevel(settings: Settings): ProviderConfig {
  return {
    ...(settings.provider ? { kind: settings.provider } : {}),
    ...(settings.baseUrl ? { baseUrl: settings.baseUrl } : {}),
    ...(settings.model ? { model: settings.model } : {}),
    ...(settings.apiKey ? { apiKey: settings.apiKey } : {}),
    ...(settings.modelPath ? { modelPath: settings.modelPath } : {}),
  };
}

async function withKey(
  chosen: ChosenProvider & ProviderConfig,
  home: string,
): Promise<ChosenProvider> {
  if (!chosen.apiKey) return chosen;

  // A literal survives here only from the environment, where it was never
  // written to a file. The config loader refuses one on the way in.
  if (!isSecretRef(chosen.apiKey)) return chosen;

  const broker = createSecretBroker(process.env, home);
  try {
    return { ...chosen, apiKey: await broker.resolve(chosen.apiKey) };
  } catch (err) {
    throw new Error(`provider "${chosen.name}": ${(err as Error).message}`);
  }
}
