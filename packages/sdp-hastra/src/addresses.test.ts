import { HASTRA_DEPLOYMENTS } from "@sdp/types/hastra-programs";
import { address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  associatedTokenAddress,
  deriveHastraAddresses,
  legacyTicketAddress,
  redemptionRequestAddress,
} from "./addresses";
import { createAssociatedTokenInstruction, prefundOwnerRentInstruction } from "./instructions";

// Values recorded from the @solana/web3.js implementation this package replaced, so the kit
// derivations and builders are pinned to exactly what SDP signed before.
const configuredDeployment = HASTRA_DEPLOYMENTS["mainnet-beta"];
if (!configuredDeployment) throw new Error("test premise: Hastra mainnet deployment is configured");
const DEPLOYMENT = configuredDeployment;
const OWNER = address("C4XGF8r1gQP7p2PeKcRAFNwGAU1gCxiinRufqddY1m98");
const PAYER = address("9jQqxu5N6bV1qkh1Yv5F6zSMDNFCV2eqRV8HqvcHhk9V");
const USDC = address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const OWNER_USDC = "8zxEFqNwajQHAJeQoBbQ4z4zUNSt4K5JFX24zXKQJCpK";

describe("Hastra addresses", () => {
  it("derives the pinned deployment's PDAs", async () => {
    await expect(deriveHastraAddresses(DEPLOYMENT)).resolves.toEqual({
      mintConfig: "Fk58YLMoqCf1nzHub5AgYBeJ369iEMbP3HL1TBPqzhev",
      mintVaultTokenAccountConfig: "8qUJGQXzavrxQxdPDxoLGdrFqsheAg1i9EYj7AU3294F",
      mintAuthority: "AJuGsS1NrHgxpHgUu7AgCvshFGL8WdRwxks9sfAVhNQM",
      redeemVaultAuthority: "22K3aMz4qu89sLjkKffzGqFFGzsFmstSjCdpbRr7Usen",
      stakeConfig: "4qZvMr1THcZzHFicLAv9MtAi7cBGzQ7EzaY4K4cyYF18",
      stakeVaultTokenAccountConfig: "3BgchdaQWVeHke4iTgagADkX6LPPjuQLuNYVvPwBUpWt",
      stakeVaultAuthority: "DT7z9w9fGJ6sH7vmGbPCa5JLi2xp6XPrL61z2gctzmHb",
      stakeMintAuthority: "EtnHujEkqJJbgfTA2aC6vgZp8DVgwG6KdBxt9V1J31KK",
      stakePriceConfig: "Ev92L9D2CsPczeKHF3UWybQSweQCG4NRfexwJfVwyqsn",
    });
  });

  it("derives an owner's token account, request and legacy ticket", async () => {
    await expect(associatedTokenAddress(OWNER, USDC)).resolves.toBe(OWNER_USDC);
    await expect(redemptionRequestAddress(DEPLOYMENT, OWNER)).resolves.toBe(
      "EKrUUYogsMoE74hFzfX6MwavM324jeBnkYiRc8q2uYEb"
    );
    await expect(legacyTicketAddress(DEPLOYMENT, OWNER)).resolves.toBe(
      "7gVoRw1ziJBmJz7ECP4BZDz6YZHecicekaSbVnHrPTv7"
    );
  });
});

describe("Hastra system and token-account instructions", () => {
  it("creates an owner's token account idempotently, paid by the payer", async () => {
    await expect(createAssociatedTokenInstruction(PAYER, OWNER, USDC)).resolves.toEqual({
      programAddress: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
      accounts: [
        { address: PAYER, role: 3 },
        { address: OWNER_USDC, role: 1 },
        { address: OWNER, role: 0 },
        { address: USDC, role: 0 },
        { address: "11111111111111111111111111111111", role: 0 },
        { address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", role: 0 },
      ],
      data: "AQ==",
    });
  });

  it("pre-funds the owner's request rent with one System transfer from the payer", () => {
    expect(prefundOwnerRentInstruction(PAYER, OWNER, 2_039_280n)).toEqual({
      programAddress: "11111111111111111111111111111111",
      accounts: [
        { address: PAYER, role: 3 },
        { address: OWNER, role: 1 },
      ],
      data: "AgAAAPAdHwAAAAAA",
    });
  });
});
