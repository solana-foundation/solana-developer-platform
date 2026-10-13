import { runInClusterScope } from "@sdp/rpc/scope";
import { address, createNoopSigner } from "@solana/kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSponsorshipFeePayment, type SponsorshipScope } from "@/services/sponsorship.service";
import { installClusterRpcStub } from "@/test/helpers/cluster-rpc";
import { env } from "@/test/helpers/env";
import type { Env } from "@/types/env";
import { createMosaicService } from "./index";

vi.mock("@/services/sponsorship.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/sponsorship.service")>();
  return { ...actual, createSponsorshipFeePayment: vi.fn(actual.createSponsorshipFeePayment) };
});

const PROJECT_ID = "prj_mosaic_sponsorship_test";
const SIGNER = createNoopSigner(address("11111111111111111111111111111111"));
const PRODUCTION_SPONSORSHIP_SCOPE: SponsorshipScope = {
  environment: "production",
  organizationId: "org_mosaic_sponsorship_test",
  projectId: PROJECT_ID,
  actor: { type: "api_key", id: "key_mosaic_sponsorship_test" },
};

function createInProduction(serviceEnv: Env) {
  return runInClusterScope({ projectId: PROJECT_ID, environment: "production" }, () =>
    createMosaicService(serviceEnv, SIGNER, "sponsored", PRODUCTION_SPONSORSHIP_SCOPE)
  );
}

describe("createMosaicService sponsorship gate", () => {
  installClusterRpcStub();

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("lets the wallet pay when only devnet's Kora is configured", () => {
    createInProduction(env);

    expect(createSponsorshipFeePayment).not.toHaveBeenCalled();
  });

  it("sponsors through the scope cluster's fee payer once it is configured", () => {
    const sponsoredEnv: Env = { ...env, KORA_RPC_URL_MAINNET: "https://kora-mainnet.mock.invalid" };

    createInProduction(sponsoredEnv);

    expect(createSponsorshipFeePayment).toHaveBeenCalledExactlyOnceWith(
      sponsoredEnv,
      PRODUCTION_SPONSORSHIP_SCOPE
    );
  });
});
