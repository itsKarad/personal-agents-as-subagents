import assert from "node:assert/strict";
import test from "node:test";
import { JobStore } from "./store.js";

function addJob(store: JobStore, id: string): void {
  store.createJob({
    id,
    repo: "/repo",
    task: "Change a constant",
    paths: ["src/value.ts"],
    checks: [],
    worktreePath: "/tmp/worktree",
    sourceHashes: { "src/value.ts": "abc" },
  });
}

test("jobs and reviews stay in the current MCP process", () => {
  const store = new JobStore();
  addJob(store, "job-1");
  assert.equal(store.setStatus("job-1", "preparing"), true);
  assert.equal(store.setStatus("job-1", "awaiting_muse"), true);
  assert.equal(store.setPatch("job-1", "--- a/src/value.ts\n+++ b/src/value.ts\n"), true);
  assert.equal(store.setCheckResults("job-1", []), true);
  store.recordReview("job-1", true, null);
  assert.equal(store.getJob("job-1")?.accepted, true);
  assert.equal(new JobStore().getJob("job-1"), null);
  assert.throws(() => store.recordReview("missing", true, null));
});

test("cancelled jobs reject late patches and results", () => {
  const store = new JobStore();
  addJob(store, "job-2");
  store.setStatus("job-2", "preparing");
  store.setStatus("job-2", "awaiting_muse");
  store.cancelJob("job-2");
  assert.equal(store.setPatch("job-2", "late patch"), false);
  assert.equal(store.setStatus("job-2", "checking"), false);
  assert.equal(store.setCheckResults("job-2", []), false);
  assert.equal(store.getJob("job-2")?.status, "cancelled");
});
