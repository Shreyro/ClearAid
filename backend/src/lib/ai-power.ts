import { config } from "./config";

/**
 * Keeps the hosted AI service asleep when nobody uses it. The AI (Ollama plus
 * the search service) runs on a large, pay-by-the-hour Render instance:
 * this suspends it after a quiet spell and resumes it on the next question.
 * Without RENDER_API_KEY and RENDER_AI_SERVICE_ID (local runs, Docker) none of this does anything.
 */
const R = config.render;
const API = "https://api.render.com/v1";

export const powerManaged = () => Boolean(R.apiKey && R.aiServiceId);

let lastUse = Date.now();
/** Call when the AI is genuinely used, so the idle clock restarts. */
export const touchAi = () => {
  lastUse = Date.now();
};

async function render(path: string, method: "GET" | "POST" = "GET") {
  const res = await fetch(`${API}/services/${R.aiServiceId}${path}`, {
    method,
    headers: { Authorization: `Bearer ${R.apiKey}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Render API ${res.status}`);
  return res.status === 204 ? {} : ((await res.json().catch(() => ({}))) as Record<string, unknown>);
}

let cached: { at: number; suspended: boolean } | null = null;

/** Whether the AI service is suspended (checked at most every 10 s). */
export async function aiSuspended(fresh = false) {
  if (!fresh && cached && Date.now() - cached.at < 10_000) return cached.suspended;
  const s = await render("");
  const suspended = s.suspended === "suspended";
  cached = { at: Date.now(), suspended };
  return suspended;
}

/** Start the AI service if it is asleep. Returns true when it had to be woken (it needs a minute or two to load). */
export async function wakeAi() {
  touchAi();
  if (!powerManaged()) return false;
  try {
    if (!(await aiSuspended())) return false;
    await render("/resume", "POST");
    cached = { at: Date.now(), suspended: false };
    console.log("[clearaid] waking the AI service");
    return true;
  } catch (e) {
    console.warn(`[clearaid] couldn't wake the AI service: ${(e as Error).message}`);
    return false;
  }
}

async function sleepIfIdle() {
  if (Date.now() - lastUse < R.idleMinutes * 60_000) return;
  try {
    if (await aiSuspended(true)) return;
    await render("/suspend", "POST");
    cached = { at: Date.now(), suspended: true };
    console.log(`[clearaid] AI service suspended after ${R.idleMinutes} minutes idle`);
  } catch (e) {
    console.warn(`[clearaid] couldn't suspend the AI service: ${(e as Error).message}`);
  }
}

let started = false;
export function startAiPower() {
  if (started || !powerManaged()) return;
  started = true;
  setInterval(() => void sleepIfIdle(), 60_000).unref();
}
