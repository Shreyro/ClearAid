import { newId } from "../db";

/**
 * Copilot answers can take minutes, longer than some proxies keep a request
 * open. So a question starts a background job and returns at once; the page
 * then asks for the answer every couple of seconds. Jobs live in memory for
 * a short while and belong to the person who started them.
 */
type Job = { userId: string; status: "working" | "done" | "error"; result?: unknown; error?: { status: number; message: string }; startedAt: number };

const jobs = new Map<string, Job>();
const KEEP_MS = 15 * 60_000;

function sweep() {
  const now = Date.now();
  for (const [id, j] of jobs) if (now - j.startedAt > KEEP_MS) jobs.delete(id);
}

export function startJob(userId: string, run: () => Promise<unknown>) {
  sweep();
  const id = newId("job");
  const job: Job = { userId, status: "working", startedAt: Date.now() };
  jobs.set(id, job);
  run().then(
    (result) => Object.assign(job, { status: "done", result }),
    (e: Error & { status?: number }) => {
      if (!e.status) console.error("[clearaid] copilot job failed", e);
      Object.assign(job, { status: "error", error: { status: e.status ?? 500, message: e.message || "Something went wrong" } });
    },
  );
  return id;
}

export const getJob = (userId: string, id: string) => {
  const j = jobs.get(id);
  return j && j.userId === userId ? j : undefined;
};
