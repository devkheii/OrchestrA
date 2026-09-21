import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { listCredentials, writeCredential } from "@dem/engine";
import type { Io } from "./session-ui.js";

/**
 * Managing models and providers from inside the session (SPEC §33.4).
 *
 * `dem setup` covered the first minute and then stopped mattering. Changing a
 * model, adding a second provider, or correcting a mistyped endpoint meant
 * leaving the session, editing JSON by hand, and starting again — so the
 * harness was configurable exactly once, at the moment its user knew least
 * about what they wanted.
 *
 * Everything writes to the same `.dem/config.json` that `dem setup` and a text
 * editor write. There is no session-only state to lose and no second source of
 * truth to drift, which is the same reason the CLI renders the daemon's event
 * log rather than keeping its own.
 */

export type Ask = (question: string) => Promise<string>;

export interface SessionCommandContext {
  workspace: string;
  io: Io;
  ask: Ask;
  /** Home directory holding the credential store. Injected so tests can move it. */
  home?: string;
  /** What the current endpoint reports. Injected so a test needs no server. */
  listModels?: () => Promise<string[]>;
}

export interface SessionCommandResult {
  /** Whether this was a command at all, as opposed to something to send. */
  handled: boolean;
  /** Whether configuration changed, so the caller can reload. */
  changed: boolean;
  /** Set when the session should end. */
  exit?: boolean;
}

export interface SessionCommand {
  name: string;
  summary: string;
  usage?: string;
}

/**
 * Every command, in one list.
 *
 * `/help` renders from this, so a command that exists and is undocumented is
 * not possible — the failure where a feature ships and nobody can find it.
 */
export const SESSION_COMMANDS: readonly SessionCommand[] = [
  { name: "/model", summary: "see or change which model this provider is asked for", usage: "/model [name]" },
  { name: "/provider", summary: "choose, add or remove a provider", usage: "/provider [name | add | remove <name>]" },
  { name: "/session", summary: "show the current session id" },
  { name: "/new", summary: "start a fresh session, discarding this conversation" },
  { name: "/help", summary: "this list" },
  { name: "/exit", summary: "leave" },
];

const B = "\u001b[1m";
const D = "\u001b[2m";
const R = "\u001b[0m";

export async function runSessionCommand(
  line: string,
  context: SessionCommandContext,
): Promise<SessionCommandResult> {
  const [name, ...rest] = line.trim().split(/\s+/);
  const args = rest.filter(Boolean);

  switch (name) {
    case "/help":
      showHelp(context.io);
      return { handled: true, changed: false };

    case "/exit":
    case "/quit":
      return { handled: true, changed: false, exit: true };

    case "/provider":
      return provider(args, context);

    case "/model":
      return model(args, context);

    default:
      context.io.err(`${name} is not a command. ${D}/help lists them.${R}\n`);
      return { handled: true, changed: false };
  }
}

function showHelp(io: Io): void {
  io.err("\n");
  for (const command of SESSION_COMMANDS) {
    io.err(`  ${B}${(command.usage ?? command.name).padEnd(34)}${R}${D}${command.summary}${R}\n`);
  }
  io.err("\n");
}

async function provider(
  args: readonly string[],
  context: SessionCommandContext,
): Promise<SessionCommandResult> {
  const config = await load(context.workspace);
  const providers = (config["providers"] ?? {}) as Record<string, Record<string, unknown>>;
  const names = Object.keys(providers);
  const current = typeof config["provider"] === "string" ? config["provider"] : undefined;

  if (args[0] === "add") return addProvider(config, context);

  if (args[0] === "remove" || args[0] === "rm") {
    const target = args[1];
    if (!target || !providers[target]) {
      context.io.err(
        `${D}which one? configured: ${names.join(", ") || "none"}${R}\n`,
      );
      return { handled: true, changed: false };
    }
    delete providers[target];
    // Leaving the selection pointing at something that no longer exists makes
    // the next turn fail with a message about the user's own edit.
    if (current === target) delete config["provider"];
    await save(context.workspace, config);
    context.io.err(`removed ${B}${target}${R}\n`);
    return { handled: true, changed: true };
  }

  if (args[0]) {
    const target = args[0];
    if (!providers[target]) {
      context.io.err(
        `no provider named ${B}${target}${R}. ` +
          `${D}configured: ${names.join(", ") || "none — try /provider add"}${R}\n`,
      );
      return { handled: true, changed: false };
    }
    config["provider"] = target;
    await save(context.workspace, config);
    context.io.err(`now using ${B}${target}${R}\n`);
    return { handled: true, changed: true };
  }

  // No argument: show what there is.
  if (names.length === 0) {
    const flat = config["baseUrl"];
    context.io.err(
      flat
        ? `\n  ${B}(unnamed)${R}  ${D}${flat}${R}  • current\n\n${D}/provider add gives it a name and lets you keep a second${R}\n`
        : `\n${D}no providers configured. /provider add${R}\n`,
    );
    return { handled: true, changed: false };
  }

  context.io.err("\n");
  for (const entry of names) {
    const detail = [providers[entry]?.["model"], providers[entry]?.["baseUrl"]]
      .filter(Boolean)
      .join("  ");
    const mark = entry === current ? `  ${B}• current${R}` : "";
    context.io.err(`  ${B}${entry.padEnd(16)}${R}${D}${detail}${R}${mark}\n`);
  }
  context.io.err(`\n${D}/provider <name> to switch  ·  /provider add  ·  /provider remove <name>${R}\n`);
  return { handled: true, changed: false };
}

async function addProvider(
  config: Record<string, unknown>,
  context: SessionCommandContext,
): Promise<SessionCommandResult> {
  const home = context.home ?? homedir();

  const name = (await context.ask("a name for it (e.g. openai, work-llama): ")).trim();
  if (!name) {
    context.io.err("nothing entered\n");
    return { handled: true, changed: false };
  }

  const baseUrl = (await context.ask("endpoint URL: ")).trim();
  if (!baseUrl) {
    context.io.err("an endpoint is required\n");
    return { handled: true, changed: false };
  }

  const model = (await context.ask("model name (blank to decide later): ")).trim();

  const entry: Record<string, unknown> = { baseUrl };
  if (model) entry["model"] = model;

  const existing = (await listCredentials(home)).some((c) => c.name === name);
  if (existing) {
    // Said out loud rather than overwritten. A credential that silently
    // changed is one nobody can debug.
    context.io.err(`${D}a credential named ${name} is already stored; keeping it${R}\n`);
    entry["apiKey"] = `secret://${name}`;
  } else {
    const wantsKey = (await context.ask("does it need an API key? [y/N] ")).trim().toLowerCase();
    if (wantsKey === "y" || wantsKey === "yes") {
      const key = (await context.ask(`key for ${name}: `)).trim();
      if (key) {
        // Into the store, never into the config file (invariant 6).
        await writeCredential(name, key, home);
        entry["apiKey"] = `secret://${name}`;
      }
    }
  }

  const providers = (config["providers"] ?? {}) as Record<string, unknown>;
  providers[name] = entry;
  config["providers"] = providers;
  config["provider"] = name;

  if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(baseUrl)) {
    context.io.err(
      `${B}this endpoint is not on this machine.${R} ` +
        `${D}prompts and the files dem reads will be sent to it${R}\n`,
    );
    config["allowRemote"] = true;
  }

  await save(context.workspace, config);
  context.io.err(`added ${B}${name}${R} and switched to it\n`);
  return { handled: true, changed: true };
}

async function model(
  args: readonly string[],
  context: SessionCommandContext,
): Promise<SessionCommandResult> {
  const config = await load(context.workspace);
  const target = selectedEntry(config);

  if (args[0]) {
    target["model"] = args[0];
    await save(context.workspace, config);
    context.io.err(`model is now ${B}${args[0]}${R}\n`);
    return { handled: true, changed: true };
  }

  const current = typeof target["model"] === "string" ? target["model"] : undefined;
  context.io.err(current ? `\n  current: ${B}${current}${R}\n` : "\n  no model set\n");

  if (!context.listModels) {
    context.io.err(`\n${D}/model <name> to change it${R}\n`);
    return { handled: true, changed: false };
  }

  let available: string[];
  try {
    available = await context.listModels();
  } catch (err) {
    // The endpoint being unreachable is worth saying. An empty list would
    // read as "this server has no models", which is a different problem.
    context.io.err(
      `\n${D}could not ask the endpoint what it serves: ${(err as Error).message}${R}\n`,
    );
    return { handled: true, changed: false };
  }

  if (available.length === 0) {
    context.io.err(`\n${D}the endpoint reports no models${R}\n`);
    return { handled: true, changed: false };
  }

  context.io.err("\n");
  for (const entry of available) {
    context.io.err(`  ${entry === current ? `${B}• ${entry}${R}` : `  ${entry}`}\n`);
  }
  context.io.err(`\n${D}/model <name> to change it${R}\n`);
  return { handled: true, changed: false };
}

/**
 * Where a model name belongs: on the selected provider if there is one, and
 * at the top level otherwise.
 *
 * Writing it to the top level while a named provider is selected would set a
 * value the provider's own entry overrides, so the change would appear to do
 * nothing.
 */
function selectedEntry(config: Record<string, unknown>): Record<string, unknown> {
  const name = config["provider"];
  const providers = config["providers"] as Record<string, Record<string, unknown>> | undefined;
  if (typeof name === "string" && providers?.[name]) return providers[name];
  return config;
}

async function load(workspace: string): Promise<Record<string, unknown>> {
  try {
    const text = await readFile(join(workspace, ".dem", "config.json"), "utf8");
    const parsed = JSON.parse(text);
    // Read whole and written back whole, so a session command cannot drop a
    // security block someone put there deliberately.
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function save(workspace: string, config: Record<string, unknown>): Promise<void> {
  const dir = join(workspace, ".dem");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "config.json"), JSON.stringify(config, null, 2) + "\n");
}
