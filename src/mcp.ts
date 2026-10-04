import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { config } from "./config.js";
import type { Job } from "./domain.js";
import { createJobSnapshot, currentSourcesMatch, removeWorktree } from "./git.js";
import { JobRunner } from "./runner.js";
import { JobStore } from "./store.js";

const instructions = [
  "Delegate only small, mechanical, bounded coding edits that are easy to review.",
  "The bridge sends only selected source files to Muse through the user's linked WhatsApp chat. Select exact non-secret files; it rejects common secret paths and secret-like values.",
  "Use deterministic, safe check commands. Checks run with shell=false in a temporary worktree.",
  "The bridge never edits the user's working tree. Fetch the result with get_job, inspect the unified diff and checks, and apply it yourself only when sourceFilesUnchanged is true.",
  "Review Muse's work as lower-confidence output. Record accept/reject and the exact Codex token count when known; use null when unavailable.",
  "Jobs exist only while this MCP process is running. If Muse needs login, delivery is uncertain, or quota is exhausted, take the work back directly. Never retry an uncertain request blindly.",
].join(" ");

function result(value: unknown, isError = false) {
  const structuredContent = value as Record<string, unknown>;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent,
    ...(isError ? { isError: true } : {}),
  };
}

function summary(job: Job): Record<string, unknown> {
  return {
    id: job.id,
    repo: job.repo,
    task: job.task,
    paths: job.paths,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
    hasPatch: job.patch !== null,
    checkResults: job.checkResults,
    accepted: job.accepted,
    codexTokens: job.codexTokens,
  };
}

const store = new JobStore();
const runner = new JobRunner(store);
const server = new McpServer(
  { name: "muse-patch-bridge", version: "0.1.0" },
  { instructions, capabilities: { tools: {} } },
);

server.registerTool("delegate_patch", {
  title: "Delegate a small patch to Muse",
  description: "Queue a bounded patch request. Only selected text files are copied into a temporary checkout and sent to Muse in the bound WhatsApp conversation. The patch is never applied to the user's working tree.",
  inputSchema: {
    repo: z.string().min(1).refine(isAbsolute, "repo must be an absolute path").describe("Absolute path to the root of a Git repository with an initial commit."),
    task: z.string().min(1).max(config.maxTaskCharacters),
    paths: z.array(z.string()).min(1).max(config.maxPaths),
    checks: z.array(z.object({ argv: z.array(z.string()).min(1) })).max(config.maxChecks).default([]),
  },
}, async ({ repo, task, paths, checks }) => {
  let snapshot: Awaited<ReturnType<typeof createJobSnapshot>> | null = null;
  try {
    snapshot = await createJobSnapshot({ repo, task, paths, checks });
    const job = store.createJob({ ...snapshot, task });
    runner.enqueue(job);
    return result({ ...summary(job), message: "Queued. Poll get_job for the patch and check results." });
  } catch (error) {
    if (snapshot) await removeWorktree(snapshot.repo, snapshot.worktreePath).catch(() => undefined);
    return result({ error: error instanceof Error ? error.message : String(error) }, true);
  }
});

server.registerTool("get_job", {
  title: "Get Muse patch job",
  description: "Get the current job status, diff, check results, and whether selected source files in the working tree still match the submitted snapshot.",
  inputSchema: { job_id: z.string().min(1) },
}, async ({ job_id }) => {
  const job = store.getJob(job_id);
  if (!job) return result({ error: `Unknown job: ${job_id}` }, true);
  let sourceFilesUnchanged: boolean | null = null;
  try {
    sourceFilesUnchanged = await currentSourcesMatch(job.repo, job.sourceHashes);
  } catch {
    sourceFilesUnchanged = false;
  }
  return result({ ...summary(job), patch: job.patch, sourceFilesUnchanged });
});

server.registerTool("list_jobs", {
  title: "List Muse patch jobs",
  description: "List recent Muse bridge jobs without returning source diffs.",
  inputSchema: { limit: z.number().int().min(1).max(100).default(25) },
}, async ({ limit }) => result({ jobs: store.listJobs(limit).map(summary) }));

server.registerTool("cancel_job", {
  title: "Cancel Muse patch job",
  description: "Cancel a queued or running Muse job. A request already sent to Muse may continue there, but it will not be resent or applied locally.",
  inputSchema: { job_id: z.string().min(1) },
}, async ({ job_id }) => {
  const job = store.cancelJob(job_id);
  return job ? result(summary(job)) : result({ error: `Unknown job: ${job_id}` }, true);
});

server.registerTool("record_review", {
  title: "Record patch review",
  description: "Record Codex's accept/reject decision and exact token count when known. This is pilot measurement metadata only.",
  inputSchema: {
    job_id: z.string().min(1),
    accepted: z.boolean(),
    codex_tokens: z.number().int().nonnegative().nullable(),
  },
}, async ({ job_id, accepted, codex_tokens }) => {
  try {
    store.recordReview(job_id, accepted, codex_tokens);
    return result(summary(store.getJob(job_id)!));
  } catch (error) {
    return result({ error: error instanceof Error ? error.message : String(error) }, true);
  }
});

const transport = new StdioServerTransport();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void runner.close().finally(() => server.close());
  });
}
transport.onclose = () => { void runner.close(); };
await server.connect(transport);
