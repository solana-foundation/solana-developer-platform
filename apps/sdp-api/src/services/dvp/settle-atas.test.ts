import { address } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import { describe, expect, it } from "vitest";
import { deriveDvpSettleAtas } from "./settle-atas";

const USER_A = address("5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn");
const USER_B = address("7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg");
const DESTINATION_A = address("9BvXsTHgFvS31NLpVN4hpAoHCTfwvVX1XkgFq7fJEZxY");
const DESTINATION_B = address("BXvugAaWDqgADmGTdwgdzVZUyJbagNM6w4hPrC4JQ1po");
const MINT_A = address("ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1");
const MINT_B = address("AqTgvZaiZ18ykVvzaQhfB2KQ4SGDw4i1o5rQqBAMsZiE");

describe("deriveDvpSettleAtas", () => {
  it("derives the four documented owner, mint, and program pairs with destinations crossed", async () => {
    const atas = await deriveDvpSettleAtas({
      userA: USER_A,
      userB: USER_B,
      userASettlementDestination: DESTINATION_A,
      userBSettlementDestination: DESTINATION_B,
      mintA: MINT_A,
      mintB: MINT_B,
      tokenProgramA: TOKEN_2022_PROGRAM_ADDRESS,
      tokenProgramB: TOKEN_2022_PROGRAM_ADDRESS,
    });
    const [userADestinationAtaB] = await findAssociatedTokenPda({
      owner: DESTINATION_A,
      mint: MINT_B,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    });
    const [userBDestinationAtaA] = await findAssociatedTokenPda({
      owner: DESTINATION_B,
      mint: MINT_A,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    });
    const [userAAtaA] = await findAssociatedTokenPda({
      owner: USER_A,
      mint: MINT_A,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    });
    const [userBAtaB] = await findAssociatedTokenPda({
      owner: USER_B,
      mint: MINT_B,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    });

    expect(atas).toEqual({
      userADestinationAtaB,
      userBDestinationAtaA,
      userAAtaA,
      userBAtaB,
    });
  });
});
