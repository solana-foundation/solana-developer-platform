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

vi.mock("./use-rings-zones", () => ({ useRingsZones: () => ({ zones: [] }) }));

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
        wallets={[WALLET]}
        gatewayRed={false}
        projectRing={projectRing}
        onPrepared={async () => {}}
      />
    </I18nProvider>
  );
}

/** Fills the minimal shield draft: wallet plus amount. */
async function fillShield(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("combobox", { name: "Private wallet" }));
  await user.click(await screen.findByRole("option", { name: "Treasury" }));
  await user.type(screen.getByPlaceholderText("1000000"), "1000000");
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
    expect(mocks.prepareRingsOperation).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ ring: undefined })
    );
    expect(screen.queryByText("Ring")).toBeNull();
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
});
