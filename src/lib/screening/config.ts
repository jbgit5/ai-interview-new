import path from "node:path";

// Server-side configuration for CV screening. Every value has a safe default and is clamped,
// so a typo in .env can't remove a limit. Documented in docs/CV-SCREENING.md and ARCHITECTURE §5.

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const n = parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function floatEnv(name: string, fallback: number, min: number, max: number): number {
  const n = parseFloat(process.env[name] ?? "");
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export interface ScreeningConfig {
  model: string;
  criteriaModel: string;
  storageDir: string;
  maxFileBytes: number;
  maxFilesPerBatch: number;
  maxUploadsPerDay: number;
  concurrency: number;
  dailyBudgetUsd: number;
  timeoutMs: number;
  maxAttempts: number;
  leaseSeconds: number;
}

export function getScreeningConfig(): ScreeningConfig {
  return {
    model: process.env.CV_SCREENING_MODEL?.trim() || "gpt-4o",
    criteriaModel: process.env.CV_CRITERIA_MODEL?.trim() || "gpt-4o-mini",
    storageDir: path.resolve(process.env.CV_STORAGE_DIR?.trim() || path.join(process.cwd(), "cv-uploads")),
    maxFileBytes: intEnv("CV_MAX_FILE_MB", 10, 1, 25) * 1024 * 1024,
    maxFilesPerBatch: intEnv("CV_MAX_FILES_PER_BATCH", 50, 1, 200),
    maxUploadsPerDay: intEnv("CV_MAX_UPLOADS_PER_DAY", 300, 1, 5_000),
    concurrency: intEnv("CV_SCREENING_CONCURRENCY", 2, 1, 6),
    dailyBudgetUsd: floatEnv("CV_SCREENING_DAILY_BUDGET_USD", 10, 0, 1_000),
    timeoutMs: intEnv("CV_SCREENING_TIMEOUT_MS", 60_000, 5_000, 180_000),
    maxAttempts: 3,
    leaseSeconds: 180,
  };
}
