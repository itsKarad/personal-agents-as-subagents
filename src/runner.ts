import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { config } from "./config.js";
import type { Job } from "./domain.js";
import { applyPatchInWorktree, extractUnifiedDiff, readSelectedSources, removeWorktree, runChecks } from "./git.js";
import { buildMusePrompt, isWhatsAppSetupReady, MuseWhatsAppSession, parseMuseResponse, readMuseChatJid } from "./muse/whatsapp.js";
import { JobStore } from "./store.js";

const lockPath = join(config.dataDir, "whatsapp-session.lock");

function processIsAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function acquireSession(shouldCancel: () => boolean): Promise<(() => Promise<void>) | null> {
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const token = randomUUID();
  while (!shouldCancel()) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, token }));
      } finally {
        await handle.close();
      }
      return async () => {
        try {
          const owner = JSON.parse(await readFile(lockPath, "utf8")) as { token?: string };
          if (owner.token === token) await unlink(lockPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const owner = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: number };
        if (!processIsAlive(owner.pid ?? 0)) await unlink(lockPath);
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code !== "ENOENT") {
          const age = Date.now() - (await stat(lockPath)).mtimeMs;
          if (age > 5_000) await unlink(lockPath).catch(() => undefined);
        }
      }
      await delay(250);
    }
  }
  return null;
}

export class JobRunner {
  readonly #store: JobStore;
  readonly #queue: string[] = [];
  #running = false;
  #closed = false;
  #activeSession: MuseWhatsAppSession | null = null;

  constructor(store: JobStore) {
    this.#store = store;
  }

  enqueue(job: Job): void {
    if (this.#closed) throw new Error("Muse runner is closed.");
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
    let session: MuseWhatsAppSession | null = null;
    const cancelled = () => this.#store.getJob(job.id)?.status === "cancelled";
    try {
      if (cancelled() || !this.#store.setStatus(job.id, "preparing")) return;
      if (!await isWhatsAppSetupReady()) {
        this.#fail(job, "whatsapp_setup_required", "Run `npm run whatsapp-setup`, then submit the task again.");
        return;
      }
      const targetJid = await readMuseChatJid();
      if (!targetJid) {
        this.#fail(job, "muse_chat_required", "Select the Muse WhatsApp chat with `npm run whatsapp-setup`.");
        return;
      }
      const sources = await readSelectedSources(job.worktreePath, job.paths);
      const prompt = buildMusePrompt(job.id, job.task, job.paths, sources);
      if (prompt.length > config.maxWhatsAppMessageCharacters) {
        this.#fail(job, "request_too_large", "Select fewer or smaller source files for WhatsApp.");
        return;
      }
      release = await acquireSession(cancelled);
      if (!release || cancelled()) return;
      session = await MuseWhatsAppSession.open({ targetJid, expectedJobIds: [job.id] });
      this.#activeSession = session;
      await session.waitUntilConnected();
      if (cancelled() || !this.#store.setStatus(job.id, "awaiting_muse")) return;
      try {
        await session.sendText(prompt);
      } catch (error) {
        this.#fail(job, "delivery_uncertain", `WhatsApp did not confirm delivery. The request was not resent. ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      const reply = await session.waitForJobReply(job.id, config.museResponseTimeoutMs, cancelled);
      if (cancelled()) return;
      let response;
      try {
        response = parseMuseResponse(job.id, reply);
      } catch (error) {
        this.#fail(job, "invalid_reply", error instanceof Error ? error.message : String(error));
        return;
      }
      if (response.kind === "quota_exhausted") {
        this.#fail(job, "quota_exhausted", response.message, "quota_exhausted");
        return;
      }
      if (response.kind === "cannot_complete") {
        this.#fail(job, "muse_could_not_complete", response.message);
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
      if (!cancelled()) this.#fail(job, "job_failed", error instanceof Error ? error.message : String(error), "failed");
    } finally {
      await session?.close();
      if (this.#activeSession === session) this.#activeSession = null;
      await release?.();
      await removeWorktree(job.repo, job.worktreePath).catch(() => undefined);
    }
  }
}
