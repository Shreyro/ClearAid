import type Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { claude, FALLBACK, MODEL } from "./client";

type Msg = Anthropic.Beta.BetaMessageParam;

export interface AgentTool {
  name: string;
  description: string;
  input_schema: Anthropic.Beta.BetaTool["input_schema"];
  /** Money-moving tools pause the loop until a human confirms. */
  gated?: boolean;
  run: (input: Record<string, unknown>) => Promise<unknown>;
}

export interface ToolTrace {
  name: string;
  input: unknown;
  ok: boolean;
  summary: string;
}

export interface AgentTurn {
  conversationId: string;
  reply: string;
  trace: ToolTrace[];
  pending?: { name: string; input: unknown; description: string }[];
}

interface Conversation {
  owner: string;
  messages: Msg[];
  pendingIds?: string[];
  updatedAt: number;
}

// Conversations live server-side so the client can never forge tool calls or
// tamper with history (and thinking blocks round-trip untouched).
const g = globalThis as unknown as { __clearaidConvos?: Map<string, Conversation> };
const convos: Map<string, Conversation> = (g.__clearaidConvos ??= new Map());

/** Append user text, merging into a trailing user turn so roles keep alternating. */
function pushUserText(messages: Msg[], text: string) {
  const last = messages[messages.length - 1];
  if (last?.role === "user") {
    const content = Array.isArray(last.content) ? last.content : [{ type: "text" as const, text: last.content }];
    last.content = [...content, { type: "text", text }];
  } else messages.push({ role: "user", content: text });
}

function gc() {
  const cutoff = Date.now() - 2 * 3600_000;
  for (const [k, v] of convos) if (v.updatedAt < cutoff) convos.delete(k);
}

const short = (v: unknown) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 160 ? `${s.slice(0, 157)}…` : s;
};

async function execute(tools: AgentTool[], block: Anthropic.Beta.BetaToolUseBlock, trace: ToolTrace[], declined = false) {
  const tool = tools.find((t) => t.name === block.name);
  let content: string;
  let ok = true;
  if (!tool) {
    content = `Unknown tool ${block.name}`;
    ok = false;
  } else if (declined) {
    content = "The user declined this action. Do not retry it; acknowledge and suggest alternatives if useful.";
    ok = false;
  } else {
    try {
      const out = await tool.run((block.input ?? {}) as Record<string, unknown>);
      content = typeof out === "string" ? out : JSON.stringify(out);
    } catch (e) {
      content = `Error: ${(e as Error).message}`;
      ok = false;
    }
  }
  trace.push({ name: block.name, input: block.input, ok, summary: short(content) });
  return { type: "tool_result" as const, tool_use_id: block.id, content: content.slice(0, 60_000), is_error: !ok };
}

export async function agentTurn(args: {
  owner: string;
  system: string;
  tools: AgentTool[];
  conversationId?: string;
  userMessage?: string;
  confirm?: boolean;
  effort?: "low" | "medium" | "high";
  maxSteps?: number;
}): Promise<AgentTurn> {
  gc();
  const c = claude();
  if (!c) throw new Error("AI disabled");
  const id = args.conversationId && convos.has(args.conversationId) ? args.conversationId : randomUUID();
  const convo = convos.get(id) ?? { owner: args.owner, messages: [], updatedAt: Date.now() };
  if (convo.owner !== args.owner) throw new Error("Conversation belongs to another user");
  convos.set(id, convo);
  const trace: ToolTrace[] = [];

  if (convo.pendingIds) {
    // Resume after a confirmation decision: answer every tool call of the last turn in one message.
    const last = convo.messages[convo.messages.length - 1];
    const blocks = (Array.isArray(last.content) ? last.content : []).filter(
      (b): b is Anthropic.Beta.BetaToolUseBlock => (b as { type: string }).type === "tool_use",
    );
    const results = [];
    for (const b of blocks) {
      const isGated = convo.pendingIds.includes(b.id);
      results.push(await execute(args.tools, b, trace, isGated && args.confirm !== true));
    }
    convo.messages.push({ role: "user", content: results });
    convo.pendingIds = undefined;
    if (args.userMessage) pushUserText(convo.messages, args.userMessage);
  } else if (args.userMessage) {
    pushUserText(convo.messages, args.userMessage);
  }

  const toolDefs: Anthropic.Beta.BetaTool[] = args.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));

  let reply = "";
  for (let step = 0; step < (args.maxSteps ?? 8); step++) {
    const res = await c.beta.messages.create({
      model: MODEL(),
      max_tokens: 8000,
      ...FALLBACK,
      system: args.system,
      tools: toolDefs,
      output_config: { effort: args.effort ?? "low" },
      messages: convo.messages,
    });
    convo.messages.push({ role: "assistant", content: res.content as Anthropic.Beta.BetaContentBlockParam[] });
    const text = res.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (text) reply = text;

    if (res.stop_reason === "refusal") {
      reply ||= "I can't help with that request.";
      break;
    }
    if (res.stop_reason === "pause_turn") continue;
    if (res.stop_reason !== "tool_use") break;

    const uses = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    const gatedUses = uses.filter((u) => args.tools.find((t) => t.name === u.name)?.gated);
    if (gatedUses.length) {
      convo.pendingIds = gatedUses.map((u) => u.id);
      convo.updatedAt = Date.now();
      return {
        conversationId: id,
        reply,
        trace,
        pending: gatedUses.map((u) => ({
          name: u.name,
          input: u.input,
          description: args.tools.find((t) => t.name === u.name)!.description.split(".")[0],
        })),
      };
    }
    const results = [];
    for (const u of uses) results.push(await execute(args.tools, u, trace));
    convo.messages.push({ role: "user", content: results });
    reply = "";
  }
  convo.updatedAt = Date.now();
  return { conversationId: id, reply: reply || "Done.", trace };
}
