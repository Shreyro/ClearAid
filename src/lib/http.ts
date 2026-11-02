import { NextResponse } from "next/server";
import { HttpError } from "./session";
import { PayPalError } from "./paypal";

export const json = (data: unknown, init?: number | ResponseInit) =>
  NextResponse.json(data, typeof init === "number" ? { status: init } : init);

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
