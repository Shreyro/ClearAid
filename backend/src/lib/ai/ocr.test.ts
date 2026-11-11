import assert from "node:assert/strict";
import { test } from "node:test";
import { isoDate, printedCode, printedTotal } from "./ocr";

test("a tracking code is only taken from the printed text", () => {
  assert.equal(printedCode("Bill to: Coastal Relief Collective #ASHA\nTOTAL 275.00"), "ASHA");
  assert.equal(printedCode("Ref #ro1-med paid"), "RO1");
  assert.equal(printedCode("Invoice 4471, no code here"), null);
  assert.equal(printedCode("Qty #4"), null, "a number isn't a code");
});

test("dates in the usual receipt forms become YYYY-MM-DD", () => {
  assert.equal(isoDate("2026-11-02"), "2026-11-02");
  assert.equal(isoDate("02/11/2026"), "2026-11-02", "day first");
  assert.equal(isoDate("2.11.26"), "2026-11-02");
  assert.equal(isoDate("2 Nov 2026"), "2026-11-02");
  assert.equal(isoDate("November 2, 2026"), "2026-11-02");
  assert.equal(isoDate("31/02/2026"), null, "not a real day");
  assert.equal(isoDate("20-11-02"), null, "ambiguous year");
  assert.equal(isoDate(null), null);
});

test("the printed total is the last amount on the last total line, never the subtotal", () => {
  assert.equal(printedTotal("Subtotal 240.00\nTax 12.00\nTOTAL (USD) 275.00"), 275);
  assert.equal(printedTotal("Sub-total 1,240.00\nGrand Total Rs 1,302.00"), 1302);
  assert.equal(printedTotal("Subtotal 50.00"), null);
});
