import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The experiment reads the same credential store the product writes.
 *
 * Not a second copy of the logic: it imports the engine's own module, so a
 * change to the store format cannot leave the experiment reading a file that
 * no longer exists in that shape. The experiments directory is not a workspace
 * package, so this goes through the built output rather than the package name.
 */

const here = dirname(fileURLToPath(import.meta.url));
const built = join(here, "..", "..", "dist", "packages", "engine", "src", "index.js");

if (!existsSync(built)) {
  throw new Error(
    `the engine is not built, so the credential store cannot be read.\n` +
      `Run: pnpm run build`,
  );
}

const engine = await import(pathToFileURL(built).href);

export const readCredential = engine.readCredential;
