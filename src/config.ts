import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = [resolve(moduleDir, ".."), resolve(moduleDir, "../..")]
  .find((directory) => existsSync(join(directory, "package.json")));
if (!projectRoot) throw new Error("Could not locate the Instinct bridge project root.");

const dataDir = resolve(process.env.INSTINCT_BRIDGE_HOME ?? join(projectRoot, ".instinct-bridge"));

export const config = {
  dataDir,
  whatsappAuthDir: join(dataDir, "whatsapp-auth"),
  whatsappTargetPath: join(dataDir, "whatsapp-target.json"),
  worktreesDir: join(dataDir, "worktrees"),
  maxPaths: 5,
  maxSelectedBytes: 30_000,
  maxTaskCharacters: 4_000,
  maxChecks: 4,
  checkTimeoutMs: 120_000,
  checkOutputBytes: 128_000,
  whatsappConnectTimeoutMs: 60_000,
  assistantResponseTimeoutMs: 10 * 60_000,
  maxWhatsAppMessageCharacters: 55_000,
} as const;
