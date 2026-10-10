import { SOL_MINT, WELL_KNOWN_TOKENS } from "@sdp/types";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import {
  createRecurringPaymentSchema,
  updateRecurringPaymentSchema,
} from "./recurring-payments/schemas";
import { PAYMENT_TOKEN_VALIDATION_MESSAGE } from "./schemas";
import { createSubscriptionSchema } from "./subscriptions/schemas";
import {
  createTransferBatchSchema,
  listTransferBatchesQuerySchema,
} from "./transfer-batches/schemas";
import { createTransferSchema, listTransfersQuerySchema } from "./transfers/schemas";

const USDC_MINT = WELL_KNOWN_TOKENS.USDC.mints["mainnet-beta"].address;
const VALID_DESTINATION = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

const tokenSchema = createTransferSchema.shape.token;
const destinationSchema = createTransferSchema.shape.destination;
const recurringPaymentTokenSchema = createRecurringPaymentSchema.shape.token;

describe("payments exact wallet contract", () => {
  const transfer = {
    sourceCustodyWalletId: "cwlt_source",
    destination: VALID_DESTINATION,
    token: USDC_MINT,
    amount: "1",
  };
  const batch = {
    sourceCustodyWalletId: "cwlt_source",
    token: USDC_MINT,
    recipients: [{ counterpartyAccountId: "cpa_test", amount: "1" }],
  };

  it("accepts exact SDP Wallet IDs and rejects the removed source selector", () => {
    expect(createTransferSchema.safeParse(transfer).success).toBe(true);
    expect(
      createTransferSchema.safeParse({
        ...transfer,
        sourceCustodyWalletId: undefined,
        source: "provider_wallet_id",
      }).success
    ).toBe(false);

    expect(createTransferBatchSchema.safeParse(batch).success).toBe(true);
    expect(
      createTransferBatchSchema.safeParse({
        ...batch,
        sourceCustodyWalletId: undefined,
        source: "provider_wallet_id",
      }).success
    ).toBe(false);
  });

  it("uses exact list filters and keeps observed history opt-in", () => {
    expect(listTransfersQuerySchema.parse({ custodyWalletId: "cwlt_source" })).toMatchObject({
      custodyWalletId: "cwlt_source",
      includeObserved: false,
    });
    expect(
      listTransferBatchesQuerySchema.parse({ sourceCustodyWalletId: "cwlt_source" })
    ).toMatchObject({ sourceCustodyWalletId: "cwlt_source" });
    expect(listTransfersQuerySchema.safeParse({ wallet: "provider_wallet_id" }).success).toBe(
      false
    );
    expect(listTransferBatchesQuerySchema.safeParse({ wallet: "provider_wallet_id" }).success).toBe(
      false
    );
  });
});

describe("payments schema inferred types", () => {
  it("destination infers as string", () => {
    type CreateTransfer = z.infer<typeof createTransferSchema>;

    expectTypeOf<CreateTransfer["destination"]>().toEqualTypeOf<string>();
  });
});

describe("subscription create schema", () => {
  it("rejects client-controlled lifecycle fields", () => {
    const result = createSubscriptionSchema.safeParse({
      planId: "psp_test",
      counterpartyId: "cp_test",
      subscriberAddress: VALID_DESTINATION,
      authorizationSignature: "client-controlled-signature",
      nextCollectionDueAt: new Date().toISOString(),
      status: "active",
    });

    expect(result.success).toBe(false);
  });
});

describe("transfer list timestamp filters", () => {
  it("normalizes offset timestamps to UTC before ledger filtering", () => {
    const query = listTransfersQuerySchema.parse({
      from: "2026-01-02T20:00:00+05:00",
      to: "2026-01-02T12:30:00-05:00",
    });

    expect(query.from).toBe("2026-01-02T15:00:00.000Z");
    expect(query.to).toBe("2026-01-02T17:30:00.000Z");
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

  const rejections: Array<[string, string, string]> = [
    ["empty string", "", "destination must be 32 to 44 characters (got 0)"],
    ["too-short string", "x".repeat(20), "destination must be 32 to 44 characters (got 20)"],
    ["too-long string", "x".repeat(50), "destination must be 32 to 44 characters (got 50)"],
    [
      "right-length non-base58 string",
      "!".repeat(43),
      "destination contains characters outside the base58 alphabet",
    ],
    [
      "right-length string with non-base58 char (0)",
      `0${"1".repeat(42)}`,
      "destination contains characters outside the base58 alphabet",
    ],
    [
      "right-length base58 string decoding to the wrong byte length",
      "1".repeat(43),
      "destination must decode to 32 bytes (got 43)",
    ],
  ];

  for (const [label, input, expectedMessage] of rejections) {
    it(`rejects ${label} with a cause-specific message`, () => {
      const result = destinationSchema.safeParse(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toHaveLength(1);
        const messages = result.error.issues.map((issue) => issue.message);
        expect(messages).toContain(expectedMessage);
      }
    });
  }
});

describe("recurring payment schema", () => {
  it("accepts an exact custody source wallet and rejects the removed Provider selector", () => {
    const result = createRecurringPaymentSchema.safeParse({
      sourceCustodyWalletId: "cwlt_source",
      counterpartyId: "cp_test",
      counterpartyAccountId: "cpa_test",
      token: USDC_MINT,
      amount: "25.00",
      periodHours: 24,
      firstCollectionAt: new Date(Date.now() + 60_000).toISOString(),
    });

    expect(result.success).toBe(true);
    expect(
      createRecurringPaymentSchema.safeParse({
        sourceCustodyWalletId: "cwlt_source",
        sourceWalletId: "provider_source",
        counterpartyId: "cp_test",
        counterpartyAccountId: "cpa_test",
        token: USDC_MINT,
        amount: "25.00",
        periodHours: 24,
      }).success
    ).toBe(false);
    expect(
      updateRecurringPaymentSchema.safeParse({ sourceWalletId: "provider_source" }).success
    ).toBe(false);
  });

  it("rejects a past firstCollectionAt timestamp", () => {
    const result = createRecurringPaymentSchema.safeParse({
      sourceCustodyWalletId: "cwlt_source",
      counterpartyId: "cp_test",
      counterpartyAccountId: "cpa_test",
      token: USDC_MINT,
      amount: "25.00",
      periodHours: 24,
      firstCollectionAt: new Date(Date.now() - 60_000).toISOString(),
    });

    expect(result.success).toBe(false);
  });

  it("still parses native SOL at the request schema layer for service-level rejection", () => {
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

  it("rejects non-http metadata URI schemes that would execute when rendered as links", () => {
    expect(
      updateRecurringPaymentSchema.safeParse({ metadataUri: "javascript:alert(document.domain)" })
        .success
    ).toBe(false);
    expect(
      updateRecurringPaymentSchema.safeParse({ metadataUri: "data:text/html,<script>1</script>" })
        .success
    ).toBe(false);
    expect(
      updateRecurringPaymentSchema.safeParse({ metadataUri: "https://example.com/metadata.json" })
        .success
    ).toBe(true);
  });
});
