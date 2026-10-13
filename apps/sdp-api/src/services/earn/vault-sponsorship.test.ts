import { runInClusterScope } from "@sdp/rpc/scope";
import type { Project } from "@sdp/types";
import type { Address } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectService } from "@/services/project.service";
import { env as testEnv } from "@/test/helpers/env";
import type { Env } from "@/types/env";
import { createVaultDeadline } from "./vault-deadline";

const createProjectSponsorshipFeePayment = vi.hoisted(() => vi.fn());

vi.mock("@/services/sponsorship.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/sponsorship.service")>()),
  createProjectSponsorshipFeePayment,
}));

const { createProjectSponsorshipFeePayment: createRealProjectSponsorshipFeePayment } =
  await vi.importActual<typeof import("@/services/sponsorship.service")>(
    "@/services/sponsorship.service"
  );

const { resolveVaultSponsorship, vaultRentPayer } = await import("./vault-sponsorship");

const SPONSOR = "4YhMUz8xDgHMPAevvfMpnJX9TJmw9DTNDA1sNWPRZG9q" as Address;

function scope(env: Partial<Env> = {}) {
  return {
    env: {
      EARN_VAULT_FEE_SPONSORSHIP_ENABLED: "true",
      SOLANA_NETWORK: "devnet",
      KORA_RPC_URL_DEVNET: "https://kora-devnet.example",
      ...env,
    } as Env,
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

    const fee = await resolveVaultSponsorship(env, input);

    expect(fee).toMatchObject({ kind: "sponsored", sponsor: SPONSOR });
    expect(vaultRentPayer(fee)).toBe(SPONSOR);
  });

  it.each(["", "false", "0", "off", undefined])(
    "falls back to wallet-pays when the flag reads %o",
    async (flag) => {
      const { env, input } = scope({ EARN_VAULT_FEE_SPONSORSHIP_ENABLED: flag });

      const fee = await resolveVaultSponsorship(env, input);

      expect(fee).toEqual({ kind: "wallet-pays" });
      expect(vaultRentPayer(fee)).toBeUndefined();
      // Turning sponsorship off must not even construct a provider: the
      // acceptance criterion is that the route reverts with no code change.
      expect(createProjectSponsorshipFeePayment).not.toHaveBeenCalled();
    }
  );

  it("goes through the shared sponsorship boundary, scoped to the custody wallet", async () => {
    // Not a raw fee-payment adapter: that boundary is what applies the budget
    // reservation and the Kora usage identity in managed deployments, so
    // bypassing it would spend the fee payer without any budget seeing it.
    const { env, input } = scope();

    await resolveVaultSponsorship(env, input);

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

    const pending = resolveVaultSponsorship(env, { ...input, deadline: createVaultDeadline(25) });
    const rejection = expect(pending).rejects.toThrow(
      "Resolving the sponsored fee payer timed out after 25ms"
    );

    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    vi.useRealTimers();
  });
});

describe("resolveVaultSponsorship on a cluster without Kora", () => {
  const productionProject: Project = {
    id: "prj_vault_sponsorship_no_kora",
    organizationId: "org_vault_sponsorship_no_kora",
    name: "Vault Sponsorship Without Kora",
    slug: "vault-sponsorship-no-kora",
    description: null,
    environment: "production",
    settings: null,
    status: "active",
    createdBy: "usr_vault_sponsorship_no_kora",
    createdAt: "2026-10-13T00:00:00.000Z",
    updatedAt: "2026-10-13T00:00:00.000Z",
  };
  const movement = {
    organizationId: productionProject.organizationId,
    projectId: productionProject.id,
    walletId: "cwlt_vault_sponsorship_no_kora",
    deadline: createVaultDeadline(),
  };

  function resolveInProduction(flag: string | undefined) {
    const env: Env = {
      ...testEnv,
      EARN_VAULT_FEE_SPONSORSHIP_ENABLED: flag,
      KORA_RPC_URL_MAINNET: undefined,
    };
    return runInClusterScope({ projectId: productionProject.id, environment: "production" }, () =>
      resolveVaultSponsorship(env, movement)
    );
  }

  beforeEach(() => {
    vi.spyOn(ProjectService.prototype, "getProject").mockResolvedValue(productionProject);
    createProjectSponsorshipFeePayment.mockImplementation(createRealProjectSponsorshipFeePayment);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses the movement with PROVIDER_NOT_AVAILABLE when the flag is on", async () => {
    await expect(resolveInProduction("true")).rejects.toMatchObject({
      name: "FeePaymentError",
      code: "PROVIDER_NOT_AVAILABLE",
      message: "Kora is not configured for mainnet-beta: set KORA_RPC_URL_MAINNET",
    });
  });

  it("lets the wallet pay when the flag is off", async () => {
    await expect(resolveInProduction(undefined)).resolves.toEqual({ kind: "wallet-pays" });
    expect(createProjectSponsorshipFeePayment).not.toHaveBeenCalled();
  });
});
