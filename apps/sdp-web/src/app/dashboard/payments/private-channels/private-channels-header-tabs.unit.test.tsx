// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";

const navState = { pathname: "/dashboard/payments/private-channels/transfer" };
const push = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => navState.pathname,
  useRouter: () => ({ push }),
}));
const onValueChangeRef: { current: ((value: string) => void) | undefined } = {
  current: undefined,
};
vi.mock("@solana/design-system/tabs", () => ({
  Tabs: ({
    children,
    onValueChange,
  }: {
    children: ReactNode;
    onValueChange?: (value: string) => void;
  }) => {
    onValueChangeRef.current = onValueChange;
    return <div>{children}</div>;
  },
  TabList: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Tab: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
}));

import { PrivateChannelsHeaderTabs } from "./private-channels-header-tabs";

afterEach(() => {
  cleanup();
  push.mockReset();
  navState.pathname = "/dashboard/payments/private-channels/transfer";
  window.history.replaceState(null, "", "/");
});

function renderTabs(isConnected: boolean) {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <PrivateChannelsHeaderTabs isConnected={isConnected} />
    </I18nProvider>
  );
}

describe("PrivateChannelsHeaderTabs", () => {
  it("shows Members next to Overview and the transfer flow tabs for connected instances", () => {
    renderTabs(true);

    // Instance, Channels and Events have no tab — they're reached from Overview links.
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Overview",
      "Members",
      "Deposit",
      "Transfer",
      "Withdraw",
      "API Playground",
    ]);
  });

  it("keeps Overview and API Playground visible when no instance is connected", () => {
    renderTabs(false);

    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Overview",
      "API Playground",
    ]);
  });

  it("swaps Overview and API Playground shallowly on the overview route", () => {
    navState.pathname = "/dashboard/payments/private-channels/overview";
    renderTabs(false);

    act(() => onValueChangeRef.current?.("api-playground"));
    expect(window.location.search).toBe("?tab=playground");

    act(() => onValueChangeRef.current?.("overview"));
    expect(window.location.search).toBe("");

    // Both panes live on the Overview route — no segment navigation happens.
    expect(push).not.toHaveBeenCalled();
  });

  it("routes to the overview segment's playground tab from other sub-pages", () => {
    renderTabs(true);

    act(() => onValueChangeRef.current?.("api-playground"));
    expect(push).toHaveBeenCalledWith(
      "/dashboard/payments/private-channels/overview?tab=playground"
    );
  });
});
