import { createInterface } from "node:readline";
import { homedir } from "node:os";
import {
  credentialStorePath,
  listCredentials,
  removeCredential,
  storeProtection,
  writeCredential,
} from "@dem/engine";
import type { Io } from "./session-ui.js";

/**
 * `dem auth` — setting a credential without writing it anywhere it can leak.
 *
 * The harness refuses a literal key in `.dem/config.json`, correctly, because
 * config files get committed. Until now that left the environment as the only
 * channel, which is invisible, does not survive a new terminal, and is
 * different on every platform. That is how a safety rule turns into a reason
 * not to use the tool.
 *
 * Three leaks this avoids, all of them ordinary:
 *
 *   `dem auth add openai sk-...` would put the key in shell history, so the
 *   value is never an argument.
 *
 *   A visible prompt puts it on the screen and in the terminal's scrollback,
 *   so input is not echoed.
 *
 *   A key pasted into a project file gets committed, so the store lives in the
 *   home directory and is never written to a workspace.
 */

const AUTH_HELP = `dem auth — credentials for remote providers

  dem auth add <name>     store a credential, prompted without echo
  dem auth list           show which credentials exist, never their values
  dem auth remove <name>  delete one

Reference a stored credential from config by name, never by value:

  {"apiKey": "secret://openai"}

A key belongs to one provider, so give each its own name. Copying one key into
a shared setting loses track of which endpoint it was issued for, which is how
a credential ends up sent to a service that should not have it.
`;

export async function runAuth(argv: readonly string[], io: Io): Promise<number> {
  const [action, name] = argv;
  const home = homedir();

  switch (action) {
    case undefined:
    case "list": {
      const credentials = await listCredentials(home);
      if (credentials.length === 0) {
        io.out(`no stored credentials\n\n${storeProtection(home)}\n`);
        return 0;
      }
      for (const credential of credentials) {
        io.out(`${credential.name}  ${"•".repeat(8)}  added ${credential.added.slice(0, 10)}\n`);
      }
      io.out(`\n${storeProtection(home)}\n`);
      return 0;
    }

    case "add": {
      if (!name) {
        io.err("dem auth add: a name is required, e.g. dem auth add openai\n");
        return 2;
      }
      if (argv.length > 2) {
        // Refused rather than accepted, because accepting it once puts the key
        // in history permanently and the user has no way to know that happened.
        io.err(
          "dem auth add: pass only a name. A key given on the command line ends up in your " +
            "shell history; this prompts for it instead.\n",
        );
        return 2;
      }

      const value = await promptHidden(`key for ${name}: `, io);
      if (!value.trim()) {
        io.err("\nnothing entered; nothing stored\n");
        return 1;
      }

      await writeCredential(name, value.trim(), home);
      io.err(`\nstored ${name}\n`);
      io.err(`${storeProtection(home)}\n`);
      io.err(`\nUse it from config as: "apiKey": "secret://${name}"\n`);
      return 0;
    }

    case "remove":
    case "rm": {
      if (!name) {
        io.err("dem auth remove: a name is required\n");
        return 2;
      }
      const removed = await removeCredential(name, home);
      io.err(removed ? `removed ${name}\n` : `no stored credential named "${name}"\n`);
      return removed ? 0 : 1;
    }

    case "path":
      // For the case this is really asked in: backing it up, or deleting it.
      io.out(`${credentialStorePath(home)}\n`);
      return 0;

    case "help":
      io.out(AUTH_HELP);
      return 0;

    default:
      io.err(`dem auth: unknown command "${action}"\n\n${AUTH_HELP}`);
      return 2;
  }
}

/**
 * Read a line without showing it.
 *
 * Node has no portable password prompt, so echo is suppressed by hand: raw
 * mode where there is a terminal, and a plain read where there is not, since a
 * pipe has nothing to echo to. A key typed in front of someone, or left in
 * scrollback, is a key to rotate.
 */
async function promptHidden(prompt: string, io: Io): Promise<string> {
  io.err(prompt);

  if (!process.stdin.isTTY) {
    // Piped input: `echo $KEY | dem auth add openai` is a legitimate way to
    // move a key out of the environment and into the store.
    const chunks: string[] = [];
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) chunks.push(chunk as string);
    return chunks.join("").split("\n")[0] ?? "";
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });

  // readline writes each keystroke back to the output; this drops those writes
  // while the answer is being typed, leaving the prompt already printed above.
  const output = rl as unknown as { output?: NodeJS.WriteStream; _writeToOutput?: unknown };
  output._writeToOutput = () => {};

  try {
    return await new Promise<string>((resolve) => rl.question("", resolve));
  } finally {
    rl.close();
  }
}
