"use client";

import Link from "next/link";
import { EyeOff, MapPin, Users } from "lucide-react";
import { ago, usd } from "./hooks";
import { RiskBadge, StatusPill } from "./ui";

export type WView = {
  id: string;
  fundSlug: string;
  fundTitle: string;
  vendor: { id: string; name: string; location: string; verified: boolean } | null;
  amount: number;
  category: string;
  need: { item: string; unit: string; unitCost: number } | null;
  quantity?: number;
  beneficiaries?: number;
  location?: string;
  purpose: string;
  purposeRaw?: string;
  piiFound: { type: string; count: number }[];
  status: string;
  audit?: {
    engine: string;
    seeded?: boolean;
    model?: string;
    riskScore: number;
    verdict: string;
    summary: string;
    ranAt: string;
    checks: { id: string; label: string; status: string; detail: string; source: string }[];
    receipt?: { vendorName: string | null; date: string | null; total: number | null; currency: string | null; lineItems: { description: string; quantity: number | null; amount: number | null }[]; legible: boolean };
    photos: { fileId: string; depicts: string; matchesClaim: boolean; estimatedQuantity: number | null; containsIdentifiablePeople: boolean; concerns: string[] }[];
  };
  approvals: { name: string; decision: string; note?: string; at: string; by?: string }[];
  requiredApprovals: number;
  payout?: { batchId: string; status: string; live: boolean; at: string };
  receipts: { id: string; name: string; mime: string; url: string; public: boolean; exif?: { takenAt?: string; lat?: number; lng?: number; device?: string } }[];
  photos: { id: string; name: string; mime: string; url: string; public: boolean; exif?: { takenAt?: string; lat?: number; lng?: number; device?: string } }[];
  hiddenFiles: number;
  createdAt: string;
  paidAt?: string;
  donorsCharged: number;
};

export const CAT_LABEL: Record<string, string> = {
  food: "Food",
  water: "Water & sanitation",
  shelter: "Shelter",
  medical: "Medical",
  hygiene: "Hygiene kits",
  logistics: "Logistics",
  cash_aid: "Cash aid",
  admin: "Admin",
};

export function SpendCard({ w, flash }: { w: WView; flash?: boolean }) {
  return (
    <Link href={`/spend/${w.id}`} className={`block rounded-xl border border-line p-4 hover:border-line-strong transition-colors ${flash ? "flash" : ""}`}>
      <div className="flex flex-wrap items-center gap-2 justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-semibold truncate">{w.vendor?.name}</span>
          <span className="text-xs text-muted">{CAT_LABEL[w.category]}</span>
        </div>
        <span className={`font-semibold tnum ${w.status === "rejected" ? "line-through text-muted" : ""}`}>{usd(w.amount)}</span>
      </div>
      <p className="text-sm text-ink-2 mt-1.5 line-clamp-2">{w.purpose}</p>
      <div className="flex flex-wrap items-center gap-2 mt-3">
        <StatusPill status={w.status} />
        {w.audit && <RiskBadge score={w.audit.riskScore} verdict={w.audit.verdict} />}
        {w.location && (
          <span className="text-xs text-muted inline-flex items-center gap-1">
            <MapPin className="h-3 w-3" /> {w.location}
          </span>
        )}
        {w.beneficiaries ? (
          <span className="text-xs text-muted inline-flex items-center gap-1">
            <Users className="h-3 w-3" /> {w.beneficiaries.toLocaleString()} people
          </span>
        ) : null}
        <span className="text-xs text-muted ml-auto">{ago(w.paidAt ?? w.createdAt)}</span>
      </div>
      {(w.photos.length > 0 || w.hiddenFiles > 0) && (
        <div className="flex gap-2 mt-3">
          {w.photos.slice(0, 3).map((p) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={p.id} src={p.url} alt={`Delivery proof from ${w.vendor?.name}`} className="h-14 w-20 object-cover rounded-md border border-line" loading="lazy" />
          ))}
          {w.hiddenFiles > 0 && (
            <span className="h-14 w-20 rounded-md border border-dashed border-line-strong text-xs text-muted grid place-items-center text-center px-1">
              <EyeOff className="h-3.5 w-3.5 mx-auto" />
              {w.hiddenFiles} private
            </span>
          )}
        </div>
      )}
    </Link>
  );
}
