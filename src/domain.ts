export const JOB_STATUSES = [
  "queued",
  "preparing",
  "awaiting_muse",
  "checking",
  "ready_for_review",
  "needs_user_attention",
  "quota_exhausted",
  "failed",
  "cancelled",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export interface CheckCommand {
  argv: string[];
}

export interface CheckResult {
  argv: string[];
  exitCode: number | null;
  durationMs: number;
  output: string;
  timedOut: boolean;
}

export interface JobInput {
  repo: string;
  task: string;
  paths: string[];
  checks: CheckCommand[];
}

export interface Job {
  id: string;
  repo: string;
  task: string;
  paths: string[];
  checks: CheckCommand[];
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  worktreePath: string;
  sourceHashes: Record<string, string>;
  patch: string | null;
  checkResults: CheckResult[] | null;
  errorCode: string | null;
  errorMessage: string | null;
  accepted: boolean | null;
  codexTokens: number | null;
}

export interface NewJob extends JobInput {
  id: string;
  worktreePath: string;
  sourceHashes: Record<string, string>;
}
