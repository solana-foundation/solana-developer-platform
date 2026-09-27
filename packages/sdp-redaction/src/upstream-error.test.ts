import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { summarizeUpstreamErrorBody, summarizeUpstreamErrorValue } from "./upstream-error";

describe("summarizeUpstreamErrorBody", () => {
  it("keeps identifier-shaped codes from known error fields", () => {
    assert.equal(
      summarizeUpstreamErrorBody('{"errorCode":"WALLET_NOT_FOUND"}'),
      "WALLET_NOT_FOUND"
    );
    assert.equal(summarizeUpstreamErrorBody('{"errorType":"already_exists"}'), "already_exists");
    assert.equal(
      summarizeUpstreamErrorBody('{"error":{"code":"InvalidCredential"}}'),
      "InvalidCredential"
    );
  });

  it("prefers the descriptive status over a code that repeats the HTTP status", () => {
    assert.equal(
      summarizeUpstreamErrorBody('{"error":{"code":400,"status":"INVALID_ARGUMENT"}}', 400),
      "INVALID_ARGUMENT"
    );
  });

  it("drops prose, oversized values, and unparsable bodies", () => {
    assert.equal(
      summarizeUpstreamErrorBody('{"error":{"code":"Bearer sk_live_abc is invalid"}}'),
      "unavailable"
    );
    assert.equal(summarizeUpstreamErrorBody(`{"code":"${"a".repeat(65)}"}`), "unavailable");
    assert.equal(
      summarizeUpstreamErrorBody('{"message":"authorization: Bearer sk_live_abc"}'),
      "unavailable"
    );
    assert.equal(summarizeUpstreamErrorBody("<html>Bearer sk_live_abc</html>"), "unavailable");
    assert.equal(summarizeUpstreamErrorBody('["Bearer sk_live_abc"]'), "unavailable");
  });

  it("fails closed on compact credential-shaped values in every accepted generic field", () => {
    // SOLA9-586: a provider-controlled compact value in a generic error field
    // reaches `code=<value>` in signer errors, persisted transfer failures, API
    // responses, and telemetry. `sk_live_…` is the platform's own API-key shape.
    for (const key of [
      "errorCode",
      "error_code",
      "errorType",
      "code",
      "status",
      "type",
      "reason",
    ]) {
      assert.equal(
        summarizeUpstreamErrorBody(JSON.stringify({ [key]: "sk_live_platform_secret" })),
        "unavailable",
        `field ${key} must not surface a credential-shaped value`
      );
    }
    assert.equal(
      summarizeUpstreamErrorBody('{"error":{"code":"sk_live_platform_secret"}}'),
      "unavailable"
    );
  });

  it("fails closed on token formats and opaque key material regardless of field", () => {
    const secrets = [
      "ghp_9f8e7d6c5b4a3210fedcba9876543210abcd",
      "github_pat_11A1B2C3D4e5F6G7H8I9J0K1L2M3N4O5",
      "AKIAIOSFODNN7EXAMPLE",
      "AIzaSyA1bC2dE3fG4hI5jK6lM7nO8pQ9rS0tU1v",
      "xoxb-123456789012-1234567890123-abcdef",
      "whsec_secretwebhooksigningkey123456",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.s3cr3t-sig",
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "q83jUTeR2wXyZ1aVbKcMdFePgH7nL4mQrTs9Vx2",
    ];
    for (const secret of secrets) {
      for (const key of ["code", "type", "reason", "status", "errorCode", "errorType"]) {
        assert.equal(
          summarizeUpstreamErrorBody(JSON.stringify({ [key]: secret })),
          "unavailable",
          `value must not surface via field ${key}`
        );
      }
    }
  });

  it("fails closed when the value matches a caller-held secret", () => {
    // Greptile finding on this PR: the shape filter accepts a short bare token
    // like the DFNS auth-token fixture value (no prefix, under 32 chars, has
    // separators), so a controlled provider echoing back exactly the credential
    // it was sent would surface it as `code=<token>`. Callers therefore vet the
    // candidate against their own held secrets by exact value.
    for (const key of [
      "errorCode",
      "error_code",
      "errorType",
      "code",
      "status",
      "type",
      "reason",
    ]) {
      assert.equal(
        summarizeUpstreamErrorBody(JSON.stringify({ [key]: "dfns-auth-token-value" }), undefined, [
          "dfns-auth-token-value",
        ]),
        "unavailable",
        `held-secret echo must not surface via field ${key}`
      );
    }
    assert.equal(
      summarizeUpstreamErrorBody('{"error":{"code":"credential_poc"}}', undefined, [
        "dfns-auth-token-value",
        "credential_poc",
      ]),
      "unavailable"
    );
    // Matching is case-insensitive and trims the candidate.
    assert.equal(
      summarizeUpstreamErrorBody('{"code":"  DFNS-AUTH-TOKEN-VALUE  "}', undefined, [
        "dfns-auth-token-value",
      ]),
      "unavailable"
    );
    assert.equal(
      summarizeUpstreamErrorValue("dfns-auth-token-value", undefined, ["dfns-auth-token-value"]),
      null
    );
    // Enum codes keep surfacing when no held secret is involved.
    assert.equal(
      summarizeUpstreamErrorBody('{"code":"WALLET_NOT_FOUND"}', undefined, [
        "dfns-auth-token-value",
      ]),
      "WALLET_NOT_FOUND"
    );
    assert.equal(
      summarizeUpstreamErrorBody('{"code":"dfns-auth-token-value"}'),
      "dfns-auth-token-value"
    );
    assert.equal(summarizeUpstreamErrorValue("dfns-auth-token-value"), "dfns-auth-token-value");
  });

  it("still surfaces provider enum codes that are not secret-shaped", () => {
    assert.equal(
      summarizeUpstreamErrorBody('{"code":"NOT_ENOUGH_PRECISION"}'),
      "NOT_ENOUGH_PRECISION"
    );
    assert.equal(
      summarizeUpstreamErrorBody('{"code":"TransactionConfirmationTimeout"}'),
      "TransactionConfirmationTimeout"
    );
    assert.equal(summarizeUpstreamErrorBody('{"code":"rate-limited"}'), "rate-limited");
    assert.equal(summarizeUpstreamErrorBody('{"code":"insufficient.gas"}'), "insufficient.gas");
    assert.equal(
      summarizeUpstreamErrorBody('{"code":"WALLET_ACCOUNT_FROZEN_V2"}'),
      "WALLET_ACCOUNT_FROZEN_V2"
    );
  });
});

describe("summarizeUpstreamErrorValue", () => {
  it("passes an identifier-shaped enum code and fails closed on everything else", () => {
    assert.equal(summarizeUpstreamErrorValue("USER_REJECTED"), "USER_REJECTED");
    assert.equal(summarizeUpstreamErrorValue("sk_live_platform_secret"), null);
    assert.equal(summarizeUpstreamErrorValue("User rejected the request"), null);
    assert.equal(summarizeUpstreamErrorValue(403, 403), null);
    assert.equal(summarizeUpstreamErrorValue(12345), "12345");
    assert.equal(summarizeUpstreamErrorValue(undefined), null);
  });
});
