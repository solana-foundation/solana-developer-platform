import { RAMP_PROVIDER_CLIENTS } from "@sdp/payments/ramps";
import { buildBvnkOnrampRuleReference } from "@sdp/payments/ramps/providers/bvnk/provider-data";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  bvnkChannelTransactionEvent,
  bvnkCryptoStatusChangeEvent,
  bvnkPayinStatusChangeEvent,
  bvnkWalletStatusChangeEvent,
} from "@/test/helpers/bvnk";
import { env as testEnv } from "@/test/helpers/env";
import type { Env } from "@/types/env";
import { BvnkWebhookProcessor } from "./bvnk";

const loggerMocks = vi.hoisted(() => ({
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(),
}));

vi.mock("@/runtime/logger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/runtime/logger")>()),
  getLogger: () => loggerMocks,
}));

const mockAccounts = vi.hoisted(() => ({
  getProviderAccountByExternalReference: vi.fn(),
}));

const mockPayments = vi.hoisted(() => ({
  getInFlightBvnkOnrampTransferByFundingWallet: vi.fn(),
  findBvnkOnrampTransferByAppliedPayinId: vi.fn(),
  updateTransferStatusGuarded: vi.fn(),
  markBvnkOnrampRuleDeactivated: vi.fn(),
  bindBvnkOnrampRule: vi.fn(),
  getBvnkOfframpTransferById: vi.fn(),
  bindBvnkOfframpCredit: vi.fn(),
}));

vi.mock("@/db", () => ({
  getDb: () => ({}),
  asTransactionalClient: (transaction: unknown) => transaction as never,
}));
vi.mock("@/db/repositories/counterparty-provider-account.repository.postgres", () => ({
  createPostgresCounterpartyProviderAccountsRepository: () => mockAccounts,
}));
vi.mock("@/db/repositories", () => ({
  createSystemPaymentsRepository: () => mockPayments,
}));

describe("BvnkWebhookProcessor.parse", () => {
  it("parses a ledger wallet status-change webhook resolved by wallet id", () => {
    const processor = new BvnkWebhookProcessor();

    expect(
      processor.parse(bvnkWalletStatusChangeEvent({ id: "a:1:wallet:1", status: "ACTIVE" }))
    ).toMatchObject({
      event: "ledger:v2:wallet:status-change",
      data: {
        id: "a:1:wallet:1",
        status: "ACTIVE",
      },
    });
  });

  it("parses a BVNK wallet create webhook with data.id", () => {
    const processor = new BvnkWebhookProcessor();

    expect(
      processor.parse({
        event: "bvnk:ledger:wallet:create",
        data: {
          id: "a:1:wallet:created",
          status: "COMPLETED",
          paymentInstruments: [
            {
              type: "FIAT",
              accountNumber: "900368997705",
              bankDetails: { bic: "101019644", name: "BVNK Bank" },
            },
          ],
        },
      })
    ).toMatchObject({
      event: "bvnk:ledger:wallet:create",
      data: {
        id: "a:1:wallet:created",
        status: "COMPLETED",
      },
    });
  });

  it("parses a BVNK fiat pay-in status-change webhook, stringifying the amount", () => {
    const processor = new BvnkWebhookProcessor();

    expect(processor.parse(bvnkPayinStatusChangeEvent())).toEqual({
      event: "bvnk:payment:payin:status-change",
      data: {
        status: "COMPLETED",
        customerReference: "customer_1",
        beneficiary: { walletId: "a:1:wallet:1" },
        amount: { value: "100" },
        uuid: "payin_1",
      },
    });
  });

  it("parses a crypto status-change webhook carrying the direction and status", () => {
    const processor = new BvnkWebhookProcessor();

    expect(processor.parse(bvnkCryptoStatusChangeEvent())).toMatchObject({
      event: "bvnk:payment:crypto:status-change",
      data: {
        type: "OUT",
        status: "COMPLETED",
      },
    });
  });

  it("parses a channel transaction-detected webhook", () => {
    const processor = new BvnkWebhookProcessor();

    // The channel payload carries more fields than the schema models; the
    // assertion pins the event name and correlation reference without
    // freezing the extras (channelId/walletAmount may or may not survive the
    // schema transform).
    expect(processor.parse(bvnkChannelTransactionEvent("transaction-detected"))).toMatchObject({
      event: "bvnk:payment:channel:transaction-detected",
      data: { reference: "bvnk-sandbox-test-payment" },
    });
  });

  it("parses a channel transaction SDP did not create without throwing", () => {
    const processor = new BvnkWebhookProcessor();

    expect(
      processor.parse(
        bvnkChannelTransactionEvent("transaction-confirmed", {
          uuid: "tx_1",
          walletCurrency: "USD",
          walletAmount: 4.95,
        })
      )
    ).toMatchObject({
      event: "bvnk:payment:channel:transaction-confirmed",
      data: {
        reference: "bvnk-sandbox-test-payment",
        walletAmount: "4.95",
      },
    });
  });

  it("accepts an sdp_offramp reference and stringifies its walletAmount", () => {
    const processor = new BvnkWebhookProcessor();

    expect(
      processor.parse(
        bvnkChannelTransactionEvent("transaction-confirmed", {
          reference: "sdp_offramp_xfr_123e4567-e89b-12d3-a456-426614174000",
          walletAmount: 100,
        })
      )
    ).toMatchObject({
      event: "bvnk:payment:channel:transaction-confirmed",
      data: {
        reference: "sdp_offramp_xfr_123e4567-e89b-12d3-a456-426614174000",
        walletAmount: "100",
      },
    });
  });

  it("ignores an unhandled BVNK event instead of throwing", () => {
    const processor = new BvnkWebhookProcessor();

    expect(
      processor.parse({
        event: "bvnk:totally:new-event",
        data: {},
      })
    ).toEqual({ event: "ignore", reason: "unsupported_event:bvnk:totally:new-event" });
  });

  it("ignores an unhandled BVNK event without a data object", () => {
    const processor = new BvnkWebhookProcessor();

    expect(processor.parse({ event: "bvnk:totally:new-event" })).toEqual({
      event: "ignore",
      reason: "unsupported_event:bvnk:totally:new-event",
    });
  });

  it("rejects a handled BVNK event missing its data object with a 400", () => {
    const processor = new BvnkWebhookProcessor();

    expect(() => processor.parse({ event: "bvnk:payment:payin:status-change" })).toThrowError(
      'BVNK webhook "bvnk:payment:payin:status-change" is missing a data object'
    );
  });

  it("rejects a detected channel event without a reference", () => {
    const processor = new BvnkWebhookProcessor();

    expect(() =>
      processor.parse({
        event: "bvnk:payment:channel:transaction-detected",
        data: { channelId: "channel_1" },
      })
    ).toThrowError("failed validation");
  });

  it("rejects a confirmed channel event without a reference", () => {
    const processor = new BvnkWebhookProcessor();

    expect(() =>
      processor.parse({
        event: "bvnk:payment:channel:transaction-confirmed",
        data: { channelId: "channel_1", walletAmount: 4.95 },
      })
    ).toThrowError("failed validation");
  });
});

describe("BvnkWebhookProcessor.process crypto completion", () => {
  const WALLET_ROW_ID = "counterparty_provider_account_funding";
  const TRANSFER_ID = "xfr_123e4567-e89b-12d3-a456-426614174000";

  beforeEach(() => {
    vi.clearAllMocks();
    mockAccounts.getProviderAccountByExternalReference.mockResolvedValue({
      id: WALLET_ROW_ID,
      organization_id: "org_test",
      project_id: "prj_test",
    });
    mockPayments.findBvnkOnrampTransferByAppliedPayinId.mockResolvedValue(null);
    mockPayments.bindBvnkOnrampRule.mockResolvedValue({
      id: TRANSFER_ID,
      organization_id: "org_test",
      project_id: "prj_test",
    });
    mockPayments.getInFlightBvnkOnrampTransferByFundingWallet.mockResolvedValue({
      id: TRANSFER_ID,
      organization_id: "org_test",
      project_id: "prj_test",
      provider: "bvnk",
      provider_data: {
        bvnk: {
          fundingWalletAccountId: WALLET_ROW_ID,
          ruleId: "rule_completed_1",
          ruleStatus: "ACTIVE",
        },
      },
    });
    mockPayments.updateTransferStatusGuarded.mockResolvedValue({
      id: TRANSFER_ID,
      organization_id: "org_test",
      project_id: "prj_test",
      status: "completed",
    });
    mockPayments.markBvnkOnrampRuleDeactivated.mockResolvedValue({
      id: TRANSFER_ID,
    });
    vi.spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "deactivateOnrampRule").mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("completes the transfer, deactivates the rule, and writes ruleStatus DEACTIVATED back to the row", async () => {
    const processor = new BvnkWebhookProcessor();
    const channel = processor.parse(
      bvnkCryptoStatusChangeEvent({
        walletId: "a:1:wallet:1",
        reference: buildBvnkOnrampRuleReference(TRANSFER_ID),
      })
    );
    if (channel.event !== "bvnk:payment:crypto:status-change") {
      throw new Error("expected crypto status-change event");
    }

    await processor.process(testEnv as Env, "sandbox", channel);

    expect(mockPayments.updateTransferStatusGuarded).toHaveBeenCalledWith(
      expect.objectContaining({
        transferId: TRANSFER_ID,
        fromStatuses: ["settling"],
        toStatus: "completed",
        providerData: {
          bvnk: expect.objectContaining({ appliedCryptoEventId: "crypto_1" }),
        },
        providerDataNullPath: ["bvnk", "appliedCryptoEventId"],
      })
    );
    expect(RAMP_PROVIDER_CLIENTS.bvnk.deactivateOnrampRule).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ruleId: "rule_completed_1" })
    );
    // The completion path writes the deactivation back so the row never keeps
    // a stale ACTIVE ruleStatus (the expiry cron's only writer before).
    expect(mockPayments.markBvnkOnrampRuleDeactivated).toHaveBeenCalledWith({
      transferId: TRANSFER_ID,
      organizationId: "org_test",
      projectId: "prj_test",
      updatedAt: expect.any(String),
    });
  });

  it("does not write DEACTIVATED when the BVNK deactivation fails", async () => {
    vi.spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "deactivateOnrampRule").mockRejectedValue(
      new Error("bvnk unreachable")
    );
    const processor = new BvnkWebhookProcessor();
    const channel = processor.parse(
      bvnkCryptoStatusChangeEvent({
        walletId: "a:1:wallet:1",
        reference: buildBvnkOnrampRuleReference(TRANSFER_ID),
      })
    );
    if (channel.event !== "bvnk:payment:crypto:status-change") {
      throw new Error("expected crypto status-change event");
    }

    await processor.process(testEnv as Env, "sandbox", channel);

    expect(mockPayments.markBvnkOnrampRuleDeactivated).not.toHaveBeenCalled();
  });

  it("acks a crypto completion whose reference names a different transfer", async () => {
    const processor = new BvnkWebhookProcessor();
    const channel = processor.parse(
      bvnkCryptoStatusChangeEvent({
        walletId: "a:1:wallet:1",
        reference: buildBvnkOnrampRuleReference("xfr_99999999-9999-4999-8999-999999999999"),
      })
    );
    if (channel.event !== "bvnk:payment:crypto:status-change") {
      throw new Error("expected crypto status-change event");
    }

    await processor.process(testEnv as Env, "sandbox", channel);

    expect(mockPayments.updateTransferStatusGuarded).not.toHaveBeenCalled();
    expect(JSON.stringify(loggerMocks.info.mock.calls)).toContain(
      "sdp_api_bvnk_crypto_event_stale"
    );
  });
});

describe("BvnkWebhookProcessor.process pay-in", () => {
  const TRANSFER_ID = "xfr_123e4567-e89b-12d3-a456-426614174000";

  beforeEach(() => {
    vi.clearAllMocks();
    mockAccounts.getProviderAccountByExternalReference.mockResolvedValue({
      id: "counterparty_provider_account_funding",
      organization_id: "org_test",
      project_id: "prj_test",
    });
    mockPayments.findBvnkOnrampTransferByAppliedPayinId.mockResolvedValue(null);
    mockPayments.getInFlightBvnkOnrampTransferByFundingWallet.mockResolvedValue({
      id: TRANSFER_ID,
      organization_id: "org_test",
      project_id: "prj_test",
      provider: "bvnk",
      provider_data: {
        bvnk: {
          fundingWalletAccountId: "counterparty_provider_account_funding",
          ruleId: "rule_bound_1",
          ruleStatus: "ACTIVE",
        },
      },
    });
    mockPayments.updateTransferStatusGuarded.mockResolvedValue({
      id: TRANSFER_ID,
      status: "settling",
    });
    mockPayments.bindBvnkOnrampRule.mockResolvedValue({ id: TRANSFER_ID });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("acks a replayed pay-in without touching any transfer", async () => {
    mockPayments.findBvnkOnrampTransferByAppliedPayinId.mockResolvedValue({
      id: "xfr_already_applied",
      organization_id: "org_test",
      project_id: "prj_test",
    });

    const processor = new BvnkWebhookProcessor();
    const channel = processor.parse(bvnkPayinStatusChangeEvent());
    if (channel.event !== "bvnk:payment:payin:status-change") {
      throw new Error("expected pay-in status-change event");
    }

    await processor.process(testEnv as Env, "sandbox", channel);

    expect(mockPayments.updateTransferStatusGuarded).not.toHaveBeenCalled();
    expect(mockAccounts.getProviderAccountByExternalReference).not.toHaveBeenCalled();
    expect(JSON.stringify(loggerMocks.info.mock.calls)).toContain("sdp_api_bvnk_payin_replayed");
  });

  it("keeps the recovered rule bound when a crash-recovered pay-in settles the transfer", async () => {
    mockPayments.getInFlightBvnkOnrampTransferByFundingWallet
      .mockResolvedValueOnce({
        id: TRANSFER_ID,
        organization_id: "org_test",
        project_id: "prj_test",
        provider: "bvnk",
        provider_data: {
          bvnk: {
            fundingWalletAccountId: "counterparty_provider_account_funding",
          },
        },
      })
      .mockResolvedValueOnce({
        id: TRANSFER_ID,
        organization_id: "org_test",
        project_id: "prj_test",
        provider: "bvnk",
        provider_data: {
          bvnk: {
            fundingWalletAccountId: "counterparty_provider_account_funding",
            ruleId: "rule_recovered_1",
            ruleStatus: "ACTIVE",
          },
        },
      });
    vi.spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "listOnrampRulesByWallet").mockResolvedValue([
      {
        id: "rule_recovered_1",
        reference: buildBvnkOnrampRuleReference(TRANSFER_ID),
        status: "ACTIVE",
      },
    ]);

    const processor = new BvnkWebhookProcessor();
    const channel = processor.parse(bvnkPayinStatusChangeEvent({ uuid: "payin_recovery_1" }));
    if (channel.event !== "bvnk:payment:payin:status-change") {
      throw new Error("expected pay-in status-change event");
    }

    await processor.process(testEnv as Env, "sandbox", channel);

    expect(mockPayments.updateTransferStatusGuarded).toHaveBeenCalledWith(
      expect.objectContaining({
        providerData: {
          bvnk: expect.objectContaining({
            ruleId: "rule_recovered_1",
            ruleStatus: "ACTIVE",
            creditedFiatAmount: "100",
            appliedPayinId: "payin_recovery_1",
          }),
        },
        providerDataNullPath: ["bvnk", "appliedPayinId"],
      })
    );
  });

  it("writes appliedPayinId and guards on it in the settling CAS", async () => {
    const processor = new BvnkWebhookProcessor();
    const channel = processor.parse(bvnkPayinStatusChangeEvent());
    if (channel.event !== "bvnk:payment:payin:status-change") {
      throw new Error("expected pay-in status-change event");
    }

    await processor.process(testEnv as Env, "sandbox", channel);

    expect(mockPayments.updateTransferStatusGuarded).toHaveBeenCalledWith(
      expect.objectContaining({
        providerData: {
          bvnk: expect.objectContaining({
            ruleId: "rule_bound_1",
            appliedPayinId: "payin_1",
          }),
        },
        providerDataNullPath: ["bvnk", "appliedPayinId"],
        fromStatuses: ["awaiting_payment"],
      })
    );
  });
});

describe("BvnkWebhookProcessor.process channel transaction", () => {
  const TRANSFER_ID = "xfr_123e4567-e89b-12d3-a456-426614174000";

  beforeEach(() => {
    vi.clearAllMocks();
    mockPayments.getBvnkOfframpTransferById.mockResolvedValue({
      id: TRANSFER_ID,
      organization_id: "org_test",
      project_id: "prj_test",
      provider_reference: "channel_correct_1",
    });
    mockPayments.updateTransferStatusGuarded.mockResolvedValue({
      id: TRANSFER_ID,
      status: "settling",
    });
    mockPayments.bindBvnkOfframpCredit.mockResolvedValue({
      id: TRANSFER_ID,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects a detected channel event whose channelId does not match the transfer", async () => {
    const processor = new BvnkWebhookProcessor();
    const channel = processor.parse(
      bvnkChannelTransactionEvent("transaction-detected", {
        channelId: "channel_wrong_1",
        reference: "sdp_offramp_xfr_123e4567-e89b-12d3-a456-426614174000",
      })
    );
    if (channel.event !== "bvnk:payment:channel:transaction-detected") {
      throw new Error("expected detected channel event");
    }

    let thrown: unknown;
    try {
      await processor.process(testEnv as Env, "sandbox", channel);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("channel_wrong_1");
    expect((thrown as Error).message).toContain(TRANSFER_ID);
    expect(mockPayments.updateTransferStatusGuarded).not.toHaveBeenCalled();
  });

  it("rejects a confirmed channel event whose channelId does not match the transfer", async () => {
    const processor = new BvnkWebhookProcessor();
    const channel = processor.parse(
      bvnkChannelTransactionEvent("transaction-confirmed", {
        channelId: "channel_wrong_1",
        reference: "sdp_offramp_xfr_123e4567-e89b-12d3-a456-426614174000",
        walletAmount: 4.95,
      })
    );
    if (channel.event !== "bvnk:payment:channel:transaction-confirmed") {
      throw new Error("expected confirmed channel event");
    }

    let thrown: unknown;
    try {
      await processor.process(testEnv as Env, "sandbox", channel);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("channel_wrong_1");
    expect((thrown as Error).message).toContain(TRANSFER_ID);
    expect(mockPayments.bindBvnkOfframpCredit).not.toHaveBeenCalled();
  });
});
