import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isSafeProxyFailure,
  SAFE_PROXY_ERROR_CODES,
  SAFE_PROXY_ERROR_HTTP_STATUS,
  SAFE_PROXY_ERROR_OUTCOMES,
  SAFE_PROXY_OUTCOMES,
  SafeProxyError,
  type SafeProxyErrorCode,
  type SafeProxyOutcome,
  safeProxyFailureSchema,
} from "./errors";

function declaredOutcomes(code: SafeProxyErrorCode): readonly SafeProxyOutcome[] {
  return SAFE_PROXY_ERROR_OUTCOMES[code];
}

const pairs = SAFE_PROXY_ERROR_CODES.flatMap((code) =>
  SAFE_PROXY_OUTCOMES.map((outcome) => ({
    code,
    outcome,
    declared: declaredOutcomes(code).includes(outcome),
  }))
);

describe("Safe Proxy error codes", () => {
  it("gives every code at least one outcome and an HTTP error status", () => {
    for (const code of SAFE_PROXY_ERROR_CODES) {
      assert.ok(declaredOutcomes(code).length > 0, `${code} has no outcome`);
      const status = SAFE_PROXY_ERROR_HTTP_STATUS[code];
      assert.ok(Number.isInteger(status) && status >= 400 && status <= 599, `${code}: ${status}`);
    }
  });

  it("accepts every declared (code, outcome) pair and refuses every undeclared one", () => {
    assert.ok(pairs.some((pair) => pair.declared));
    assert.ok(pairs.some((pair) => !pair.declared));
    for (const { code, outcome, declared } of pairs) {
      assert.equal(isSafeProxyFailure({ code, outcome }), declared, `${code}/${outcome}`);
      assert.equal(
        safeProxyFailureSchema.safeParse({ code, outcome }).success,
        declared,
        `${code}/${outcome}`
      );
    }
  });

  it("refuses a code outside the list", () => {
    assert.equal(
      safeProxyFailureSchema.safeParse({ code: "not_a_code", outcome: "rejected" }).success,
      false
    );
  });
});

describe("SafeProxyError", () => {
  it("exposes the code and outcome and its message carries only those two", () => {
    const error = new SafeProxyError({ code: "deadline_exceeded", outcome: "no_answer" });
    assert.ok(error instanceof Error);
    assert.equal(error.name, "SafeProxyError");
    assert.equal(error.code, "deadline_exceeded");
    assert.equal(error.outcome, "no_answer");
    assert.equal(error.message, "Safe Proxy: deadline_exceeded (no_answer)");
  });
});
