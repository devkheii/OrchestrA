import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * A credential store the CLI can write (invariant 6, SPEC §34.1).
 *
 * Invariant 6 keeps secrets out of config because config files get committed.
 * For a while the only remaining way to supply a key was an environment
 * variable, and that is correct and unusable: a session variable is invisible,
 * does not survive a new terminal, and pushes every user toward pasting the
 * key into a file — which is the outcome the invariant exists to prevent. A
 * rule that makes the safe path impractical does not produce safety. It
 * produces workarounds.
 *
 * The earlier objection to implementing `secret://` was that a keychain which
 * silently degrades into a file is worse than none, because the user believes
 * their key is somewhere it is not. That objection was right and it is not an
 * objection to this: a store that says plainly it is a file, in the home
 * directory, restricted to its owner, is not pretending to be anything.
 *
 * What this is not: encryption at rest. Anything that could decrypt without a
 * passphrase would be obfuscation, and one asked for on every call is a
 * password prompt per request. An OS keychain can be added later as its own
 * scheme with a migration, rather than as a silent upgrade nobody can verify.
 */

interface StoreFile {
  version: 1;
  secrets: Record<string, { value: string; added: string }>;
}

export interface CredentialInfo {
  name: string;
  /** ISO date the credential was stored. Never the value, or part of it. */
  added: string;
}

/**
 * Where credentials live: the home directory, never a workspace.
 *
 * Putting this beside `.dem/config.json` in a project would reintroduce
 * exactly the problem refusing literals in config was meant to solve.
 */
export function credentialStorePath(home: string = homedir()): string {
  return join(home, ".dem", "credentials.json");
}

export async function writeCredential(
  name: string,
  value: string,
  home: string = homedir(),
): Promise<void> {
  if (!name.trim()) throw new Error("a credential needs a name");
  if (!value.trim()) throw new Error(`refusing to store an empty value for ${name}`);

  const store = await load(home, { missingIsEmpty: true });
  store.secrets[name] = { value, added: new Date().toISOString() };
  await save(store, home);
}

export async function readCredential(
  name: string,
  home: string = homedir(),
): Promise<string | undefined> {
  const store = await load(home, { missingIsEmpty: true });
  return store.secrets[name]?.value;
}

/** Names and dates. Never a value, and never a fragment one could be rebuilt from. */
export async function listCredentials(home: string = homedir()): Promise<CredentialInfo[]> {
  const store = await load(home, { missingIsEmpty: true });
  return Object.entries(store.secrets).map(([name, entry]) => ({ name, added: entry.added }));
}

/** @returns whether there was one to remove. */
export async function removeCredential(
  name: string,
  home: string = homedir(),
): Promise<boolean> {
  const store = await load(home, { missingIsEmpty: true });
  if (!store.secrets[name]) return false;
  delete store.secrets[name];
  await save(store, home);
  return true;
}

/**
 * How the store is protected, in words the CLI can print.
 *
 * Stated rather than implied. On Windows this is an ACL question the process
 * cannot settle by looking at a mode bit, and claiming a guarantee the
 * platform did not give is the deception this module exists to avoid.
 */
export function storeProtection(home: string = homedir()): string {
  return process.platform === "win32"
    ? `${credentialStorePath(home)} — a plain file in your user profile, protected by the ` +
        `permissions on that profile. Not encrypted.`
    : `${credentialStorePath(home)} — a plain file, mode 0600, readable only by you. ` +
        `Not encrypted.`;
}

async function load(
  home: string,
  options: { missingIsEmpty: boolean },
): Promise<StoreFile> {
  const path = credentialStorePath(home);
  let text: string;

  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // Absent means no credentials. Anything else — a permission error above
    // all — is a real failure, and reporting it as "no credentials" would send
    // the user to set keys they already set, overwriting the ones they had.
    if (code === "ENOENT" && options.missingIsEmpty) return { version: 1, secrets: {} };
    throw new Error(`could not read ${path}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`could not parse ${path}: ${(err as Error).message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`could not use ${path}: expected a JSON object`);
  }

  const store = parsed as Partial<StoreFile>;
  return { version: 1, secrets: store.secrets ?? {} };
}

async function save(store: StoreFile, home: string): Promise<void> {
  const path = credentialStorePath(home);
  await mkdir(dirname(path), { recursive: true });

  // Written restricted and then moved into place, so the file is never
  // briefly readable by anyone else and a crash mid-write cannot leave a
  // half-written store where a whole one used to be.
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(store, null, 2), { mode: 0o600 });
  try {
    await chmod(temporary, 0o600);
  } catch {
    // Windows has no mode bits to set. storeProtection() says so rather than
    // letting the caller assume otherwise.
  }
  await rename(temporary, path);
}
