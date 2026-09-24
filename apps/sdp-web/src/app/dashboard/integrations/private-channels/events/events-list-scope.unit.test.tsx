// @vitest-environment jsdom

/**
 * Regression for SOLA9-230 (APE-717): a mounted events feed must stay bound to
 * the project it rendered with. The follow-up server action receives the page's
 * project scope, and any response carrying another project's rows is dropped
 * instead of being appended to or replacing the feed.
 */

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

function feed(
  projectId: string,
  overrides: Partial<ComponentProps<typeof EventsList>> = {}
): ComponentProps<typeof EventsList> {
  return {
    projectId,
    initialEvents: [event(projectId, `event_${projectId}`)],
    initialHasMore: true,
    initialNextCursor: `cursor_from_${projectId}`,
    canViewRawPayload: true,
    ...overrides,
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

/** Every event renders twice — the stacked list and the table — so row assertions name the table. */
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
    // resetAllMocks, not clearAllMocks: a test that aborts early must not leak
    // its queued responses into the next test's action mock.
    vi.resetAllMocks();
  });

  it("binds follow-up pagination to the mounted project and drops a sibling-project page", async () => {
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

    // Security invariant first: the sibling-project page must never enter the
    // mounted feed, and the mounted project's own rows must survive.
    await waitFor(() => {
      expect(eventTable().queryByText(/999\.00 USDC/)).toBeNull();
    });
    expect(eventTable().getByText(/10\.00 USDC/)).toBeTruthy();

    await waitFor(() => {
      expect(mocks.loadProjectEventsAction).toHaveBeenCalledWith({
        projectId: "project_a",
        before: "cursor_from_project_a",
        limit: 50,
      });
    });

    // The dropped response must not hand its cursor to the feed either: the
    // retry still paginates from the mounted project's cursor.
    await user.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => {
      expect(mocks.loadProjectEventsAction).toHaveBeenNthCalledWith(2, {
        projectId: "project_a",
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

    // Security invariant first: the sibling-project page must never replace the
    // mounted feed.
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

    // The scope change remounts the feed's data: the other project's initial
    // rows take over, the stale rows and filter do not survive.
    expect(eventTable().getByText(/999\.00 USDC/)).toBeTruthy();
    expect(eventTable().queryByText(/10\.00 USDC/)).toBeNull();
    expect(
      (screen.getByRole("combobox", { name: "Event category" }) as HTMLSelectElement).value
    ).toBe("all");

    await user.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => {
      expect(mocks.loadProjectEventsAction).toHaveBeenCalledWith({
        projectId: "project_b",
        before: "cursor_from_project_b",
        limit: 50,
      });
    });
  });

  it.each(["failure", "out-of-scope response"])(
    "does not revert the new project's filter after a stale %s",
    async (outcome) => {
      const user = userEvent.setup();
      // Project A: transfer filter loads, then the user reverts to "all"; that
      // request is still in flight when the page switches to project B.
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

      // B's filter stays on the "all" it reset to, and its unfiltered rows and
      // cursor are intact for the next pagination request.
      expect((filter as HTMLSelectElement).value).toBe("all");
      expect(eventTable().getByText(/999\.00 USDC/)).toBeTruthy();
      await user.click(screen.getByRole("button", { name: "Load more" }));
      expect(mocks.loadProjectEventsAction).toHaveBeenLastCalledWith({
        projectId: "project_b",
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

      // The stale response dropped whole (no feed rewrite), so the details the
      // user opened stay open until they close them.
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
