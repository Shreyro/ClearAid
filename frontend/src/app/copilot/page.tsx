"use client";

import { Page, useMe } from "@/components/AppShell";
import { Chat } from "@/components/Chat";

export default function CopilotPage() {
  const { me } = useMe();
  return (
    <Page title="Copilot" subtitle="Ask where money came from and where it went. Claude reads the fund ledgers, bank lines and PayPal (through the PayPal Agent Toolkit). It can't tag or approve anything.">
      <div className="grid lg:grid-cols-[minmax(0,1fr)_300px] gap-6">
        <Chat
          endpoint="/api/copilot"
          title="ClearAid Copilot"
          subtitle={`Signed in as ${me.name}. It sees the funds you can see.`}
          placeholder="Ask about money in, money out, untagged lines or reconciliation…"
          height={520}
          suggestions={[
            "Where did the Cyclone Asha money come from and where did it go?",
            "What bank money is still untagged or waiting for approval?",
            "Which payments over the receipt threshold have no receipt?",
            "Reconcile the last 31 days of donations against PayPal",
          ]}
        />
        <div className="card p-5 text-sm self-start">
          <h3 className="font-semibold">Guardrails</h3>
          <ul className="mt-2 space-y-2 text-ink-2 text-xs">
            <li>It never tags, retags or suggests a tracking code. Tags come from the code in the record, the fee policy, or a named person.</li>
            <li>It can&apos;t approve tags. A second person does that on the Untagged page.</li>
            <li>The only action that moves money is a donor refund. It waits for your confirmation, is capped at the donor&apos;s unspent share, and lands on the ledger and audit log.</li>
            <li>PayPal tools come from the official <code>@paypal/agent-toolkit</code>, adapted to Claude tool use.</li>
          </ul>
        </div>
      </div>
    </Page>
  );
}
