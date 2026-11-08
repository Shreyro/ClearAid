import type { Metadata } from "next";
import { AppShell } from "@/components/AppShell";
import "./globals.css";

export const metadata: Metadata = {
  title: "ClearAid — financial controls for relief NGOs",
  description: "Governance, risk and compliance for NGO relief funds on PayPal: every transaction on a tamper-evident ledger, AI-audited payouts with dual approval, and a complete audit trail.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full">
      <body className="min-h-full">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
