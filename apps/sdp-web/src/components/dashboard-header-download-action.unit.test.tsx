// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { DashboardHeaderAction, type DashboardHeaderActionConfig } from "./dashboard-header";

const toastMock = vi.hoisted(() => ({ error: vi.fn() }));

vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("next/navigation", () => import("@/test/next-navigation"));

const exportAction: DashboardHeaderActionConfig = {
  label: "Download CSV",
  href: "/api/dashboard/payments/transactions/export",
  icon: "download",
  variant: "outline",
  withCurrentQuery: true,
  download: true,
};

function renderAction() {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <DashboardHeaderAction action={exportAction} search="status=succeeded" />
    </I18nProvider>
  );
}

describe("DashboardHeaderAction downloads", () => {
  beforeEach(() => {
    // jsdom has no object URLs.
    URL.createObjectURL = vi.fn(() => "blob:csv");
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    toastMock.error.mockReset();
  });

  it("tells the user when the export runs into the rate limit", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ error: { code: "RATE_LIMITED" } }, { status: 429 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const view = renderAction();

    fireEvent.click(view.getByRole("button", { name: "Download CSV" }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        "Too many requests to finish the download. Wait a minute and try again."
      )
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/dashboard/payments/transactions/export?status=succeeded",
      expect.objectContaining({ method: "GET" })
    );
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("tells the user when the export fails any other way", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      })
    );
    const view = renderAction();

    fireEvent.click(view.getByRole("button", { name: "Download CSV" }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("The download didn't finish. Try again.")
    );
  });

  it("saves the CSV under the name the export gives it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("id\ntxn_1\n", {
            headers: {
              "Content-Type": "text/csv; charset=utf-8",
              "Content-Disposition": 'attachment; filename="sdp-transactions-2026-10-05.csv"',
            },
          })
      )
    );
    const clicked: { href: string; download: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement
    ) {
      clicked.push({ href: this.href, download: this.download });
    });
    const view = renderAction();

    fireEvent.click(view.getByRole("button", { name: "Download CSV" }));

    await waitFor(() =>
      expect(clicked).toEqual([{ href: "blob:csv", download: "sdp-transactions-2026-10-05.csv" }])
    );
    expect(toastMock.error).not.toHaveBeenCalled();
  });
});
