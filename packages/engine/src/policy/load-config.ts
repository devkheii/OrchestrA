import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PolicyViolation } from "@dem/protocol";
import type { ConfigScope, PermissionMode, ScopedConfig, SecurityConfig } from "@dem/protocol";
import { composeSecurity, mergeSettings } from "./config.js";

/**
 * Reading configuration off disk (SPEC §33, tests SEC-013 / SEC-023).
 *
 * The precedence chain and the monotonic security composition were written and
 * tested as pure functions long before anything called them with a file — so
 * the whole design was unreachable and every setting had to be an environment
 * variable. This is the layer that makes it usable.
 *
 * Two failures matter more than the rest here:
 *
 * A config that does not apply but looks like it did. A malformed file is
 * refused rather than skipped, because a user who believes their `maxMode` is
 * in force when it silently is not has been given the opposite of what the
 * setting was for.
 *
 * A credential written into a file. Config files get committed; a key here is
 * a key in that repository's history. Invariant 6 keeps secrets out of
 * ordinary config, so this layer refuses a literal and asks for a reference.
 */

export interface Settings {
  provider?: string;
  model?: string;
  baseUrl?: string;
  /** A reference — `env://NAME` or `secret://...` — never a literal. */
  apiKey?: string;
  agent?: string;
  allowRemote: boolean;
  security: SecurityConfig;
}

export interface LoadOptions {
  workspace: string;
  /** Home directory holding the user-level config. Injected so tests can move it. */
  home: string;
  env: Record<string, string | undefined>;
  /** Explicit flags, highest authority. */
  cli: Record<string, unknown>;
}

const CONFIG_PATH = join(".dem", "config.json");

/** Fields that carry a credential and must hold a reference, never a value. */
const SECRET_FIELDS = ["apiKey"] as const;

/**
 * Shapes that look like a real credential rather than a reference. Matched
 * loosely on purpose: the cost of a false positive is a clear error message,
 * and the cost of a false negative is a key in a git history.
 */
const LOOKS_LIKE_A_SECRET = /^(sk-|pk-|ghp_|gho_|github_pat_|xox[abp]-|AIza|AKIA)/i;

export async function loadScopes(options: LoadOptions): Promise<ScopedConfig[]> {
  const user = await readConfigFile(join(options.home, CONFIG_PATH));
  const workspace = await readConfigFile(join(options.workspace, CONFIG_PATH));

  // Ordered as SPEC §33 lists them, highest authority first. The merge
  // functions sort by authority themselves, so this order is documentation
  // rather than mechanism.
  return [
    scopeFrom("cli", options.cli),
    scopeFrom("environment", fromEnv(options.env)),
    scopeFrom("workspace", workspace),
    scopeFrom("user", user),
    { scope: "defaults", settings: { allowRemote: false }, security: DEFAULT_SECURITY },
  ];
}

export async function resolveSettings(options: LoadOptions): Promise<Settings> {
  const scopes = await loadScopes(options);
  const merged = mergeSettings(scopes);
  const security = composeSecurity(scopes);

  const settings: Settings = {
    allowRemote: merged["allowRemote"] === true,
    security,
  };

  for (const key of ["provider", "model", "baseUrl", "apiKey", "agent"] as const) {
    const value = merged[key];
    if (typeof value === "string") settings[key] = value;
  }

  return settings;
}

const DEFAULT_SECURITY: Partial<SecurityConfig> = {
  denyCommands: [],
  // Local-first by default (invariant 1): egress is off until something says on.
  remoteEgress: false,
  // v0.1 ships no sandbox adapter, so ASK is the ceiling anyway (SPEC §19.1).
  maxMode: "ASK" as PermissionMode,
};

function scopeFrom(scope: ConfigScope, raw: Record<string, unknown>): ScopedConfig {
  const { security, ...settings } = raw;
  const out: ScopedConfig = { scope, settings };
  if (security && typeof security === "object") {
    out.security = security as Partial<SecurityConfig>;
  }
  return out;
}

async function readConfigFile(path: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    // Absent is no opinion. Anything else is a real failure worth surfacing:
    // a permission error on a config file is not the same as not having one.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`could not read ${path}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`could not parse ${path}: ${(err as Error).message}`);
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`could not use ${path}: expected a JSON object`);
  }

  const config = parsed as Record<string, unknown>;
  assertNoLiteralSecrets(config, path);
  return config;
}

function assertNoLiteralSecrets(config: Record<string, unknown>, path: string): void {
  for (const field of SECRET_FIELDS) {
    const value = config[field];
    if (typeof value !== "string" || !value) continue;
    if (value.startsWith("env://") || value.startsWith("secret://")) continue;

    if (LOOKS_LIKE_A_SECRET.test(value)) {
      throw new PolicyViolation(
        `${path} sets ${field} to what looks like a credential. Config files get committed, ` +
          `so this would put the key in the repository's history. Write a reference instead: ` +
          `"${field}": "env://ANTHROPIC_API_KEY".`,
        6,
      );
    }
  }
}

/** Environment variables, mapped onto the same shape a config file uses. */
function fromEnv(env: Record<string, string | undefined>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const put = (key: string, value: string | undefined) => {
    if (value !== undefined && value !== "") out[key] = value;
  };

  put("provider", env["DEM_PROVIDER"]);
  put("model", env["DEM_MODEL"]);
  put("baseUrl", env["DEM_BASE_URL"]);
  put("agent", env["DEM_AGENT"]);
  // A key in the environment is not committed, so it may be a literal here.
  put("apiKey", env["DEM_API_KEY"] ?? env["ANTHROPIC_API_KEY"]);
  if (env["DEM_ALLOW_REMOTE"] === "1") out["allowRemote"] = true;

  return out;
}
