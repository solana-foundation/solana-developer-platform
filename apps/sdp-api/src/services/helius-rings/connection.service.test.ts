import { describe, expect, it } from "vitest";
import type { Env } from "@/types/env";
import { type RingsConnectionInput, validateRingsConnectionInput } from "./connection.service";

const baseInput: RingsConnectionInput = {
  name: "Shared devnet",
  solanaRpcUrl: "https://rpc.example.com",
  indexerUrl: "https://indexer.example.com",
  proverUrl: "https://prover.example.com",
  ringRpcUrl: "https://ring.example.com",
  allowInsecureHttp: false,
};

describe("validateRingsConnectionInput", () => {
  it.each([
    "https://127.0.0.1/private",
    "https://169.254.169.254/latest/meta-data",
    "https://service.internal/health",
  ])("blocks private HTTPS targets even when development HTTP is allowed: %s", (url) => {
    expect(() =>
      validateRingsConnectionInput({ ENVIRONMENT: "development" } as Env, {
        ...baseInput,
        solanaRpcUrl: url,
        allowInsecureHttp: true,
      })
    ).toThrow("Solana RPC URL points to a host SDP cannot reach");
  });

  it("blocks private HTTP targets in development", () => {
    expect(() =>
      validateRingsConnectionInput({ ENVIRONMENT: "development" } as Env, {
        ...baseInput,
        indexerUrl: "http://localhost:8080",
        allowInsecureHttp: true,
      })
    ).toThrow("Photon indexer URL points to a host SDP cannot reach");
  });

  it("allows a public HTTP endpoint only in development", () => {
    expect(
      validateRingsConnectionInput({ ENVIRONMENT: "development" } as Env, {
        ...baseInput,
        proverUrl: "http://prover.example.com",
        allowInsecureHttp: true,
      }).proverUrl
    ).toBe("http://prover.example.com/");
  });
});
