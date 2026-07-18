import { type PolicyRule, SOL_MINT, WELL_KNOWN_TOKENS } from "@sdp/types";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import {
  createRecurringPaymentSchema,
  createTransferSchema,
  PAYMENT_TOKEN_VALIDATION_MESSAGE,
  updateRecurringPaymentSchema,
  updateWalletPolicySchema,
} from "./schemas";

const USDC_MINT = WELL_KNOWN_TOKENS.USDC.mints["mainnet-beta"];
const VALID_DESTINATION = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

const tokenSchema = createTransferSchema.shape.token;
const destinationSchema = createTransferSchema.shape.destination;
const destinationAllowlistSchema = updateWalletPolicySchema.shape.destinationAllowlist;
const recurringPaymentTokenSchema = createRecurringPaymentSchema.shape.token;

describe("payments schema inferred types", () => {
  it("destination and allowlist entries infer as string", () => {
    type CreateTransfer = z.infer<typeof createTransferSchema>;
    type UpdateWalletPolicy = z.infer<typeof updateWalletPolicySchema>;

    expectTypeOf<CreateTransfer["destination"]>().toEqualTypeOf<string>();
    expectTypeOf<UpdateWalletPolicy["destinationAllowlist"]>().toEqualTypeOf<string[]>();
  });
});

describe("payments token schema", () => {
  describe("accepts native SOL keyword", () => {
    it("'SOL' parses to 'SOL'", () => {
      expect(tokenSchema.parse("SOL")).toBe("SOL");
    });

    it("'sol' is case-folded to 'SOL'", () => {
      expect(tokenSchema.parse("sol")).toBe("SOL");
    });

    it("' SOL ' is trimmed to 'SOL'", () => {
      expect(tokenSchema.parse(" SOL ")).toBe("SOL");
    });

    it("' soL ' combines case + whitespace", () => {
      expect(tokenSchema.parse(" soL ")).toBe("SOL");
    });
  });

  describe("accepts the canonical SOL mint", () => {
    it("parses the bare mint unchanged", () => {
      expect(tokenSchema.parse(SOL_MINT)).toBe(SOL_MINT);
    });

    it("trims whitespace around the mint", () => {
      expect(tokenSchema.parse(` ${SOL_MINT} `)).toBe(SOL_MINT);
    });
  });

  describe("accepts a valid base58 mint", () => {
    it("parses a real USDC mint unchanged", () => {
      expect(tokenSchema.parse(USDC_MINT)).toBe(USDC_MINT);
    });

    it("trims whitespace around a valid mint", () => {
      expect(tokenSchema.parse(` ${USDC_MINT} `)).toBe(USDC_MINT);
    });
  });

  describe("accepts well-known token symbols", () => {
    it("'USDC' parses to 'USDC'", () => {
      expect(tokenSchema.parse("USDC")).toBe("USDC");
    });

    it("' usdc ' is trimmed and case-folded to 'USDC'", () => {
      expect(tokenSchema.parse(" usdc ")).toBe("USDC");
    });
  });

  describe("rejects string inputs that do not match the contract", () => {
    const cases: Array<[string, string]> = [
      ["empty string", ""],
      ["unknown token symbol 'BTC'", "BTC"],
      ["too-short non-SOL string", "x".repeat(20)],
      ["too-long string", "x".repeat(50)],
      ["right-length non-base58 string", "!".repeat(43)],
      ["right-length string with non-base58 character (0)", `0${"1".repeat(42)}`],
    ];

    for (const [label, input] of cases) {
      it(`rejects ${label} with the canonical message`, () => {
        const result = tokenSchema.safeParse(input);
        expect(result.success).toBe(false);
        if (!result.success) {
          const messages = result.error.issues.map((issue) => issue.message);
          expect(messages).toContain(PAYMENT_TOKEN_VALIDATION_MESSAGE);
        }
      });
    }
  });

  describe("rejects non-string inputs", () => {
    const cases: Array<[string, unknown]> = [
      ["number", 123],
      ["null", null],
      ["undefined", undefined],
      ["object", { mint: SOL_MINT }],
    ];

    for (const [label, input] of cases) {
      it(`rejects ${label}`, () => {
        const result = tokenSchema.safeParse(input);
        expect(result.success).toBe(false);
      });
    }
  });
});

describe("payments destination schema", () => {
  it("accepts a valid base58 address", () => {
    expect(destinationSchema.parse(VALID_DESTINATION)).toBe(VALID_DESTINATION);
  });

  it("trims surrounding whitespace", () => {
    expect(destinationSchema.parse(` ${VALID_DESTINATION} `)).toBe(VALID_DESTINATION);
  });

  const rejections: Array<[string, string]> = [
    ["empty string", ""],
    ["too-short string", "x".repeat(20)],
    ["too-long string", "x".repeat(50)],
    ["right-length non-base58 string", "!".repeat(43)],
    ["right-length string with non-base58 char (0)", `0${"1".repeat(42)}`],
  ];

  for (const [label, input] of rejections) {
    it(`rejects ${label} with the destination-specific message`, () => {
      const result = destinationSchema.safeParse(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        const messages = result.error.issues.map((issue) => issue.message);
        expect(messages).toContain("destination must be a base58 Solana address");
      }
    });
  }
});

describe("recurring payment schema", () => {
  it("accepts a custody source wallet and counterparty crypto wallet account target", () => {
    const result = createRecurringPaymentSchema.safeParse({
      sourceWalletId: "wal_source",
      counterpartyId: "cp_test",
      counterpartyAccountId: "cpa_test",
      token: USDC_MINT,
      amount: "25.00",
      periodHours: 24,
      firstCollectionAt: new Date(Date.now() + 60_000).toISOString(),
    });

    expect(result.success).toBe(true);
  });

  it("rejects a past firstCollectionAt timestamp", () => {
    const result = createRecurringPaymentSchema.safeParse({
      sourceWalletId: "wal_source",
      counterpartyId: "cp_test",
      counterpartyAccountId: "cpa_test",
      token: USDC_MINT,
      amount: "25.00",
      periodHours: 24,
      firstCollectionAt: new Date(Date.now() - 60_000).toISOString(),
    });

    expect(result.success).toBe(false);
  });

  it("accepts native SOL as a supported recurring payment token", () => {
    expect(recurringPaymentTokenSchema.parse("SOL")).toBe("SOL");
  });

  it("rejects an empty recurring payment update body", () => {
    const result = updateRecurringPaymentSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("accepts nullable pending and active timing fields on recurring payment updates", () => {
    const result = updateRecurringPaymentSchema.safeParse({
      firstCollectionAt: null,
      nextCollectionDueAt: null,
      metadataUri: null,
    });
    expect(result.success).toBe(true);
  });

  it("requires counterpartyAccountId when counterpartyId changes", () => {
    const result = updateRecurringPaymentSchema.safeParse({
      counterpartyId: "cp_next",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid recurring payment update amount, period, and metadata URL", () => {
    expect(updateRecurringPaymentSchema.safeParse({ amount: "0" }).success).toBe(false);
    expect(updateRecurringPaymentSchema.safeParse({ periodHours: 0 }).success).toBe(false);
    expect(updateRecurringPaymentSchema.safeParse({ metadataUri: "not-a-url" }).success).toBe(
      false
    );
  });
});

describe("wallet policy destinationAllowlist schema", () => {
  it("accepts an empty array", () => {
    expect(destinationAllowlistSchema.parse([])).toEqual([]);
  });

  it("accepts trimmed valid addresses", () => {
    expect(destinationAllowlistSchema.parse([` ${VALID_DESTINATION} `, USDC_MINT])).toEqual([
      VALID_DESTINATION,
      USDC_MINT,
    ]);
  });

  it("rejects an entry that is the wrong length", () => {
    const result = destinationAllowlistSchema.safeParse([VALID_DESTINATION, "x".repeat(20)]);
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((issue) => issue.message);
      expect(messages).toContain("destinationAllowlist entry must be a base58 Solana address");
    }
  });

  it("rejects a right-length non-base58 entry", () => {
    const result = destinationAllowlistSchema.safeParse([VALID_DESTINATION, "!".repeat(43)]);
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((issue) => issue.message);
      expect(messages).toContain("destinationAllowlist entry must be a base58 Solana address");
    }
  });
});

describe("wallet policy rule schema", () => {
  it("accepts operation_type and standalone asset rules", () => {
    const rules = [
      {
        id: "deny-payment-execution",
        kind: "operation_type",
        operationType: "payment_transfer_execute",
        action: "deny",
      },
      {
        id: "approve-usdc",
        kind: "asset",
        assets: ["USDC", USDC_MINT],
        action: "approval_required",
      },
    ] satisfies PolicyRule[];

    const parsed = updateWalletPolicySchema.parse({ destinationAllowlist: [], rules });

    expect(parsed.rules).toEqual(rules);
  });

  it("rejects invalid operation_type and asset values with field-specific errors", () => {
    const result = updateWalletPolicySchema.safeParse({
      destinationAllowlist: [],
      rules: [
        { kind: "operation_type", operationType: "" },
        { kind: "asset", assets: [""] },
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ["rules", 0, "operationType"],
            message: "operationType must not be empty",
          }),
          expect.objectContaining({
            path: ["rules", 1, "assets", 0],
            message: "assets entries must not be empty",
          }),
        ])
      );
    }
  });

  it("keeps all existing public rule kinds backward-compatible", () => {
    const rules = [
      { kind: "operation_family", family: "payment", action: "allow" },
      { kind: "destination", destination: VALID_DESTINATION, action: "deny" },
      { kind: "amount", max: "100", asset: "USDC", action: "approval_required" },
      { kind: "approval", families: ["payment"], approvalGroupId: "group-1" },
      { kind: "always", action: "review" },
    ] satisfies PolicyRule[];

    const parsed = updateWalletPolicySchema.parse({ destinationAllowlist: [], rules });

    expect(parsed.rules).toEqual(rules);
  });
});
