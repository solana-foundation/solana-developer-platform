import { createHash } from "node:crypto";
import { SPL_TOKEN_PROGRAMS } from "@sdp/types";
import { getBase58Decoder, getBase58Encoder } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { parseKaminoDepositReceipt } from "./deposit-receipt";
import { kaminoClusterConfig } from "./programs";

const config = kaminoClusterConfig("mainnet-beta");
const input = {
  signature: "recorded-signature",
  vault: "vault",
  owner: "owner",
  tokenMint: "token",
  shareMint: "shares",
  requestedAmount: "10",
};

function fixture(withFloor = false) {
  const data = Buffer.alloc(withFloor ? 24 : 16);
  createHash("sha256")
    .update(`global:${withFloor ? "deposit_with_min_shares_out" : "deposit"}`)
    .digest()
    .copy(data, 0, 0, 8);
  data.writeBigUInt64LE(10_000_000n, 8);
  if (withFloor) data.writeBigUInt64LE(1_000_000n, 16);
  const balance = (accountIndex: number, mint: string, amount: string) => ({
    accountIndex,
    mint,
    owner: "owner",
    uiTokenAmount: { amount, decimals: 6 },
  });
  return {
    meta: {
      err: null,
      // Net +7 tokens after a swap credits 10 and the capped deposit takes 3.
      preTokenBalances: [balance(1, "token", "0")],
      postTokenBalances: [balance(1, "token", "7000000"), balance(2, "shares", "2900000")],
      innerInstructions: [
        {
          index: 0,
          instructions: [
            {
              programId: String(TOKEN_PROGRAM_ADDRESS),
              parsed: {
                type: "transfer",
                info: {
                  source: "swap",
                  destination: "source",
                  amount: "10000000",
                  authority: "swap",
                },
              },
            },
          ],
        },
        {
          index: 1,
          instructions: [
            {
              programId: String(TOKEN_PROGRAM_ADDRESS),
              parsed: {
                type: "transferChecked",
                info: {
                  source: "source",
                  destination: "token-vault",
                  authority: "owner",
                  mint: "token",
                  tokenAmount: { amount: "3000000", decimals: 6 },
                },
              },
            },
            {
              programId: String(TOKEN_PROGRAM_ADDRESS),
              parsed: {
                type: "mintTo",
                info: {
                  mint: "shares",
                  account: "destination",
                  mintAuthority: "authority",
                  amount: "2900000",
                },
              },
            },
          ],
        },
      ],
    },
    transaction: {
      signatures: [input.signature],
      message: {
        accountKeys: [
          { pubkey: "owner", signer: true },
          { pubkey: "source", signer: false },
          { pubkey: "destination", signer: false },
        ],
        instructions: [
          { programId: "swap", data: "", accounts: [] as string[] },
          {
            programId: String(config.kvaultProgramId),
            data: getBase58Decoder().decode(data),
            accounts: [
              "owner",
              "vault",
              "token-vault",
              "token",
              "authority",
              "shares",
              "source",
              "destination",
              String(config.klendProgramId),
              String(TOKEN_PROGRAM_ADDRESS),
              String(TOKEN_PROGRAM_ADDRESS),
              "event-authority",
              String(config.kvaultProgramId),
            ],
          },
        ],
      },
    },
  };
}

describe("Kamino finalized deposit receipt", () => {
  it("reads Token-2022 debits in the deposit's token program", () => {
    const transaction = fixture();
    transaction.transaction.message.instructions[1].accounts[9] = SPL_TOKEN_PROGRAMS["token-2022"];
    const transfer = transaction.meta.innerInstructions[1].instructions[0];
    transfer.programId = SPL_TOKEN_PROGRAMS["token-2022"];
    expect(parseKaminoDepositReceipt(transaction, "mainnet-beta", input)?.amount).toBe("3");
    transfer.parsed.type = "transferCheckedWithFee";
    expect(parseKaminoDepositReceipt(transaction, "mainnet-beta", input)?.amount).toBe("3");
    transfer.programId = TOKEN_PROGRAM_ADDRESS;
    expect(parseKaminoDepositReceipt(transaction, "mainnet-beta", input)).toBeNull();
  });

  it.each(["-1", "1.5", "1e6", "0", "10000001", "18446744073709551616"])(
    "refuses malformed, empty or excessive debit %s",
    (amount) => {
      const transaction = fixture();
      const transfer = transaction.meta.innerInstructions[1].instructions[0].parsed.info;
      if ("tokenAmount" in transfer && transfer.tokenAmount) transfer.tokenAmount.amount = amount;
      expect(parseKaminoDepositReceipt(transaction, "mainnet-beta", input)).toBeNull();
    }
  );

  it("refuses a share mint below the encoded floor and unfamiliar instruction bytes", () => {
    const transaction = fixture(true);
    const instruction = transaction.transaction.message.instructions[1];
    const bytes = Buffer.from(getBase58Encoder().encode(instruction.data));
    bytes.writeBigUInt64LE(3_000_000n, 16);
    instruction.data = getBase58Decoder().decode(bytes);
    expect(parseKaminoDepositReceipt(transaction, "mainnet-beta", input)).toBeNull();
    instruction.data = "1".repeat(1000);
    expect(parseKaminoDepositReceipt(transaction, "mainnet-beta", input)).toBeNull();
    instruction.data = "0";
    expect(parseKaminoDepositReceipt(transaction, "mainnet-beta", input)).toBeNull();
  });

  it.each([false, true])(
    "observes a capped deposit inside a swap-funded transaction (floor=%s)",
    (floor) => {
      expect(parseKaminoDepositReceipt(fixture(floor), "mainnet-beta", input)).toEqual({
        amount: "3",
        sharesOut: "2.9",
      });
    }
  );

  it("preserves atom precision above Number.MAX_SAFE_INTEGER", () => {
    const transaction = fixture();
    // Both the instruction maximum and observed CPI amount are integer bytes/strings.
    const maximum = Buffer.alloc(16);
    createHash("sha256").update("global:deposit").digest().copy(maximum, 0, 0, 8);
    maximum.writeBigUInt64LE(9007199254740993n, 8);
    transaction.transaction.message.instructions[1].data = getBase58Decoder().decode(maximum);
    const transfer = transaction.meta.innerInstructions[1].instructions[0].parsed.info;
    if ("tokenAmount" in transfer && transfer.tokenAmount)
      transfer.tokenAmount.amount = "9007199254740993";
    expect(
      parseKaminoDepositReceipt(transaction, "mainnet-beta", {
        ...input,
        requestedAmount: "9007199254.740993",
      })?.amount
    ).toBe("9007199254.740993");
  });

  it.each(["signature", "vault", "owner", "tokenMint", "shareMint", "requestedAmount"] as const)(
    "refuses a receipt for the wrong %s",
    (field) => {
      expect(
        parseKaminoDepositReceipt(fixture(), "mainnet-beta", { ...input, [field]: "wrong" })
      ).toBeNull();
    }
  );

  it("refuses a foreign cluster and incomplete or failed metadata", () => {
    const transaction = fixture();
    expect(parseKaminoDepositReceipt(transaction, "devnet", input)).toBeNull();
    expect(parseKaminoDepositReceipt(null, "mainnet-beta", input)).toBeNull();
    expect(
      parseKaminoDepositReceipt({ ...transaction, meta: null }, "mainnet-beta", input)
    ).toBeNull();
    expect(
      parseKaminoDepositReceipt(
        { ...transaction, meta: { ...transaction.meta, err: {} } },
        "mainnet-beta",
        input
      )
    ).toBeNull();
    transaction.meta.innerInstructions = [];
    expect(parseKaminoDepositReceipt(transaction, "mainnet-beta", input)).toBeNull();
  });

  it("does not infer the deposit from a wallet balance or another instruction's transfers", () => {
    const transaction = fixture();
    transaction.meta.innerInstructions[1].index = 2;
    expect(parseKaminoDepositReceipt(transaction, "mainnet-beta", input)).toBeNull();
  });

  it("refuses duplicate deposits, missing mint observations, and inconsistent decimals", () => {
    const transaction = fixture();
    transaction.transaction.message.instructions.push(
      transaction.transaction.message.instructions[1]
    );
    expect(parseKaminoDepositReceipt(transaction, "mainnet-beta", input)).toBeNull();
    transaction.transaction.message.instructions.pop();
    transaction.meta.postTokenBalances[0].uiTokenAmount.decimals = 9;
    expect(parseKaminoDepositReceipt(transaction, "mainnet-beta", input)).toBeNull();
    transaction.meta.postTokenBalances = [];
    expect(parseKaminoDepositReceipt(transaction, "mainnet-beta", input)).toBeNull();
  });
});
