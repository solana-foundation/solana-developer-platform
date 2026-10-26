import { runInClusterScope } from "@sdp/rpc/scope";
import type { SdpEnvironment } from "@sdp/types/api-keys";
import type { Address } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as sponsorshipService from "@/services/sponsorship.service";
import type { Env } from "@/types/env";
import { createVaultDeadline } from "./vault-deadline";
import { resolveVaultSponsorship, vaultRentPayer } from "./vault-sponsorship";

const resolveProjectSponsorshipScope = vi.fn();
const createSponsorshipFeePayment = vi.fn();

const SPONSOR = "4YhMUz8xDgHMPAevvfMpnJX9TJmw9DTNDA1sNWPRZG9q" as Address;

const WALLET_SCOPE = {
  environment: "sandbox",
  organizationId: "org_1",
  projectId: "prj_1",
  actor: { type: "wallet", id: "cwlt_1" },
} as const;

function scope(env: Partial<Env> = {}) {
  return {
    env: {
      EARN_VAULT_FEE_SPONSORSHIP_ENABLED: "true",
      SOLANA_NETWORK: "devnet",
      KORA_DEVNET_URL: "https://kora-devnet.mock.invalid",
      ...env,
    } as Env,
    input: {
      organizationId: "org_1",
      projectId: "prj_1",
      walletId: "cwlt_1",
      deadline: createVaultDeadline(),
      movement: "earn.deposit" as const,
    },
  };
}

/** The resolution as a movement on `environment`'s cluster runs it: inside that scope. */
function resolveIn(
  environment: SdpEnvironment,
  env: Env,
  input: Parameters<typeof resolveVaultSponsorship>[1]
) {
  return runInClusterScope({ projectId: "prj_1", environment }, () =>
    resolveVaultSponsorship(env, input)
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(sponsorshipService, "resolveProjectSponsorshipScope").mockImplementation(
    resolveProjectSponsorshipScope
  );
  vi.spyOn(sponsorshipService, "createSponsorshipFeePayment").mockImplementation(
    createSponsorshipFeePayment
  );
  resolveProjectSponsorshipScope.mockResolvedValue(WALLET_SCOPE);
  createSponsorshipFeePayment.mockReturnValue({
    getFeePayer: vi.fn().mockResolvedValue(SPONSOR),
  });
});

describe("resolveVaultSponsorship", () => {
  it("sponsors devnet when the flag is on, resolving the sponsor once", async () => {
    const { env, input } = scope();

    const fee = await resolveIn("sandbox", env, input);

    expect(fee).toMatchObject({ kind: "sponsored", sponsor: SPONSOR });
    expect(vaultRentPayer(fee)).toBe(SPONSOR);
  });

  it.each(["", "false", "0", "off", undefined])(
    "falls back to wallet-pays when the flag reads %o",
    async (flag) => {
      const { env, input } = scope({ EARN_VAULT_FEE_SPONSORSHIP_ENABLED: flag });

      const fee = await resolveIn("sandbox", env, input);

      expect(fee).toEqual({ kind: "wallet-pays" });
      expect(vaultRentPayer(fee)).toBeUndefined();
      // Turning sponsorship off must not even construct a provider: the
      // acceptance criterion is that the route reverts with no code change.
      expect(createSponsorshipFeePayment).not.toHaveBeenCalled();
    }
  );

  /**
   * The exit-safety guard, and the reason the predicate takes a cluster at all.
   *
   * One API process serves both clusters, and withdrawals are deliberately NOT
   * environment-gated (ADR 0002 forbids money-out inheriting a money-in gate).
   * A deployment-global flag would therefore sponsor mainnet withdrawals the
   * instant devnet deposits were enabled, against a paymaster this deployment
   * may not even have for that cluster: a 5xx on a customer's exit. Which
   * clusters sponsor is configuration: a cluster with no Kora endpoint answers
   * wallet-pays, flag or no flag.
   */
  it("keeps mainnet at wallet-pays while no mainnet paymaster is configured, flag on", async () => {
    const { env, input } = scope({
      SOLANA_NETWORK: "devnet",
      KORA_DEVNET_URL: "https://kora-devnet.mock.invalid",
    });

    const fee = await resolveIn("production", env, input);

    expect(fee).toEqual({ kind: "wallet-pays" });
    expect(createSponsorshipFeePayment).not.toHaveBeenCalled();
  });

  it("sponsors mainnet once its own paymaster is wired (PRO-1738)", async () => {
    const { env, input } = scope({
      SOLANA_NETWORK: "devnet",
      KORA_DEVNET_URL: "https://kora-devnet.mock.invalid",
      KORA_MAINNET_URL: "https://kora-mainnet.mock.invalid",
    });

    const productionScope = { ...WALLET_SCOPE, environment: "production" } as const;
    resolveProjectSponsorshipScope.mockResolvedValue(productionScope);

    const fee = await resolveIn("production", env, input);

    expect(fee).toMatchObject({ kind: "sponsored", sponsor: SPONSOR });
    expect(createSponsorshipFeePayment).toHaveBeenCalledWith(env, productionScope, "earn.deposit", {
      custodyWalletId: "cwlt_1",
    });
  });

  it("goes through the shared sponsorship boundary, scoped to the custody wallet", async () => {
    // Not a raw fee-payment adapter: that boundary is what applies the budget
    // reservation and the Kora usage identity in managed deployments, so
    // bypassing it would spend the fee payer without any budget seeing it.
    const { env, input } = scope();

    await resolveIn("sandbox", env, input);

    expect(resolveProjectSponsorshipScope).toHaveBeenCalledWith(env, {
      organizationId: "org_1",
      projectId: "prj_1",
      actor: { type: "wallet", id: "cwlt_1" },
    });
    expect(createSponsorshipFeePayment).toHaveBeenCalledWith(env, WALLET_SCOPE, "earn.deposit", {
      custodyWalletId: "cwlt_1",
    });
  });

  it("bounds sponsor resolution with the caller's deadline", async () => {
    vi.useFakeTimers();
    createSponsorshipFeePayment.mockReturnValue({
      getFeePayer: vi.fn(() => new Promise(() => undefined)),
    });
    const { env, input } = scope();

    const pending = resolveIn("sandbox", env, { ...input, deadline: createVaultDeadline(25) });
    const rejection = expect(pending).rejects.toThrow(
      "Resolving the sponsored fee payer timed out after 25ms"
    );

    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    vi.useRealTimers();
  });
});
