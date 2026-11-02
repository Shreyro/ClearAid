import type { Metadata } from "next";
import { Header } from "@/components/Header";
import "./globals.css";

export const metadata: Metadata = {
  title: "ClearAid — transparent disaster relief on PayPal",
  description:
    "Dedicated relief funds where every withdrawal is receipted, AI-audited and published on a tamper-evident ledger. Donors follow their dollar and choose what happens to leftovers.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full">
      <body className="min-h-full flex flex-col">
        <Header />
        <main className="flex-1">{children}</main>
        <footer className="border-t border-line mt-16">
          <div className="mx-auto max-w-6xl px-4 py-8 text-sm text-muted flex flex-col sm:flex-row gap-2 justify-between">
            <span>ClearAid · built for the PayPal AI Hackathon · demo data is fictional</span>
            <span>Payments by PayPal · audits by Claude</span>
          </div>
        </footer>
      </body>
    </html>
  );
}
