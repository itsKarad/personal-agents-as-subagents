import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyPatchInWorktree,
  createJobSnapshot,
  currentSourcesMatch,
  extractUnifiedDiff,
  removeWorktree,
  runChecks,
} from "./git.js";

async function makeRepo(root: string): Promise<void> {
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "value.ts"), "export const value = 1;\n");
  await writeFile(join(root, "src", "untouched.ts"), "export const untouched = true;\n");
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Instinct Bridge Tests"], { cwd: root });
  execFileSync("git", ["config", "user.email", "instinct-bridge-tests@example.invalid"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: root, stdio: "ignore" });
}

test("snapshot overlays only selected current files onto the committed checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "instinct-bridge-git-"));
  const checkoutCache = await mkdtemp(join(tmpdir(), "instinct-bridge-worktrees-"));
  await makeRepo(root);
  try {
    await writeFile(join(root, "src", "value.ts"), "export const value = 2;\n");
    await writeFile(join(root, "src", "untouched.ts"), "export const untouched = false;\n");
    const job = await createJobSnapshot({
      repo: root,
      task: "Change value to 3",
      paths: ["src/value.ts"],
      checks: [],
    }, checkoutCache);
    try {
      assert.equal(await readFile(join(job.worktreePath, "src", "value.ts"), "utf8"), "export const value = 2;\n");
      assert.equal(await readFile(join(job.worktreePath, "src", "untouched.ts"), "utf8"), "export const untouched = true;\n");
      assert.equal(job.sourceHashes["src/value.ts"]?.length, 64);
      assert.equal(await currentSourcesMatch(root, job.sourceHashes), true);
      await writeFile(join(root, "src", "value.ts"), "export const value = 4;\n");
      assert.equal(await currentSourcesMatch(root, job.sourceHashes), false);
    } finally {
      await removeWorktree(root, job.worktreePath, checkoutCache);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(checkoutCache, { recursive: true, force: true });
  }
});

test("selected secrets, ignored files, and out-of-scope diffs are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "instinct-bridge-security-"));
  const checkoutCache = await mkdtemp(join(tmpdir(), "instinct-bridge-worktrees-"));
  await makeRepo(root);
  try {
    await writeFile(join(root, ".env"), "DEMO=value\n");
    await writeFile(join(root, "src", "leaked.ts"), 'const token = "ghp_123456789012345678901234567890";\n');
    await assert.rejects(createJobSnapshot({
      repo: root,
      task: "Read configuration",
      paths: [".env"],
      checks: [],
    }, checkoutCache), /Sensitive path is blocked/);
    await assert.rejects(createJobSnapshot({
      repo: root,
      task: "Update source",
      paths: ["../outside.ts"],
      checks: [],
    }, checkoutCache), /unsafe segment/);
    await assert.rejects(createJobSnapshot({
      repo: root,
      task: "Inspect source",
      paths: ["src/leaked.ts"],
      checks: [],
    }, checkoutCache), /Secret-like content is blocked/);
    assert.throws(() => extractUnifiedDiff("This is not a diff", ["src/value.ts"]), /file headers/);
    assert.throws(() => extractUnifiedDiff(
      "diff --git a/other.ts b/other.ts\n--- a/other.ts\n+++ b/other.ts\n@@ -1 +1 @@\n-old\n+new",
      ["src/value.ts"],
    ), /not selected/);
    assert.throws(() => extractUnifiedDiff(
      "--- a/src/value.ts\n+++ b/src/value.ts\n@@ -1 +1 @@\n-old\n+new\n-extra\n+ignored",
      ["src/value.ts"],
    ), /outside a declared hunk/);
    assert.throws(() => extractUnifiedDiff(
      "--- a/src/value.ts\n+++ b/src/value.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n--- a/src/other.ts\n+++ b/src/other.ts\n@@ -1 +1 @@\n-before\n+after",
      ["src/value.ts", "src/other.ts"],
    ), /next file before its declared line counts/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(checkoutCache, { recursive: true, force: true });
  }
});

test("unified diff is checked and applied only in the temporary worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "instinct-bridge-patch-"));
  const checkoutCache = await mkdtemp(join(tmpdir(), "instinct-bridge-worktrees-"));
  await makeRepo(root);
  try {
    const job = await createJobSnapshot({
      repo: root,
      task: "Change the selected constant",
      paths: ["src/value.ts"],
      checks: [],
    }, checkoutCache);
    try {
      const patch = extractUnifiedDiff(`diff --git a/src/value.ts b/src/value.ts
index 5dd9c48..c1b0730 100644
--- a/src/value.ts
+++ b/src/value.ts
@@ -1 +1 @@
-export const value = 1;
+export const value = 3;`, ["src/value.ts"]);
      await applyPatchInWorktree(job.worktreePath, patch);
      await applyPatchInWorktree(job.worktreePath, patch);
      assert.equal(await readFile(join(job.worktreePath, "src", "value.ts"), "utf8"), "export const value = 3;\n");
      assert.equal(await readFile(join(root, "src", "value.ts"), "utf8"), "export const value = 1;\n");
    } finally {
      await removeWorktree(root, job.worktreePath, checkoutCache);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(checkoutCache, { recursive: true, force: true });
  }
});

test("checks can find Node from the bridge runtime when its PATH is minimal", async () => {
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = "/usr/bin:/bin";
    const results = await runChecks(process.cwd(), [{
      argv: ["node", "-e", "process.stdout.write('runtime-node-found')"],
    }]);
    assert.equal(results[0]?.exitCode, 0);
    assert.equal(results[0]?.output, "runtime-node-found");
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});
