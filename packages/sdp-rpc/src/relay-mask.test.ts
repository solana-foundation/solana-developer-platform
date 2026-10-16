import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { maskEndpoint } from "./relay";
import type { RpcEnv } from "./types";

const env: RpcEnv = {};

describe("maskEndpoint", () => {
  it("masks a credential-shaped path segment of a managed URL whose key SDP does not hold", () => {
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
