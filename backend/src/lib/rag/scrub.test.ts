import assert from "node:assert/strict";
import { test } from "node:test";
import { scrub } from "./scrub";

test("sentences about the prompt's own headings are dropped", () => {
  const r = scrub("Cyclone Asha raised $37,023.14. This is listed under TOTAL MONEY IN in the FUND SUMMARIES. The goal is $60,000.");
  assert.equal(r, "Cyclone Asha raised $37,023.14. The goal is $60,000.");
});

test("a later second-guess is cut and the first answer kept", () => {
  const r = scrub("The biggest category is Shelter, $2,771.68. However, if you're asking something else, it's Food.");
  assert.equal(r, "The biggest category is Shelter, $2,771.68.");
});

test("an answer that is nothing but a leak is not emptied", () => {
  assert.ok(scrub("See the FUND SUMMARIES.").length > 0);
});

test("bracketed data labels and 'section' are removed", () => {
  assert.equal(scrub("Cyclone Asha spent $1,535.47 (LAST MONTH (2026-10): money in $18,113.60, spent $1,535.47) last month."), "Cyclone Asha spent $1,535.47 last month.");
  assert.equal(scrub("According to the records (MONEY OUT) section, the largest payee was Shelter Kit Inc."), "The largest payee was Shelter Kit Inc.");
});

test("a list keeps its lines", () => {
  assert.equal(scrub("Last month:\n* A: $1\n* B: $2"), "Last month:\n* A: $1\n* B: $2");
});

test("an emptied 'according to the' lead-in is removed", () => {
  assert.equal(scrub("According to the (MONEY OUT) section, last month the largest payee was X."), "Last month the largest payee was X.");
  assert.equal(scrub("According to the summaries, last month it spent $1."), "Last month it spent $1.");
});

test("soft mentions of the data are turned into plain wording", () => {
  assert.equal(scrub("It raised $5. This is the total, as shown in the fund summary."), "It raised $5. This is the total.");
  assert.equal(scrub("Passage [16] mentions a payment."), "Record [16] mentions a payment.");
});
