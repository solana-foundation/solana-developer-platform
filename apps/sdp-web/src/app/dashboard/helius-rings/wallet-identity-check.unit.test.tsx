// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import type { RingsWallet, RingsWalletIdentity } from "./helius-rings.data";
import { WalletIdentityCheck } from "./wallet-identity-check";

const mocks = vi.hoisted(() => ({ fetchRingsWalletIdentity: vi.fn() }));

vi.mock("./helius-rings.data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./helius-rings.data")>()),
  fetchRingsWalletIdentity: mocks.fetchRingsWalletIdentity,
}));

/** The wallet this control is offered for: provisioning never completed. */
const WALLET: RingsWallet = {
  id: "hrw_pending",
  sdpWalletId: "wal_pending",
  name: "Treasury",
  shieldedAddress: null,
  status: "pending",
  network: "devnet",
};

const DERIVED = "rings1derivedByThisDeployment";
const PUBLISHED = "rings1publishedBySomeoneElse";

function identity(overrides: Partial<RingsWalletIdentity> = {}): RingsWalletIdentity {
  return {
    status: "unregistered",
    derivedShieldedAddress: DERIVED,
    publishedShieldedAddress: null,
    mismatch: null,
    recordedShieldedAddress: null,
    ...overrides,
  };
}

function renderCheck(wallet: RingsWallet = WALLET) {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <WalletIdentityCheck wallet={wallet} />
    </I18nProvider>
  );
}

/** The check control in the table cell — not the dialog's close button. */
function checkButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /^(Check on chain|Checking…)$/ });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(cleanup);

describe("WalletIdentityCheck", () => {
  it("reads nothing until the operator asks", async () => {
    renderCheck();

    // The read costs an RPC round trip, so mounting must not trigger one.
    expect(mocks.fetchRingsWalletIdentity).not.toHaveBeenCalled();
    expect(checkButton().disabled).toBe(false);
    expect(screen.queryByRole("status")).toBeNull();

    mocks.fetchRingsWalletIdentity.mockResolvedValue({ identity: identity() });
    await userEvent.setup().click(checkButton());

    expect(mocks.fetchRingsWalletIdentity).toHaveBeenCalledExactlyOnceWith(WALLET.id);
  });

  it("announces the read in flight and blocks a second one", async () => {
    let settle: ((result: { identity: RingsWalletIdentity }) => void) | undefined;
    mocks.fetchRingsWalletIdentity.mockReturnValue(
      new Promise<{ identity: RingsWalletIdentity }>((resolve) => {
        settle = resolve;
      })
    );
    renderCheck();

    await userEvent.setup().click(checkButton());

    expect(checkButton().textContent).toBe("Checking…");
    expect(checkButton().disabled).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText(/Reading the on-chain registry record/)).toBeNull();

    settle?.({ identity: identity() });
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(await screen.findByText("Not registered")).toBeTruthy();
    expect(checkButton().disabled).toBe(false);
  });

  it("says provisioning will create the record when nothing is registered", async () => {
    mocks.fetchRingsWalletIdentity.mockResolvedValue({ identity: identity() });
    renderCheck();

    await userEvent.setup().click(checkButton());

    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(await screen.findByText("Not registered")).toBeTruthy();
    expect(screen.getByText(/provisioning will create one/)).toBeTruthy();
    // An absent record must not read as a record agreeing with us.
    expect(screen.queryByText(/The chain publishes/)).toBeNull();
    expect(screen.getByText(/This deployment derives/)).toBeTruthy();
    expect(screen.getByText("Nothing recorded yet")).toBeTruthy();
    expect(screen.queryByText(/Differs in:/)).toBeNull();
  });

  it("says the row is merely behind when the published record is ours", async () => {
    mocks.fetchRingsWalletIdentity.mockResolvedValue({
      identity: identity({
        status: "ours",
        publishedShieldedAddress: DERIVED,
      }),
    });
    renderCheck();

    await userEvent.setup().click(checkButton());

    expect(await screen.findByText("Registered by this deployment")).toBeTruthy();
    expect(screen.getByText(/only this row is behind/)).toBeTruthy();
    // Not the foreign advice: nothing about binding a different custody wallet.
    expect(screen.queryByText(/different custody wallet/)).toBeNull();
    expect(screen.queryByText(/Differs in:/)).toBeNull();
  });

  it("names the differing key and the resolution when the record is foreign", async () => {
    mocks.fetchRingsWalletIdentity.mockResolvedValue({
      identity: identity({
        status: "foreign",
        publishedShieldedAddress: PUBLISHED,
        mismatch: "nullifier_key",
      }),
    });
    renderCheck();

    await userEvent.setup().click(checkButton());

    expect(await screen.findByText("Registered with different keys")).toBeTruthy();
    // SDP does not rotate keys, so the resolution is a different custody
    // wallet, not a retry.
    expect(screen.getByText(/will refuse rather than re-key it/)).toBeTruthy();
    expect(screen.getByText(/different custody wallet/)).toBeTruthy();
    expect(screen.getByText("Differs in: the nullifier key")).toBeTruthy();
    expect(screen.getByText(PUBLISHED)).toBeTruthy();
    expect(screen.getByText(DERIVED)).toBeTruthy();
  });

  it.each([
    ["owner", "Differs in: the record's owner"],
    ["nullifier_key", "Differs in: the nullifier key"],
    ["viewing_key", "Differs in: the viewing key"],
  ] as const)("labels a %s mismatch", async (mismatch, expected) => {
    mocks.fetchRingsWalletIdentity.mockResolvedValue({
      identity: identity({ status: "foreign", publishedShieldedAddress: PUBLISHED, mismatch }),
    });
    renderCheck();

    await userEvent.setup().click(checkButton());

    expect(await screen.findByText(expected)).toBeTruthy();
  });

  it("distinguishes what the chain says from what our row records", async () => {
    mocks.fetchRingsWalletIdentity.mockResolvedValue({
      identity: identity({
        status: "ours",
        publishedShieldedAddress: DERIVED,
        recordedShieldedAddress: DERIVED,
      }),
    });
    renderCheck();

    await userEvent.setup().click(checkButton());

    expect(await screen.findByText(/This row records/)).toBeTruthy();
    expect(screen.queryByText("Nothing recorded yet")).toBeNull();
  });

  it("surfaces the server's own reason when the read fails", async () => {
    mocks.fetchRingsWalletIdentity.mockResolvedValue({
      error: "Helius Rings setup is required for this project",
    });
    renderCheck();

    await userEvent.setup().click(checkButton());

    expect(await screen.findByText(/Helius Rings setup is required/)).toBeTruthy();
    // A failure is not a verdict about the chain.
    expect(screen.queryByText("Not registered")).toBeNull();
    expect(checkButton().disabled).toBe(false);
  });

  it("falls back to its own copy when the failure carried no message", async () => {
    mocks.fetchRingsWalletIdentity.mockResolvedValue({});
    renderCheck();

    await userEvent.setup().click(checkButton());

    expect(await screen.findByText(/could not be read/)).toBeTruthy();
  });

  // Uncaught, a rejection would leave the control disabled on "Checking…".
  it("answers, and re-enables the check, when the request never returns a reply", async () => {
    mocks.fetchRingsWalletIdentity.mockRejectedValue(new TypeError("Failed to fetch"));
    renderCheck();

    await userEvent.setup().click(checkButton());

    expect(await screen.findByText(/could not be read/)).toBeTruthy();
    expect(checkButton().disabled).toBe(false);
  });

  it("replaces a failure with the next successful verdict", async () => {
    mocks.fetchRingsWalletIdentity.mockResolvedValueOnce({ error: "transient" });
    renderCheck();
    const user = userEvent.setup();

    await user.click(checkButton());
    expect(await screen.findByText("transient")).toBeTruthy();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();

    mocks.fetchRingsWalletIdentity.mockResolvedValueOnce({ identity: identity() });
    await user.click(checkButton());

    expect(await screen.findByText("Not registered")).toBeTruthy();
    expect(screen.queryByText("transient")).toBeNull();
  });

  it("keeps the table cell compact after the dialog closes, and reopens the same verdict", async () => {
    mocks.fetchRingsWalletIdentity.mockResolvedValue({
      identity: identity({
        status: "foreign",
        publishedShieldedAddress: PUBLISHED,
        mismatch: "nullifier_key",
      }),
    });
    renderCheck();
    const user = userEvent.setup();

    await user.click(checkButton());
    expect(await screen.findByText(/will refuse rather than re-key it/)).toBeTruthy();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText(/will refuse rather than re-key it/)).toBeNull();
    expect(mocks.fetchRingsWalletIdentity).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "View details" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByText(/will refuse rather than re-key it/)).toBeTruthy();
    expect(mocks.fetchRingsWalletIdentity).toHaveBeenCalledTimes(1);
  });
});
