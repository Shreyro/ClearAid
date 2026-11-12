import { audit } from "@/lib/audit";
import { getDb, mutate, nowIso } from "@/lib/db";
import { entryByKey, fileInUse, metaOf, metaView, tagsOf } from "@/lib/entry-meta";
import { publish } from "@/lib/events";
import { handle, json } from "@/lib/http";
import { fmt } from "@/lib/money";
import { actorOf, getSession, HttpError, requireNgo, visibleFunds } from "@/lib/session";

type Body =
  | { action: "tags"; key?: string; tagIds?: string[] }
  | { action: "attach"; key?: string; fileId?: string; kind?: string }
  | { action: "detach"; key?: string; fileId?: string };

const KINDS = ["invoice", "receipt", "other"] as const;

/**
 * Add to a transaction after the fact: its category tags, and invoices,
 * receipts or other documents. Staff, on the funds they can see. The ledger
 * entry itself never changes; every change goes in the audit log.
 */
export const POST = handle(async (req: Request) => {
  const me = await requireNgo();
  const s = await getSession();
  const b = (await req.json()) as Body;
  const actor = actorOf(me);
  const out = mutate((db) => {
    const key = String(b.key ?? "");
    const e = entryByKey(db, key);
    if (!e || !visibleFunds(db, s).some((f) => f.id === e.fundId)) throw new HttpError(404, "Transaction not found");
    const fundTitle = db.funds.find((f) => f.id === e.fundId)?.title ?? "";
    const label = `${e.amount ? fmt(Math.abs(e.amount)) : "entry"} ${e.amount < 0 ? "out of" : "into"} ${fundTitle} (${e.ts.slice(0, 10)}, #${e.seq})`;
    const meta = (metaOf(db)[key] ??= {});

    if (b.action === "tags") {
      const want = [...new Set((b.tagIds ?? []).map(String))].slice(0, 20);
      const tags = tagsOf(db).filter((t) => t.ngoId === me.ngoId);
      for (const id of want) if (!tags.some((t) => t.id === id)) throw new HttpError(400, "Unknown tag");
      const before = meta.tagIds ?? [];
      const added = want.filter((id) => !before.includes(id));
      const removed = before.filter((id) => !want.includes(id));
      if (!added.length && !removed.length) throw new HttpError(400, "No change");
      meta.tagIds = want;
      const names = (ids: string[]) => ids.map((id) => `"${tags.find((t) => t.id === id)?.name ?? id}"`).join(", ");
      audit(db, { actor, action: "transaction.tagged", fundId: e.fundId, targetId: key, summary: `Tags on ${label}: ${[added.length && `added ${names(added)}`, removed.length && `removed ${names(removed)}`].filter(Boolean).join("; ")}` });
      return "Tags saved.";
    }

    if (b.action === "attach") {
      const kind = (KINDS as readonly string[]).includes(b.kind ?? "") ? (b.kind as (typeof KINDS)[number]) : "invoice";
      const file = db.files.find((f) => f.id === b.fileId && f.kind === "receipt" && !f.public && f.scan?.ngoId === me.ngoId);
      if (!file) throw new HttpError(400, "Upload the document first");
      const used = fileInUse(db, file.id);
      if (used) throw new HttpError(409, `This exact file is already attached to ${used}`);
      // A recorded payment without its receipt gets it there, so its own record is complete too.
      const payment = e.type === "expense" ? (db.payments ?? []).find((p) => p.id === e.ref) : undefined;
      if (payment && !payment.receipt && kind !== "other") {
        payment.receipt = { fileId: file.id, engine: file.scan?.engine ?? "none", extraction: file.scan?.extraction, note: file.scan?.note };
        audit(db, { actor, action: "transaction.document_added", fundId: e.fundId, targetId: key, summary: `Added the ${kind} for ${label}: it's now the recorded payment's receipt`, meta: { sha256: file.sha256 } });
        return `The ${kind} is attached (as the payment's receipt).`;
      }
      if ((meta.docs?.length ?? 0) >= 10) throw new HttpError(400, "Up to 10 documents per transaction");
      (meta.docs ??= []).push({ fileId: file.id, kind, byId: me.id, byName: me.name, at: nowIso() });
      audit(db, { actor, action: "transaction.document_added", fundId: e.fundId, targetId: key, summary: `Added a${kind === "other" ? " document" : `n ${kind}`} to ${label}`, meta: { sha256: file.sha256 } });
      return `The ${kind === "other" ? "document" : kind} is attached.`;
    }

    if (b.action === "detach") {
      const d = meta.docs?.find((x) => x.fileId === b.fileId);
      if (!d) throw new HttpError(404, "That document isn't attached here");
      if (me.role !== "admin" && d.byId !== me.id) throw new HttpError(403, "Only the person who attached it, or an admin, can remove it");
      meta.docs = meta.docs!.filter((x) => x !== d);
      audit(db, { actor, action: "transaction.document_removed", fundId: e.fundId, targetId: key, summary: `Removed a ${d.kind} from ${label}` });
      return "Removed. The file stays stored, and the audit log keeps a record.";
    }
    throw new HttpError(400, "Unknown action");
  });
  publish({ kind: "bank" });
  return json({ ok: true, message: out, ...metaView(getDb(), String(b.key ?? "")) });
});
