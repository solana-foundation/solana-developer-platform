import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDfnsApiClient } from "../dfns/client";
import { SigningError } from "../signing";
import { assertHttpsBaseUrl } from "./common";

const DFNS_TEST_PRIVATE_KEY = [
  "-----BEGIN PRIVATE KEY-----",
  "MC4CAQAwBQYDK2VwBCIEIC0XA6Hut2AL9pRoqfPikZgWfxpzo9jQyLLQYl1MYIiT",
  "-----END PRIVATE KEY-----",
].join("\n");

describe("assertHttpsBaseUrl", () => {
  it("accepts an https base URL and returns it unchanged", () => {
    assert.equal(
      assertHttpsBaseUrl("https://api.example.com/v1", "Example"),
      "https://api.example.com/v1"
    );
  });

  it("rejects an http base URL", () => {
    assert.throws(
      () => assertHttpsBaseUrl("http://api.example.com", "Example"),
      (error: unknown) =>
        error instanceof SigningError && error.message === "Example API base URL must use https"
    );
  });

  it("rejects a value that is not a URL", () => {
    assert.throws(
      () => assertHttpsBaseUrl("not a url", "Example"),
      (error: unknown) =>
        error instanceof SigningError && error.message === "Example API base URL is not a valid URL"
    );
  });

  it("rejects userinfo credentials embedded in the URL", () => {
    assert.throws(
      () => assertHttpsBaseUrl("https://user:secret@api.example.com", "Example"),
      (error: unknown) =>
        error instanceof SigningError &&
        error.message === "Example API base URL must not embed credentials"
    );
  });
});

describe("DFNS client base URL validation", () => {
  it("refuses to construct a client over http", async () => {
    await assert.rejects(
      createDfnsApiClient(
        {
          DFNS_AUTH_TOKEN: "token",
          DFNS_CREDENTIAL_ID: "credential",
          DFNS_PRIVATE_KEY: DFNS_TEST_PRIVATE_KEY,
        },
        { apiBaseUrl: "http://attacker.example" }
      ),
      (error: unknown) =>
        error instanceof SigningError && error.message === "DFNS API base URL must use https"
    );
  });
});
