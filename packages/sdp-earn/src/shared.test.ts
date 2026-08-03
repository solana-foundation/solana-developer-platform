import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bearerAuthHeader, earnId, requireEnv } from "./shared";

describe("requireEnv", () => {
  it("returns the trimmed value", () => {
    assert.equal(requireEnv({ VEDA_API_KEY: "  secret  " }, "VEDA_API_KEY"), "secret");
  });

  it("throws naming the missing key", () => {
    assert.throws(() => requireEnv({}, "VEDA_API_KEY"), /VEDA_API_KEY/);
  });

  it("treats blank values as missing", () => {
    assert.throws(() => requireEnv({ VEDA_API_KEY: "" }, "VEDA_API_KEY"), /VEDA_API_KEY/);
    assert.throws(() => requireEnv({ VEDA_API_KEY: "   " }, "VEDA_API_KEY"), /VEDA_API_KEY/);
  });
});

describe("bearerAuthHeader", () => {
  it("prefixes the token with the Bearer scheme", () => {
    assert.equal(bearerAuthHeader("token-123"), "Bearer token-123");
  });
});

describe("earnId", () => {
  it("joins the prefix to a UUID", () => {
    assert.match(
      earnId("pos"),
      /^pos_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it("is unique per call", () => {
    assert.notEqual(earnId("pos"), earnId("pos"));
  });
});
