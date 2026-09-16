import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { summarizeUpstreamErrorBody } from "./upstream-error";

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
});
