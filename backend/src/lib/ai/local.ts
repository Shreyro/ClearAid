import fs from "node:fs";
import path from "node:path";
import { z } from "zod/v4";
import { config } from "../config";
import { uploadsDir } from "../db";
import type { StoredFile } from "../types";

/**
 * Every AI feature runs on the local model through Ollama: the same model the
 * Copilot answers with (COPILOT_MODEL, llama3.1:8b by default), kept loaded
 * between calls. Only work that has to look at an image (receipts, delivery
 * photos) needs a model that can see; if the main model can't, the local
 * vision model (LOCAL_VISION_MODEL, llava by default) is used for that call.
 *
 * Nothing leaves the machine. Callers always have a non-AI fallback, so a
 * stopped Ollama or a missing model only means less help, never an error.
 */

const L = config.local;
/**
 * How long Ollama keeps a model in memory after a call. The main model stays
 * loaded so the next call starts instantly; a separate vision model is let go
 * soon after, so two big models don't sit in memory together.
 */
const keepAlive = (model: string) => (model === L.model ? "30m" : "5m");

const capabilities = new Map<string, Promise<string[]>>();
function capsOf(model: string) {
  let p = capabilities.get(model);
  if (!p) {
    p = fetch(`${L.ollamaUrl}/api/show`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model }), signal: AbortSignal.timeout(10_000) })
      .then((r) => (r.ok ? (r.json() as Promise<{ capabilities?: string[] }>) : { capabilities: [] }))
      .then((j) => j.capabilities ?? [])
      .catch(() => {
        capabilities.delete(model); // Ollama was down: ask again next time
        return [];
      });
    capabilities.set(model, p);
  }
  return p;
}

/** The model for a call: the main local model, unless images are involved and it can't see them. */
export async function modelFor(needsVision: boolean) {
  if (!needsVision) return L.model;
  return (await capsOf(L.model)).includes("vision") ? L.model : L.visionModel;
}

/** Name of the text model, for labels ("local · llama3.1:8b"). */
export const localModel = () => L.model;

/** An uploaded image as base64 for the vision model, or null if it isn't one (PDFs can't be looked at). */
export function imageOf(f: StoredFile): string | null {
  if (!["image/jpeg", "image/png", "image/webp"].includes(f.mime)) return null;
  const p = path.join(uploadsDir(), f.id);
  return fs.existsSync(p) ? fs.readFileSync(p).toString("base64") : null;
}

type Chat = { message?: { content?: string }; error?: string };

async function chat(model: string, body: Record<string, unknown>, timeoutMs: number): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${L.ollamaUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, stream: false, keep_alive: keepAlive(model), ...body }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error(`The local model isn't reachable at ${L.ollamaUrl}`);
  }
  const j = (await res.json().catch(() => ({}))) as Chat;
  if (!res.ok) throw new Error(j.error?.includes("not found") ? `The local model ${model} isn't downloaded (ollama pull ${model})` : `Local model error: ${j.error ?? res.status}`);
  return j.message?.content ?? "";
}

/**
 * One structured call: the model must answer with JSON matching `schema`
 * (Ollama constrains the output to the schema). The answer is checked with
 * the schema too; a malformed answer is retried once, then it throws.
 */
export async function structured<S extends z.ZodType>(args: {
  schema: S;
  system: string;
  prompt: string;
  /** Base64 images the model should look at (switches to a vision-capable model). */
  images?: string[];
  maxTokens?: number;
  timeoutMs?: number;
}): Promise<{ data: z.infer<S>; model: string }> {
  if (!L.ai) throw new Error("Local AI is switched off (LOCAL_AI=off)");
  const images = (args.images ?? []).filter(Boolean);
  const model = await modelFor(images.length > 0);
  const format = z.toJSONSchema(args.schema);
  let last = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const content = attempt === 0 ? args.prompt : `${args.prompt}\n\nYour last answer wasn't valid. Reply with JSON only, exactly matching the schema.`;
    const raw = await chat(
      model,
      {
        format,
        messages: [
          { role: "system", content: `${args.system}\n\nReply with JSON only.` },
          { role: "user", content, ...(images.length ? { images } : {}) },
        ],
        options: { temperature: 0, num_ctx: 8192, num_predict: args.maxTokens ?? 2048 },
      },
      args.timeoutMs ?? 240_000,
    );
    try {
      const parsed = args.schema.safeParse(JSON.parse(raw));
      if (parsed.success) return { data: parsed.data, model };
      last = parsed.error.issues[0]?.message ?? "schema mismatch";
    } catch {
      last = "not JSON";
    }
  }
  throw new Error(`The local model's answer didn't match what was asked (${last})`);
}
