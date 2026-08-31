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

const WALLET: RingsWallet = {
  id: "hrw_treasury",
  sdpWalletId: "wal_treasury",
  name: "Treasury",
  shieldedAddress: "rings1treasury",
  status: "ready",
  network: "devnet",
};

const ACTIVE_RING: ProjectRing = {
  ringProgramId: RING_PROGRAM,
  status: "active",
  auditorPublicKeyHex: "04ff",
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

function renderComposer(projectRing: ProjectRing | null) {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <OperationComposer
        wallet={WALLET}
        recipientOptions={[]}
        custodyPublicKey="9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"
        projectRing={projectRing}
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
  it("offers no ring selector while the project has no custom ring", async () => {
    renderComposer(null);

    expect(screen.queryByRole("combobox", { name: "Ring" })).toBeNull();

    const user = userEvent.setup();
    await fillShield(user);
    await user.click(screen.getByRole("button", { name: "Review" }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    // Omitted, not "default": the field only exists to name the custom ring.
    expect(mocks.prepareRingsOperation).toHaveBeenCalledTimes(1);
    expect("ring" in (mocks.prepareRingsOperation.mock.calls[0]?.[0] ?? {})).toBe(false);
  });

  it("offers the ring only on the shield tab", async () => {
    renderComposer(ACTIVE_RING);

    expect(screen.getByRole("combobox", { name: "Ring" })).toBeTruthy();

    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Withdraw" }));
    // A withdraw spends default-pool notes; a ring choice would misstate it.
    expect(screen.queryByRole("combobox", { name: "Ring" })).toBeNull();

    await user.click(screen.getByRole("tab", { name: "Shield" }));
    expect(screen.getByRole("combobox", { name: "Ring" })).toBeTruthy();
  });

  it("disables the custom option, with the reason, while bring-up is unfinished", async () => {
    renderComposer({ ...ACTIVE_RING, status: "pending", auditorPublicKeyHex: null });

    expect(screen.getByText(/not active yet; complete bring-up/)).toBeTruthy();

    await userEvent.setup().click(screen.getByRole("combobox", { name: "Ring" }));
    const custom = await screen.findByRole("option", { name: "Custom ring" });
    expect(custom.getAttribute("aria-disabled")).toBe("true");
  });

  it("sends ring:custom and shows the ring on review when active", async () => {
    renderComposer(ACTIVE_RING);

    const user = userEvent.setup();
    await fillShield(user);
    await user.click(screen.getByRole("combobox", { name: "Ring" }));
    await user.click(await screen.findByRole("option", { name: "Custom ring" }));
    await user.click(screen.getByRole("button", { name: "Review" }));

    expect(screen.getByText("Custom ring (RingPr…1111)")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Confirm" }));

    expect(mocks.prepareRingsOperation).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ ring: "custom" })
    );
  });

  it("forgets a custom choice when the operation leaves the shield tab", async () => {
    renderComposer(ACTIVE_RING);

    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "Ring" }));
    await user.click(await screen.findByRole("option", { name: "Custom ring" }));
    await user.click(screen.getByRole("tab", { name: "Withdraw" }));
    await user.click(screen.getByRole("tab", { name: "Shield" }));

    await fillShield(user);
    await user.click(screen.getByRole("button", { name: "Review" }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    expect(mocks.prepareRingsOperation).toHaveBeenCalledTimes(1);
    expect("ring" in (mocks.prepareRingsOperation.mock.calls[0]?.[0] ?? {})).toBe(false);
  });
});
