// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import type { RingsSyncPhotonResult, RingsWallet } from "./helius-rings.data";
import { formatWhen } from "./helius-rings.utils";
import { WalletStateCard } from "./wallet-state-card";

const mocks = vi.hoisted(() => ({
  syncRingsWallet: vi.fn(),
}));

vi.mock("./helius-rings.data", () => ({
  syncRingsWallet: mocks.syncRingsWallet,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    variant: _variant,
    ...props
  }: ComponentProps<"button"> & { variant?: string }) => <button {...props}>{children}</button>,
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({
    ariaLabel,
    children,
    disabled,
    onValueChange,
    placeholder,
    value,
  }: {
    ariaLabel?: string;
    children: ReactNode;
    disabled?: boolean;
    onValueChange?: (value: string | null) => void;
    placeholder?: string;
    value?: string | null;
  }) => (
    <select
      aria-label={ariaLabel}
      disabled={disabled}
      onChange={(event) => onValueChange?.(event.target.value || null)}
      value={value ?? ""}
    >
      <option value="">{placeholder}</option>
      {children}
    </select>
  ),
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) => (
    <option value={value}>{children}</option>
  ),
}));

const USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const OBSERVED_AT = "2026-08-25T17:00:00.000Z";

const wallets: RingsWallet[] = [
  {
    id: "wallet_pending",
    sdpWalletId: "custody_pending",
    name: "Pending wallet",
    shieldedAddress: null,
    status: "pending",
    network: "devnet",
  },
  {
    id: "wallet_alpha",
    sdpWalletId: "custody_alpha",
    name: "Alpha wallet",
    shieldedAddress: "shielded_alpha",
    status: "ready",
    network: "devnet",
  },
  {
    id: "wallet_paused",
    sdpWalletId: "custody_paused",
    name: "Paused wallet",
    shieldedAddress: "shielded_paused",
    status: "paused",
    network: "devnet",
  },
  {
    id: "wallet_beta",
    sdpWalletId: "custody_beta",
    name: "Beta wallet",
    shieldedAddress: "shielded_beta",
    status: "ready",
    network: "devnet",
  },
];

function syncResult(
  overrides: {
    balances?: RingsSyncPhotonResult["balances"];
    history?: RingsSyncPhotonResult["history"];
    report?: Partial<RingsSyncPhotonResult["report"]>;
    observedAt?: string;
    observedSlot?: string;
  } = {}
): RingsSyncPhotonResult {
  return {
    balances: overrides.balances ?? [
      {
        mint: USDC_MINT,
        symbol: "USDC",
        amountRaw: "1234500",
        decimals: 6,
      },
    ],
    history: overrides.history ?? [
      {
        signature: "sig_alpha_111111111111111111111111111111111111111111",
        slot: "987654321",
        index: "0",
        kind: "shield",
        direction: "inbound",
        mint: USDC_MINT,
        amountRaw: "2500000",
      },
    ],
    report: {
      storedNotes: 2,
      unparsedTransactions: 0,
      undecryptableCandidates: 0,
      unknownAssetIds: 0,
      unknownAssetFields: 0,
      degraded: false,
      ...overrides.report,
    },
    indexedOperationSignatures: [],
    observedAt: overrides.observedAt ?? OBSERVED_AT,
    observedSlot: overrides.observedSlot ?? "987654321",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function renderCard(walletOptions: RingsWallet[] = wallets) {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <WalletStateCard wallets={walletOptions} />
    </I18nProvider>
  );
}

async function selectWallet(user: ReturnType<typeof userEvent.setup>, walletId = "wallet_alpha") {
  await user.selectOptions(screen.getByLabelText("Private wallet"), walletId);
}

async function refreshSelected(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Refresh shielded state" }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.syncRingsWallet.mockResolvedValue({ result: syncResult() });
});

afterEach(cleanup);

describe("WalletStateCard", () => {
  it("offers only ready wallets in the selector", () => {
    renderCard();

    const selector = screen.getByLabelText("Private wallet");
    expect(
      within(selector)
        .getAllByRole("option")
        .map((option) => option.textContent)
    ).toEqual(["Select a ready private wallet", "Alpha wallet", "Beta wallet"]);
    expect(within(selector).queryByText("Pending wallet")).toBeNull();
    expect(within(selector).queryByText("Paused wallet")).toBeNull();
  });

  it("shows a clear state when no wallet is ready", () => {
    renderCard(wallets.filter((wallet) => wallet.status !== "ready"));

    expect(screen.getByText(/No ready private wallets are available/)).toBeTruthy();
    expect(screen.queryByLabelText("Private wallet")).toBeNull();
    expect(screen.queryByRole("button", { name: "Refresh shielded state" })).toBeNull();
  });

  it("never syncs automatically, including after wallet selection", async () => {
    const user = userEvent.setup();
    renderCard();

    await selectWallet(user);

    expect(mocks.syncRingsWallet).not.toHaveBeenCalled();
  });

  it("names the loading work and blocks duplicate refreshes", async () => {
    const pending = deferred<{ result: RingsSyncPhotonResult }>();
    mocks.syncRingsWallet.mockReturnValue(pending.promise);
    const user = userEvent.setup();
    renderCard();
    await selectWallet(user);

    await user.dblClick(screen.getByRole("button", { name: "Refresh shielded state" }));

    expect(mocks.syncRingsWallet).toHaveBeenCalledTimes(1);
    expect(
      (screen.getByRole("button", { name: "Refreshing shielded state…" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
    expect(screen.getByRole("status").textContent).toContain(
      "Refreshing Alpha wallet’s shielded balances and Photon history"
    );

    pending.resolve({ result: syncResult() });
    await act(async () => {
      await pending.promise;
    });
    expect(await screen.findByText("1.2345 USDC")).toBeTruthy();
  });

  it("renders a clean observation with precise balances and Photon history", async () => {
    const user = userEvent.setup();
    renderCard();
    await selectWallet(user);
    await refreshSelected(user);

    expect(await screen.findByText(`Observed ${formatWhen(OBSERVED_AT, "en")}`)).toBeTruthy();
    const balances = screen.getByRole("region", { name: "Shielded balances" });
    expect(within(balances).getByText("1.2345 USDC")).toBeTruthy();
    expect(within(balances).getByText(USDC_MINT)).toBeTruthy();

    const history = screen.getByRole("region", { name: "Photon history" });
    expect(within(history).getByText("Shield")).toBeTruthy();
    expect(within(history).getByText("Inbound")).toBeTruthy();
    expect(within(history).getByText("2.5 USDC")).toBeTruthy();
    expect(within(history).getByText("Slot 987654321")).toBeTruthy();
    expect(
      within(history).getByText("sig_alpha_111111111111111111111111111111111111111111")
    ).toBeTruthy();
    expect(screen.queryByText("Shielded state may be incomplete")).toBeNull();
  });

  it("delegates overflow, focus, and labelling to the shared tables", async () => {
    const user = userEvent.setup();
    renderCard();
    await selectWallet(user);
    await refreshSelected(user);
    await screen.findByText("1.2345 USDC");

    const regions = screen.getAllByRole("region");
    expect(regions).toHaveLength(2);
    for (const [label, minWidth] of [
      ["Shielded balances", "[&_table]:min-w-[40rem]"],
      ["Photon history", "[&_table]:min-w-[52rem]"],
    ] as const) {
      const region = screen.getByRole("region", { name: label });
      expect(region.tabIndex).toBe(0);
      expect(region.className).toContain(minWidth);
      expect(region.className).toContain("[&_table]:table-fixed");
      expect(region.classList.contains("table-fixed")).toBe(false);
      expect(region.style.minWidth).toBe("");
      expect(region.querySelector("table")).toBeTruthy();
    }
  });

  it("keeps the observed timestamp as the sole status after success", async () => {
    const user = userEvent.setup();
    renderCard();
    await selectWallet(user);
    expect(
      screen.getByText(
        "Refresh shielded state to load this wallet’s latest balances and Photon history."
      )
    ).toBeTruthy();

    await refreshSelected(user);
    const observed = await screen.findByText(`Observed ${formatWhen(OBSERVED_AT, "en")}`);

    expect(
      screen.queryByText(
        "Refresh shielded state to load this wallet’s latest balances and Photon history."
      )
    ).toBeNull();
    expect(screen.getAllByRole("status")).toEqual([observed]);
  });

  it("lets a 120-character selected wallet name wrap while loading", async () => {
    const pending = deferred<{ result: RingsSyncPhotonResult }>();
    mocks.syncRingsWallet.mockReturnValue(pending.promise);
    const longName = "W".repeat(120);
    const alphaWallet = wallets.find((wallet) => wallet.id === "wallet_alpha");
    if (!alphaWallet) throw new Error("Alpha wallet fixture is missing");
    const user = userEvent.setup();
    renderCard([{ ...alphaWallet, name: longName }]);
    await selectWallet(user);
    await refreshSelected(user);

    const status = screen.getByRole("status");
    expect(status.textContent).toContain(longName);
    expect(status.className).toContain("min-w-0");
    expect(status.className).toContain("break-words");

    pending.resolve({ result: syncResult() });
    await act(async () => {
      await pending.promise;
    });
  });

  it("prominently reports every nonzero degraded-sync anomaly", async () => {
    mocks.syncRingsWallet.mockResolvedValue({
      result: syncResult({
        report: {
          degraded: true,
          unparsedTransactions: 2,
          undecryptableCandidates: 3,
          unknownAssetIds: 4,
          unknownAssetFields: 5,
        },
      }),
    });
    const user = userEvent.setup();
    renderCard();
    await selectWallet(user);
    await refreshSelected(user);

    const warning = await screen.findByRole("alert");
    expect(within(warning).getByText("Shielded state may be incomplete")).toBeTruthy();
    expect(within(warning).getByText("Unparsed transactions: 2")).toBeTruthy();
    expect(within(warning).getByText("Undecryptable candidates: 3")).toBeTruthy();
    expect(within(warning).getByText("Unknown asset IDs: 4")).toBeTruthy();
    expect(within(warning).getByText("Unknown asset fields: 5")).toBeTruthy();
  });

  it("shows distinct empty states for balances and history", async () => {
    mocks.syncRingsWallet.mockResolvedValue({
      result: syncResult({ balances: [], history: [] }),
    });
    const user = userEvent.setup();
    renderCard();
    await selectWallet(user);
    await refreshSelected(user);

    expect(await screen.findByText("No shielded balances were observed.")).toBeTruthy();
    expect(screen.getByText("No Photon history was observed.")).toBeTruthy();
  });

  it("shows the API error and offers a working retry", async () => {
    mocks.syncRingsWallet
      .mockResolvedValueOnce({ error: "Photon has not caught up yet." })
      .mockResolvedValueOnce({ result: syncResult() });
    const user = userEvent.setup();
    renderCard();
    await selectWallet(user);
    await refreshSelected(user);

    const error = await screen.findByRole("alert");
    expect(within(error).getByText("Could not refresh shielded state")).toBeTruthy();
    expect(within(error).getByText("Photon has not caught up yet.")).toBeTruthy();

    await user.click(within(error).getByRole("button", { name: "Try again" }));

    expect(mocks.syncRingsWallet).toHaveBeenCalledTimes(2);
    expect(await screen.findByText("1.2345 USDC")).toBeTruthy();
  });

  it("clears the previous wallet result and error when the selection changes", async () => {
    const user = userEvent.setup();
    renderCard();
    await selectWallet(user);
    await refreshSelected(user);
    expect(await screen.findByText("1.2345 USDC")).toBeTruthy();

    await selectWallet(user, "wallet_beta");
    expect(screen.queryByText("1.2345 USDC")).toBeNull();

    mocks.syncRingsWallet.mockResolvedValueOnce({ error: "Beta sync failed." });
    await refreshSelected(user);
    expect(await screen.findByText("Beta sync failed.")).toBeTruthy();

    await selectWallet(user, "wallet_alpha");
    expect(screen.queryByText("Beta sync failed.")).toBeNull();
  });

  it("ignores an older response after the wallet changes", async () => {
    const alphaSync = deferred<{ result: RingsSyncPhotonResult }>();
    const betaResult = syncResult({
      balances: [
        {
          mint: "So11111111111111111111111111111111111111112",
          symbol: "SOL",
          amountRaw: "9000000000",
          decimals: 9,
        },
      ],
      history: [],
      observedAt: "2026-08-25T18:00:00.000Z",
      observedSlot: "987654322",
    });
    mocks.syncRingsWallet
      .mockReturnValueOnce(alphaSync.promise)
      .mockResolvedValueOnce({ result: betaResult });
    const user = userEvent.setup();
    renderCard();
    await selectWallet(user);
    await refreshSelected(user);

    await selectWallet(user, "wallet_beta");
    alphaSync.resolve({ result: syncResult() });
    await act(async () => {
      await alphaSync.promise;
    });

    await waitFor(() => {
      expect(screen.queryByText("1.2345 USDC")).toBeNull();
    });
    await refreshSelected(user);
    expect(await screen.findByText("9 SOL")).toBeTruthy();
    expect(mocks.syncRingsWallet.mock.calls.map(([walletId]) => walletId)).toEqual([
      "wallet_alpha",
      "wallet_beta",
    ]);
  });
});
