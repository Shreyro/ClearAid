"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { ArrowLeftRight, Bot, Building2, Eye, Landmark, LogOut, Menu, RotateCcw, ScrollText, Settings, ShieldCheck, Tags, Wallet, Waypoints, X } from "lucide-react";
import clsx from "clsx";
import { api, useJson } from "./hooks";
import { roleName, SignIn, type Member, type Sess } from "./console";

const MeContext = createContext<{ me: Member; reload: () => Promise<void> } | null>(null);

/** The signed-in NGO member. Only usable inside the app shell (i.e. after sign-in). */
export function useMe() {
  const ctx = useContext(MeContext);
  if (!ctx) throw new Error("useMe must be used inside AppShell");
  return ctx;
}

const NAV: { href: string; label: string; icon: typeof Waypoints }[] = [
  { href: "/", label: "Money flow", icon: Waypoints },
  { href: "/transactions", label: "Transactions", icon: ArrowLeftRight },
  { href: "/untagged", label: "Untagged", icon: Tags },
  { href: "/funds", label: "Funds", icon: Wallet },
  { href: "/sources", label: "Sources", icon: Landmark },
  { href: "/audit", label: "Audit log", icon: ScrollText },
  { href: "/settings", label: "Settings", icon: Settings },
  { href: "/copilot", label: "Copilot", icon: Bot },
];

/** Read-only donor logins only get the "where did the money go" pages (the server refuses everything else too). */
const DONOR_PAGES = ["/", "/transactions", "/funds", "/spend", "/copilot"];
const donorMayOpen = (path: string) => DONOR_PAGES.some((p) => (p === "/" ? path === "/" : path === p || path.startsWith(`${p}/`)));

export function AppShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  // Public donation links (/give/<fund>) and embeds (/embed/<key>) are for outsiders: no sign-in, no app chrome, no session lookups.
  const bare = path.startsWith("/give/") || path.startsWith("/embed/");
  const { data: sess, reload } = useJson<Sess>(bare ? null : "/api/session");
  const { data: cfg } = useJson<{ ai?: { enabled: boolean } }>(bare ? null : "/api/config");
  // The mobile drawer remembers the page it was opened on, so navigating closes it.
  const [navOpenAt, setNavOpenAt] = useState<string | null>(null);
  const navOpen = navOpenAt === path;
  const setNavOpen = (open: boolean) => setNavOpenAt(open ? path : null);
  const router = useRouter();

  useEffect(() => {
    const h = () => void reload();
    window.addEventListener("clearaid:persona", h);
    return () => window.removeEventListener("clearaid:persona", h);
  }, [reload]);

  if (bare) return <>{children}</>;
  if (!sess) return <div className="min-h-screen grid place-items-center"><div className="h-8 w-8 rounded-full border-2 border-brand border-t-transparent animate-spin" aria-label="Loading" /></div>;
  const me = sess.session.member;
  if (sess.session.role !== "ngo" || !me) return <SignIn demoLogins={sess.demoLogins} onSignedIn={reload} />;

  const isAdmin = me.role === "admin";
  const isDonor = me.role === "donor";
  // The hosted version (RENDER_MODE=YES) has no AI: hide the Copilot.
  const base = cfg?.ai?.enabled === false ? NAV.filter((n) => n.href !== "/copilot") : NAV;
  const nav = isDonor ? base.filter((n) => donorMayOpen(n.href)) : base;
  const blocked = isDonor && !donorMayOpen(path);
  const active = (href: string) => (href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`) || (href === "/transactions" && path.startsWith("/spend/")));

  async function signOut() {
    await api("/api/auth/logout", { method: "POST" });
    router.push("/");
    await reload();
  }
  async function resetDemo() {
    if (!window.confirm("Reset all data to the original demo scenario? Every change, including new logins, will be lost.")) return;
    await api("/api/admin/reset", { method: "POST" });
    router.push("/");
    router.refresh();
    window.dispatchEvent(new Event("clearaid:persona"));
    await reload();
  }

  const sidebar = (
    <div className="flex h-full flex-col">
      <Link href="/" className="flex items-center gap-2 px-4 h-14 font-semibold tracking-tight shrink-0">
        <svg viewBox="0 0 32 32" className="h-7 w-7" aria-hidden>
          <rect width="32" height="32" rx="9" fill="var(--brand)" />
          <path d="M9 17.5l4.5 4.5L23 11.5" stroke="#fff" strokeWidth="3.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span>ClearAid</span>
        <span className="text-xs font-semibold uppercase tracking-wide text-muted border border-line rounded px-1.5 py-0.5">Tracker</span>
      </Link>
      <div className="px-4 pb-3 text-xs text-muted flex items-center gap-1.5"><Building2 className="h-3.5 w-3.5" /> {me.ngoName}</div>
      <nav className="flex-1 overflow-y-auto px-2 space-y-0.5 text-sm" aria-label="Main">
        {nav.map((n) => (
          <Link key={n.href} href={n.href} aria-current={active(n.href) ? "page" : undefined} className={clsx("flex items-center gap-2.5 rounded-lg px-3 py-2", active(n.href) ? "bg-brand-wash text-brand-ink font-semibold" : "text-ink-2 hover:bg-hover hover:text-ink")}>
            <n.icon className="h-4 w-4 shrink-0" /> {n.label}
          </Link>
        ))}
      </nav>
      <div className="border-t border-line p-3">
        <div className="flex items-center gap-2.5 px-1">
          <div className="h-8 w-8 rounded-full bg-brand text-white grid place-items-center text-xs font-semibold shrink-0" aria-hidden>
            {me.name.split(" ").map((p) => p[0]).slice(0, 2).join("")}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium truncate">{me.name}</div>
            <div className="text-xs text-muted truncate flex items-center gap-1">{isAdmin && <ShieldCheck className="h-3 w-3 text-brand" />}{isDonor && <Eye className="h-3 w-3" />}{roleName(me.role)}{isDonor ? " · read-only" : ` · ${me.title}`}</div>
          </div>
          <button onClick={signOut} className="p-1.5 rounded-lg text-muted hover:text-ink hover:bg-hover" aria-label="Sign out" title="Sign out">
            <LogOut className="h-4 w-4" />
          </button>
        </div>
        {isAdmin && (
          <button onClick={resetDemo} className="mt-2 w-full text-left text-xs text-muted hover:text-critical px-1 inline-flex items-center gap-1.5">
            <RotateCcw className="h-3 w-3" /> Reset demo data
          </button>
        )}
      </div>
    </div>
  );

  return (
    <MeContext.Provider value={{ me, reload }}>
      <div className="min-h-screen lg:grid lg:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="hidden lg:block sticky top-0 h-screen border-r border-line bg-sidebar">{sidebar}</aside>
        <header className="lg:hidden sticky top-0 z-40 h-14 px-4 flex items-center gap-3 border-b border-line bg-[rgba(246,246,242,0.92)] backdrop-blur">
          <button onClick={() => setNavOpen(true)} className="p-1.5 -ml-1.5 rounded-lg hover:bg-hover" aria-label="Open menu"><Menu className="h-5 w-5" /></button>
          <span className="font-semibold">ClearAid</span>
          <span className="ml-auto text-xs text-muted truncate">{me.name}</span>
        </header>
        {navOpen && (
          <div className="lg:hidden fixed inset-0 z-50">
            <div className="absolute inset-0 bg-black/30" onClick={() => setNavOpen(false)} />
            <div className="absolute inset-y-0 left-0 w-72 max-w-[85vw] bg-sidebar shadow-xl">
              <button onClick={() => setNavOpen(false)} className="absolute right-2 top-3 p-1.5 rounded-lg hover:bg-hover" aria-label="Close menu"><X className="h-5 w-5" /></button>
              {sidebar}
            </div>
          </div>
        )}
        <main className="min-w-0">
          {blocked ? (
            <div className="p-6 lg:p-10">
              <div className="card p-6 max-w-lg">
                <h1 className="text-lg font-semibold">Not available on a donor login</h1>
                <p className="text-sm text-ink-2 mt-1">Your login is read-only: you can see where the money came from, which fund it went to and where it went next.</p>
                <Link href="/" className="btn btn-primary mt-4 w-fit">Go to Money flow</Link>
              </div>
            </div>
          ) : (
            children
          )}
        </main>
      </div>
    </MeContext.Provider>
  );
}

/** Standard page frame: title, optional subtitle and actions. */
export function Page({ title, subtitle, actions, children, wide }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <div className={clsx("mx-auto px-4 sm:px-6 py-6 sm:py-8", wide ? "max-w-[1400px]" : "max-w-6xl")}>
      <div className="flex flex-wrap items-end justify-between gap-3 mb-6">
        <div className="min-w-0">
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="text-sm text-ink-2 mt-1 max-w-3xl">{subtitle}</p>}
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  );
}
