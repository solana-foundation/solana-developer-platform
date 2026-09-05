import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import type { Env } from "@/types/env";
import { canonicalMetadataUrl, resolveMetadataOrigin } from "./metadata";

const envWith = (publicApiOrigin?: string): Env =>
  ({ PUBLIC_API_ORIGIN: publicApiOrigin }) as unknown as Env;

describe("resolveMetadataOrigin", () => {
  it("returns the configured PUBLIC_API_ORIGIN", () => {
    expect(resolveMetadataOrigin(envWith("https://pinned.example"))).toBe("https://pinned.example");
  });

  it("normalizes a configured value with a trailing slash to a bare origin", () => {
    expect(resolveMetadataOrigin(envWith("https://pinned.example/"))).toBe(
      "https://pinned.example"
    );
  });

  it("strips a path from a configured value, keeping only the origin", () => {
    expect(resolveMetadataOrigin(envWith("https://pinned.example/base/path"))).toBe(
      "https://pinned.example"
    );
  });

  it("accepts a plain http origin for local development", () => {
    expect(resolveMetadataOrigin(envWith("http://localhost:8787"))).toBe("http://localhost:8787");
  });

  // The origin is burned into the on-chain MetadataPointer, so it may only ever
  // come from trusted configuration. There is deliberately no request-derived
  // fallback: a hostile Host header must never be mintable, and a broken config
  // must fail the deploy instead of silently degrading to one.
  it("fails closed when PUBLIC_API_ORIGIN is unset", () => {
    expect(() => resolveMetadataOrigin(envWith(undefined))).toThrowError(AppError);
  });

  it("fails closed when PUBLIC_API_ORIGIN is blank", () => {
    expect(() => resolveMetadataOrigin(envWith("   "))).toThrowError(AppError);
  });

  it("fails closed when PUBLIC_API_ORIGIN is malformed", () => {
    expect(() => resolveMetadataOrigin(envWith("not a url"))).toThrowError(AppError);
  });

  it("fails closed when PUBLIC_API_ORIGIN is not http(s)", () => {
    expect(() => resolveMetadataOrigin(envWith("ftp://pinned.example"))).toThrowError(AppError);
    expect(() =>
      resolveMetadataOrigin(envWith("javascript:alert(1)//pinned.example"))
    ).toThrowError(AppError);
  });
});

describe("canonicalMetadataUrl", () => {
  it("builds the public metadata.json url for a token", () => {
    expect(canonicalMetadataUrl("https://api.sdp.example", "tok_1")).toBe(
      "https://api.sdp.example/v1/issuance/tokens/tok_1/metadata.json"
    );
  });

  it("encodes a hostile token id so it cannot splice path segments", () => {
    expect(canonicalMetadataUrl("https://api.sdp.example", "../../evil?x=1#f")).toBe(
      "https://api.sdp.example/v1/issuance/tokens/..%2F..%2Fevil%3Fx%3D1%23f/metadata.json"
    );
  });
});
