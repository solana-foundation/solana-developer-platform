import { describe, expect, it } from "vitest";
import type { Env } from "@/types/env";
import { canonicalMetadataUrl, resolveMetadataOrigin } from "./metadata";

const envWith = (publicApiOrigin?: string): Env =>
  ({ PUBLIC_API_ORIGIN: publicApiOrigin }) as unknown as Env;

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
});

describe("canonicalMetadataUrl", () => {
  it("builds the public metadata.json url for a token", () => {
    expect(canonicalMetadataUrl("https://api.sdp.example", "tok_1")).toBe(
      "https://api.sdp.example/v1/issuance/tokens/tok_1/metadata.json"
    );
  });
});
