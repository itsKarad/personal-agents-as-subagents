import type { CheckResult, Job, JobStatus, NewJob } from "./domain.js";

const allowedTransitions: Record<JobStatus, ReadonlySet<JobStatus>> = {
  queued: new Set(["preparing", "cancelled"]),
  preparing: new Set(["awaiting_muse", "needs_user_attention", "failed", "cancelled"]),
  awaiting_muse: new Set(["checking", "needs_user_attention", "quota_exhausted", "failed", "cancelled"]),
  checking: new Set(["ready_for_review", "needs_user_attention", "failed", "cancelled"]),
  ready_for_review: new Set(),
  needs_user_attention: new Set(),
  quota_exhausted: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

export class JobStore {
  readonly #jobs = new Map<string, Job>();

  createJob(input: NewJob): Job {
    if (this.#jobs.has(input.id)) throw new Error(`Duplicate job: ${input.id}`);
    const now = new Date().toISOString();
    const job: Job = {
      ...input,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      patch: null,
      checkResults: null,
      errorCode: null,
      errorMessage: null,
      accepted: null,
      codexTokens: null,
    };
    this.#jobs.set(input.id, job);
    return structuredClone(job);
  }

  getJob(id: string): Job | null {
    const job = this.#jobs.get(id);
    return job ? structuredClone(job) : null;
  }

  listJobs(limit = 25): Job[] {
    return [...this.#jobs.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((job) => structuredClone(job));
  }

  setStatus(
    id: string,
    status: JobStatus,
    fields: { errorCode?: string | null; errorMessage?: string | null } = {},
  ): boolean {
    const job = this.#jobs.get(id);
    if (!job) throw new Error(`Unknown job: ${id}`);
    if (!allowedTransitions[job.status].has(status)) return false;
    job.status = status;
    job.updatedAt = new Date().toISOString();
    if (fields.errorCode !== undefined) job.errorCode = fields.errorCode;
    if (fields.errorMessage !== undefined) job.errorMessage = fields.errorMessage;
    return true;
  }

  setPatch(id: string, patch: string): boolean {
    const job = this.#jobs.get(id);
    if (!job || job.status !== "awaiting_muse") return false;
    job.patch = patch;
    job.status = "checking";
    job.updatedAt = new Date().toISOString();
    return true;
  }

  setCheckResults(id: string, results: CheckResult[]): boolean {
    const job = this.#jobs.get(id);
    if (!job || job.status !== "checking") return false;
    job.checkResults = results;
    job.status = "ready_for_review";
    job.updatedAt = new Date().toISOString();
    return true;
  }

  recordReview(id: string, accepted: boolean, codexTokens: number | null): void {
    const job = this.#jobs.get(id);
    if (!job || job.status !== "ready_for_review") throw new Error("Review can only be recorded for a ready patch.");
    job.accepted = accepted;
    job.codexTokens = codexTokens;
    job.updatedAt = new Date().toISOString();
  }

  cancelJob(id: string): Job | null {
    const job = this.#jobs.get(id);
    if (!job) return null;
    if (!allowedTransitions[job.status].has("cancelled")) return structuredClone(job);
    job.status = "cancelled";
    job.updatedAt = new Date().toISOString();
    job.errorCode = "cancelled";
    job.errorMessage = "Cancelled by Codex.";
    return structuredClone(job);
  }
}
