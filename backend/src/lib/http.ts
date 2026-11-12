import { config } from "./config";
import { HttpError } from "./session";
import { PayPalError } from "./paypal";

/** Second argument of every route handler: the path parameters, e.g. `{ id }`. */
export type Ctx<P extends Record<string, string> = Record<string, string>> = { params: Promise<P> };

export const json = (data: unknown, init?: number | ResponseInit) =>
  Response.json(data, typeof init === "number" ? { status: init } : init);

/** Set (or, with `null`, clear) a 30-day, HTTP-only, same-site cookie on a response. */
export function setCookie(res: Response, name: string, value: string | null) {
  const attrs = value === null ? "Max-Age=0" : `Max-Age=${60 * 60 * 24 * 30}`;
  // Served over HTTPS (APP_URL https://…): the cookie is never sent over plain HTTP. Browsers still accept it on http://localhost.
  const secure = config.appUrl.startsWith("https://") ? "; Secure" : "";
  res.headers.append("Set-Cookie", `${name}=${value === null ? "" : encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; ${attrs}${secure}`);
  return res;
}

/** Run work after the response has been sent, so the caller isn't kept waiting. */
export function after(fn: () => unknown) {
  setImmediate(() => {
    Promise.resolve()
      .then(fn)
      .catch((e) => console.error("[clearaid] background task failed", e));
  });
}

/** Wrap a route handler so thrown errors become JSON responses. */
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (e) {
      const err = e as Error;
      const status = e instanceof HttpError ? e.status : e instanceof PayPalError ? (e.status >= 500 ? 502 : 400) : 400;
      if (!(e instanceof HttpError)) console.error("[clearaid]", err);
      return json({ error: err.message || "Something went wrong" }, status);
    }
  };
}
