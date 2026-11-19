import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import {
  defineSafeProxyCatalog,
  SAFE_PROXY_MAX_BUDGET_MS,
  type SafeProxyOperation,
} from "./catalog";

const shared = {
  credential: "none",
  callers: ["api"],
  budgetMs: 1_000,
  request: z.strictObject({}),
  response: z.object({}),
} as const;

function reads(budgetMs: number): SafeProxyOperation {
  return { ...shared, kind: "reads", budgetMs };
}

function changesPairedWith(pairedRead: `${string}.${string}`): SafeProxyOperation {
  return { ...shared, kind: "changes", pairedRead };
}

describe("defineSafeProxyCatalog", () => {
  it("returns a valid definition unchanged", () => {
    const definition = {
      ledger: {
        lookup: reads(1),
        slowest: reads(SAFE_PROXY_MAX_BUDGET_MS),
        sign: { ...shared, kind: "signs" },
        submit: changesPairedWith("ledger.lookup"),
      },
    } as const;
    assert.equal(defineSafeProxyCatalog(definition), definition);
  });

  it("refuses a budget that is not an integer from 1 to the maximum", () => {
    for (const budgetMs of [0, -1, 1.5, SAFE_PROXY_MAX_BUDGET_MS + 1]) {
      assert.throws(
        () => defineSafeProxyCatalog({ ledger: { lookup: reads(budgetMs) } }),
        /budgetMs must be an integer/,
        `${budgetMs}`
      );
    }
  });

  it("refuses an operation no caller may use", () => {
    assert.throws(
      () => defineSafeProxyCatalog({ ledger: { lookup: { ...reads(1_000), callers: [] } } }),
      /no caller may use/
    );
  });

  it("refuses a changes operation whose pairedRead is not a reads operation in the catalog", () => {
    const pairedReads = [
      "other.lookup",
      "ledger.missing",
      "ledger.sign",
      "ledger.submit",
      "constructor.toString",
      "ledger.constructor",
      "ledger.toString",
    ] as const;
    for (const pairedRead of pairedReads) {
      assert.throws(
        () =>
          defineSafeProxyCatalog({
            ledger: {
              lookup: reads(1_000),
              sign: { ...shared, kind: "signs" },
              submit: changesPairedWith(pairedRead),
            },
          }),
        /pairedRead must name a reads operation/,
        pairedRead
      );
    }
  });
});
