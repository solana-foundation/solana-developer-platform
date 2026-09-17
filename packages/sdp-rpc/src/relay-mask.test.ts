import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { maskEndpoint } from "./relay";

const env = {} as Parameters<typeof maskEndpoint>[1];

describe("maskEndpoint", () => {
  it("masks a credential-shaped path segment of a customer endpoint", () => {
    // A custom endpoint's key is not among the platform's own keys, so only
    // the shape of the segment can catch it.
    assert.equal(
      maskEndpoint("https://rpc.example.com/AbC123xyz456QwErTy789012", env),
      "https://rpc.example.com/***"
    );
  });

  it("keeps ordinary path vocabulary, including long digit-free network names", () => {
    assert.equal(
      maskEndpoint("https://rpc.example.com/v2/solana-mainnet-beta", env),
      "https://rpc.example.com/v2/solana-mainnet-beta"
    );
  });

  it("masks a percent-encoded Base64-style path credential", () => {
    assert.equal(
      maskEndpoint("https://rpc.example.com/QWxhZGRpbjpvcGVuIHNlc2FtZQ%3D%3D", env),
      "https://rpc.example.com/***"
    );
  });

  it("masks key-ish query parameters", () => {
    assert.equal(
      maskEndpoint("https://rpc.example.com/rpc?api-key=secret123", env),
      "https://rpc.example.com/rpc?api-key=***"
    );
  });
});

it("maskTenantEndpoint masks a credential-shaped path segment the apiKey field does not carry", async () => {
  const { maskTenantEndpoint } = await import("./byok");
  const masked = maskTenantEndpoint(
    "https://rpc.example.com/v2/AbCdEf1234567890XyZ?cluster=devnet",
    "some-other-key-1234567890abcdef"
  );
  assert.equal(masked, "https://rpc.example.com/v2/***?cluster=devnet");
});

it("maskTenantEndpoint keeps masking the known key and query heuristics", async () => {
  const { maskTenantEndpoint } = await import("./byok");
  const masked = maskTenantEndpoint(
    "https://rpc.example.com/rpc?api-key=tenantsecret",
    "tenantsecret"
  );
  assert.equal(masked, "https://rpc.example.com/rpc?api-key=***");
});
