import { SOL_MINT, WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";
import { describe, expect, it } from "vitest";
import {
  createRecurringPaymentSchema,
  updateRecurringPaymentSchema,
} from "./recurring-payments/schemas";
import { PAYMENT_TOKEN_VALIDATION_MESSAGE } from "./schemas";
import { createSubscriptionSchema } from "./subscriptions/schemas";
import { createTransferBatchSchema } from "./transfer-batches/schemas";
import { createTransferSchema, listTransfersQuerySchema } from "./transfers/schemas";

const USDC_MINT = WELL_KNOWN_TOKENS.USDC.mints["mainnet-beta"].address;
const VALID_DESTINATION = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

const tokenSchema = createTransferSchema.shape.token;
const destinationSchema = createTransferSchema.shape.destination;

describe("transfer and batch request contract", () => {
  it("requires a batch to name its payout run", () => {
    const batch = {
      externalId: "payroll-2026-05",
      sourceCustodyWalletId: "cwlt_source",
      token: USDC_MINT,
      recipients: [{ counterpartyAccountId: "cpa_test", amount: "1" }],
    };
    expect(createTransferBatchSchema.safeParse(batch).success).toBe(true);
    expect(createTransferBatchSchema.safeParse({ ...batch, externalId: undefined }).success).toBe(
      false
    );
  });

  it("lists recorded transfers only unless observed history is asked for", () => {
    expect(listTransfersQuerySchema.parse({}).includeObserved).toBe(false);
    expect(listTransfersQuerySchema.parse({ includeObserved: "true" }).includeObserved).toBe(true);
  });
});

describe("subscription create schema", () => {
  it("rejects client-controlled lifecycle fields", () => {
    const create = {
      planId: "psp_test",
      counterpartyId: "cp_test",
      subscriberAddress: VALID_DESTINATION,
    };
    expect(createSubscriptionSchema.safeParse(create).success).toBe(true);
    for (const lifecycle of [
      { authorizationSignature: "client-controlled-signature" },
      { nextCollectionDueAt: new Date().toISOString() },
      { status: "active" },
    ]) {
      expect(createSubscriptionSchema.safeParse({ ...create, ...lifecycle }).success).toBe(false);
    }
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
  it.each([
    ["SOL", "SOL"],
    [" soL ", "SOL"],
    [" usdc ", "USDC"],
    [` ${SOL_MINT} `, SOL_MINT],
    [` ${USDC_MINT} `, USDC_MINT],
  ])("normalizes %j to %j", (input, expected) => {
    expect(tokenSchema.parse(input)).toBe(expected);
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
  it("accepts a base58 address, trimmed", () => {
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
  it("accepts a first collection in the future and refuses one in the past", () => {
    const create = {
      sourceCustodyWalletId: "cwlt_source",
      counterpartyId: "cp_test",
      counterpartyAccountId: "cpa_test",
      token: USDC_MINT,
      amount: "25.00",
      periodHours: 24,
    };
    const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

    expect(
      createRecurringPaymentSchema.safeParse({ ...create, firstCollectionAt: at(60_000) }).success
    ).toBe(true);
    expect(
      createRecurringPaymentSchema.safeParse({ ...create, firstCollectionAt: at(-60_000) }).success
    ).toBe(false);
  });

  it("rejects an update that changes nothing", () => {
    expect(updateRecurringPaymentSchema.safeParse({}).success).toBe(false);
    expect(updateRecurringPaymentSchema.safeParse({ expectedUpdatedAt: "v1" }).success).toBe(false);
    expect(
      updateRecurringPaymentSchema.safeParse({ expectedUpdatedAt: "v1", amount: "1" }).success
    ).toBe(true);
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
    expect(updateRecurringPaymentSchema.safeParse({ counterpartyId: "cp_next" }).success).toBe(
      false
    );
    expect(
      updateRecurringPaymentSchema.safeParse({
        counterpartyId: "cp_next",
        counterpartyAccountId: "cpa_next",
      }).success
    ).toBe(true);
  });

  it("rejects invalid recurring payment update amount, period, and metadata URL", () => {
    expect(updateRecurringPaymentSchema.safeParse({ amount: "0" }).success).toBe(false);
    expect(updateRecurringPaymentSchema.safeParse({ amount: "1" }).success).toBe(true);
    expect(updateRecurringPaymentSchema.safeParse({ periodHours: 0 }).success).toBe(false);
    expect(updateRecurringPaymentSchema.safeParse({ periodHours: 1 }).success).toBe(true);
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
