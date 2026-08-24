import { HeliusRingsError, NotImplementedRingsGateway } from "@sdp/helius-rings";
import { describe, expect, it } from "vitest";
import type { Env } from "@/types/env";
import { resolveRingsGateway } from "./gateway";

// Every endpoint is loopback so the suite builds a real client and probes it
// without leaving the machine. Loopback http needs no insecure-http opt-in.
const CONFIGURED = {
  HELIUS_RINGS_ADAPTER: "ts",
  SOLANA_RPC_HELIUS_URL: "http://127.0.0.1:1/?api-key={API_KEY}",
  SOLANA_RPC_HELIUS_API_KEY: "test-key",
  HELIUS_RINGS_INDEXER_URL: "http://127.0.0.1:1",
  HELIUS_RINGS_PROVER_URL: "http://127.0.0.1:1",
} as unknown as Env;

describe("resolveRingsGateway", () => {
  it("keeps the not-implemented gateway unless the adapter is selected", () => {
    for (const adapter of [undefined, "none", "http", "TS"]) {
      const gateway = resolveRingsGateway({ ...CONFIGURED, HELIUS_RINGS_ADAPTER: adapter } as Env);
      expect(gateway).toBeInstanceOf(NotImplementedRingsGateway);
    }
  });

  it("builds the live gateway when the adapter is selected and configured", () => {
    expect(resolveRingsGateway(CONFIGURED)).not.toBeInstanceOf(NotImplementedRingsGateway);
  });

  it.each([["SOLANA_RPC_HELIUS_URL"], ["HELIUS_RINGS_INDEXER_URL"], ["HELIUS_RINGS_PROVER_URL"]])(
    "names %s in the health detail when it is missing",
    async (variable) => {
      const gateway = resolveRingsGateway({ ...CONFIGURED, [variable]: undefined } as Env);

      const health = await gateway.probeHealth();
      expect(health.gateway).toBe("red");
      expect(health.detail?.gateway).toContain(variable);
    }
  );

  it("fails an operation closed rather than downgrading when misconfigured", async () => {
    const gateway = resolveRingsGateway({
      ...CONFIGURED,
      HELIUS_RINGS_INDEXER_URL: undefined,
    } as Env);

    // Not the not-implemented gateway: selecting `ts` and getting the default
    // back would hide the misconfiguration behind a plausible response.
    expect(gateway).not.toBeInstanceOf(NotImplementedRingsGateway);

    const error = await gateway.provisionIdentity({ walletId: "hrw_1", sdpAddress: "addr" }).then(
      () => null,
      (thrown: unknown) => thrown
    );
    expect(error).toBeInstanceOf(HeliusRingsError);
    expect((error as HeliusRingsError).code).toBe("config_error");
  });

  it("treats an unsubstituted API key placeholder as missing configuration", async () => {
    // withHeliusApiKey returns the URL untouched when the key is absent, so the
    // client would otherwise be built against a literal {API_KEY} and report an
    // unreachable RPC — pointing at the wrong variable.
    const gateway = resolveRingsGateway({
      ...CONFIGURED,
      SOLANA_RPC_HELIUS_API_KEY: undefined,
    } as Env);

    expect((await gateway.probeHealth()).detail?.gateway).toContain("SOLANA_RPC_HELIUS_API_KEY");
  });

  it("accepts a URL that already carries its own key", async () => {
    const gateway = resolveRingsGateway({
      ...CONFIGURED,
      SOLANA_RPC_HELIUS_URL: "http://127.0.0.1:1/?api-key=embedded",
      SOLANA_RPC_HELIUS_API_KEY: undefined,
    } as Env);

    expect((await gateway.probeHealth()).detail?.gateway).toBeUndefined();
  });

  it("never exposes the Helius API key through the health response", async () => {
    // The fully configured path, where the key really is applied to the URL and
    // a client really is built: asserting this against a misconfigured gateway
    // proved nothing, because it never touches the key.
    const gateway = resolveRingsGateway({
      ...CONFIGURED,
      SOLANA_RPC_HELIUS_API_KEY: "super-secret-key",
    } as Env);

    expect(JSON.stringify(await gateway.probeHealth())).not.toContain("super-secret-key");
  });
});
