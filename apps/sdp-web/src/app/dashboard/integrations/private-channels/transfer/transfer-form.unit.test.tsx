// @vitest-environment jsdom

import type {
  CustodyWalletSummary,
  PrivateChannelMembershipChannelDto,
  PrivateChannelTokenEligibility,
  PrivateChannelTransfer,
  PrivateChannelTransferRecipientDto,
} from "@sdp/types";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createTransferAction: vi.fn(),
  fetchTransferRecipientsAction: vi.fn(),
  fetchWalletBalancesAction: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("./actions", () => ({
  createTransferAction: mocks.createTransferAction,
  fetchTransferRecipientsAction: mocks.fetchTransferRecipientsAction,
}));
vi.mock("../wallet-balances", () => ({
  fetchWalletBalancesAction: mocks.fetchWalletBalancesAction,
}));
vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));
vi.mock("@/lib/use-solana-cluster", () => ({ useSolanaCluster: () => "devnet" }));
vi.mock("@/components/ui/button", () => ({
  Button: (props: ComponentProps<"button">) => <button {...props} />,
}));
vi.mock("@/components/ui/input", () => ({
  Input: (props: ComponentProps<"input">) => <input {...props} />,
}));
vi.mock("@/components/ui/label", () => ({
  Label: (props: ComponentProps<"label">) => (
    // biome-ignore lint/a11y/noLabelWithoutControl: This test double forwards associations supplied by the component.
    <label {...props} />
  ),
}));
vi.mock("@/components/ui/select", () => ({
  Select: ({
    ariaLabel,
    children,
    disabled,
    onValueChange,
    value,
  }: {
    ariaLabel?: string;
    children: ReactNode;
    disabled?: boolean;
    onValueChange?: (value: string | null) => void;
    value?: string | null;
  }) => (
    <select
      aria-label={ariaLabel}
      disabled={disabled}
      onChange={(event) => onValueChange?.(event.target.value || null)}
      value={value ?? ""}
    >
      <option value="">Select an option</option>
      {children}
    </select>
  ),
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) => (
    <option value={value}>{children}</option>
  ),
}));
vi.mock("./transfer-progress", () => ({
  TransferProgress: ({
    onReset,
    recipientLabel,
    senderLabel,
    transfer,
  }: {
    onReset: () => void;
    recipientLabel?: string;
    senderLabel?: string;
    transfer: PrivateChannelTransfer;
  }) => (
    <div>
      <p>Progress: {transfer.status}</p>
      <p>Submitted sender: {senderLabel}</p>
      <p>Submitted recipient: {recipientLabel}</p>
      <p>Submitted amount: {transfer.amount} USDC</p>
      <button onClick={onReset} type="button">
        New transfer
      </button>
    </div>
  ),
}));

import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { TransferForm } from "./transfer-form";

/** Passed as `wrapper` so `rerender` keeps the provider in place. */
function I18nWrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      {children}
    </I18nProvider>
  );
}

function renderForm(props: Omit<ComponentProps<typeof TransferForm>, "tokens">) {
  return render(<TransferForm {...props} tokens={eligibleTokens} />, { wrapper: I18nWrapper });
}

const eligibleTokens: PrivateChannelTokenEligibility[] = [
  {
    symbol: "USDC",
    mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    decimals: 6,
    tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    enabled: true,
    exclusionReasons: [],
  },
];

const channels: PrivateChannelMembershipChannelDto[] = [
  { id: "channel_alpha", name: "Alpha", isDefault: true },
  { id: "channel_beta", name: "Beta", isDefault: false },
];

const sourceWallets: CustodyWalletSummary[] = [
  {
    id: "custody_sender",
    custodyConfigId: "custody-config-1",
    isRuntimeExecutionAllowed: true,
    walletId: "wallet_sender",
    publicKey: "Sender1111111111111111111111111111111111",
    label: "Treasury",
    purpose: null,
    status: "active",
    createdAt: "2026-07-28T00:00:00.000Z",
  },
  {
    id: "custody_operations",
    custodyConfigId: "custody-config-1",
    isRuntimeExecutionAllowed: true,
    walletId: "wallet_operations",
    publicKey: "Operations22222222222222222222222222222222",
    label: "Operations",
    purpose: null,
    status: "active",
    createdAt: "2026-07-28T00:00:00.000Z",
  },
];

const alphaRecipients: PrivateChannelTransferRecipientDto[] = [
  {
    id: "pcvw_alice",
    pubkey: "Alice11111111111111111111111111111111111",
    walletName: "Alice Treasury",
    privateChannelUserId: "pcu_alice",
    isSelf: false,
  },
  {
    id: "pcvw_alice_savings",
    pubkey: "Alice22222222222222222222222222222222222",
    walletName: "Alice Savings",
    privateChannelUserId: "pcu_alice",
    isSelf: false,
  },
];

const betaRecipients: PrivateChannelTransferRecipientDto[] = [
  {
    id: "pcvw_bob",
    pubkey: "Bob111111111111111111111111111111111111",
    walletName: null,
    privateChannelUserId: "pcu_bob",
    isSelf: false,
  },
];

function makeTransfer(overrides: Partial<PrivateChannelTransfer> = {}): PrivateChannelTransfer {
  return {
    id: "pct_test",
    organizationId: "org_test",
    projectId: "project_test",
    instanceId: "pci_test",
    channelId: "channel_alpha",
    walletId: "wallet_sender",
    sender: sourceWallets[0]?.publicKey ?? "",
    recipient: alphaRecipients[0]?.pubkey ?? "",
    mint: "Usdc111111111111111111111111111111111111",
    amount: "1.25",
    status: "submitted",
    signature: "signature",
    failureReason: null,
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function renderReadyForm() {
  mocks.fetchTransferRecipientsAction.mockResolvedValue({
    ok: true,
    recipients: alphaRecipients,
  });
  const user = userEvent.setup();
  renderForm({
    channels,
    scopeKey: "org_test:project_test:pci_test",
    sourceWallets,
  });
  await screen.findByRole("option", { name: "Alice Treasury (Alic…1111)" });
  await user.selectOptions(screen.getByLabelText("Recipient wallet"), "pcvw_alice");
  await user.type(screen.getByLabelText("Amount (USDC)"), "1.25");
  return user;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchWalletBalancesAction.mockResolvedValue({ channel: "10", onChain: "5" });
});

describe("TransferForm", () => {
  it("explains when the authenticated member has no eligible channels", () => {
    renderForm({
      channels: [],
      scopeKey: "org_test:project_test:pci_test",
      sourceWallets,
    });

    expect(screen.getByText(/not a member of any active private channel/i)).toBeTruthy();
    expect(mocks.fetchTransferRecipientsAction).not.toHaveBeenCalled();
  });

  it("does not offer unverified or non-signable source wallets", () => {
    renderForm({
      channels,
      scopeKey: "org_test:project_test:pci_test",
      sourceWallets: [],
    });

    expect(screen.getByText(/no verified custody wallet that SDP can sign with/i)).toBeTruthy();
    expect(mocks.fetchTransferRecipientsAction).not.toHaveBeenCalled();
  });

  it("shows an empty state when a channel has no eligible recipient wallets", async () => {
    mocks.fetchTransferRecipientsAction.mockResolvedValue({ ok: true, recipients: [] });

    renderForm({
      channels,
      scopeKey: "org_test:project_test:pci_test",
      sourceWallets,
    });

    expect(
      await screen.findByText(/no verified wallet on this channel can receive this transfer/i)
    ).toBeTruthy();
  });

  it("uses custody wallet names for recipient wallets without exposing owner identity", async () => {
    mocks.fetchTransferRecipientsAction.mockResolvedValue({
      ok: true,
      recipients: [
        {
          id: "pcvw_self_operations",
          pubkey: sourceWallets[1]?.publicKey ?? "",
          walletName: "Operations",
          privateChannelUserId: "pcu_self",
          isSelf: true,
        },
        ...alphaRecipients,
      ] satisfies PrivateChannelTransferRecipientDto[],
    });

    renderForm({
      channels,
      scopeKey: "org_test:project_test:pci_test",
      sourceWallets,
    });

    const recipientSelect = await screen.findByLabelText("Recipient wallet");
    expect(
      within(recipientSelect).getByRole("option", { name: /^Operations \(Oper…2222\)$/ })
    ).toBeTruthy();
    expect(
      within(recipientSelect).getByRole("option", { name: /^Alice Treasury \(Alic…1111\)$/ })
    ).toBeTruthy();
    expect(within(recipientSelect).queryByText(/alice@example\.com/)).toBeNull();
  });

  it("drops the selected source wallet from the recipient list and clears a stale selection", async () => {
    const ownOperationsWallet: PrivateChannelTransferRecipientDto = {
      id: "pcvw_self_operations",
      pubkey: sourceWallets[1]?.publicKey ?? "",
      walletName: "Operations",
      privateChannelUserId: "pcu_self",
      isSelf: true,
    };
    mocks.fetchTransferRecipientsAction.mockResolvedValue({
      ok: true,
      recipients: [ownOperationsWallet, ...alphaRecipients],
    });
    const user = userEvent.setup();
    renderForm({
      channels,
      scopeKey: "org_test:project_test:pci_test",
      sourceWallets,
    });

    const recipientSelect = (await screen.findByLabelText("Recipient wallet")) as HTMLSelectElement;
    expect(
      within(recipientSelect).getByRole("option", { name: /^Operations \(Oper…2222\)$/ })
    ).toBeTruthy();
    await user.selectOptions(recipientSelect, "pcvw_self_operations");
    expect(recipientSelect.value).toBe("pcvw_self_operations");

    await user.selectOptions(screen.getByLabelText("From wallet"), "wallet_operations");

    await waitFor(() => {
      expect(
        within(recipientSelect).queryByRole("option", { name: /^Operations \(Oper…2222\)$/ })
      ).toBeNull();
    });
    expect((screen.getByLabelText("Recipient wallet") as HTMLSelectElement).value).toBe("");
  });

  it("resets the old recipient while loading a newly selected channel", async () => {
    const betaResponse = deferred<{
      ok: true;
      recipients: PrivateChannelTransferRecipientDto[];
    }>();
    mocks.fetchTransferRecipientsAction
      .mockResolvedValueOnce({ ok: true, recipients: alphaRecipients })
      .mockReturnValueOnce(betaResponse.promise);
    const user = userEvent.setup();
    renderForm({
      channels,
      scopeKey: "org_test:project_test:pci_test",
      sourceWallets,
    });

    await screen.findByRole("option", { name: /Alic…1111/ });
    await user.selectOptions(screen.getByLabelText("Recipient wallet"), "pcvw_alice");
    expect(screen.getByLabelText("Recipient wallet")).toHaveProperty("value", "pcvw_alice");

    await user.selectOptions(screen.getByLabelText("Channel"), "channel_beta");
    expect(screen.getByText("Loading verified recipient wallets…")).toBeTruthy();
    expect(screen.queryByLabelText("Recipient wallet")).toBeNull();

    betaResponse.resolve({ ok: true, recipients: betaRecipients });
    await screen.findByRole("option", { name: "Bob1…1111" });
    expect(screen.getByLabelText("Recipient wallet")).toHaveProperty("value", "");
  });

  it("ignores an older recipient response that resolves after a channel change", async () => {
    const alphaResponse = deferred<{
      ok: true;
      recipients: PrivateChannelTransferRecipientDto[];
    }>();
    const betaResponse = deferred<{
      ok: true;
      recipients: PrivateChannelTransferRecipientDto[];
    }>();
    mocks.fetchTransferRecipientsAction
      .mockReturnValueOnce(alphaResponse.promise)
      .mockReturnValueOnce(betaResponse.promise);
    const user = userEvent.setup();
    renderForm({
      channels,
      scopeKey: "org_test:project_test:pci_test",
      sourceWallets,
    });

    await user.selectOptions(screen.getByLabelText("Channel"), "channel_beta");
    betaResponse.resolve({ ok: true, recipients: betaRecipients });
    await screen.findByRole("option", { name: "Bob1…1111" });

    alphaResponse.resolve({ ok: true, recipients: alphaRecipients });
    await waitFor(() => {
      expect(screen.queryAllByRole("option", { name: /Alice/ })).toHaveLength(0);
      expect(screen.getByRole("option", { name: "Bob1…1111" })).toBeTruthy();
    });
  });

  it("renders an HTTP-200 failed transfer without reporting success", async () => {
    const failedTransfer = makeTransfer({
      status: "failed",
      failureReason: "Insufficient shared wallet balance.",
    });
    mocks.createTransferAction.mockResolvedValue({ ok: true, transfer: failedTransfer });
    const user = await renderReadyForm();

    await user.click(screen.getByRole("button", { name: "Transfer USDC" }));

    await screen.findByText("Progress: failed");
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith("Insufficient shared wallet balance.");
  });

  it("refreshes the sender balance when starting a new transfer after confirmation", async () => {
    mocks.fetchWalletBalancesAction
      .mockResolvedValueOnce({ channel: "10", onChain: "5" })
      .mockResolvedValueOnce({ channel: "8.75", onChain: "5" });
    mocks.createTransferAction.mockResolvedValue({
      ok: true,
      transfer: makeTransfer({ status: "confirmed" }),
    });
    const user = await renderReadyForm();
    await waitFor(() =>
      expect(mocks.fetchWalletBalancesAction).toHaveBeenCalledWith(
        "wallet_sender",
        expect.any(String)
      )
    );

    await user.click(screen.getByRole("button", { name: "Transfer USDC" }));
    await screen.findByText("Progress: confirmed");
    await user.click(screen.getByRole("button", { name: "New transfer" }));

    await waitFor(() => expect(mocks.fetchWalletBalancesAction).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("8.75 USDC")).toBeTruthy();
  });

  it("prevents duplicate submissions while the first request is pending", async () => {
    const response = deferred<{ ok: true; transfer: PrivateChannelTransfer }>();
    mocks.createTransferAction.mockReturnValue(response.promise);
    await renderReadyForm();
    const form = screen.getByRole("button", { name: "Transfer USDC" }).closest("form");
    if (!form) {
      throw new Error("Expected transfer form");
    }

    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() => expect(mocks.createTransferAction).toHaveBeenCalledTimes(1));

    response.resolve({ ok: true, transfer: makeTransfer() });
    await screen.findByText("Progress: submitted");
  });

  it("freezes financial fields during a slow submit and keeps result labels", async () => {
    const response = deferred<{ ok: true; transfer: PrivateChannelTransfer }>();
    mocks.createTransferAction.mockReturnValue(response.promise);
    const user = await renderReadyForm();

    await user.click(screen.getByRole("button", { name: "Transfer USDC" }));
    await waitFor(() => expect(mocks.createTransferAction).toHaveBeenCalledTimes(1));

    const channel = screen.getByLabelText("Channel");
    const source = screen.getByLabelText("From wallet");
    const recipient = screen.getByLabelText("Recipient wallet");
    const amount = screen.getByLabelText("Amount (USDC)");
    expect(channel).toHaveProperty("disabled", true);
    expect(source).toHaveProperty("disabled", true);
    expect(recipient).toHaveProperty("disabled", true);
    expect(amount).toHaveProperty("disabled", true);

    fireEvent.change(channel, { target: { value: "channel_beta" } });
    fireEvent.change(source, { target: { value: "wallet_operations" } });
    fireEvent.change(recipient, { target: { value: "pcvw_alice_savings" } });
    fireEvent.change(amount, { target: { value: "9" } });

    expect(channel).toHaveProperty("value", "channel_alpha");
    expect(source).toHaveProperty("value", "wallet_sender");
    expect(recipient).toHaveProperty("value", "pcvw_alice");
    expect(amount).toHaveProperty("value", "1.25");
    expect(mocks.fetchTransferRecipientsAction).toHaveBeenCalledTimes(1);

    response.resolve({ ok: true, transfer: makeTransfer() });
    await screen.findByText("Progress: submitted");
    expect(screen.getByText("Submitted sender: Treasury (Send…1111)")).toBeTruthy();
    expect(screen.getByText("Submitted recipient: Alice Treasury (Alic…1111)")).toBeTruthy();
    expect(screen.getByText("Submitted amount: 1.25 USDC")).toBeTruthy();
    expect(mocks.createTransferAction).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "channel_alpha",
        walletId: "wallet_sender",
        recipientVerifiedWalletId: "pcvw_alice",
        amount: "1.25",
      })
    );
  });

  it("resets every financial and progress state when the server scope changes", async () => {
    const nextChannels: PrivateChannelMembershipChannelDto[] = [
      {
        id: "channel_gamma",
        name: "Gamma",
        isDefault: true,
      },
    ];
    const nextSourceWallets: CustodyWalletSummary[] = [
      {
        ...sourceWallets[0],
        id: "custody_gamma",
        walletId: "wallet_gamma",
        publicKey: "Gamma333333333333333333333333333333333333",
        label: "Gamma treasury",
      },
    ];
    const gammaRecipients: PrivateChannelTransferRecipientDto[] = [
      {
        id: "pcvw_carol",
        pubkey: "Carol33333333333333333333333333333333333",
        walletName: "Carol treasury",
        privateChannelUserId: "pcu_carol",
        isSelf: false,
      },
    ];
    mocks.fetchTransferRecipientsAction.mockImplementation(async (channelId: string) => ({
      ok: true,
      recipients: channelId === "channel_gamma" ? gammaRecipients : alphaRecipients,
    }));
    mocks.createTransferAction
      .mockResolvedValueOnce({ ok: true, transfer: makeTransfer() })
      .mockResolvedValueOnce({
        ok: true,
        transfer: makeTransfer({
          id: "pct_gamma",
          channelId: "channel_gamma",
          walletId: "wallet_gamma",
          sender: nextSourceWallets[0]?.publicKey ?? "",
          recipient: gammaRecipients[0]?.pubkey ?? "",
          amount: "2",
        }),
      });
    const user = userEvent.setup();
    const view = renderForm({
      channels,
      scopeKey: "org_one:project_one:instance_one",
      sourceWallets,
    });

    await screen.findByRole("option", { name: /Alic…1111/ });
    await user.selectOptions(screen.getByLabelText("Recipient wallet"), "pcvw_alice");
    await user.type(screen.getByLabelText("Amount (USDC)"), "1.25");
    await user.click(screen.getByRole("button", { name: "Transfer USDC" }));
    await screen.findByText("Progress: submitted");

    view.rerender(
      <TransferForm
        channels={nextChannels}
        scopeKey="org_two:project_two:instance_two"
        sourceWallets={nextSourceWallets}
        tokens={eligibleTokens}
      />
    );

    expect(screen.queryByText("Progress: submitted")).toBeNull();
    expect(screen.getByLabelText("Channel")).toHaveProperty("value", "channel_gamma");
    expect(screen.getByLabelText("From wallet")).toHaveProperty("value", "wallet_gamma");
    expect(screen.getByLabelText("Amount (USDC)")).toHaveProperty("value", "");
    await screen.findByRole("option", { name: /Caro…3333/ });
    expect(screen.getByLabelText("Recipient wallet")).toHaveProperty("value", "");

    await user.selectOptions(screen.getByLabelText("Recipient wallet"), "pcvw_carol");
    await user.type(screen.getByLabelText("Amount (USDC)"), "2");
    await user.click(screen.getByRole("button", { name: "Transfer USDC" }));

    expect(mocks.createTransferAction.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        channelId: "channel_alpha",
        walletId: "wallet_sender",
        recipientVerifiedWalletId: "pcvw_alice",
        amount: "1.25",
      })
    );
    expect(mocks.createTransferAction.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        channelId: "channel_gamma",
        walletId: "wallet_gamma",
        recipientVerifiedWalletId: "pcvw_carol",
        amount: "2",
      })
    );
  });
});
