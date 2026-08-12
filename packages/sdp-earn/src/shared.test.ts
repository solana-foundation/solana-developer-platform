import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bearerAuthHeader } from "./shared";

describe("bearerAuthHeader", () => {
  it("prefixes the token with the Bearer scheme", () => {
    assert.equal(bearerAuthHeader("token-123"), "Bearer token-123");
  });
});
