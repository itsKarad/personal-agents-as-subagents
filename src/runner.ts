import { config } from "./config.js";
import type { Job } from "./domain.js";
import { applyPatchInWorktree, extractUnifiedDiff, readSelectedSources, removeWorktree, runChecks } from "./git.js";
import { buildInstinctPrompt, isWhatsAppSetupReady, InstinctWhatsAppSession, parseInstinctResponse, readInstinctChatJid, WhatsAppBridgeError } from "./instinct/whatsapp.js";
import { acquireWhatsAppSessionLock } from "./session-lock.js";
import { JobStore } from "./store.js";

export function classifyRunnerError(error: unknown): {
  code: string;
  message: string;
  status: "needs_user_attention" | "failed";
} {
  if (error instanceof WhatsAppBridgeError) {
    return { code: error.code, message: error.message, status: "needs_user_attention" };
  }
  return {
    code: "job_failed",
    message: error instanceof Error ? error.message : String(error),
    status: "failed",
  };
}

export class JobRunner {
  readonly #store: JobStore;
  readonly #queue: string[] = [];
  #running = false;
  #closed = false;
  #activeSession: InstinctWhatsAppSession | null = null;

  constructor(store: JobStore) {
    this.#store = store;
  }

  enqueue(job: Job): void {
    if (this.#closed) throw new Error("Instinct runner is closed.");
    this.#queue.push(job.id);
    void this.#drain();
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const job of this.#store.listJobs(Number.MAX_SAFE_INTEGER)) this.#store.cancelJob(job.id);
    await this.#activeSession?.close();
  }

  async #drain(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      while (this.#queue.length > 0) {
        const id = this.#queue.shift()!;
        const job = this.#store.getJob(id);
        if (job) await this.#run(job);
      }
    } finally {
      this.#running = false;
    }
  }

  #fail(job: Job, code: string, message: string, status: "needs_user_attention" | "quota_exhausted" | "failed" = "needs_user_attention"): void {
    this.#store.setStatus(job.id, status, { errorCode: code, errorMessage: message });
  }

  async #run(job: Job): Promise<void> {
    let release: (() => Promise<void>) | null = null;
    let session: InstinctWhatsAppSession | null = null;
    const cancelled = () => this.#store.getJob(job.id)?.status === "cancelled";
    try {
      if (cancelled() || !this.#store.setStatus(job.id, "preparing")) return;
      release = await acquireWhatsAppSessionLock(config.dataDir, cancelled);
      if (!release || cancelled()) return;
      if (!await isWhatsAppSetupReady()) {
        this.#fail(job, "whatsapp_setup_required", "Run `npm run whatsapp-setup`, then submit the task again.");
        return;
      }
      const chatJid = await readInstinctChatJid();
      if (!chatJid) {
        this.#fail(job, "instinct_chat_required", "Select the Instinct WhatsApp chat with `npm run whatsapp-setup`.");
        return;
      }
      const sources = await readSelectedSources(job.worktreePath, job.paths);
      const prompt = buildInstinctPrompt(job.id, job.task, job.paths, sources);
      if (prompt.length > config.maxWhatsAppMessageCharacters) {
        this.#fail(job, "request_too_large", "Select fewer or smaller source files for WhatsApp.");
        return;
      }
      session = await InstinctWhatsAppSession.open({
        chatJid,
        expectedJobIds: [job.id],
        ...(process.env.INSTINCT_BRIDGE_DEBUG === "1" ? {
          onMessageMetadata: (event) => process.stderr.write(`INSTINCT_METADATA ${JSON.stringify(event)}\n`),
          onConnectionMetadata: (event) => process.stderr.write(`INSTINCT_CONNECTION_METADATA ${JSON.stringify(event)}\n`),
        } : {}),
      });
      this.#activeSession = session;
      await session.waitUntilConnected();
      if (cancelled() || !this.#store.setStatus(job.id, "awaiting_reply")) return;
      if (process.env.INSTINCT_BRIDGE_DEBUG === "1") {
        process.stderr.write(`INSTINCT_SEND_METADATA ${JSON.stringify({ selectedPathCount: job.paths.length, promptCharacters: prompt.length })}\n`);
      }
      try {
        await session.sendText(prompt);
      } catch (error) {
        this.#fail(job, "delivery_uncertain", `WhatsApp did not confirm delivery. The request was not resent. ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      const reply = await session.waitForJobReply(job.id, config.assistantResponseTimeoutMs, cancelled);
      if (cancelled()) return;
      let response;
      try {
        response = parseInstinctResponse(job.id, reply);
      } catch (error) {
        this.#fail(job, "invalid_reply", error instanceof Error ? error.message : String(error));
        return;
      }
      if (response.kind === "quota_exhausted") {
        this.#fail(job, "quota_exhausted", response.message, "quota_exhausted");
        return;
      }
      if (response.kind === "cannot_complete") {
        this.#fail(job, "instinct_could_not_complete", response.message);
        return;
      }
      try {
        const patch = extractUnifiedDiff(response.response, job.paths);
        await applyPatchInWorktree(job.worktreePath, patch);
        if (!this.#store.setPatch(job.id, patch)) return;
      } catch (error) {
        this.#fail(job, "invalid_patch", error instanceof Error ? error.message : String(error));
        return;
      }
      const checks = await runChecks(job.worktreePath, job.checks, cancelled);
      if (!cancelled()) this.#store.setCheckResults(job.id, checks);
    } catch (error) {
      if (!cancelled()) {
        const failure = classifyRunnerError(error);
        this.#fail(job, failure.code, failure.message, failure.status);
      }
    } finally {
      await session?.close();
      if (this.#activeSession === session) this.#activeSession = null;
      await release?.();
      await removeWorktree(job.repo, job.worktreePath).catch(() => undefined);
    }
  }
}
