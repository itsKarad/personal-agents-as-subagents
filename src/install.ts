import { execFile } from "node:child_process";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const name = "instinct-patch-bridge";

async function run(args: string[]): Promise<string> {
  const result = await execFileAsync("codex", ["mcp", ...args], { encoding: "utf8" });
  return result.stdout.trim();
}

async function main(): Promise<void> {
  const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const entry = join(projectRoot, "dist", "src", "mcp.js");
  let registered = true;
  try {
    await run(["get", name]);
  } catch {
    registered = false;
  }
  if (registered) {
    const list = await run(["list"]);
    const existing = list.split("\n").find((line) => line.trimStart().startsWith(name));
    if (!existing?.includes(process.execPath) || !existing.includes(entry)) {
      throw new Error(`Codex has a different MCP named ${name}; it was left unchanged.`);
    }
  } else {
    await run(["add", name, "--", process.execPath, entry]);
  }
  process.stdout.write(`Registered Codex MCP '${name}'. Restart Codex to load its new tool list.\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`Instinct bridge install failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
