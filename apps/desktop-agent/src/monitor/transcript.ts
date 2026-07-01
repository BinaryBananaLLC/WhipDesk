import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Newest file mtime (epoch ms) found at/under any of `paths`, or null if none exist. Depth- and
 * entry-capped so scanning a big transcripts dir stays cheap on every poll. A fresh mtime means the
 * agent just wrote to its transcript — i.e. it's actively working.
 */
export async function newestActivity(paths: string[]): Promise<number | null> {
  let newest: number | null = null;
  for (const p of paths) {
    const m = await newestUnder(p, 2, { count: 0 });
    if (m != null && (newest == null || m > newest)) newest = m;
  }
  return newest;
}

async function newestUnder(path: string, depth: number, budget: { count: number }): Promise<number | null> {
  if (budget.count > 500) return null;
  budget.count++;
  let st;
  try {
    st = await stat(path);
  } catch {
    return null;
  }
  if (st.isFile()) return st.mtimeMs;
  if (!st.isDirectory() || depth <= 0) return st.mtimeMs;
  let entries: string[];
  try {
    entries = await readdir(path);
  } catch {
    return st.mtimeMs;
  }
  let newest: number | null = null;
  for (const e of entries) {
    const m = await newestUnder(join(path, e), depth - 1, budget);
    if (m != null && (newest == null || m > newest)) newest = m;
  }
  return newest;
}
