import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyPatchInWorktree, createJobSnapshot, extractUnifiedDiff, readSelectedSources, removeWorktree, runChecks } from "./git.js";
import { buildMusePrompt, parseMuseResponse } from "./muse/whatsapp.js";
import { JobStore } from "./store.js";

interface FixtureTask {
  name: string;
  path: string;
  task: string;
  firstLine: string;
  oldLine: string;
  newLine: string;
  lastLine: string;
}

const tasks: FixtureTask[] = [
  {
    name: "return-value",
    path: "src/answer.js",
    task: "Change answer() to return 42.",
    firstLine: "export function answer() {",
    oldLine: "  return 41;",
    newLine: "  return 42;",
    lastLine: "}",
  },
  {
    name: "trim-label",
    path: "src/label.js",
    task: "Trim surrounding whitespace before lowercasing the label.",
    firstLine: "export function normalizeLabel(value) {",
    oldLine: "  return value.toLowerCase();",
    newLine: "  return value.trim().toLowerCase();",
    lastLine: "}",
  },
  {
    name: "collapse-name",
    path: "src/name.js",
    task: "Collapse repeated whitespace in a display name to one space.",
    firstLine: "export function displayName(value) {",
    oldLine: "  return value;",
    newLine: "  return value.trim().replace(/\\s+/g, \" \");",
    lastLine: "}",
  },
];

function fixtureReply(jobId: string, task: FixtureTask): string {
  const id = jobId.replaceAll("-", "").toUpperCase();
  return [
    `MUSE_BRIDGE_BEGIN_${id}`,
    "```diff",
    `diff --git a/${task.path} b/${task.path}`,
    `--- a/${task.path}`,
    `+++ b/${task.path}`,
    "@@ -1,3 +1,3 @@",
    ` ${task.firstLine}`,
    `-${task.oldLine}`,
    `+${task.newLine}`,
    ` ${task.lastLine}`,
    "```",
    `MUSE_BRIDGE_DONE_${id}`,
  ].join("\n");
}

test("three mechanical fixture delegations reach review with passing checks", async () => {
  const root = await mkdtemp(join(tmpdir(), "muse-bridge-pilot-"));
  const checkoutCache = join(root, "worktrees");
  const fixtureRoot = join(process.cwd(), "fixtures");
  const store = new JobStore();
  const snapshots: Array<{ repo: string; worktreePath: string }> = [];
  try {
    for (let index = 0; index < tasks.length; index += 1) {
      const fixture = tasks[index]!;
      const repo = join(root, fixture.name);
      await cp(join(fixtureRoot, fixture.name), repo, { recursive: true });
      execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Muse Bridge Pilot"], { cwd: repo });
      execFileSync("git", ["config", "user.email", "muse-bridge@example.invalid"], { cwd: repo });
      execFileSync("git", ["add", "."], { cwd: repo });
      execFileSync("git", ["commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });

      const jobId = `fixture-${index + 1}`;
      const snapshot = await createJobSnapshot({ repo, task: fixture.task, paths: [fixture.path], checks: [{ argv: ["node", "verify.mjs"] }] }, checkoutCache);
      snapshots.push({ repo, worktreePath: snapshot.worktreePath });
      store.createJob({ ...snapshot, id: jobId, task: fixture.task });
      assert.equal(store.setStatus(jobId, "preparing"), true);
      assert.equal(store.setStatus(jobId, "awaiting_muse"), true);

      const sources = await readSelectedSources(snapshot.worktreePath, snapshot.paths);
      const prompt = buildMusePrompt(jobId, fixture.task, snapshot.paths, sources);
      assert.match(prompt, new RegExp(fixture.path.replaceAll("/", "\\/")));
      assert.equal(sources.length, 1);
      const simulatedMuseReply = fixtureReply(jobId, fixture);
      const response = parseMuseResponse(jobId, simulatedMuseReply);
      assert.equal(response.kind, "patch");
      if (response.kind !== "patch") throw new Error("Expected a patch response.");
      const patch = extractUnifiedDiff(response.response, [fixture.path]);
      await applyPatchInWorktree(snapshot.worktreePath, patch);
      assert.equal(store.setPatch(jobId, patch), true);
      assert.match(await readFile(join(snapshot.worktreePath, fixture.path), "utf8"), new RegExp(fixture.newLine.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      const checks = await runChecks(snapshot.worktreePath, [{ argv: ["node", "verify.mjs"] }]);
      assert.deepEqual(checks.map((check) => check.exitCode), [0]);
      assert.equal(store.setCheckResults(jobId, checks), true);
      store.recordReview(jobId, true, null);
      assert.equal(store.getJob(jobId)?.status, "ready_for_review");
      assert.equal(store.getJob(jobId)?.accepted, true);
    }
    assert.equal(store.listJobs().filter((job) => job.accepted).length, 3);
  } finally {
    for (const snapshot of snapshots) await removeWorktree(snapshot.repo, snapshot.worktreePath, checkoutCache).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
