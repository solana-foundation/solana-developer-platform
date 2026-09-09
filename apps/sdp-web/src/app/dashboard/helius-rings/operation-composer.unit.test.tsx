// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import type { ProjectRing, RingsWallet } from "./helius-rings.data";
import { OperationComposer } from "./operation-composer";

const mocks = vi.hoisted(() => ({ prepareRingsOperation: vi.fn() }));

vi.mock("./helius-rings.data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./helius-rings.data")>()),
  prepareRingsOperation: mocks.prepareRingsOperation,
}));

const RING_PROGRAM = "RingProgram1111111111111111111111111111111";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

const WALLET: RingsWallet = {
  id: "hrw_treasury",
  sdpWalletId: "wal_treasury",
  name: "Treasury",
  shieldedAddress: "rings1treasury",
  status: "ready",
  network: "devnet",
};

const RECIPIENT: RingsWallet = {
  ...WALLET,
  id: "hrw_desk",
  sdpWalletId: "wal_desk",
  name: "Trading desk",
  shieldedAddress: "rings1desk",
};

const ACTIVE_RING: ProjectRing = {
  id: "hrr_1",
  name: "treasury",
  ringProgramId: RING_PROGRAM,
  status: "active",
  auditorPublicKeyHex: "04ff",
  lookupTableAddress: "LookupTab1e11111111111111111111111111111111",
  failure: null,
  createdAt: "2026-08-26T12:00:00.000Z",
  updatedAt: "2026-08-26T12:00:00.000Z",
};

const PREPARED = {
  operation: {
    id: "hro_1",
    walletId: WALLET.id,
    opType: "shield",
    state: "indexing",
    assetMint: null,
    amountRaw: null,
    ringProgramId: null,
    createdAt: "2026-08-26T12:00:00.000Z",
    failure: null,
    events: [],
  },
};

function renderComposer(projectRings: ProjectRing[], recipientOptions: RingsWallet[] = []) {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <OperationComposer
        wallet={WALLET}
        recipientOptions={recipientOptions}
        custodyPublicKey="9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"
        projectRings={projectRings}
        gatewayRed={false}
        onPrepared={async () => {}}
      />
    </I18nProvider>
  );
}

/** Fills the minimal shield draft: the decimal amount. */
async function fillShield(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByPlaceholderText("1.01"), "1.5");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prepareRingsOperation.mockResolvedValue(PREPARED);
});

afterEach(cleanup);

describe("OperationComposer ring selection", () => {
  it("offers no ring selector while the project has no custom rings", async () => {
    renderComposer([]);

    expect(screen.queryByRole("combobox", { name: "Ring" })).toBeNull();

    const user = userEvent.setup();
    await fillShield(user);
    await user.click(screen.getByRole("button", { name: "Review" }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    // Omitted, not "default": the field only exists to name a custom ring.
    expect(mocks.prepareRingsOperation).toHaveBeenCalledTimes(1);
    expect("ring" in (mocks.prepareRingsOperation.mock.calls[0]?.[0] ?? {})).toBe(false);
  });

  it("offers the ring on every operation tab", async () => {
    renderComposer([ACTIVE_RING]);

    expect(screen.getByRole("combobox", { name: "Ring" })).toBeTruthy();

    const user = userEvent.setup();
    // A ring spend consumes the ring's own notes, so the selector names the
    // source of funds on the spend tabs.
    await user.click(screen.getByRole("tab", { name: "Withdraw" }));
    expect(screen.getByRole("combobox", { name: "Ring" })).toBeTruthy();
    expect(screen.getByText(/source of funds/)).toBeTruthy();

    await user.click(screen.getByRole("tab", { name: "Shield" }));
    expect(screen.getByRole("combobox", { name: "Ring" })).toBeTruthy();
  });

  it("disables a non-active ring's option, with the reason", async () => {
    renderComposer([{ ...ACTIVE_RING, status: "pending", auditorPublicKeyHex: null }]);

    expect(screen.getByText(/No ring is active yet; complete bring-up/)).toBeTruthy();

    await userEvent.setup().click(screen.getByRole("combobox", { name: "Ring" }));
    const option = await screen.findByRole("option", { name: "treasury" });
    expect(option.getAttribute("aria-disabled")).toBe("true");
  });

  it("sends the ring's name and shows it on review when active", async () => {
    renderComposer([ACTIVE_RING]);

    const user = userEvent.setup();
    await fillShield(user);
    await user.click(screen.getByRole("combobox", { name: "Ring" }));
    await user.click(await screen.findByRole("option", { name: "treasury" }));
    await user.click(screen.getByRole("button", { name: "Review" }));

    expect(screen.getByText("treasury")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Confirm" }));

    expect(mocks.prepareRingsOperation).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ ring: "treasury" })
    );
  });

  it("sends the ring's name on a withdraw", async () => {
    renderComposer([ACTIVE_RING]);

    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Withdraw" }));
    await fillShield(user);
    await user.click(screen.getByRole("combobox", { name: "Ring" }));
    await user.click(await screen.findByRole("option", { name: "treasury" }));
    await user.click(screen.getByRole("button", { name: "Review" }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    expect(mocks.prepareRingsOperation).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ opType: "withdraw", ring: "treasury" })
    );
  });

  it("forgets a ring choice when the operation changes tab", async () => {
    renderComposer([ACTIVE_RING]);

    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "Ring" }));
    await user.click(await screen.findByRole("option", { name: "treasury" }));
    // The ring's meaning flips with the op type (destination vs source), so a
    // carried-over choice would silently redirect value.
    await user.click(screen.getByRole("tab", { name: "Withdraw" }));
    await user.click(screen.getByRole("tab", { name: "Shield" }));

    await fillShield(user);
    await user.click(screen.getByRole("button", { name: "Review" }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    expect(mocks.prepareRingsOperation).toHaveBeenCalledTimes(1);
    expect("ring" in (mocks.prepareRingsOperation.mock.calls[0]?.[0] ?? {})).toBe(false);
  });
});

describe("OperationComposer merge", () => {
  it("asks for an asset alone, with no amount or ring to choose", async () => {
    renderComposer([ACTIVE_RING]);

    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Merge" }));

    // A merge consolidates this wallet's own default-ring notes, so neither
    // field has a meaning to offer.
    expect(screen.queryByPlaceholderText("1.01")).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Ring" })).toBeNull();
    expect(screen.getByRole("combobox", { name: "Asset" })).toBeTruthy();
  });

  it("reviews without an amount row and sends an asset with no amountRaw", async () => {
    renderComposer([ACTIVE_RING]);

    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Merge" }));
    // No amount to type: the draft is complete as soon as the tab is chosen.
    await user.click(screen.getByRole("button", { name: "Review" }));

    expect(screen.queryByText("Amount")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Confirm" }));

    // The API's merge arm is strict, so an amount it has no use for would be
    // refused rather than ignored.
    expect(mocks.prepareRingsOperation).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ opType: "merge", asset: { mint: SOL_MINT } })
    );
    const sent = mocks.prepareRingsOperation.mock.calls[0]?.[0] ?? {};
    expect("ring" in sent).toBe(false);
    expect(sent.to).toBeUndefined();
  });

  it("submits a USDC merge, carrying the asset across the tab switch", async () => {
    renderComposer([]);

    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "Asset" }));
    await user.click(await screen.findByRole("option", { name: "USDC" }));
    await user.click(screen.getByRole("tab", { name: "Merge" }));

    await user.click(screen.getByRole("button", { name: "Review" }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    expect(mocks.prepareRingsOperation).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        opType: "merge",
        asset: { mint: USDC_MINT },
      })
    );
  });
});

describe("OperationComposer USDC", () => {
  it("offers USDC on every operation", async () => {
    // A recipient, so the private-transfer tab composes rather than reporting
    // it has nobody to send to.
    renderComposer([ACTIVE_RING], [RECIPIENT]);

    const user = userEvent.setup();
    for (const tab of ["Shield", "Withdraw", "Private transfer", "Merge"]) {
      await user.click(screen.getByRole("tab", { name: tab }));
      await user.click(screen.getByRole("combobox", { name: "Asset" }));
      expect(await screen.findByRole("option", { name: "USDC" })).toBeTruthy();
      await user.keyboard("{Escape}");
    }
  });

  it("submits a USDC withdrawal from the default ring", async () => {
    renderComposer([]);

    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Withdraw" }));
    await user.click(screen.getByRole("combobox", { name: "Asset" }));
    await user.click(await screen.findByRole("option", { name: "USDC" }));
    await fillShield(user);
    await user.click(screen.getByRole("button", { name: "Review" }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    expect(mocks.prepareRingsOperation).toHaveBeenCalledExactlyOnceWith(
      // USDC has six decimals, so "1.5" is 1_500_000 base units.
      expect.objectContaining({
        opType: "withdraw",
        asset: { mint: USDC_MINT, amountRaw: "1500000" },
      })
    );
  });

  // Pinning a ring changes where the notes come from, not which assets the
  // build settles: a chosen USDC survives the ring select rather than
  // silently falling back to SOL.
  it("keeps USDC on a spend once a custom ring is pinned", async () => {
    renderComposer([ACTIVE_RING]);

    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Withdraw" }));
    await user.click(screen.getByRole("combobox", { name: "Asset" }));
    await user.click(await screen.findByRole("option", { name: "USDC" }));

    await user.click(screen.getByRole("combobox", { name: "Ring" }));
    await user.click(await screen.findByRole("option", { name: "treasury" }));

    await user.click(screen.getByRole("combobox", { name: "Asset" }));
    expect(await screen.findByRole("option", { name: "USDC" })).toBeTruthy();
    await user.keyboard("{Escape}");

    await fillShield(user);
    await user.click(screen.getByRole("button", { name: "Review" }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    expect(mocks.prepareRingsOperation).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        opType: "withdraw",
        ring: "treasury",
        asset: { mint: USDC_MINT, amountRaw: "1500000" },
      })
    );
  });

  it("shields USDC into a custom ring", async () => {
    renderComposer([ACTIVE_RING]);

    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "Asset" }));
    await user.click(await screen.findByRole("option", { name: "USDC" }));
    await user.click(screen.getByRole("combobox", { name: "Ring" }));
    await user.click(await screen.findByRole("option", { name: "treasury" }));

    await fillShield(user);
    await user.click(screen.getByRole("button", { name: "Review" }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    expect(mocks.prepareRingsOperation).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        opType: "shield",
        ring: "treasury",
        asset: { mint: USDC_MINT, amountRaw: "1500000" },
      })
    );
  });
});
