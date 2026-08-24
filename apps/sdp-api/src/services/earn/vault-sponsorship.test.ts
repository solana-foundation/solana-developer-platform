import type { Address } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "@/types/env";
import { createVaultDeadline } from "./vault-deadline";

const createProjectSponsorshipFeePayment = vi.hoisted(() => vi.fn());

vi.mock("@/services/sponsorship.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/sponsorship.service")>()),
  createProjectSponsorshipFeePayment,
}));

const { resolveVaultSponsorship, vaultRentPayer } = await import("./vault-sponsorship");

const SPONSOR = "4YhMUz8xDgHMPAevvfMpnJX9TJmw9DTNDA1sNWPRZG9q" as Address;

function scope(env: Partial<Env> = {}) {
  return {
    env: { EARN_VAULT_FEE_SPONSORSHIP_ENABLED: "true", ...env } as Env,
    input: {
      organizationId: "org_1",
      projectId: "prj_1",
      walletId: "cwlt_1",
      deadline: createVaultDeadline(),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  createProjectSponsorshipFeePayment.mockResolvedValue({
    getFeePayer: vi.fn().mockResolvedValue(SPONSOR),
  });
});

describe("resolveVaultSponsorship", () => {
  it("sponsors devnet when the flag is on, resolving the sponsor once", async () => {
    const { env, input } = scope();

    const fee = await resolveVaultSponsorship(env, { ...input, cluster: "devnet" });

    expect(fee).toMatchObject({ kind: "sponsored", sponsor: SPONSOR });
    expect(vaultRentPayer(fee)).toBe(SPONSOR);
  });

  it.each(["", "false", "0", "off", undefined])(
    "falls back to wallet-pays when the flag reads %o",
    async (flag) => {
      const { env, input } = scope({ EARN_VAULT_FEE_SPONSORSHIP_ENABLED: flag });

      const fee = await resolveVaultSponsorship(env, { ...input, cluster: "devnet" });

      expect(fee).toEqual({ kind: "wallet-pays" });
      expect(vaultRentPayer(fee)).toBeUndefined();
      // Turning sponsorship off must not even construct a provider: the
      // acceptance criterion is that the route reverts with no code change.
      expect(createProjectSponsorshipFeePayment).not.toHaveBeenCalled();
    }
  );

  /**
   * The exit-safety guard, and the reason the predicate takes a cluster at all.
   *
   * One API process serves both clusters, and withdrawals are deliberately NOT
   * environment-gated (ADR 0002 forbids money-out inheriting a money-in gate).
   * A deployment-global flag would therefore sponsor mainnet withdrawals the
   * instant devnet deposits were enabled, against a mainnet Kora that
   * allowlists no Kamino program and a disabled mainnet budget policy: a 5xx on
   * a customer's exit.
   */
  it("never sponsors mainnet, even with the flag on", async () => {
    const { env, input } = scope();

    const fee = await resolveVaultSponsorship(env, { ...input, cluster: "mainnet-beta" });

    expect(fee).toEqual({ kind: "wallet-pays" });
    expect(createProjectSponsorshipFeePayment).not.toHaveBeenCalled();
  });

  it("goes through the shared sponsorship boundary, scoped to the custody wallet", async () => {
    // Not a raw fee-payment adapter: that boundary is what applies the budget
    // reservation and the Kora usage identity in managed deployments, so
    // bypassing it would spend the fee payer without any budget seeing it.
    const { env, input } = scope();

    await resolveVaultSponsorship(env, { ...input, cluster: "devnet" });

    expect(createProjectSponsorshipFeePayment).toHaveBeenCalledWith(env, {
      organizationId: "org_1",
      projectId: "prj_1",
      actor: { type: "wallet", id: "cwlt_1" },
    });
  });

  it("bounds sponsor resolution with the caller's deadline", async () => {
    vi.useFakeTimers();
    createProjectSponsorshipFeePayment.mockResolvedValue({
      getFeePayer: vi.fn(() => new Promise(() => undefined)),
    });
    const { env, input } = scope();

    const pending = resolveVaultSponsorship(env, {
      ...input,
      cluster: "devnet",
      deadline: createVaultDeadline(25),
    });
    const rejection = expect(pending).rejects.toThrow(
      "Resolving the sponsored fee payer timed out after 25ms"
    );

    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    vi.useRealTimers();
  });
});
