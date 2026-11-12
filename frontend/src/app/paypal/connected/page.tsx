"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { CheckCircle2, CreditCard, Loader2 } from "lucide-react";
import { Page } from "@/components/AppShell";
import { api } from "@/components/hooks";

/**
 * Where PayPal sends someone back after they logged in and allowed ClearAid to
 * use their PayPal account. PayPal adds ?merchantId=<ClearAid's tracking ID>
 * and ?merchantIdInPayPal=<their merchant ID>; the server then asks PayPal what
 * was actually granted before the account goes live.
 */
export default function PayPalConnected() {
  const [state, setState] = useState<{ busy: boolean; done?: string; error?: string }>({ busy: true });
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const finish = async () => {
      const q = new URLSearchParams(window.location.search);
      const id = q.get("merchantId") ?? "";
      if (!id) throw new Error("This link doesn't come from a PayPal sign-up started in ClearAid. Start again from Sources.");
      if (q.get("permissionsGranted") === "false") throw new Error("PayPal says ClearAid wasn't given permission. Start again from Sources and agree to share access.");
      const r = await api<{ message: string }>("/api/paypal/accounts", { json: { action: "connect_finish", id, merchantId: q.get("merchantIdInPayPal") ?? undefined } });
      return r.message;
    };
    finish().then(
      (done) => setState({ busy: false, done }),
      (e) => setState({ busy: false, error: (e as Error).message }),
    );
  }, []);

  return (
    <Page title="Connecting your PayPal account" subtitle="Checking with PayPal what ClearAid was allowed to do.">
      <div className="card p-6 max-w-xl">
        {state.busy ? (
          <p className="flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin text-brand" /> Confirming with PayPal…</p>
        ) : state.error ? (
          <p className="text-sm text-critical" role="alert">{state.error}</p>
        ) : (
          <p className="flex items-start gap-2 text-sm" role="status"><CheckCircle2 className="h-4 w-4 mt-0.5 text-brand shrink-0" /> {state.done}</p>
        )}
        <Link href="/sources" className="btn btn-ghost mt-4 w-fit"><CreditCard className="h-4 w-4" /> Back to Sources</Link>
      </div>
    </Page>
  );
}
