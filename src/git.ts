import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { config } from "./config.js";
import type { CheckCommand, CheckResult, JobInput } from "./domain.js";

const execFileAsync = promisify(execFile);
const secretName = /(^|\/)(\.env(?:\..*)?|\.npmrc|\.pypirc|credentials?(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|id_(?:rsa|ed25519)|.*\.(?:pem|p12|pfx|key))$/i;
const secretValuePatterns = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /\bsk-[A-Za-z0-9]{24,}\b/,
];

class InputError extends Error {
  constructor(message: string, readonly code = "invalid_input") {
    super(message);
    this.name = "InputError";
  }
}

async function runFile(
  command: string,
  args: string[],
  cwd?: string,
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

async function git(args: string[], cwd: string): Promise<string> {
  return (await runFile("git", args, cwd)).stdout.trim();
}

function hash(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function checkPathSyntax(path: string): string {
  if (!path || path.includes("\0") || path.includes("\\") || isAbsolute(path)) {
    throw new InputError(`Path must be a nonempty repository-relative POSIX path: ${path}`);
  }
  const parts = path.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new InputError(`Path contains an unsafe segment: ${path}`);
  }
  if (parts.some((part) => part.toLowerCase() === ".git")) {
    throw new InputError("Git metadata cannot be delegated.");
  }
  if (secretName.test(path)) {
    throw new InputError(`Sensitive path is blocked: ${path}`, "secret_path");
  }
  return parts.join("/");
}

function validateTaskInput(input: JobInput): void {
  if (!input.task.trim() || input.task.length > config.maxTaskCharacters) {
    throw new InputError(`Task must contain 1–${config.maxTaskCharacters} characters.`);
  }
  if (input.paths.length < 1 || input.paths.length > config.maxPaths) {
    throw new InputError(`Select between 1 and ${config.maxPaths} paths.`);
  }
  if (input.checks.length > config.maxChecks) {
    throw new InputError(`At most ${config.maxChecks} checks may be supplied.`);
  }
  for (const check of input.checks) {
    if (!Array.isArray(check.argv) || check.argv.length === 0 || check.argv.some((part) => !part || part.includes("\0"))) {
      throw new InputError("Checks must be nonempty argument arrays.");
    }
  }
}

async function rejectSymlinkComponents(repoRoot: string, relPath: string): Promise<void> {
  let current = repoRoot;
  for (const segment of relPath.split("/")) {
    current = join(current, segment);
    try {
      const details = await lstat(current);
      if (details.isSymbolicLink()) throw new InputError(`Symlinks are not allowed in selected paths: ${relPath}`);
      if (current !== join(repoRoot, relPath) && !details.isDirectory()) {
        throw new InputError(`A selected path parent is not a directory: ${relPath}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

async function isIgnored(repoRoot: string, relPath: string): Promise<boolean> {
  try {
    await runFile("git", ["check-ignore", "-q", "--", relPath], repoRoot);
    return true;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 1 || code === "1") return false;
    throw error;
  }
}

async function selectedFile(repoRoot: string, relPath: string): Promise<{ bytes: Buffer | null; text: string | null }> {
  await rejectSymlinkComponents(repoRoot, relPath);
  if (await isIgnored(repoRoot, relPath)) throw new InputError(`Ignored files cannot be delegated: ${relPath}`);
  const fullPath = resolve(repoRoot, relPath);
  if (!isWithin(repoRoot, fullPath)) throw new InputError(`Path escapes the repository: ${relPath}`);
  try {
    const info = await lstat(fullPath);
    if (!info.isFile()) throw new InputError(`Selected path must be a regular file: ${relPath}`);
    const bytes = await readFile(fullPath);
    if (bytes.includes(0)) throw new InputError(`Binary files cannot be delegated: ${relPath}`);
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) throw new InputError(`File is not valid UTF-8: ${relPath}`);
    if (secretValuePatterns.some((pattern) => pattern.test(text))) {
      throw new InputError(`Secret-like content is blocked: ${relPath}`, "secret_content");
    }
    return { bytes, text };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { bytes: null, text: null };
    throw error;
  }
}

export async function createJobSnapshot(input: JobInput, worktreeBase = config.worktreesDir): Promise<{
  id: string;
  repo: string;
  worktreePath: string;
  paths: string[];
  checks: CheckCommand[];
  sourceHashes: Record<string, string>;
}> {
  validateTaskInput(input);
  const repoRoot = await realpath(input.repo);
  const top = await realpath(await git(["rev-parse", "--show-toplevel"], repoRoot));
  if (top !== repoRoot) throw new InputError("Repo must point to the Git worktree root.");
  const head = await git(["rev-parse", "--verify", "HEAD^{commit}"], repoRoot);
  const paths = [...new Set(input.paths.map(checkPathSyntax))];
  if (paths.length !== input.paths.length) throw new InputError("Duplicate selected paths are not allowed.");

  const files = new Map<string, Buffer | null>();
  let totalBytes = 0;
  const sourceHashes: Record<string, string> = {};
  for (const relPath of paths) {
    const file = await selectedFile(repoRoot, relPath);
    if (file.bytes) {
      totalBytes += file.bytes.length;
      if (totalBytes > config.maxSelectedBytes) {
        throw new InputError(`Selected files exceed ${config.maxSelectedBytes} bytes.`);
      }
      sourceHashes[relPath] = hash(file.bytes);
    } else {
      sourceHashes[relPath] = "absent";
    }
    files.set(relPath, file.bytes);
  }

  await mkdir(worktreeBase, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const worktreePath = join(worktreeBase, id);
  await mkdir(dirname(worktreePath), { recursive: true, mode: 0o700 });
  try {
    await git(["worktree", "add", "--detach", worktreePath, head], repoRoot);
    for (const [relPath, bytes] of files) {
      const destination = resolve(worktreePath, relPath);
      if (!isWithin(worktreePath, destination)) throw new InputError(`Path escapes the checkout: ${relPath}`);
      if (bytes === null) {
        await rm(destination, { force: true });
        continue;
      }
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, bytes, { mode: 0o600 });
    }
    return { id, repo: repoRoot, worktreePath, paths, checks: input.checks, sourceHashes };
  } catch (error) {
    await git(["worktree", "remove", "--force", worktreePath], repoRoot).catch(async () => {
      await rm(worktreePath, { recursive: true, force: true });
    });
    throw error;
  }
}

export async function readSelectedSources(worktreePath: string, paths: string[]): Promise<Array<{ path: string; contents: string }>> {
  const root = await realpath(worktreePath);
  const result: Array<{ path: string; contents: string }> = [];
  for (const rawPath of paths) {
    const relPath = checkPathSyntax(rawPath);
    const fullPath = resolve(root, relPath);
    if (!isWithin(root, fullPath)) throw new InputError(`Path escapes the checkout: ${relPath}`);
    try {
      const bytes = await readFile(fullPath);
      if (bytes.includes(0)) throw new InputError(`Binary files cannot be sent: ${relPath}`);
      result.push({ path: relPath, contents: bytes.toString("utf8") });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        result.push({ path: relPath, contents: "[This selected file does not exist yet.]" });
      } else {
        throw error;
      }
    }
  }
  return result;
}

export function extractUnifiedDiff(response: string, allowedPaths: string[]): string {
  const fence = response.match(/```diff\s*([\s\S]*?)```/i);
  const patch = (fence?.[1] ?? response).trim();
  if (!patch || patch.includes("GIT binary patch") || /^Binary files /m.test(patch)) {
    throw new InputError("Muse did not return a text unified diff.", "invalid_patch");
  }
  if (/^(?:rename from|rename to|deleted file mode) /m.test(patch)) {
    throw new InputError("Renames and file deletions are not accepted.", "invalid_patch");
  }
  const expected = new Set(allowedPaths.map(checkPathSyntax));
  const fileHeaders = [...patch.matchAll(/^(?:\+\+\+ b\/([^\t\n]+)|--- a\/([^\t\n]+)|\+\+\+ \/dev\/null|--- \/dev\/null)$/gm)];
  const changed = new Set<string>();
  for (const match of fileHeaders) {
    const raw = match[1] ?? match[2];
    if (raw) changed.add(checkPathSyntax(raw.trim()));
  }
  if (changed.size === 0) throw new InputError("The response does not contain recognizable file headers.", "invalid_patch");
  for (const path of changed) {
    if (!expected.has(path)) throw new InputError(`Patch changes a path that was not selected: ${path}`, "out_of_scope_patch");
  }
  if (/^\+\+\+ \/dev\/null$/m.test(patch)) throw new InputError("File deletions are not accepted.", "invalid_patch");
  if (!/^diff --git /m.test(patch) && !/^--- /m.test(patch)) {
    throw new InputError("The response does not look like a unified diff.", "invalid_patch");
  }
  return `${patch}\n`;
}

export async function applyPatchInWorktree(worktreePath: string, patch: string): Promise<void> {
  try {
    await runGitWithInput(["apply", "--check", "--whitespace=error", "-"], worktreePath, patch);
  } catch (checkError) {
    try {
      await runGitWithInput(["apply", "--reverse", "--check", "--whitespace=error", "-"], worktreePath, patch);
    } catch {
      throw checkError;
    }
    await runFile("git", ["diff", "--check"], worktreePath);
    return;
  }
  await runGitWithInput(["apply", "--whitespace=error", "-"], worktreePath, patch);
  await runFile("git", ["diff", "--check"], worktreePath);
}

async function runGitWithInput(args: string[], cwd: string, input: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(stderr.trim() || `git ${args[0]} failed with exit code ${code}`));
    });
    child.stdin.end(input);
  });
}

export async function runChecks(
  worktreePath: string,
  checks: CheckCommand[],
  shouldCancel: () => boolean = () => false,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    if (shouldCancel()) break;
    const startedAt = Date.now();
    const result = await new Promise<CheckResult>((resolvePromise) => {
      const child = spawn(check.argv[0]!, check.argv.slice(1), {
        cwd: worktreePath,
        shell: false,
        env: { ...process.env, CI: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      let outputBytes = 0;
      let timedOut = false;
      let cancelled = false;
      let hardKillTimer: NodeJS.Timeout | undefined;
      const onChunk = (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes <= config.checkOutputBytes) output += chunk.toString("utf8");
        else if (!timedOut) {
          timedOut = true;
          output += "\n[output limit exceeded; process terminated]";
          child.kill("SIGKILL");
        }
      };
      child.stdout.on("data", onChunk);
      child.stderr.on("data", onChunk);
      const timer = setTimeout(() => {
        timedOut = true;
        output += "\n[check timed out]";
        child.kill("SIGKILL");
      }, config.checkTimeoutMs);
      const cancelPoll = setInterval(() => {
        if (cancelled || !shouldCancel()) return;
        cancelled = true;
        output += "\n[check cancelled]";
        child.kill("SIGTERM");
        hardKillTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      }, 250);
      child.on("error", (error) => {
        clearTimeout(timer);
        clearInterval(cancelPoll);
        if (hardKillTimer) clearTimeout(hardKillTimer);
        resolvePromise({ argv: check.argv, exitCode: null, durationMs: Date.now() - startedAt, output: `${output}\n${error.message}`, timedOut });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        clearInterval(cancelPoll);
        if (hardKillTimer) clearTimeout(hardKillTimer);
        resolvePromise({ argv: check.argv, exitCode: code, durationMs: Date.now() - startedAt, output, timedOut });
      });
    });
    results.push(result);
  }
  return results;
}

export async function currentSourcesMatch(repoRoot: string, sourceHashes: Record<string, string>): Promise<boolean> {
  for (const [relPath, expected] of Object.entries(sourceHashes)) {
    const file = await selectedFile(repoRoot, relPath);
    const actual = file.bytes === null ? "absent" : hash(file.bytes);
    if (actual !== expected) return false;
  }
  return true;
}

export async function removeWorktree(repoRoot: string, worktreePath: string, worktreeBase = config.worktreesDir): Promise<void> {
  const fullCache = await realpath(worktreeBase).catch(() => resolve(worktreeBase));
  const fullPath = await realpath(worktreePath).catch(() => resolve(worktreePath));
  if (!isWithin(fullCache, fullPath) || fullPath === fullCache) throw new Error("Refusing to remove a path outside the bridge worktree cache.");
  await git(["worktree", "remove", "--force", fullPath], repoRoot).catch(async () => {
    await rm(fullPath, { recursive: true, force: true });
  });
}
