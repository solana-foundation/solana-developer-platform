import * as solanaRpc from "@sdp/rpc/solana";
import { createSolanaRpc, signature } from "@solana/kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIssuanceSponsor } from "@/services/issuance/sponsored-submitter";
import type {
  PreparedOwnedSubmission,
  SponsorshipFeePayment,
  SponsorshipScope,
} from "@/services/sponsorship.service";
import * as sponsorshipService from "@/services/sponsorship.service";
import { env } from "@/test/helpers/env";
import { sendTransactionPreflightError } from "@/test/helpers/rpc-errors";

const SIGNATURE = signature("1".repeat(64));

const SCOPE: SponsorshipScope = {
  organizationId: "org_issuance_sponsor",
  projectId: "prj_issuance_sponsor",
  actor: { type: "api_key", id: "key_issuance_sponsor" },
};

describe("createIssuanceSponsor", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("releases the reservation and fails the send when the RPC refuses it at preflight", async () => {
    const custodySigned = new Uint8Array([9]);
    const sponsorSigned = new Uint8Array([1, 2, 3]);
    const releaseDefinitelyUnbroadcast = vi
      .fn<PreparedOwnedSubmission["releaseDefinitelyUnbroadcast"]>()
      .mockResolvedValue(undefined);
    const prepareOwnedSubmission = vi
      .fn<SponsorshipFeePayment["prepareOwnedSubmission"]>()
      .mockResolvedValue({
        signedTransaction: sponsorSigned,
        signature: SIGNATURE,
        releaseDefinitelyUnbroadcast,
      });
    const createSponsor = vi
      .spyOn(sponsorshipService, "createSponsorshipFeePayment")
      .mockReturnValue({
        providerId: "test",
        getFeePayer: vi.fn(),
        signAsFeePayer: vi.fn(),
        getSponsorshipConfiguration: vi.fn(),
        prepareOwnedSubmission,
      });
    const refusal = sendTransactionPreflightError();
    const send = vi.spyOn(solanaRpc, "sendTransaction").mockRejectedValueOnce(refusal);
    const rpc: solanaRpc.SolanaRpc = createSolanaRpc("http://127.0.0.1:8899");

    const sponsor = createIssuanceSponsor(env, SCOPE, "issuance.authority", {
      custodyWalletId: "cwlt_authority",
    });

    await expect(
      sponsor.submitSponsored({ transaction: custodySigned, lastValidBlockHeight: 123n, rpc })
    ).rejects.toMatchObject({ code: "TRANSACTION_FAILED" });
    expect(createSponsor).toHaveBeenCalledExactlyOnceWith(env, SCOPE, "issuance.authority", {
      custodyWalletId: "cwlt_authority",
    });
    expect(prepareOwnedSubmission).toHaveBeenCalledOnce();
    expect(prepareOwnedSubmission.mock.calls[0][0]).toBe(custodySigned);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).toBe(rpc);
    expect(send.mock.calls[0][1]).toBe(sponsorSigned);
    expect(releaseDefinitelyUnbroadcast).toHaveBeenCalledExactlyOnceWith(refusal);
  });
});
