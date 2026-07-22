import { describe, expect, it } from "vitest";
import type { Env } from "@/types/env";
import { canonicalMetadataUrl, resolveMetadataOrigin } from "./metadata";

const envWith = (publicApiOrigin?: string, kService?: string): Env =>
  ({ PUBLIC_API_ORIGIN: publicApiOrigin, K_SERVICE: kService }) as unknown as Env;

describe("resolveMetadataOrigin", () => {
  const requestUrl = "https://api.sdp.example/v1/issuance/tokens/tok_1/metadata.json";

  it("prefers PUBLIC_API_ORIGIN over the request origin", () => {
    expect(resolveMetadataOrigin(envWith("https://pinned.example"), requestUrl)).toBe(
      "https://pinned.example"
    );
  });

  it("normalizes a configured value with a trailing slash to a bare origin", () => {
    expect(resolveMetadataOrigin(envWith("https://pinned.example/"), requestUrl)).toBe(
      "https://pinned.example"
    );
  });

  it("strips a path from a configured value, keeping only the origin", () => {
    expect(resolveMetadataOrigin(envWith("https://pinned.example/base/path"), requestUrl)).toBe(
      "https://pinned.example"
    );
  });

  it("falls back to the request origin when PUBLIC_API_ORIGIN is unset", () => {
    expect(resolveMetadataOrigin(envWith(undefined), requestUrl)).toBe("https://api.sdp.example");
  });

  it("falls back to the request origin when PUBLIC_API_ORIGIN is malformed", () => {
    expect(resolveMetadataOrigin(envWith("not a url"), requestUrl)).toBe("https://api.sdp.example");
  });

  it("uses the trusted forwarded scheme for a Cloud Run service", () => {
    expect(
      resolveMetadataOrigin(
        envWith(undefined, "sdp-api"),
        "http://api.sdp.example/v1/issuance/tokens/tok_1/metadata.json",
        "https"
      )
    ).toBe("https://api.sdp.example");
  });

  it("uses the proxy-appended forwarded scheme instead of an untrusted prefix", () => {
    expect(
      resolveMetadataOrigin(
        envWith(undefined, "sdp-api"),
        "http://api.sdp.example/v1/issuance/tokens/tok_1/metadata.json",
        "http, https"
      )
    ).toBe("https://api.sdp.example");
  });

  it("ignores a forwarded scheme outside Cloud Run", () => {
    expect(
      resolveMetadataOrigin(
        envWith(undefined),
        "http://localhost:8787/v1/issuance/tokens/tok_1/metadata.json",
        "https"
      )
    ).toBe("http://localhost:8787");
  });
});

describe("canonicalMetadataUrl", () => {
  it("builds the public metadata.json url for a token", () => {
    expect(canonicalMetadataUrl("https://api.sdp.example", "tok_1")).toBe(
      "https://api.sdp.example/v1/issuance/tokens/tok_1/metadata.json"
    );
  });
});
