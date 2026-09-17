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

  it("keeps ordinary path vocabulary", () => {
    assert.equal(
      maskEndpoint("https://rpc.example.com/v2/solana-mainnet", env),
      "https://rpc.example.com/v2/solana-mainnet"
    );
  });

  it("masks key-ish query parameters", () => {
    assert.equal(
      maskEndpoint("https://rpc.example.com/rpc?api-key=secret123", env),
      "https://rpc.example.com/rpc?api-key=***"
    );
  });
});
