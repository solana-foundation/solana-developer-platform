import { runInClusterScope } from "@sdp/rpc/scope";
import { EARN_PROVIDERS } from "@sdp/types";
import { describe, expect, it } from "vitest";
import { installClusterRpcStub } from "@/test/helpers/cluster-rpc";
import type { Env } from "@/types/env";
import {
  resolveRecordedVaultWithdrawClient,
  resolveVaultDirectClient,
  resolveVaultParRedemptionClient,
  resolveVaultWithdrawClient,
} from "./execution-registry";
import { createVaultDeadline } from "./vault-deadline";

const executionEnv = {} as Env;
const hastraDexExecutionEnv = {
  ...executionEnv,
  EARN_HASTRA_DEX_EXIT_ENABLED: "true",
  JUPITER_SWAP_API_KEY: "jup_test_key",
} as Env;
const depositInput = {
  providerReference: "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx",
  owner: "11111111111111111111111111111112",
  amount: "1",
};

describe("resolveVaultDirectClient", () => {
  const stub = installClusterRpcStub();

  it("keeps resolution I/O-free and preserves inherited provider capabilities", () => {
    const client = resolveVaultDirectClient(executionEnv, "kamino", createVaultDeadline());

    expect(client).not.toBeNull();
    expect(typeof (client as unknown as Record<string, unknown>).listStrategyMetrics).toBe(
      "function"
    );
    expect(stub.calls).toEqual([]);
  });

  it("resolves an executing client for every provider that can move money", () => {
    const catalogueOnly = new Set(["upshift", "perena"]);

    for (const provider of EARN_PROVIDERS) {
      const client = resolveVaultDirectClient(executionEnv, provider, createVaultDeadline());
      if (catalogueOnly.has(provider)) {
        expect(client, provider).toBeNull();
        continue;
      }
      expect(client, provider).not.toBeNull();
      expect(client?.provider, provider).toBe(provider);
      // The superset, not a replacement: the executing client still catalogues.
      expect(typeof client?.listStrategies, provider).toBe("function");
    }
    expect(stub.calls).toEqual([]);
  });

  /**
   * This resolver is the ONE sanctioned provider-id branch in the codebase, and
   * unknown ids must answer null rather than throw: a strategy row written by a
   * newer deploy would otherwise 500 a read that merely touched it. `ground`
   * stays listed as a RETIRED id — stored rows outlive the registry entry that
   * wrote them, so it must keep failing closed exactly like a never-known id.
   */
  it("answers null for anything this deployment cannot execute", () => {
    for (const provider of ["ground", "upshift", "perena", "not-a-provider", "__proto__", ""]) {
      expect(
        resolveVaultDirectClient(executionEnv, provider, createVaultDeadline()),
        provider
      ).toBeNull();
    }
  });

  /**
   * SDP has no confirmed PRODUCTION Veda deployment (devnet is deployed;
   * mainnet waits on PRO-1777), so a production deposit fails on THAT rather
   * than on an RPC — and it fails before any endpoint work, because an
   * unconfigured deployment is a fact about SDP that should not depend on a
   * node being reachable.
   */
  it("refuses Veda work on the missing mainnet deployment, before any RPC", async () => {
    const productionRuntime = { env: {}, environment: "production" } as const;
    const productionScope = {
      projectId: "proj_execution_registry_production",
      environment: "production",
    } as const;
    const client = resolveVaultDirectClient(executionEnv, "veda", createVaultDeadline());
    if (!client) throw new Error("expected a Veda vault-direct client");

    await expect(
      runInClusterScope(productionScope, () =>
        client.buildVaultDeposit(productionRuntime, { ...depositInput, minSharesOut: "1" })
      )
    ).rejects.toMatchObject({ code: "DEPLOYMENT_NOT_CONFIGURED" });
    await expect(
      runInClusterScope(productionScope, () =>
        client.readVaultPositions(productionRuntime, {
          owner: depositInput.owner,
          providerReferences: [depositInput.providerReference],
        })
      )
    ).rejects.toMatchObject({ code: "DEPLOYMENT_NOT_CONFIGURED" });
    expect(stub.calls).toEqual([]);
  });

  it("resolves WisdomTree as vault-direct with eligibility and withdraw, I/O-free", async () => {
    const {
      supportsDepositEligibility,
      supportsVaultDirect,
      supportsVaultProviderOrderWithdraw,
      supportsVaultWithdraw,
    } = await import("@sdp/earn/capabilities");

    const client = resolveVaultDirectClient(executionEnv, "wisdomtree", createVaultDeadline());

    expect(client).not.toBeNull();
    if (!client) throw new Error("expected WisdomTree vault-direct client");
    expect(supportsVaultDirect(client)).toBe(true);
    expect(supportsVaultWithdraw(client)).toBe(true);
    expect(supportsVaultProviderOrderWithdraw(client)).toBe(true);
    expect(supportsDepositEligibility(client)).toBe(true);
    expect(stub.calls).toEqual([]);
  });

  it("defaults Hastra to par-only and admits the DEX capability only when configured", async () => {
    const { supportsVaultParRedemption, supportsVaultWithdraw } = await import(
      "@sdp/earn/capabilities"
    );

    const direct = resolveVaultDirectClient(executionEnv, "hastra", createVaultDeadline());
    const par = resolveVaultParRedemptionClient(executionEnv, "hastra", createVaultDeadline());
    const defaultDex = resolveVaultWithdrawClient(executionEnv, "hastra", createVaultDeadline());
    const flagWithoutKey = resolveVaultWithdrawClient(
      { ...executionEnv, EARN_HASTRA_DEX_EXIT_ENABLED: "true" } as Env,
      "hastra",
      createVaultDeadline()
    );
    const enabledDex = resolveVaultWithdrawClient(
      hastraDexExecutionEnv,
      "hastra",
      createVaultDeadline()
    );
    const historicalDex = resolveRecordedVaultWithdrawClient(
      executionEnv,
      "hastra",
      createVaultDeadline()
    );

    expect(direct).not.toBeNull();
    expect(direct?.provider).toBe("hastra");
    expect(direct && supportsVaultWithdraw(direct)).toBe(true);
    expect(direct && supportsVaultParRedemption(direct)).toBe(true);
    expect(par).not.toBeNull();
    expect(par?.provider).toBe("hastra");
    expect(defaultDex).toBeNull();
    expect(flagWithoutKey).toBeNull();
    expect(enabledDex?.provider).toBe("hastra");
    expect(historicalDex?.provider).toBe("hastra");
    expect(stub.calls).toEqual([]);
  });

  it("keeps every provider's withdrawal capability and settlement table in agreement", async () => {
    const { supportsVaultProviderOrderWithdraw } = await import("@sdp/earn/capabilities");
    const { EARN_PROVIDERS, EARN_PROVIDER_WITHDRAWAL_SETTLEMENT } = await import("@sdp/types");

    for (const provider of EARN_PROVIDERS) {
      const client = resolveVaultDirectClient(executionEnv, provider, createVaultDeadline());
      // The reconciler decides by CLIENT CAPABILITY while ?settled= and the
      // dashboard decide by the SETTLEMENT TABLE. If the two disagree, the API
      // parks rows the list calls settled (or the reverse) — so pin them to
      // each other for the whole registry, null clients included.
      const capability = client !== null && supportsVaultProviderOrderWithdraw(client);
      expect(capability, provider).toBe(
        EARN_PROVIDER_WITHDRAWAL_SETTLEMENT[provider] === "provider_order"
      );
    }
    // The loop is not vacuous: exactly one provider-order provider exists today.
    expect(EARN_PROVIDER_WITHDRAWAL_SETTLEMENT.wisdomtree).toBe("provider_order");
  });
});
