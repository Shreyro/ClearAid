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
