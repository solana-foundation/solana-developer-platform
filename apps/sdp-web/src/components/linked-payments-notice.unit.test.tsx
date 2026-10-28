// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { LinkedPaymentsNotice, type LinkedPaymentsState } from "./linked-payments-notice";

function renderNotice(state: LinkedPaymentsState) {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <LinkedPaymentsNotice subject="member" state={state} />
    </I18nProvider>
  );
}

function project(projectId: string, activeRecurringPayments: number, openPaymentRequests: number) {
  return {
    projectId,
    projectName: `Project ${projectId}`,
    activeRecurringPayments,
    openPaymentRequests,
  };
}

afterEach(() => {
  cleanup();
});

describe("LinkedPaymentsNotice", () => {
  it("links each nonzero count to its project's list, narrowed to the principal", () => {
    renderNotice({
      status: "loaded",
      filter: { kind: "member", userId: "user_test_1" },
      projects: [
        project("prj_test_a", 2, 0),
        project("prj_test_b", 0, 3),
        project("prj_test_c", 0, 0),
      ],
    });

    expect(
      screen.getByText(
        "SDP keeps running these after the member is removed. Cancel any that should stop."
      )
    ).toBeTruthy();
    expect(
      screen.getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")])
    ).toEqual([
      [
        "Active recurring payments: 2",
        "/dashboard/prj_test_a/payments/recurring?status=active&activatedByUserId=user_test_1",
      ],
      [
        "Open payment requests: 3",
        "/dashboard/prj_test_b/payments/requests?status=awaiting_payment&createdByUserId=user_test_1",
      ],
    ]);
    expect(screen.getByText("Project prj_test_a")).toBeTruthy();
    expect(screen.getByText("Project prj_test_b")).toBeTruthy();
    expect(screen.queryByText("Project prj_test_c")).toBeNull();
  });

  it("says nothing keeps running when every count is zero", () => {
    renderNotice({
      status: "loaded",
      filter: { kind: "member", userId: "user_test_1" },
      projects: [project("prj_test_a", 0, 0)],
    });

    expect(screen.getByText("Nothing it set up is still running.")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("alerts with the reason a read failed", () => {
    renderNotice({ status: "error", message: "upstream unavailable" });

    expect(screen.getByRole("alert").textContent).toBe(
      "Couldn't check what it set up: upstream unavailable"
    );
  });
});
