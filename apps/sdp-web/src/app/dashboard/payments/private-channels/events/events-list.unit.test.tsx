// @vitest-environment jsdom

import {
  PRIVATE_CHANNEL_EVENT_FAMILIES,
  PRIVATE_CHANNEL_EVENT_STATUSES,
  PRIVATE_CHANNEL_EVENT_TYPES,
  type PrivateChannelEventDto,
  WELL_KNOWN_TOKENS,
} from "@sdp/types";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadProjectEventsAction: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("./actions", () => ({
  loadProjectEventsAction: mocks.loadProjectEventsAction,
}));
vi.mock("sonner", () => ({
  toast: { error: mocks.toastError },
}));
vi.mock("@/lib/use-solana-cluster", () => ({
  useSolanaCluster: () => "devnet",
}));
vi.mock("@/components/ui/button", () => ({
  Button: (props: ComponentProps<"button">) => <button {...props} />,
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
      onChange={(event) => onValueChange?.(event.target.value)}
      value={value ?? ""}
    >
      {children}
    </select>
  ),
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) => (
    <option value={value}>{children}</option>
  ),
}));

import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { shortenAddress } from "../../payments-overview.utils";
import { EventsList } from "./events-list";

const SENDER = "Sender1111111111111111111111111111111111";
const RECIPIENT = "Recipient11111111111111111111111111111111";
const USDC_MINT = WELL_KNOWN_TOKENS.USDC.mints.devnet.address;
const SIGNATURE = "Signature111111111111111111111111111111111111111111111111";

function makeEvent(overrides: Partial<PrivateChannelEventDto> = {}): PrivateChannelEventDto {
  return {
    id: "pce_lifecycle",
    organizationId: "org_test",
    projectId: "project_test",
    instanceId: "pci_test",
    channelId: "channel_test",
    sdpUserId: null,
    family: PRIVATE_CHANNEL_EVENT_FAMILIES.LIFECYCLE,
    type: PRIVATE_CHANNEL_EVENT_TYPES.LIFECYCLE_CHANNEL_CREATED,
    status: PRIVATE_CHANNEL_EVENT_STATUSES.INFO,
    payload: { channelId: "channel_test", name: "Treasury" },
    occurredAt: "2026-07-30T12:00:00.000Z",
    createdAt: "2026-07-30T12:00:00.000Z",
    ...overrides,
  };
}

function makeTransferEvent(
  id: string,
  overrides: Partial<PrivateChannelEventDto> = {}
): PrivateChannelEventDto {
  return makeEvent({
    id,
    family: PRIVATE_CHANNEL_EVENT_FAMILIES.TRANSFER,
    type: PRIVATE_CHANNEL_EVENT_TYPES.TRANSFER_TRANSFER_CONFIRMED,
    status: PRIVATE_CHANNEL_EVENT_STATUSES.CONFIRMED,
    payload: {
      transferId: `pct_${id}`,
      amount: "12.50",
      mint: USDC_MINT,
      sender: SENDER,
      recipient: RECIPIENT,
      signature: SIGNATURE,
    },
    ...overrides,
  });
}

function renderEvents(
  props: Partial<ComponentProps<typeof EventsList>> & {
    initialEvents?: PrivateChannelEventDto[];
  } = {},
  locale: "en" | "fr" = "en"
) {
  return render(
    <I18nProvider locale={locale} messages={getMessages(locale)}>
      <EventsList
        initialEvents={props.initialEvents ?? [makeEvent()]}
        initialHasMore={props.initialHasMore ?? false}
        initialNextCursor={props.initialNextCursor ?? null}
        canViewRawPayload={props.canViewRawPayload ?? false}
        names={props.names}
      />
    </I18nProvider>
  );
}

/**
 * Every event renders twice — a stacked list below `lg`, a table from `lg` up — and
 * jsdom applies no CSS, so row assertions have to name the layout they mean.
 */
function eventTable() {
  return within(screen.getByRole("table"));
}

function eventStack() {
  return within(screen.getByRole("list"));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("EventsList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders a readable transfer summary with shortened row addresses", () => {
    renderEvents({ initialEvents: [makeTransferEvent("pce_transfer")] });

    expect(
      eventTable().getByText(
        `12.50 USDC from ${shortenAddress(SENDER)} to ${shortenAddress(RECIPIENT)}`
      )
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain('{"transferId"');
    expect(document.body.textContent).not.toContain("[object Object]");
  });

  it("renders wallet and channel names when a names map is provided", () => {
    renderEvents({
      initialEvents: [
        makeTransferEvent("pce_transfer", {
          channelId: "pch_treasury",
        }),
      ],
      names: {
        [SENDER]: "Treasury Wallet",
        [RECIPIENT]: "Payroll Wallet",
        pch_treasury: "Treasury",
      },
    });

    expect(
      eventTable().getByText("12.50 USDC from Treasury Wallet to Payroll Wallet")
    ).toBeTruthy();
    expect(eventTable().getByText("Treasury")).toBeTruthy();
    expect(
      eventStack().getByText("12.50 USDC from Treasury Wallet to Payroll Wallet")
    ).toBeTruthy();
    expect(eventStack().getByText("Treasury")).toBeTruthy();
  });

  it("falls back to shortened addresses when the names map has no match", () => {
    renderEvents({
      initialEvents: [makeTransferEvent("pce_transfer")],
      names: {},
    });

    expect(
      eventTable().getByText(
        `12.50 USDC from ${shortenAddress(SENDER)} to ${shortenAddress(RECIPIENT)}`
      )
    ).toBeTruthy();
  });

  it("opens the detail modal from a stacked row, without a details column to reach", async () => {
    const user = userEvent.setup();
    renderEvents({ initialEvents: [makeTransferEvent("pce_transfer")] });

    const stackedRow = eventStack().getByRole("button");
    expect(stackedRow.textContent).toContain("Member transfer confirmed");
    expect(stackedRow.textContent).toContain("Confirmed");
    expect(eventStack().queryByText("View details")).toBeNull();

    await user.click(stackedRow);

    expect(
      await screen.findByRole("dialog", { name: "Member transfer confirmed event details" })
    ).toBeTruthy();
  });

  it("shows a name row above each reference in the detail modal", async () => {
    const user = userEvent.setup();
    renderEvents({
      initialEvents: [
        makeTransferEvent("pce_transfer", {
          channelId: "pch_treasury",
          instanceId: "pci_production",
        }),
      ],
      names: {
        [SENDER]: "Treasury Wallet",
        [RECIPIENT]: "Payroll Wallet",
        pch_treasury: "Treasury",
        pci_production: "https://gateway.example",
      },
    });

    await user.click(screen.getByRole("button", { name: /View details/i }));

    const rows = Array.from(document.querySelectorAll("dl dt")).map((term) => [
      term.textContent,
      term.nextElementSibling?.textContent,
    ]);

    expect(rows).toEqual(
      expect.arrayContaining([
        ["Token", "USDC"],
        ["Mint", USDC_MINT],
        ["Sender wallet", "Treasury Wallet"],
        ["Sender", SENDER],
        ["Recipient wallet", "Payroll Wallet"],
        ["Recipient", RECIPIENT],
        ["Channel", "Treasury"],
        ["Channel ID", "pch_treasury"],
        ["Gateway", "https://gateway.example"],
        ["Instance ID", "pci_production"],
      ])
    );

    // Each name sits directly above the reference it names.
    const labels = rows.map(([label]) => label);
    expect(labels.indexOf("Channel")).toBe(labels.indexOf("Channel ID") - 1);
    expect(labels.indexOf("Gateway")).toBe(labels.indexOf("Instance ID") - 1);
  });

  it("omits the token row when the mint has no known symbol", async () => {
    const user = userEvent.setup();
    const unknownMint = "UnknownMint111111111111111111111111111111";
    renderEvents({
      initialEvents: [
        makeTransferEvent("pce_transfer", {
          payload: { transferId: "pct_unknown", amount: "1.00", mint: unknownMint },
        }),
      ],
    });

    await user.click(screen.getByRole("button", { name: /View details/i }));

    expect(screen.queryByText("Token")).toBeNull();
    expect(screen.getByText(unknownMint)).toBeTruthy();
  });

  it("formats row amounts for the English locale without losing precision", () => {
    renderEvents({
      initialEvents: [
        makeTransferEvent("pce_transfer", {
          payload: {
            amount: "12345678901234567890.50",
            mint: USDC_MINT,
            sender: SENDER,
            recipient: RECIPIENT,
          },
        }),
      ],
    });

    expect(
      eventTable().getByText(
        `12,345,678,901,234,567,890.50 USDC from ${shortenAddress(SENDER)} to ${shortenAddress(RECIPIENT)}`
      )
    ).toBeTruthy();
  });

  it("formats row amounts for the French locale without losing precision", () => {
    renderEvents(
      {
        initialEvents: [
          makeTransferEvent("pce_transfer", {
            payload: {
              amount: "12345678901234567890.50",
              mint: USDC_MINT,
              sender: SENDER,
              recipient: RECIPIENT,
            },
          }),
        ],
      },
      "fr"
    );

    // FR private-channels catalog is release-bot owned; product branches fall back to EN copy.
    const summary = [...screen.getByRole("table").querySelectorAll("span")].find((element) =>
      element.textContent?.includes("USDC from")
    );
    expect(summary?.textContent).toBe(
      `12 345 678 901 234 567 890,50 USDC from ${shortenAddress(SENDER)} to ${shortenAddress(RECIPIENT)}`
    );
  });

  it("hides the family filter from non-admins", () => {
    renderEvents({ canViewRawPayload: false });

    expect(screen.queryByRole("combobox", { name: "Event category" })).toBeNull();
  });

  it("replaces events for a family filter and preserves that family while paginating", async () => {
    const user = userEvent.setup();
    const firstTransfer = makeTransferEvent("pce_transfer_1");
    const secondTransfer = makeTransferEvent("pce_transfer_2", {
      payload: {
        transferId: "pct_transfer_2",
        amount: "4.00",
        mint: USDC_MINT,
        sender: RECIPIENT,
        recipient: SENDER,
      },
    });
    mocks.loadProjectEventsAction
      .mockResolvedValueOnce({
        ok: true,
        data: { events: [firstTransfer], hasMore: true, nextCursor: "cursor_transfer" },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: { events: [secondTransfer], hasMore: false, nextCursor: null },
      });

    renderEvents({ canViewRawPayload: true });

    const familyFilter = screen.getByRole("combobox", { name: "Event category" });
    await user.selectOptions(familyFilter, PRIVATE_CHANNEL_EVENT_FAMILIES.TRANSFER);

    await waitFor(() => {
      expect(mocks.loadProjectEventsAction).toHaveBeenNthCalledWith(1, {
        family: PRIVATE_CHANNEL_EVENT_FAMILIES.TRANSFER,
        limit: 50,
      });
    });
    expect(screen.queryByText("Channel created")).toBeNull();
    expect(eventTable().getByText("Member transfer confirmed")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Load more" }));

    await waitFor(() => {
      expect(mocks.loadProjectEventsAction).toHaveBeenNthCalledWith(2, {
        before: "cursor_transfer",
        family: PRIVATE_CHANNEL_EVENT_FAMILIES.TRANSFER,
        limit: 50,
      });
    });
    expect(
      eventTable().getByText(
        `4.00 USDC from ${shortenAddress(RECIPIENT)} to ${shortenAddress(SENDER)}`
      )
    ).toBeTruthy();
    expect(
      eventTable().getByText(
        `12.50 USDC from ${shortenAddress(SENDER)} to ${shortenAddress(RECIPIENT)}`
      )
    ).toBeTruthy();
  });

  it("locks pagination and filtering while a page request is pending", async () => {
    const user = userEvent.setup();
    const request = deferred<{
      ok: true;
      data: {
        events: PrivateChannelEventDto[];
        hasMore: boolean;
        nextCursor: string | null;
      };
    }>();
    mocks.loadProjectEventsAction.mockReturnValueOnce(request.promise);

    renderEvents({
      initialHasMore: true,
      initialNextCursor: "cursor_1",
      canViewRawPayload: true,
    });
    const loadMore = screen.getByRole("button", { name: "Load more" });
    const familyFilter = screen.getByRole("combobox", { name: "Event category" });

    await user.click(loadMore);
    await waitFor(() => {
      expect((loadMore as HTMLButtonElement).disabled).toBe(true);
      expect((familyFilter as HTMLSelectElement).disabled).toBe(true);
    });
    await user.click(loadMore);
    expect(mocks.loadProjectEventsAction).toHaveBeenCalledTimes(1);

    request.resolve({
      ok: true,
      data: { events: [], hasMore: true, nextCursor: "cursor_2" },
    });
    await waitFor(() => {
      expect((loadMore as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it("keeps the current feed and reports a translated filter error", async () => {
    const user = userEvent.setup();
    mocks.loadProjectEventsAction.mockResolvedValueOnce({
      ok: false,
      message: "Internal API detail",
    });

    renderEvents({ canViewRawPayload: true });
    const familyFilter = screen.getByRole("combobox", { name: "Event category" });
    await user.selectOptions(familyFilter, PRIVATE_CHANNEL_EVENT_FAMILIES.ERROR);

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith("Events could not be loaded. Try again.");
    });
    expect(eventTable().getByText("Channel created")).toBeTruthy();
    expect((familyFilter as HTMLSelectElement).value).toBe("all");
  });

  it("uses the event DTO instance id when the payload omits it", async () => {
    const user = userEvent.setup();
    renderEvents({
      initialEvents: [
        makeEvent({
          instanceId: "pci_production",
          channelId: null,
          type: PRIVATE_CHANNEL_EVENT_TYPES.LIFECYCLE_INSTANCE_CONNECTED,
          payload: { gatewayUrl: "https://gateway.example" },
        }),
      ],
    });

    await user.click(screen.getByRole("button", { name: "View details for Instance connected" }));

    expect(
      await screen.findByRole("dialog", { name: "Instance connected event details" })
    ).toBeTruthy();
    expect(screen.getByText("pci_production")).toBeTruthy();
  });

  it.each([
    {
      name: "private member transfer",
      event: makeTransferEvent("pce_transfer", {
        type: PRIVATE_CHANNEL_EVENT_TYPES.TRANSFER_TRANSFER_SUBMITTED,
        status: PRIVATE_CHANNEL_EVENT_STATUSES.PENDING,
      }),
      buttonName: "View details for Member transfer submitted",
    },
    {
      name: "withdrawal burn",
      event: makeEvent({
        type: PRIVATE_CHANNEL_EVENT_TYPES.TRANSFER_WITHDRAWAL_SUBMITTED,
        family: PRIVATE_CHANNEL_EVENT_FAMILIES.TRANSFER,
        status: PRIVATE_CHANNEL_EVENT_STATUSES.PENDING,
        payload: {
          withdrawalId: "pcw_submitted",
          amount: "5.00",
          mint: USDC_MINT,
          sender: SENDER,
          recipient: RECIPIENT,
          signature: SIGNATURE,
        },
      }),
      buttonName: "View details for Withdrawal submitted",
    },
  ])(
    "keeps the full $name signature without a public explorer link",
    async ({ event, buttonName }) => {
      const user = userEvent.setup();
      renderEvents({ initialEvents: [event] });

      await user.click(screen.getByRole("button", { name: buttonName }));

      expect(await screen.findByRole("dialog")).toBeTruthy();
      expect(screen.getByText(SIGNATURE)).toBeTruthy();
      expect(
        screen.queryByRole("link", { name: "View transaction on Solana Explorer" })
      ).toBeNull();
    }
  );

  it.each([
    {
      name: "deposit",
      event: makeEvent({
        type: PRIVATE_CHANNEL_EVENT_TYPES.TRANSFER_DEPOSIT_CONFIRMED,
        family: PRIVATE_CHANNEL_EVENT_FAMILIES.TRANSFER,
        status: PRIVATE_CHANNEL_EVENT_STATUSES.CONFIRMED,
        payload: {
          depositId: "pcd_confirmed",
          amount: "5.00",
          mint: USDC_MINT,
          recipient: RECIPIENT,
          signature: SIGNATURE,
        },
      }),
      buttonName: "View details for Deposit confirmed",
    },
    {
      name: "settled withdrawal",
      event: makeEvent({
        type: PRIVATE_CHANNEL_EVENT_TYPES.TRANSFER_WITHDRAWAL_SETTLED,
        family: PRIVATE_CHANNEL_EVENT_FAMILIES.TRANSFER,
        status: PRIVATE_CHANNEL_EVENT_STATUSES.CONFIRMED,
        payload: {
          withdrawalId: "pcw_settled",
          amount: "5.00",
          mint: USDC_MINT,
          sender: SENDER,
          recipient: RECIPIENT,
          signature: SIGNATURE,
        },
      }),
      buttonName: "View details for Withdrawal settled",
    },
  ])("links the public $name signature to Solana Explorer", async ({ event, buttonName }) => {
    const user = userEvent.setup();
    renderEvents({ initialEvents: [event] });

    await user.click(screen.getByRole("button", { name: buttonName }));

    const explorerLink = await screen.findByRole("link", {
      name: "View transaction on Solana Explorer",
    });
    expect(explorerLink.getAttribute("href")).toBe(
      `https://explorer.solana.com/tx/${SIGNATURE}?cluster=devnet`
    );
  });

  it("shows raw payload only to admins", async () => {
    const user = userEvent.setup();
    const event = makeEvent({
      payload: {
        channelId: "channel_test",
        name: "Treasury",
        adminOnly: "secret-value",
      },
    });

    const memberView = renderEvents({ initialEvents: [event], canViewRawPayload: false });
    await user.click(screen.getByRole("button", { name: "View details for Channel created" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.queryByText("Raw payload")).toBeNull();
    expect(document.body.textContent).not.toContain("secret-value");
    memberView.unmount();

    renderEvents({ initialEvents: [event], canViewRawPayload: true });
    await user.click(screen.getByRole("button", { name: "View details for Channel created" }));
    expect(await screen.findByText("Raw payload")).toBeTruthy();
    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName === "PRE" && Boolean(element.textContent?.includes('"secret-value"'))
      )
    ).toBeTruthy();
  });

  it("degrades malformed payloads without rendering object coercions", () => {
    renderEvents({
      initialEvents: [
        makeTransferEvent("pce_malformed", {
          payload: {
            amount: { nested: "1.00" },
            sender: ["bad"],
            recipient: null,
            unknown: { nested: true },
          },
        }),
      ],
    });

    expect(eventTable().getByText("No additional details")).toBeTruthy();
    expect(document.body.textContent).not.toContain("[object Object]");
  });
});
