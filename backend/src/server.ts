import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { logger } from "hono/logger";
import type { Ctx } from "@/lib/http";
import { startIndexing } from "@/lib/rag/copilot";
import { getSession, requestContext } from "@/lib/session";
import * as adminReset from "./routes/admin/reset/route";
import * as appConfig from "./routes/config/route";
import * as auditLog from "./routes/audit/route";
import * as bankAccounts from "./routes/bank/accounts/route";
import * as bankImport from "./routes/bank/accounts/[id]/import/route";
import * as bankSync from "./routes/bank/accounts/[id]/sync/route";
import * as bankPlaid from "./routes/bank/plaid/route";
import * as bankTxns from "./routes/bank/transactions/route";
import * as fundCodes from "./routes/funds/[id]/codes/route";
import * as fundFlow from "./routes/funds/[id]/flow/route";
import * as overview from "./routes/overview/route";
import * as payments from "./routes/payments/route";
import * as paymentScan from "./routes/payments/scan/route";
import * as transactions from "./routes/transactions/route";
import * as authLogin from "./routes/auth/login/route";
import * as authLogout from "./routes/auth/logout/route";
import * as bankReceipts from "./routes/bank/transactions/[id]/receipts/route";
import * as give from "./routes/give/[slug]/route";
import * as giveOrder from "./routes/give/[slug]/order/route";
import * as giveCapture from "./routes/give/[slug]/capture/route";
import * as ngoControls from "./routes/ngo/controls/route";
import * as ngoAssignments from "./routes/ngo/assignments/route";
import * as ngoMembers from "./routes/ngo/members/route";
import * as copilot from "./routes/copilot/route";
import * as embeds from "./routes/embeds/route";
import * as embedPreview from "./routes/embeds/preview/route";
import * as publicEmbed from "./routes/embed/[key]/route";
import * as file from "./routes/files/[id]/route";
import * as funds from "./routes/funds/route";
import * as fundDraft from "./routes/funds/draft/route";
import * as fund from "./routes/funds/[id]/route";
import * as fundClose from "./routes/funds/[id]/close/route";
import * as fundInsights from "./routes/funds/[id]/insights/route";
import * as fundLedger from "./routes/funds/[id]/ledger/route";
import * as webhook from "./routes/paypal/webhook/route";
import * as paypalAccounts from "./routes/paypal/accounts/route";
import * as session from "./routes/session/route";
import * as stream from "./routes/stream/route";
import * as vendors from "./routes/vendors/route";
import * as withdrawals from "./routes/withdrawals/route";
import * as withdrawal from "./routes/withdrawals/[id]/route";
import * as withdrawalAudit from "./routes/withdrawals/[id]/audit/route";
import * as withdrawalDecision from "./routes/withdrawals/[id]/decision/route";

type Handler = (req: Request, ctx: Ctx) => Promise<Response>;
type RouteModule = Partial<Record<"GET" | "POST", Handler>>;

// Static routes come before parameterised ones (e.g. /funds/draft before /funds/:id).
const routes: [string, unknown][] = [
  ["/api/admin/reset", adminReset],
  ["/api/config", appConfig],
  ["/api/auth/login", authLogin],
  ["/api/auth/logout", authLogout],
  ["/api/audit", auditLog],
  ["/api/paypal/accounts", paypalAccounts],
  ["/api/bank/accounts", bankAccounts],
  ["/api/bank/accounts/:id/import", bankImport],
  ["/api/bank/accounts/:id/sync", bankSync],
  ["/api/bank/plaid", bankPlaid],
  ["/api/bank/transactions", bankTxns],
  ["/api/bank/transactions/:id/receipts", bankReceipts],
  ["/api/copilot", copilot],
  ["/api/embed/:key", publicEmbed],
  ["/api/embeds", embeds],
  ["/api/embeds/preview", embedPreview],
  ["/api/files/:id", file],
  ["/api/funds", funds],
  ["/api/funds/draft", fundDraft],
  ["/api/funds/:id", fund],
  ["/api/funds/:id/close", fundClose],
  ["/api/funds/:id/codes", fundCodes],
  ["/api/funds/:id/flow", fundFlow],
  ["/api/funds/:id/insights", fundInsights],
  ["/api/funds/:id/ledger", fundLedger],
  ["/api/give/:slug", give],
  ["/api/give/:slug/order", giveOrder],
  ["/api/give/:slug/capture", giveCapture],
  ["/api/ngo/assignments", ngoAssignments],
  ["/api/ngo/controls", ngoControls],
  ["/api/ngo/members", ngoMembers],
  ["/api/overview", overview],
  ["/api/payments", payments],
  ["/api/payments/scan", paymentScan],
  ["/api/paypal/webhook", webhook],
  ["/api/session", session],
  ["/api/stream", stream],
  ["/api/transactions", transactions],
  ["/api/vendors", vendors],
  ["/api/withdrawals", withdrawals],
  ["/api/withdrawals/:id", withdrawal],
  ["/api/withdrawals/:id/audit", withdrawalAudit],
  ["/api/withdrawals/:id/decision", withdrawalDecision],
];

/** Routes reachable without signing in. */
const OPEN_ROUTES = new Set(["/api/auth/login", "/api/auth/logout", "/api/session", "/api/config", "/api/paypal/webhook", "/api/give/:slug", "/api/give/:slug/order", "/api/give/:slug/capture", "/api/embed/:key"]);

/**
 * The only things a donor login may do: read where the money went. Everything
 * else (settings, sources, tagging, audit log, Copilot, any change) is refused
 * here, before a handler runs, so a new route is closed to donors by default.
 */
const DONOR_ROUTES = new Set([
  "GET /api/session",
  "GET /api/config",
  "POST /api/auth/logout",
  "GET /api/overview",
  "GET /api/funds",
  "GET /api/funds/:id",
  "GET /api/funds/:id/flow",
  "GET /api/funds/:id/ledger",
  "GET /api/funds/:id/insights",
  "GET /api/transactions",
  "GET /api/withdrawals/:id",
  "GET /api/files/:id",
  "GET /api/stream",
  // The local Copilot only answers from the funds an admin assigned to the donor.
  "GET /api/copilot",
  "POST /api/copilot",
]);

export const app = new Hono();
app.use(logger());
app.get("/healthz", (c) => c.json({ ok: true }));

for (const [path, mod] of routes) {
  for (const method of ["GET", "POST"] as const) {
    const fn = (mod as RouteModule)[method];
    if (!fn) continue;
    // Run each handler inside the request context so getSession() can read its cookies.
    // Everything except sign-in, public donation links, published embeds and PayPal's server-to-server webhook needs an NGO session.
    app.on(method, path, (c) =>
      requestContext.run(c.req.raw, async () => {
        if (!OPEN_ROUTES.has(path)) {
          const s = await getSession();
          if (s.role !== "ngo") return c.json({ error: "Sign in to continue" }, 401);
          if (s.memberRole === "donor" && !DONOR_ROUTES.has(`${method} ${path}`)) return c.json({ error: "Donor logins are read-only" }, 403);
        }
        return fn(c.req.raw, { params: Promise.resolve(c.req.param()) });
      }),
    );
  }
}

app.notFound((c) => c.json({ error: "Not found" }, 404));

const port = Number(process.env.PORT) || 4000;
// Keep the local Copilot's FAISS index in step with the data (needs rag/server.py running; harmless if it isn't).
startIndexing();

const server = serve({ fetch: app.fetch, port, hostname: process.env.HOST || "0.0.0.0" }, (info) => {
  console.log(`[clearaid] API listening on http://${info.address}:${info.port}`);
});

// The JSON store writes synchronously, so it is safe to exit as soon as we're asked to.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}
