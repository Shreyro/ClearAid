"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Bot, ChevronDown, CreditCard, HandHeart, Store, UserRound, Building2 } from "lucide-react";
import clsx from "clsx";
import { api, useJson } from "./hooks";

type SessionResp = {
  session: { role: string; id?: string; name?: string };
  personas: { donors: P[]; ngo: P[]; vendors: P[] };
};
type P = { id: string; name: string; sub: string };
type Cfg = { paypal: { live: boolean; env: string }; ai: { enabled: boolean; model: string } };

export function Header() {
  const { data, reload } = useJson<SessionResp>("/api/session");
  const { data: cfg } = useJson<Cfg>("/api/config");
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const path = usePathname();

  useEffect(() => {
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, []);
  useEffect(() => {
    void reload();
  }, [path, reload]);

  async function choose(role: string, id?: string) {
    await api("/api/session", { json: { role, id } });
    setOpen(false);
    await reload();
    if (role === "ngo") router.push("/ngo");
    else if (role === "vendor") router.push("/vendor");
    else if (role === "donor") router.push("/me");
    router.refresh();
    window.dispatchEvent(new Event("clearaid:persona"));
  }

  const role = data?.session.role ?? "public";
  const icon = { donor: HandHeart, ngo: Building2, vendor: Store, public: UserRound }[role] ?? UserRound;
  const Icon = icon;
  const nav = [
    { href: "/", label: "Funds" },
    { href: "/me", label: "My impact" },
    { href: "/ngo", label: "NGO console" },
    { href: "/vendor", label: "Vendor portal" },
  ];

  return (
    <header className="sticky top-0 z-40 bg-[rgba(246,246,242,0.88)] backdrop-blur border-b border-line">
      <div className="mx-auto max-w-6xl px-4 h-14 flex items-center gap-4">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight shrink-0">
          <svg viewBox="0 0 32 32" className="h-7 w-7" aria-hidden>
            <rect width="32" height="32" rx="9" fill="var(--brand)" />
            <path d="M9 17.5l4.5 4.5L23 11.5" stroke="#fff" strokeWidth="3.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>ClearAid</span>
        </Link>
        <nav className="hidden md:flex items-center gap-1 text-sm">
          {nav.map((n) => (
            <Link key={n.href} href={n.href} className={clsx("px-3 py-1.5 rounded-lg", (n.href === "/" ? path === "/" || path.startsWith("/funds") : path.startsWith(n.href)) ? "bg-surface border border-line font-semibold" : "text-ink-2 hover:text-ink")}>
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          {cfg && (
            <div className="hidden lg:flex items-center gap-1.5 text-[11px] font-semibold">
              <span title={cfg.paypal.live ? `PayPal ${cfg.paypal.env}` : "PayPal calls are simulated"} className={clsx("inline-flex items-center gap-1 rounded-full px-2 py-1", cfg.paypal.live ? "bg-[#e8eefc] text-paypal" : "bg-[#f1f0ec] text-ink-2")}>
                <CreditCard className="h-3 w-3" /> {cfg.paypal.live ? `PayPal ${cfg.paypal.env}` : "PayPal simulated"}
              </span>
              <span title={cfg.ai.enabled ? cfg.ai.model : "Heuristic fallbacks"} className={clsx("inline-flex items-center gap-1 rounded-full px-2 py-1", cfg.ai.enabled ? "bg-brand-wash text-brand-ink" : "bg-[#f1f0ec] text-ink-2")}>
                <Bot className="h-3 w-3" /> {cfg.ai.enabled ? "Claude on" : "AI offline"}
              </span>
            </div>
          )}
          <div ref={ref} className="relative">
            <button onClick={() => setOpen((o) => !o)} className="btn btn-ghost !py-1.5 !px-2.5" aria-haspopup="menu" aria-expanded={open}>
              <Icon className="h-4 w-4" />
              <span className="max-w-[9rem] truncate">{data?.session.name ?? "Public visitor"}</span>
              <ChevronDown className="h-3.5 w-3.5 text-muted" />
            </button>
            {open && data && (
              <div role="menu" className="absolute right-0 mt-2 w-72 card shadow-xl p-2 max-h-[70vh] overflow-auto text-sm">
                <div className="px-2 py-1.5 text-[11px] uppercase tracking-wide text-muted font-semibold">Demo personas</div>
                <PersonaRow active={role === "public"} title="Public visitor" sub="What anyone sees" onClick={() => choose("public")} />
                <Group label="Donors" items={data.personas.donors} role="donor" current={data.session} onPick={choose} />
                <Group label="NGO admins" items={data.personas.ngo} role="ngo" current={data.session} onPick={choose} />
                <Group label="Vendors" items={data.personas.vendors} role="vendor" current={data.session} onPick={choose} />
                <div className="border-t border-line mt-2 pt-2 px-2">
                  <button
                    className="text-xs text-muted hover:text-critical"
                    onClick={async () => {
                      if (!confirm("Reset all demo data to the original scenario?")) return;
                      await api("/api/admin/reset", { method: "POST" });
                      router.push("/");
                      router.refresh();
                      window.dispatchEvent(new Event("clearaid:persona"));
                      await reload();
                    }}
                  >
                    Reset demo data
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      <nav className="md:hidden flex gap-1 px-4 pb-2 overflow-x-auto text-sm">
        {nav.map((n) => (
          <Link key={n.href} href={n.href} className="px-2.5 py-1 rounded-lg text-ink-2 whitespace-nowrap">
            {n.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}

function Group({ label, items, role, current, onPick }: { label: string; items: P[]; role: string; current: { role: string; id?: string }; onPick: (r: string, id: string) => void }) {
  return (
    <>
      <div className="px-2 pt-2 pb-1 text-[11px] uppercase tracking-wide text-muted font-semibold">{label}</div>
      {items.map((p) => (
        <PersonaRow key={p.id} active={current.role === role && current.id === p.id} title={p.name} sub={p.sub} onClick={() => onPick(role, p.id)} />
      ))}
    </>
  );
}

function PersonaRow({ active, title, sub, onClick }: { active: boolean; title: string; sub: string; onClick: () => void }) {
  return (
    <button role="menuitem" onClick={onClick} className={clsx("w-full text-left rounded-lg px-2 py-1.5 hover:bg-[#f4f3ef]", active && "bg-brand-wash")}>
      <div className="font-medium">{title}</div>
      <div className="text-xs text-muted truncate">{sub}</div>
    </button>
  );
}
