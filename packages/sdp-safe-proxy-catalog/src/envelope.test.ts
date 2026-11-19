import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { SAFE_PROXY_MAX_BUDGET_MS, type SafeProxyOperation } from "./catalog";
import {
  credentialReferenceSchema,
  safeProxyRequestEnvelopeSchema,
  safeProxyResponseEnvelopeSchema,
} from "./envelope";

function operation(
  fields:
    | { kind: "reads" | "signs"; credential: "customer" | "none" }
    | { kind: "changes"; credential: "customer" | "none" }
): SafeProxyOperation {
  const shared = {
    credential: fields.credential,
    callers: ["api"] as const,
    budgetMs: 1_000,
    request: z.strictObject({ id: z.string() }),
    response: z.object({ value: z.string() }),
  };
  return fields.kind === "changes"
    ? { ...shared, kind: "changes", pairedRead: "test.read" }
    : { ...shared, kind: fields.kind };
}

const OPERATIONS = [
  operation({ kind: "reads", credential: "none" }),
  operation({ kind: "reads", credential: "customer" }),
  operation({ kind: "signs", credential: "customer" }),
  operation({ kind: "changes", credential: "customer" }),
  operation({ kind: "changes", credential: "none" }),
];

const CREDENTIAL = { id: "cred_1", version: "1", organizationId: "org_1", projectId: "proj_1" };
const BASE = { requestId: "req_1", budgetMs: 1_000, input: { id: "a" } };
const READS_NONE = operation({ kind: "reads", credential: "none" });

type EnvelopeCase = typeof BASE & {
  credential?: typeof CREDENTIAL;
  idempotencyKey?: string;
};

describe("safeProxyRequestEnvelopeSchema", () => {
  it("requires credential and idempotencyKey exactly when the operation declares them", () => {
    for (const op of OPERATIONS) {
      for (const withCredential of [true, false]) {
        for (const withKey of [true, false]) {
          const envelope: EnvelopeCase = { ...BASE };
          if (withCredential) {
            envelope.credential = CREDENTIAL;
          }
          if (withKey) {
            envelope.idempotencyKey = "key_1";
          }
          const expected =
            withCredential === (op.credential === "customer") &&
            withKey === (op.kind === "changes");
          assert.equal(
            safeProxyRequestEnvelopeSchema(op).safeParse(envelope).success,
            expected,
            `${op.kind}/${op.credential} credential=${withCredential} key=${withKey}`
          );
        }
      }
    }
  });

  it("refuses unknown top-level and input fields", () => {
    const schema = safeProxyRequestEnvelopeSchema(READS_NONE);
    assert.equal(schema.safeParse(BASE).success, true);
    assert.equal(schema.safeParse({ ...BASE, extra: 1 }).success, false);
    assert.equal(schema.safeParse({ ...BASE, input: { id: "a", extra: 1 } }).success, false);
  });

  it("accepts budgetMs only as an integer from 1 to the maximum", () => {
    const schema = safeProxyRequestEnvelopeSchema(READS_NONE);
    for (const budgetMs of [1, SAFE_PROXY_MAX_BUDGET_MS]) {
      assert.equal(schema.safeParse({ ...BASE, budgetMs }).success, true, `${budgetMs}`);
    }
    for (const budgetMs of [0, -1, 1.5, SAFE_PROXY_MAX_BUDGET_MS + 1]) {
      assert.equal(schema.safeParse({ ...BASE, budgetMs }).success, false, `${budgetMs}`);
    }
  });
});

describe("credentialReferenceSchema", () => {
  it("accepts an exact positive version only", () => {
    for (const version of ["1", "12"]) {
      assert.equal(credentialReferenceSchema.safeParse({ ...CREDENTIAL, version }).success, true);
    }
    for (const version of ["latest", "0", ""]) {
      assert.equal(
        credentialReferenceSchema.safeParse({ ...CREDENTIAL, version }).success,
        false,
        version
      );
    }
  });

  it("refuses unknown fields", () => {
    assert.equal(credentialReferenceSchema.safeParse({ ...CREDENTIAL, extra: "x" }).success, false);
  });
});

describe("safeProxyResponseEnvelopeSchema", () => {
  const schema = safeProxyResponseEnvelopeSchema(READS_NONE);

  it("strips output fields the operation does not declare", () => {
    const parsed = schema.parse({ ok: true, output: { value: "v", undeclared: "x" } });
    assert.deepEqual(parsed, { ok: true, output: { value: "v" } });
  });

  it("refuses an error whose outcome the code cannot carry", () => {
    const declared = { ok: false, error: { code: "internal", outcome: "no_answer" } };
    const undeclared = { ok: false, error: { code: "invalid_request", outcome: "no_answer" } };
    assert.equal(schema.safeParse(declared).success, true);
    assert.equal(schema.safeParse(undeclared).success, false);
  });
});
