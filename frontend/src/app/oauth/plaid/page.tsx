"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Landmark, Loader2 } from "lucide-react";
import { Page } from "@/components/AppShell";
import { resumePlaidLink } from "@/components/plaidLink";

/**
 * Where a bank that logs in on its own website (OAuth) sends the person back.
 * Plaid Link is reopened here to finish connecting; register this page's URL
 * as PLAID_REDIRECT_URI and in the Plaid dashboard's allowed redirect URIs.
 */
export default function PlaidOAuthReturn() {
  const [state, setState] = useState<{ busy: boolean; done?: string; error?: string }>({ busy: true });
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    resumePlaidLink().then(
      (m) => setState({ busy: false, done: m ?? "Bank connection cancelled." }),
      (e) => setState({ busy: false, error: (e as Error).message }),
    );
  }, []);

  return (
    <Page title="Connecting your bank" subtitle="Finishing the bank login through Plaid.">
      <div className="card p-6 max-w-xl">
        {state.busy ? (
          <p className="flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin text-brand" /> Finishing with Plaid…</p>
        ) : state.error ? (
          <p className="text-sm text-critical" role="alert">{state.error}</p>
        ) : (
          <p className="flex items-start gap-2 text-sm" role="status"><CheckCircle2 className="h-4 w-4 mt-0.5 text-brand shrink-0" /> {state.done}</p>
        )}
        <Link href="/sources" className="btn btn-ghost mt-4 w-fit"><Landmark className="h-4 w-4" /> Back to Sources</Link>
      </div>
    </Page>
  );
}
