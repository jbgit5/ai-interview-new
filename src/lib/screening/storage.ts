import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { getScreeningConfig } from "./config";

// Private on-disk storage for uploaded CVs: CV_STORAGE_DIR/<jobId>/<documentId>.<ext>.
// Never under public/; directories 0700, files 0600; only served through the authorised
// /api/jobs/[id]/screening/documents/[docId]/file route.

const REL_RE = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(pdf|docx)$/i;

function resolveSafe(rel: string): string {
  if (!REL_RE.test(rel)) throw new Error("invalid_storage_path");
  const base = getScreeningConfig().storageDir;
  const file = path.resolve(base, rel);
  if (!file.startsWith(base + path.sep)) throw new Error("invalid_storage_path");
  return file;
}

export function storagePathFor(jobId: string, documentId: string, ext: "pdf" | "docx"): string {
  return `${jobId}/${documentId}.${ext}`;
}

export async function saveCvFile(rel: string, data: Uint8Array): Promise<void> {
  const file = resolveSafe(rel);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, data, { mode: 0o600, flag: "wx" });
}

export async function readCvFile(rel: string): Promise<Buffer> {
  return readFile(resolveSafe(rel));
}

export async function deleteCvFile(rel: string): Promise<void> {
  try {
    await unlink(resolveSafe(rel));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }
}
