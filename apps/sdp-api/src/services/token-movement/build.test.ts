import { runInClusterScope } from "@sdp/rpc/scope";
import { createNoopSigner } from "@solana/kit";
import {
  getTransferCheckedInstructionDataDecoder,
  TOKEN_2022_PROGRAM_ADDRESS,
  TRANSFER_CHECKED_DISCRIMINATOR,
} from "@solana-program/token-2022";
import { describe, expect, it } from "vitest";
import { resolvePaymentAsset } from "@/services/payment-operation.service";
import { installClusterRpcResponder, tokenAccountsByOwnerResult } from "@/test/helpers/cluster-rpc";
import { syntheticAddress } from "@/test/helpers/parsed-transactions";
import { required } from "@/test/helpers/required";
import { scaledUiAmountConfig } from "@/test/helpers/token-mints";
import { answerMovementAccounts, mintRpcAccount } from "@/test/helpers/token-movement";
import { buildPlannedLeg, planTokenMovement } from "./build";

describe("planTokenMovement and buildPlannedLeg", () => {
  const rpc = installClusterRpcResponder();

  it.each([
    { kind: "plain", extensions: null },
    {
      // An amount is in token units (ADR 0012): the multiplier changes only what a wallet shows.
      kind: "scaled UI amount",
      extensions: [
        scaledUiAmountConfig({
          multiplier: 2,
          newMultiplier: 4,
          newMultiplierEffectiveTimestamp: 1_800_000_000n,
        }),
      ],
    },
  ])(
    "moves an amount above 2^53 base units exactly on a $kind Token-2022 mint",
    async ({ extensions }) => {
      const mint = syntheticAddress(11);
      const source = syntheticAddress(13);
      answerMovementAccounts(
        rpc,
        new Map([[mint, mintRpcAccount("token-2022", { decimals: 6, extensions })]])
      );
      rpc.answer(
        "getTokenAccountsByOwner",
        tokenAccountsByOwnerResult(1, [
          {
            pubkey: syntheticAddress(12),
            mint,
            amount: "20000000000000000",
            decimals: 6,
            uiAmountString: "20000000000",
            state: "initialized",
          },
        ])
      );

      const instructions = await runInClusterScope(
        { projectId: null, environment: "sandbox" },
        async () => {
          const plan = await planTokenMovement({
            asset: resolvePaymentAsset(mint),
            basis: "debit",
            source,
            destinations: [{ owner: syntheticAddress(14), amount: "9007199254.740993" }],
            memo: null,
          });
          return buildPlannedLeg(plan, required(plan.legs[0]), {
            authority: createNoopSigner(source),
            feePayer: syntheticAddress(15),
          });
        }
      );

      const transfers = instructions.filter(
        (instruction) =>
          instruction.programAddress === TOKEN_2022_PROGRAM_ADDRESS &&
          instruction.data?.[0] === TRANSFER_CHECKED_DISCRIMINATOR
      );
      expect(transfers).toHaveLength(1);
      expect(
        getTransferCheckedInstructionDataDecoder().decode(required(transfers[0]?.data))
      ).toMatchObject({ amount: 9_007_199_254_740_993n, decimals: 6 });
      // The terms, Clock and destination account are one read.
      expect(
        rpc.requests.filter((request) => request.method === "getMultipleAccounts")
      ).toHaveLength(1);
    }
  );
});
