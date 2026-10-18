import { describe, expect, it } from "vitest";
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
    expect(assertHttpsBaseUrl("https://api.example.com/v1", "Example")).toBe(
      "https://api.example.com/v1"
    );
  });

  it("rejects an http base URL", () => {
    expect(() => assertHttpsBaseUrl("http://api.example.com", "Example")).toThrow(
      new SigningError("Example API base URL must use https", "PROVIDER_NOT_CONFIGURED")
    );
  });

  it("rejects a value that is not a URL", () => {
    expect(() => assertHttpsBaseUrl("not a url", "Example")).toThrow(
      new SigningError("Example API base URL is not a valid URL", "PROVIDER_NOT_CONFIGURED")
    );
  });

  it("rejects userinfo credentials embedded in the URL", () => {
    expect(() => assertHttpsBaseUrl("https://user:secret@api.example.com", "Example")).toThrow(
      new SigningError("Example API base URL must not embed credentials", "PROVIDER_NOT_CONFIGURED")
    );
  });
});

describe("DFNS client base URL validation", () => {
  it("refuses to construct a client over http", async () => {
    await expect(
      createDfnsApiClient(
        {
          DFNS_AUTH_TOKEN: "token",
          DFNS_CREDENTIAL_ID: "credential",
          DFNS_PRIVATE_KEY: DFNS_TEST_PRIVATE_KEY,
        },
        { apiBaseUrl: "http://attacker.example" }
      )
    ).rejects.toThrow(
      new SigningError("DFNS API base URL must use https", "PROVIDER_NOT_CONFIGURED")
    );
  });
});
