"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import { Page, useMe } from "@/components/AppShell";
import { Access, FundAdmin, Team, Vendors } from "@/components/console";
import { Controls } from "@/components/Controls";
import { Embeds } from "@/components/Embeds";

const TABS = [
  { id: "team", label: "Team", admin: false },
  { id: "access", label: "Fund access", admin: false },
  { id: "funds", label: "Funds & tracking codes", admin: true },
  { id: "controls", label: "Controls", admin: true },
  { id: "payees", label: "Payees", admin: true },
  { id: "publish", label: "Public embeds", admin: true },
] as const;
type Tab = (typeof TABS)[number]["id"];

export default function SettingsPage() {
  const { me, reload } = useMe();
  const isAdmin = me.role === "admin";
  const tabs = TABS.filter((t) => !t.admin || isAdmin);
  const [tab, setTab] = useState<Tab>("team");

  // Deep links (?tab=…) from other pages and the old /team and /vendors URLs.
  useEffect(() => {
    const want = new URLSearchParams(window.location.search).get("tab");
    /* eslint-disable-next-line react-hooks/set-state-in-effect */
    if (want && TABS.some((t) => t.id === want && (!t.admin || isAdmin))) setTab(want as Tab);
  }, [isAdmin]);

  function choose(t: Tab) {
    setTab(t);
    window.history.replaceState(null, "", `/settings?tab=${t}`);
  }

  return (
    <Page title="Settings" subtitle={isAdmin ? "People, who can see which fund, funds and their tracking codes, tracking controls (sign-off, receipts, bank fees), named payees and what is published on your website. Every change is written to the audit log." : "Your team and the funds you have access to."}>
      <div className="flex gap-1 border-b border-line mb-6 overflow-x-auto" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => choose(t.id)} className={clsx("px-3 pb-2.5 text-sm font-semibold border-b-2 -mb-px whitespace-nowrap", tab === t.id ? "border-brand text-ink" : "border-transparent text-muted hover:text-ink")}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === "team" && <Team me={me} onSelfChange={reload} />}
      {tab === "access" && <Access me={me} />}
      {tab === "funds" && isAdmin && <FundAdmin />}
      {tab === "controls" && isAdmin && <Controls />}
      {tab === "payees" && isAdmin && <Vendors />}
      {tab === "publish" && isAdmin && <Embeds />}
    </Page>
  );
}
