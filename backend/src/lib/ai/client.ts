import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod/v4";
import { aiEnabled, config } from "../config";

let client: Anthropic | null = null;

export function claude(): Anthropic | null {
  if (!aiEnabled()) return null;
  client ??= new Anthropic({ apiKey: config.anthropicKey });
  return client;
}

export const MODEL = () => config.claudeModel;

/** Opt into server-side refusal fallbacks (routes declines to a fallback model). */
export const FALLBACK = {
  betas: ["server-side-fallback-2026-07-01"] as Anthropic.Beta.AnthropicBeta[],
  fallbacks: "default" as const,
};

type Effort = "low" | "medium" | "high";

/**
 * One structured-output call. Returns the parsed object, or throws if the model
 * refused or the output did not match the schema.
 */
export async function structured<S extends z.ZodType>(args: {
  schema: S;
  system: string;
  content: Anthropic.Beta.BetaContentBlockParam[] | string;
  effort?: Effort;
  maxTokens?: number;
}): Promise<z.infer<S>> {
  const c = claude();
  if (!c) throw new Error("AI disabled");
  const res = await c.beta.messages.parse({
    model: MODEL(),
    max_tokens: args.maxTokens ?? 8000,
    ...FALLBACK,
    system: args.system,
    output_config: { effort: args.effort ?? "medium", format: betaZodOutputFormat(args.schema) },
    messages: [{ role: "user", content: args.content }],
  });
  if (res.stop_reason === "refusal") throw new Error("The model declined this request");
  if (res.parsed_output == null) throw new Error("Model output did not match the expected schema");
  return res.parsed_output as z.infer<S>;
}
