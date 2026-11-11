import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import { AppShell } from "@/components/AppShell";
import "./globals.css";

// IBM Plex: built for financial and data UI, with true tabular figures for the ledgers. Self-hosted by next/font.
const plex = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-plex", display: "swap" });
const plexMono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-plex-mono", display: "swap" });

export const metadata: Metadata = {
  title: "ClearAid — where relief money comes from and where it goes",
  description: "An audit tracker for NGO relief funds: PayPal, bank and staff-recorded money traced from source to fund to payee on a tamper-evident ledger, with receipts and a full audit trail.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`h-full ${plex.variable} ${plexMono.variable}`}>
      <body className="min-h-full">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
