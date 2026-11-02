"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Camera, FileText, FlaskConical, Loader2, MapPin, ReceiptText, Store, Upload, X } from "lucide-react";
import { api, ago, useJson, useLive, usd } from "@/components/hooks";
import { Pill, RiskBadge, Section, StatusPill } from "@/components/ui";
import { CAT_LABEL, type WView } from "@/components/SpendCard";

type Sess = { session: { role: string; id?: string; name?: string }; personas: { vendors: { id: string; name: string; sub: string }[] } };
type FundCard = { id: string; slug: string; title: string; status: string };
type Need = { id: string; item: string; unit: string; unitCost: number; category: string; targetQty: number; fulfilledQty: number };
type Meta = { dhash?: string; exif?: { takenAt?: string; lat?: number; lng?: number; device?: string; software?: string } };
type Prepared = { file: File; preview: string; meta: Meta };

// ------------------------------------------------------- image helpers ----

function canvasToFile(c: HTMLCanvasElement, name: string, type = "image/jpeg"): Promise<File> {
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(new File([b], name, { type })) : rej(new Error("encode failed"))), type, 0.86));
}

/** 64-bit difference hash: robust to resizing/re-encoding, used to catch reused proof photos. */
function dHash(src: CanvasImageSource) {
  const c = document.createElement("canvas");
  c.width = 9;
  c.height = 8;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(src, 0, 0, 9, 8);
  const d = ctx.getImageData(0, 0, 9, 8).data;
  const g = (x: number, y: number) => {
    const i = (y * 9 + x) * 4;
    return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  };
  let bits = 0n;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits = (bits << 1n) | (g(x, y) > g(x + 1, y) ? 1n : 0n);
  return bits.toString(16).padStart(16, "0");
}

async function prepareImage(file: File, withMeta: boolean): Promise<Prepared> {
  let meta: Meta = {};
  if (withMeta) {
    const exifr = (await import("exifr")).default;
    const t = await exifr.parse(file, { gps: true }).catch(() => null);
    if (t) {
      const when = t.DateTimeOriginal ?? t.CreateDate;
      meta.exif = {
        takenAt: when instanceof Date ? when.toISOString() : undefined,
        lat: typeof t.latitude === "number" ? t.latitude : undefined,
        lng: typeof t.longitude === "number" ? t.longitude : undefined,
        device: [t.Make, t.Model].filter(Boolean).join(" ") || undefined,
        software: t.Software,
      };
    }
  }
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
  if (withMeta) meta = { ...meta, dhash: dHash(bmp) };
  const out = await canvasToFile(c, file.name.replace(/\.\w+$/, "") + ".jpg");
  return { file: out, preview: URL.createObjectURL(out), meta };
}

function sampleReceipt(vendor: string, need: Need | undefined, qty: number, amountUsd: number) {
  const c = document.createElement("canvas");
  c.width = 900;
  c.height = 1100;
  const x = c.getContext("2d")!;
  x.fillStyle = "#fbfaf6";
  x.fillRect(0, 0, 900, 1100);
  x.fillStyle = "#0f766e";
  x.fillRect(0, 0, 900, 14);
  x.fillStyle = "#111";
  x.font = "bold 34px system-ui";
  x.fillText(vendor, 60, 90);
  x.font = "20px ui-monospace, monospace";
  x.fillStyle = "#555";
  x.fillText(`TAX INVOICE  No. INV-${Math.floor(Math.random() * 9000 + 1000)}`, 60, 130);
  x.fillText(`Date ${new Date().toISOString().slice(0, 10)}`, 60, 160);
  x.fillText("Bill to: Coastal Relief Collective (ClearAid fund)", 60, 210);
  x.strokeStyle = "#999";
  x.beginPath();
  x.moveTo(60, 250);
  x.lineTo(840, 250);
  x.stroke();
  x.fillStyle = "#222";
  x.font = "bold 22px ui-monospace, monospace";
  x.fillText("Item", 60, 290);
  x.fillText("Qty", 520, 290);
  x.fillText("Rate", 620, 290);
  x.fillText("Amount", 740, 290);
  x.font = "22px ui-monospace, monospace";
  const rate = qty > 0 ? amountUsd / qty : amountUsd;
  x.fillText((need?.item ?? "Relief supplies").slice(0, 30), 60, 335);
  x.fillText(String(qty || 1), 520, 335);
  x.fillText(rate.toFixed(2), 620, 335);
  x.fillText(amountUsd.toFixed(2), 740, 335);
  x.beginPath();
  x.setLineDash([6, 6]);
  x.moveTo(60, 380);
  x.lineTo(840, 380);
  x.stroke();
  x.setLineDash([]);
  x.font = "bold 26px ui-monospace, monospace";
  x.fillText(`TOTAL USD ${amountUsd.toFixed(2)}`, 500, 440);
  x.font = "18px ui-monospace, monospace";
  x.fillStyle = "#555";
  x.fillText("Goods delivered to relief site. Authorised signatory: ______", 60, 1040);
  return canvasToFile(c, "sample-receipt.png", "image/png");
}

function syntheticPhoto() {
  const c = document.createElement("canvas");
  c.width = 1200;
  c.height = 800;
  const x = c.getContext("2d")!;
  const g = x.createLinearGradient(0, 0, 0, 800);
  g.addColorStop(0, "#9ec9e2");
  g.addColorStop(1, "#eef6fb");
  x.fillStyle = g;
  x.fillRect(0, 0, 1200, 800);
  x.fillStyle = "#a8a29e";
  x.fillRect(0, 600, 1200, 200);
  for (let r = 0; r < 5; r++)
    for (let i = 0; i < 12 - r; i++) {
      x.fillStyle = ["#2b7bb9", "#3a8fd1", "#1f6aa5"][(i + r) % 3];
      x.fillRect(200 + i * 62 + r * 31, 540 - r * 82, 56, 78);
    }
  x.fillStyle = "rgba(0,0,0,.55)";
  x.fillRect(0, 740, 1200, 60);
  x.fillStyle = "#fff";
  x.font = "24px ui-monospace, monospace";
  x.fillText("SYNTHETIC TEST IMAGE: the AI audit should flag this", 20, 778);
  return canvasToFile(c, "synthetic-test-photo.jpg");
}

// ---------------------------------------------------------------- page ----

export default function VendorPortal() {
  const { data: sess, reload } = useJson<Sess>("/api/session");
  useEffect(() => {
    const h = () => void reload();
    window.addEventListener("clearaid:persona", h);
    return () => window.removeEventListener("clearaid:persona", h);
  }, [reload]);
  if (!sess) return <div className="mx-auto max-w-5xl px-4 py-10"><div className="card h-40 animate-pulse" /></div>;
  if (sess.session.role !== "vendor") {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 text-center">
        <Store className="h-10 w-10 text-brand mx-auto" />
        <h1 className="text-2xl font-semibold mt-3">Vendor portal</h1>
        <p className="text-ink-2 mt-2">Verified suppliers request payment here with a receipt and delivery photos. Choose a vendor:</p>
        <div className="grid sm:grid-cols-2 gap-2 mt-6 text-left">
          {sess.personas.vendors.map((d) => (
            <button
              key={d.id}
              className="card p-4 hover:border-brand"
              onClick={async () => {
                await api("/api/session", { json: { role: "vendor", id: d.id } });
                window.dispatchEvent(new Event("clearaid:persona"));
                await reload();
              }}
            >
              <div className="font-semibold">{d.name}</div>
              <div className="text-xs text-muted">{d.sub}</div>
            </button>
          ))}
        </div>
      </div>
    );
  }
  return <Portal vendorName={sess.session.name ?? "Vendor"} />;
}

function Portal({ vendorName }: { vendorName: string }) {
  const { data: funds } = useJson<{ funds: FundCard[] }>("/api/funds");
  const active = (funds?.funds ?? []).filter((f) => f.status === "active");
  const [pickedFund, setFundId] = useState("");
  const fundId = pickedFund || active[0]?.id || "";
  const { data: fund } = useJson<{ fund: { needs: Need[]; title: string } }>(fundId ? `/api/funds/${fundId}` : null);
  const mine = useJson<{ withdrawals: WView[] }>("/api/withdrawals");
  useLive(undefined, (e) => {
    if (e.kind === "withdrawal" || e.kind === "ledger") void mine.reload();
  });

  const [needId, setNeedId] = useState("");
  const need = useMemo(() => fund?.fund.needs.find((n) => n.id === needId), [fund, needId]);
  const [category, setCategory] = useState("food");
  const [qty, setQty] = useState("");
  const [amount, setAmount] = useState("");
  const [beneficiaries, setBeneficiaries] = useState("");
  const [location, setLocation] = useState("");
  const [purpose, setPurpose] = useState("");
  const [receipts, setReceipts] = useState<Prepared[]>([]);
  const [photos, setPhotos] = useState<Prepared[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ id: string; piiFound: { type: string; count: number }[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);


  async function addReceipts(files: FileList | File[]) {
    setBusy("files");
    try {
      const out: Prepared[] = [];
      for (const f of Array.from(files)) {
        if (f.type === "application/pdf") out.push({ file: f, preview: "", meta: {} });
        else out.push(await prepareImage(f, false));
      }
      setReceipts((r) => [...r, ...out].slice(0, 3));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  async function addPhotos(files: FileList | File[]) {
    setBusy("files");
    try {
      const out: Prepared[] = [];
      for (const f of Array.from(files)) out.push(await prepareImage(f, true));
      setPhotos((p) => [...p, ...out].slice(0, 6));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function submit() {
    setErr(null);
    setResult(null);
    setBusy("submit");
    try {
      const fd = new FormData();
      fd.set("fundId", fundId);
      if (needId) fd.set("needId", needId);
      fd.set("category", category);
      fd.set("amountUsd", amount);
      if (qty) fd.set("quantity", qty);
      if (beneficiaries) fd.set("beneficiaries", beneficiaries);
      if (location) fd.set("location", location);
      fd.set("purpose", purpose);
      receipts.forEach((r) => fd.append("receipts", r.file));
      photos.forEach((p) => fd.append("photos", p.file));
      fd.set("photoMeta", JSON.stringify(photos.map((p) => p.meta)));
      const r = await api<{ id: string; piiFound: { type: string; count: number }[] }>("/api/withdrawals", { method: "POST", body: fd });
      setResult(r);
      setReceipts([]);
      setPhotos([]);
      setPurpose("");
      setQty("");
      setAmount("");
      void mine.reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="text-sm text-muted">Signed in as {vendorName}</div>
      <h1 className="text-3xl font-semibold tracking-tight">Request a payment</h1>
      <p className="text-ink-2 mt-1 max-w-2xl">Upload the invoice and photos of the goods at the relief site. ClearAid redacts personal data, Claude audits the evidence, and once the NGO approves, PayPal Payouts sends the money to your PayPal account.</p>

      <div className="grid lg:grid-cols-[minmax(0,1fr)_360px] gap-6 mt-6">
        <section className="card p-5 space-y-4">
          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <label className="label">Fund</label>
              <select className="input" value={fundId} onChange={(e) => { setFundId(e.target.value); setNeedId(""); }}>
                {active.map((f) => <option key={f.id} value={f.id}>{f.title}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Which need does this fulfil?</label>
              <select
                className="input"
                value={needId}
                onChange={(e) => {
                  setNeedId(e.target.value);
                  const n = fund?.fund.needs.find((x) => x.id === e.target.value);
                  if (n) {
                    setCategory(n.category);
                    if (qty) setAmount(((Number(qty) * n.unitCost) / 100).toFixed(2));
                  }
                }}
              >
                <option value="">— Other / not listed —</option>
                {fund?.fund.needs.map((n) => <option key={n.id} value={n.id}>{n.item}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Category</label>
              <select className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
                {Object.entries(CAT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="label">Quantity{need ? ` (${need.unit})` : ""}</label>
                <input className="input" inputMode="numeric" value={qty} onChange={(e) => { setQty(e.target.value.replace(/\D/g, "")); if (need) setAmount(((Number(e.target.value.replace(/\D/g, "")) * need.unitCost) / 100).toFixed(2)); }} />
              </div>
              <div>
                <label className="label">Amount (USD)</label>
                <input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} />
              </div>
            </div>
            {need && <p className="sm:col-span-2 text-xs text-muted -mt-1">Expected about {usd(need.unitCost)} per {need.unit.replace(/s$/, "")}. Prices well above this are flagged.</p>}
            <div>
              <label className="label">People served (approx.)</label>
              <input className="input" inputMode="numeric" value={beneficiaries} onChange={(e) => setBeneficiaries(e.target.value.replace(/\D/g, ""))} />
            </div>
            <div>
              <label className="label">Delivery location</label>
              <input className="input" placeholder="Camp, village or ward" value={location} onChange={(e) => setLocation(e.target.value)} />
            </div>
          </div>
          <div>
            <label className="label">What was delivered?</label>
            <textarea className="input" rows={3} value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="e.g. 1,500 jerrycans delivered to Arjyapalli camp, handed to the camp coordinator for distribution" />
            <p className="text-xs text-muted mt-1">Names, phone numbers and ID numbers are redacted automatically before anything is published.</p>
          </div>

          <div className="grid sm:grid-cols-2 gap-4">
            <DropZone icon={ReceiptText} title="Receipt / invoice" hint="JPG, PNG or PDF" accept="image/jpeg,image/png,image/webp,application/pdf" onFiles={addReceipts} items={receipts} onRemove={(i) => setReceipts((r) => r.filter((_, j) => j !== i))}>
              <button
                type="button"
                className="btn btn-ghost !py-1 text-xs"
                onClick={async () => {
                  const f = await sampleReceipt(vendorName, need, Number(qty) || 0, Number(amount) || 0);
                  setReceipts((r) => [...r, { file: f, preview: URL.createObjectURL(f), meta: {} }].slice(0, 3));
                }}
              >
                <FileText className="h-3.5 w-3.5" /> Generate sample receipt
              </button>
            </DropZone>
            <DropZone icon={Camera} title="Delivery photos" hint="Use your phone camera on site; time and GPS are read from the photo" accept="image/jpeg,image/png,image/webp" capture onFiles={addPhotos} items={photos} onRemove={(i) => setPhotos((p) => p.filter((_, j) => j !== i))}>
              <button
                type="button"
                className="btn btn-ghost !py-1 text-xs"
                onClick={async () => {
                  const f = await syntheticPhoto();
                  await addPhotos([f]);
                }}
              >
                <FlaskConical className="h-3.5 w-3.5" /> Add synthetic test photo
              </button>
            </DropZone>
          </div>

          {err && <p className="text-sm text-critical">{err}</p>}
          {result && (
            <div className="rounded-xl bg-brand-wash border border-[#bfe3dc] p-3 text-sm">
              Submitted <Link href={`/spend/${result.id}`} className="font-mono underline">{result.id}</Link>. The AI audit is running; you&apos;ll see the result below in a few seconds.
              {result.piiFound.length > 0 && <span className="block text-xs text-ink-2 mt-1">Redacted before publishing: {result.piiFound.map((p) => `${p.count}× ${p.type}`).join(", ")}</span>}
            </div>
          )}
          <button className="btn btn-primary w-full sm:w-auto" disabled={Boolean(busy) || !fundId || !amount || !purpose || !receipts.length} onClick={submit}>
            {busy === "submit" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Submit for audit &amp; approval
          </button>
        </section>

        <Section title="My requests">
          <ul className="space-y-3">
            {(mine.data?.withdrawals ?? []).map((w) => (
              <li key={w.id}>
                <Link href={`/spend/${w.id}`} className="block rounded-xl border border-line p-3 hover:border-line-strong">
                  <div className="flex justify-between gap-2 text-sm">
                    <span className="font-medium truncate">{w.fundTitle}</span>
                    <span className="font-semibold tnum">{usd(w.amount)}</span>
                  </div>
                  <div className="text-xs text-ink-2 mt-0.5 line-clamp-1">{w.purpose}</div>
                  <div className="flex flex-wrap gap-1.5 mt-2 items-center">
                    <StatusPill status={w.status} />
                    {w.audit && w.status !== "auditing" && <RiskBadge score={w.audit.riskScore} verdict={w.audit.verdict} />}
                    <span className="text-[11px] text-muted ml-auto">{ago(w.createdAt)}</span>
                  </div>
                  {w.payout && <div className="text-[11px] text-muted mt-1.5 font-mono">PayPal payout {w.payout.batchId}</div>}
                </Link>
              </li>
            ))}
            {mine.data && !mine.data.withdrawals.length && <li className="text-sm text-muted">No requests yet.</li>}
          </ul>
        </Section>
      </div>
    </div>
  );
}

function DropZone({
  icon: Icon,
  title,
  hint,
  accept,
  capture,
  onFiles,
  items,
  onRemove,
  children,
}: {
  icon: typeof Camera;
  title: string;
  hint: string;
  accept: string;
  capture?: boolean;
  onFiles: (f: FileList) => void;
  items: Prepared[];
  onRemove: (i: number) => void;
  children?: React.ReactNode;
}) {
  const [over, setOver] = useState(false);
  return (
    <div
      className={`rounded-xl border-2 border-dashed p-4 ${over ? "border-brand bg-brand-wash" : "border-line"}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); if (e.dataTransfer.files.length) onFiles(e.dataTransfer.files); }}
    >
      <div className="flex items-center gap-2 font-semibold text-sm"><Icon className="h-4 w-4" /> {title}</div>
      <p className="text-xs text-muted mt-0.5">{hint}</p>
      <div className="flex flex-wrap gap-2 mt-3">
        <label className="btn btn-ghost !py-1 text-xs cursor-pointer">
          <Upload className="h-3.5 w-3.5" /> Choose
          <input type="file" className="hidden" accept={accept} multiple {...(capture ? { capture: "environment" as const } : {})} onChange={(e) => e.target.files && onFiles(e.target.files)} />
        </label>
        {children}
      </div>
      {items.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-3">
          {items.map((it, i) => (
            <div key={i} className="relative">
              {it.preview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={it.preview} alt="" className="h-16 w-20 object-cover rounded-md border border-line" />
              ) : (
                <div className="h-16 w-20 rounded-md border border-line grid place-items-center text-[10px] text-muted">PDF</div>
              )}
              <button className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-ink text-white grid place-items-center" onClick={() => onRemove(i)} aria-label="Remove">
                <X className="h-3 w-3" />
              </button>
              {it.meta.exif?.lat != null && <MapPin className="absolute bottom-1 left-1 h-3.5 w-3.5 text-white drop-shadow" />}
            </div>
          ))}
        </div>
      )}
      {items.some((i) => i.meta.dhash) && (
        <div className="mt-2 flex flex-wrap gap-1">
          {items.map((i, k) => i.meta.dhash && <Pill key={k}>{i.meta.exif?.takenAt ? "time ✓" : "no time"} · {i.meta.exif?.lat != null ? "GPS ✓" : "no GPS"}</Pill>)}
        </div>
      )}
    </div>
  );
}
