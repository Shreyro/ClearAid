import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // ClearAid serves a live, mutable ledger, so pages fetch fresh data on the
  // client and API routes are dynamic. We use the classic (non Cache Components)
  // rendering model to keep that behaviour explicit.
  // The Docker image sets NEXT_OUTPUT=standalone: the build then carries its own
  // minimal server and dependencies (node .next/standalone/server.js), so the
  // runtime image needs no node_modules. Local dev and `next start` are unchanged.
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
  // All API routes live in the separate Hono backend (../backend). Proxy them
  // so the client can keep using same-origin `/api/...` URLs and cookies.
  async rewrites() {
    const backend = process.env.BACKEND_URL ?? "http://localhost:4000";
    return [{ source: "/api/:path*", destination: `${backend}/api/:path*` }];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
