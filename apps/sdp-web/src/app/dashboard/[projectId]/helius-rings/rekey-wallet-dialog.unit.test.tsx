// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import type { RingsWallet } from "./helius-rings.data";
import { RekeyWalletDialog } from "./rekey-wallet-dialog";

const mocks = vi.hoisted(() => ({ rekeyRingsWallet: vi.fn() }));

vi.mock("./helius-rings.data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./helius-rings.data")>()),
  rekeyRingsWallet: mocks.rekeyRingsWallet,
}));

const WALLET: RingsWallet = {
  id: "hrw_treasury",
  sdpWalletId: "wal_treasury",
  name: "Treasury",
  shieldedAddress: "rings1treasury",
  status: "paused",
  network: "devnet",
};

function renderDialog(onRekeyed = vi.fn().mockResolvedValue(undefined)) {
  render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <RekeyWalletDialog wallet={WALLET} onRekeyed={onRekeyed} />
    </I18nProvider>
  );
  return onRekeyed;
}

async function openDialog() {
  await userEvent.click(screen.getByRole("button", { name: /Re-key wallet/i }));
}

function submitButton() {
  return screen.getByRole("button", { name: /Re-key and discard balance/i });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(cleanup);

describe("RekeyWalletDialog", () => {
  it("names the loss before anything can be submitted", async () => {
    renderDialog();
    await openDialog();

    // The cost is the whole reason this dialog exists; an operator who reads
    // only the heading still has to pass "cannot be undone" to reach the input.
    expect(screen.getByText(/discards whatever this wallet's published keys hold/i)).toBeTruthy();
    expect(screen.getByText(/cannot be undone/i)).toBeTruthy();
  });

  it("keeps the action disabled until the wallet's name is typed exactly", async () => {
    renderDialog();
    await openDialog();

    expect(submitButton().hasAttribute("disabled")).toBe(true);

    await userEvent.type(screen.getByLabelText(/Type Treasury to confirm/i), "Treasur");
    expect(submitButton().hasAttribute("disabled")).toBe(true);

    await userEvent.type(screen.getByLabelText(/Type Treasury to confirm/i), "y");
    expect(submitButton().hasAttribute("disabled")).toBe(false);
  });

  it("sends the confirmation and refreshes the wallet list once it lands", async () => {
    mocks.rekeyRingsWallet.mockResolvedValue({ wallet: { ...WALLET, status: "ready" } });
    const onRekeyed = renderDialog();
    await openDialog();

    await userEvent.type(screen.getByLabelText(/Type Treasury to confirm/i), "Treasury");
    await userEvent.click(submitButton());

    expect(mocks.rekeyRingsWallet).toHaveBeenCalledWith(WALLET.id, "Treasury");
    await waitFor(() => expect(onRekeyed).toHaveBeenCalled());
  });

  it("keeps the dialog open on a refusal so the server's reason is readable", async () => {
    mocks.rekeyRingsWallet.mockResolvedValue({
      error: "only a paused rings wallet can be re-keyed",
    });
    const onRekeyed = renderDialog();
    await openDialog();

    await userEvent.type(screen.getByLabelText(/Type Treasury to confirm/i), "Treasury");
    await userEvent.click(submitButton());

    expect(await screen.findByText(/only a paused rings wallet/i)).toBeTruthy();
    // Closing here would report a rotation that never happened.
    expect(onRekeyed).not.toHaveBeenCalled();
  });

  it("reports a dropped request instead of waiting on it forever", async () => {
    mocks.rekeyRingsWallet.mockRejectedValue(new TypeError("Failed to fetch"));
    renderDialog();
    await openDialog();

    await userEvent.type(screen.getByLabelText(/Type Treasury to confirm/i), "Treasury");
    await userEvent.click(submitButton());

    // The rotation may still have landed, so the copy must not claim it failed.
    expect(await screen.findByText(/may still have landed/i)).toBeTruthy();
  });
});
