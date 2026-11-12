import assert from "node:assert/strict";
import { test } from "node:test";
import { dropUnsupported, unsupportedAmounts } from "./verify";

const known = "TOTAL MONEY IN: $37,023.14. Shelter $5,150.00; OIL $1,700.62. Goal $60,000.";

test("amounts present in the data are supported", () => {
  assert.deepEqual(unsupportedAmounts("Cyclone Asha raised $37,023.14 toward $60,000.", known), []);
});

test("a whole-dollar rounding of a known amount is supported", () => {
  assert.deepEqual(unsupportedAmounts("About $5,150 went to shelter.", known), []);
});

test("an invented amount is flagged", () => {
  assert.deepEqual(unsupportedAmounts("It spent $9,999.99 on shelter.", known), [999999]);
});

test("sentences with invented amounts are dropped, the rest kept", () => {
  const out = dropUnsupported("Shelter was $5,150. OIL got $1,234.56 last month. That is the top category.", known);
  assert.equal(out, "Shelter was $5,150. That is the top category.");
});

test("nothing left means undefined", () => {
  assert.equal(dropUnsupported("It was $1,234.56.", known), undefined);
});
