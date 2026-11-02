import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // ClearAid serves a live, mutable ledger, so pages fetch fresh data on the
  // client and API routes are dynamic. We use the classic (non Cache Components)
  // rendering model to keep that behaviour explicit.
  serverExternalPackages: ["@paypal/agent-toolkit"],
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
