import type { MoneygramRampEvent, PaymentTransferStatus, PaymentTransferSummary } from "@sdp/types";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { builtinEnvironments, type EnvironmentReturn } from "vitest/environments";
import { postMoneygramRampEvent } from "@/app/dashboard/payments/payments-workspace.data";
import { getMessages, translate } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { MoneygramRampWidget, type MoneygramRampWidgetProps } from "./moneygram-ramp-widget";
import { fundMoneygramDeposit } from "./moneygram-sign-transaction";

vi.mock("@/app/dashboard/payments/payments-workspace.data", () => ({
  postMoneygramRampEvent: vi.fn(),
}));
vi.mock("./moneygram-sign-transaction", () => ({ fundMoneygramDeposit: vi.fn() }));

const SOURCE_WALLET = "8mSiNWTeu59yy1pxsoNCyy7KNMnKvfgGu8Ej975LsufM";
const DEPOSIT_WALLET = "8mSiNWTeu59yxhp2VPuWURbW4N1zF2oX96oVxdThMNS3";
const USDC_MINT = "8mSiNWTeu59yy4EzchXDwb8j3XoQsVmVdp4QMjEo6wvX";
const messages = getMessages("en");
const pendingStatus = "pending" satisfies PaymentTransferStatus;
const ramp: PaymentTransferSummary = {
  id: "xfr_0f1e2d3c-4b5a-4c6d-8e7f-9a0b1c2d3e4f",
  custodyWalletId: "cwlt_mg_1",
  providerWalletId: "wal_mg_1",
  status: pendingStatus,
  signature: null,
  rampsMemo: {},
  moneygram: { transactionId: "mg_tx_owned_1", customerId: "mg_profile_1" },
};
const props: MoneygramRampWidgetProps = {
  direction: "offramp",
  quote: {
    provider: "moneygram",
    id: "mg_session_1",
    status: pendingStatus,
    deliveryMode: "session_widget",
    sessionId: "mg_session_1",
    sessionToken: "mg_session_token_1",
    widgetUrl: "https://playground.xramps.moneygram.com/sdk/widget.html?mode=off-ramp",
  },
  sourceWalletId: "cwlt_mg_1",
  sourceWalletName: "Test wallet",
  sourceWalletAddress: SOURCE_WALLET,
  sourceTokenMint: USDC_MINT,
  cryptoAsset: "USDC",
  cryptoAmount: "25",
  fiatCurrency: "USD",
  onSessionExpiring: vi.fn(),
};
const created = { id: "mg_tx_owned_1", mgiTransactionId: "mgi_tx_owned_1" };
const createdEvent = {
  kind: "transaction_created",
  sessionId: "mg_session_1",
  transactionId: created.id,
  mgiTransactionId: created.mgiTransactionId,
} satisfies MoneygramRampEvent;
const deposit = { address: DEPOSIT_WALLET, chain: "solana", asset: "USDC", amount: "25" };

type RampsConfig = Parameters<NonNullable<Window["RampsSDK"]>["createRamps"]>[0];
let captured: RampsConfig | undefined;
let dom: EnvironmentReturn;
const open = vi.fn();
const close = vi.fn();
const destroy = vi.fn();
const createRamps = vi.fn((config: RampsConfig) => {
  captured = config;
  return { open, close, destroy };
});

beforeAll(async () => {
  dom = await builtinEnvironments.jsdom.setup(globalThis, {});
});

afterAll(async () => {
  await dom.teardown(globalThis);
});

beforeEach(() => {
  captured = undefined;
  window.RampsSDK = { createRamps };
  vi.mocked(postMoneygramRampEvent).mockResolvedValue(ramp);
  vi.mocked(fundMoneygramDeposit).mockResolvedValue("sig_mg_deposit_1");
});

afterEach(() => {
  cleanup();
  delete window.RampsSDK;
  vi.clearAllMocks();
  vi.mocked(postMoneygramRampEvent).mockReset();
  vi.mocked(fundMoneygramDeposit).mockReset();
});

async function renderWidget(): Promise<RampsConfig> {
  render(
    <I18nProvider locale="en" messages={messages}>
      <MoneygramRampWidget {...props} />
    </I18nProvider>
  );
  await waitFor(() => expect(createRamps).toHaveBeenCalledTimes(1));
  if (captured === undefined) {
    throw new Error("MoneyGram SDK did not receive a widget configuration");
  }
  return captured;
}

describe("MoneygramRampWidget", () => {
  it("configures a custodial wallet without an onSignTransaction callback", async () => {
    const config = await renderWidget();

    expect(config.wallet.walletType).toBe("custodial");
    expect(config).not.toHaveProperty("onSignTransaction");
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("posts the created transaction and session identifiers", async () => {
    const config = await renderWidget();

    config.onTransactionCreated(created);

    expect(postMoneygramRampEvent).toHaveBeenCalledExactlyOnceWith(
      createdEvent,
      expect.any(Function)
    );
  });

  it("waits for a successful created post before funding without posting again", async () => {
    const posted = Promise.withResolvers<PaymentTransferSummary>();
    vi.mocked(postMoneygramRampEvent).mockReturnValueOnce(posted.promise);
    const config = await renderWidget();
    config.onTransactionCreated(created);

    const funding = config.onDepositAddress(deposit);
    expect(fundMoneygramDeposit).not.toHaveBeenCalled();
    posted.resolve(ramp);

    await expect(funding).resolves.toBe("sig_mg_deposit_1");
    expect(fundMoneygramDeposit).toHaveBeenCalledExactlyOnceWith(
      deposit,
      expect.objectContaining({
        sessionId: "mg_session_1",
        sourceWalletId: "cwlt_mg_1",
        sourceTokenMint: USDC_MINT,
        cryptoAsset: "USDC",
      })
    );
    expect(postMoneygramRampEvent).toHaveBeenCalledTimes(1);
  });

  it("re-posts a failed created event once and waits for it before funding", async () => {
    const retried = Promise.withResolvers<PaymentTransferSummary>();
    vi.mocked(postMoneygramRampEvent)
      .mockRejectedValueOnce(new Error("Created event request failed"))
      .mockReturnValueOnce(retried.promise);
    const config = await renderWidget();
    config.onTransactionCreated(created);

    const funding = config.onDepositAddress(deposit);
    await waitFor(() => expect(postMoneygramRampEvent).toHaveBeenCalledTimes(2));
    expect(postMoneygramRampEvent).toHaveBeenNthCalledWith(1, createdEvent, expect.any(Function));
    expect(vi.mocked(postMoneygramRampEvent).mock.calls[1]).toEqual(
      vi.mocked(postMoneygramRampEvent).mock.calls[0]
    );
    expect(fundMoneygramDeposit).not.toHaveBeenCalled();
    retried.resolve(ramp);

    await expect(funding).resolves.toBe("sig_mg_deposit_1");
    expect(fundMoneygramDeposit).toHaveBeenCalledTimes(1);
    expect(postMoneygramRampEvent).toHaveBeenCalledTimes(2);
  });

  it("rejects a deposit before a created event with the translated unreported error", async () => {
    const config = await renderWidget();

    await expect(config.onDepositAddress(deposit)).rejects.toThrow(
      translate(messages, "DashboardPayments.ramps.moneygramTransactionUnreported")
    );
    expect(fundMoneygramDeposit).not.toHaveBeenCalled();
    expect(postMoneygramRampEvent).not.toHaveBeenCalled();
  });
});
