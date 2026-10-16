// @vitest-environment jsdom

import {
  PRIVATE_CHANNEL_EVENT_FAMILIES,
  PRIVATE_CHANNEL_EVENT_STATUSES,
  PRIVATE_CHANNEL_EVENT_TYPES,
  type PrivateChannelEventDto,
  WELL_KNOWN_TOKENS,
} from "@sdp/types";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps, ReactElement, ReactNode } from "react";
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
import type { LoadEventsResult } from "./actions";
import { EventsList } from "./events-list";

const MINT = WELL_KNOWN_TOKENS.USDC.mints.devnet.address;

function event(projectId: string, id: string): PrivateChannelEventDto {
  return {
    id,
    organizationId: "org_shared",
    projectId,
    instanceId: `${projectId}_instance`,
    channelId: `${projectId}_channel`,
    sdpUserId: null,
    family: PRIVATE_CHANNEL_EVENT_FAMILIES.TRANSFER,
    type: PRIVATE_CHANNEL_EVENT_TYPES.TRANSFER_TRANSFER_CONFIRMED,
    status: PRIVATE_CHANNEL_EVENT_STATUSES.CONFIRMED,
    payload: {
      transferId: `${projectId}_transfer`,
      amount: projectId === "project_a" ? "10.00" : "999.00",
      mint: MINT,
    },
    occurredAt: "2026-09-24T00:00:00.000Z",
    createdAt: "2026-09-24T00:00:00.000Z",
  };
}

function feed(projectId: string): ComponentProps<typeof EventsList> {
  return {
    projectId,
    initialEvents: [event(projectId, `event_${projectId}`)],
    initialHasMore: true,
    initialNextCursor: `cursor_from_${projectId}`,
    canViewRawPayload: true,
  };
}

function renderFeed(props: ComponentProps<typeof EventsList>) {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <EventsList {...props} />
    </I18nProvider>
  );
}

function rerenderFeed(
  rerender: (ui: ReactElement) => void,
  props: ComponentProps<typeof EventsList>
) {
  rerender(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <EventsList {...props} />
    </I18nProvider>
  );
}

function eventTable() {
  return within(screen.getByRole("table"));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

afterEach(() => cleanup());

describe("stale project events feed (SOLA9-230)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("drops a sibling-project page and keeps paginating from the mounted cursor", async () => {
    const user = userEvent.setup();
    mocks.loadProjectEventsAction
      .mockResolvedValueOnce({
        ok: true,
        data: {
          events: [event("project_b", "event_b")],
          hasMore: true,
          nextCursor: "cursor_from_project_b",
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: { events: [], hasMore: false, nextCursor: null },
      });

    renderFeed(feed("project_a"));

    await user.click(screen.getByRole("button", { name: "Load more" }));

    await waitFor(() => {
      expect(eventTable().queryByText(/999\.00 USDC/)).toBeNull();
    });
    expect(eventTable().getByText(/10\.00 USDC/)).toBeTruthy();

    await waitFor(() => {
      expect(mocks.loadProjectEventsAction).toHaveBeenCalledWith({
        before: "cursor_from_project_a",
        limit: 50,
      });
    });

    await user.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => {
      expect(mocks.loadProjectEventsAction).toHaveBeenNthCalledWith(2, {
        before: "cursor_from_project_a",
        limit: 50,
      });
    });
  });

  it("keeps the mounted project's feed when a family-filter response is for another project", async () => {
    const user = userEvent.setup();
    mocks.loadProjectEventsAction.mockResolvedValueOnce({
      ok: true,
      data: {
        events: [event("project_b", "event_b")],
        hasMore: false,
        nextCursor: null,
      },
    });

    renderFeed(feed("project_a"));

    const familyFilter = screen.getByRole("combobox", { name: "Event category" });
    await user.selectOptions(familyFilter, PRIVATE_CHANNEL_EVENT_FAMILIES.LIFECYCLE);

    await waitFor(() => {
      expect(eventTable().queryByText(/999\.00 USDC/)).toBeNull();
    });
    expect(eventTable().getByText(/10\.00 USDC/)).toBeTruthy();
    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith("Events could not be loaded. Try again.");
    });
    expect((familyFilter as HTMLSelectElement).value).toBe("all");
  });

  it("resets rows, cursor, and filter when the page scope changes", async () => {
    const user = userEvent.setup();
    mocks.loadProjectEventsAction.mockResolvedValue({
      ok: true,
      data: { events: [], hasMore: false, nextCursor: null },
    });

    const { rerender } = renderFeed(feed("project_a"));

    const familyFilter = screen.getByRole("combobox", { name: "Event category" });
    await user.selectOptions(familyFilter, PRIVATE_CHANNEL_EVENT_FAMILIES.TRANSFER);
    await waitFor(() => {
      expect((familyFilter as HTMLSelectElement).value).toBe(
        PRIVATE_CHANNEL_EVENT_FAMILIES.TRANSFER
      );
    });

    rerenderFeed(rerender, feed("project_b"));

    expect(eventTable().getByText(/999\.00 USDC/)).toBeTruthy();
    expect(eventTable().queryByText(/10\.00 USDC/)).toBeNull();
    expect(
      (screen.getByRole("combobox", { name: "Event category" }) as HTMLSelectElement).value
    ).toBe("all");

    await user.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => {
      expect(mocks.loadProjectEventsAction).toHaveBeenCalledWith({
        before: "cursor_from_project_b",
        limit: 50,
      });
    });
  });

  it.each(["failure", "out-of-scope response"])(
    "does not revert the new project's filter after a stale %s",
    async (outcome) => {
      const user = userEvent.setup();
      const staleA = deferred<LoadEventsResult>();
      mocks.loadProjectEventsAction
        .mockResolvedValueOnce({
          ok: true,
          data: {
            events: [event("project_a", "filtered_a")],
            hasMore: true,
            nextCursor: "filtered_cursor_a",
          },
        })
        .mockReturnValueOnce(staleA.promise)
        .mockResolvedValueOnce({
          ok: true,
          data: { events: [], hasMore: false, nextCursor: null },
        });
      const { rerender } = renderFeed(feed("project_a"));
      const filter = screen.getByRole("combobox", { name: "Event category" });
      await user.selectOptions(filter, PRIVATE_CHANNEL_EVENT_FAMILIES.TRANSFER);
      await user.selectOptions(filter, "all");
      expect(mocks.loadProjectEventsAction).toHaveBeenCalledTimes(2);

      rerenderFeed(rerender, feed("project_b"));
      await act(async () => {
        staleA.resolve(
          outcome === "failure"
            ? { ok: false, message: "Unavailable" }
            : {
                ok: true,
                data: {
                  events: [event("project_b", "wrong_scope")],
                  hasMore: false,
                  nextCursor: null,
                },
              }
        );
        await staleA.promise;
      });

      expect((filter as HTMLSelectElement).value).toBe("all");
      expect(eventTable().getByText(/999\.00 USDC/)).toBeTruthy();
      await user.click(screen.getByRole("button", { name: "Load more" }));
      expect(mocks.loadProjectEventsAction).toHaveBeenLastCalledWith({
        before: "cursor_from_project_b",
        limit: 50,
      });
    }
  );

  it.each(["project_b", "project_a"])(
    "preserves %s's event details when an earlier scope's filter response completes",
    async (currentProject) => {
      const user = userEvent.setup();
      const staleA = deferred<LoadEventsResult>();
      mocks.loadProjectEventsAction.mockReturnValueOnce(staleA.promise);
      const { rerender } = renderFeed(feed("project_a"));
      await user.selectOptions(
        screen.getByRole("combobox", { name: "Event category" }),
        PRIVATE_CHANNEL_EVENT_FAMILIES.TRANSFER
      );
      expect(mocks.loadProjectEventsAction).toHaveBeenCalledTimes(1);

      rerenderFeed(rerender, feed("project_b"));
      if (currentProject === "project_a") {
        rerenderFeed(rerender, feed("project_a"));
      }
      await user.click(eventTable().getByRole("button", { name: /View details/i }));
      expect(screen.getByRole("dialog")).toBeTruthy();

      await act(async () => {
        staleA.resolve({
          ok: true,
          data: { events: [], hasMore: false, nextCursor: null },
        });
        await staleA.promise;
      });

      const dialog = screen.getByRole("dialog");
      expect(within(dialog).getByText(`${currentProject}_channel`)).toBeTruthy();
      await user.keyboard("{Escape}");
      expect(
        eventTable().getByText(currentProject === "project_a" ? /10\.00 USDC/ : /999\.00 USDC/)
      ).toBeTruthy();
      expect(screen.getByRole("button", { name: "Load more" })).toBeTruthy();
    }
  );
});
