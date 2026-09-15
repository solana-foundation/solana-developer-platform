// @vitest-environment jsdom

import type { WalletApprovalRequestSummary } from "@sdp/types";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Toaster, toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { ApprovalRequestDetail } from "./approval-request-detail";

const pendingRequest: WalletApprovalRequestSummary = {
  id: "apr_1",
  organizationId: "org_1",
  projectId: "prj_1",
  walletOperationId: "wop_1",
  approvalGroupId: null,
  status: "pending",
  provider: null,
  providerReference: null,
  requestedBy: "usr_requester",
  resolvedBy: null,
  expiresAt: null,
  resolvedAt: null,
  createdAt: "2026-09-11T00:00:00.000Z",
  updatedAt: "2026-09-11T00:00:00.000Z",
  wallet: null,
  operation: {
    id: "wop_1",
    custodyWalletId: "cwlt_1",
    walletId: "wallet_1",
    apiKeyId: null,
    source: "api",
    operationFamily: "payment",
    operationType: "payment_transfer_execute",
    asset: null,
    amount: "10",
    destination: null,
    status: "pending_approval",
    executionStartedAt: null,
    executionCompletedAt: null,
    executionError: null,
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z",
  },
  policyEvaluation: null,
  viewerIsRequester: false,
};

const REVIEW_DESCRIPTION =
  "Confirm the policy context and operation details before making a decision.";

function approvedRequest(
  operation: Partial<WalletApprovalRequestSummary["operation"]>
): WalletApprovalRequestSummary {
  return {
    ...pendingRequest,
    status: "approved",
    resolvedBy: "usr_approver",
    resolvedAt: "2026-09-11T10:00:00.000Z",
    operation: { ...pendingRequest.operation, ...operation },
  };
}

afterEach(() => {
  act(() => toast.dismiss());
  cleanup();
  vi.unstubAllGlobals();
});

describe("ApprovalRequestDetail", () => {
  it.each([
    {
      status: 403,
      reason: "runtime_execution_paused",
      message:
        "Wallet execution is paused. This request is still pending. Approve it again when execution is available.",
    },
    {
      status: 409,
      reason: "runtime_execution_unavailable",
      message:
        "The wallet is unavailable. This request is still pending. Check the wallet before approving again.",
    },
    {
      status: 403,
      reason: "provider_not_entitled",
      message:
        "Your organization does not have access to this wallet provider. This request is still pending. Approve it again after access is restored.",
    },
  ])(
    "keeps the same request available for approval after $reason",
    async ({ status, reason, message }) => {
      const fetchResponse = vi.fn<typeof fetch>();
      fetchResponse.mockResolvedValueOnce(
        Response.json({ error: { message: "Runtime refusal", details: { reason } } }, { status })
      );
      vi.stubGlobal("fetch", fetchResponse);
      const user = userEvent.setup();
      render(
        <I18nProvider locale="en" messages={getMessages("en")}>
          <ApprovalRequestDetail
            initialRequest={pendingRequest}
            evaluation={null}
            apiKeyNames={{}}
            canDecide
          />
          <Toaster theme="light" />
        </I18nProvider>
      );

      await user.click(screen.getByRole("button", { name: "Approve" }));
      await user.click(screen.getByRole("button", { name: "Approve request" }));

      expect(await screen.findByText(message)).toBeTruthy();
      expect(screen.getAllByText("Pending").length).toBeGreaterThan(0);
      expect(
        screen.queryByText("Your role does not have permission to decide approval requests.")
      ).toBeNull();
      expect(
        screen.queryByText("This request was already decided. The latest status is now shown.")
      ).toBeNull();
      expect(fetchResponse).toHaveBeenCalledTimes(1);

      fetchResponse.mockResolvedValueOnce(
        Response.json({
          data: {
            approvalRequest: {
              ...pendingRequest,
              status: "approved",
              operation: { ...pendingRequest.operation, status: "completed" },
            },
          },
        })
      );
      await user.click(screen.getByRole("button", { name: "Approve" }));
      await user.click(screen.getByRole("button", { name: "Approve request" }));

      expect(await screen.findByText("Request approved")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
      expect(fetchResponse.mock.calls).toEqual([
        ["/api/dashboard/approval-requests/apr_1/approve", { method: "POST" }],
        ["/api/dashboard/approval-requests/apr_1/approve", { method: "POST" }],
      ]);
    }
  );

  // The API refuses a decision from whoever raised the request, so offering
  // Approve or Reject to them only offers a 403.
  it("offers the requester Cancel only, and says someone else decides", () => {
    render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <ApprovalRequestDetail
          initialRequest={{ ...pendingRequest, viewerIsRequester: true }}
          evaluation={null}
          apiKeyNames={{}}
          canDecide
        />
      </I18nProvider>
    );

    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(
      screen.getByText("You raised this request, so someone else has to decide it.")
    ).toBeTruthy();
    // The review prompt is for whoever can decide; the requester cannot.
    expect(screen.queryByText(REVIEW_DESCRIPTION)).toBeNull();
  });

  it("asks only a viewer who can decide to review before deciding", () => {
    const { rerender } = render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <ApprovalRequestDetail
          initialRequest={pendingRequest}
          evaluation={null}
          apiKeyNames={{}}
          canDecide
        />
      </I18nProvider>
    );
    expect(screen.getByText(REVIEW_DESCRIPTION)).toBeTruthy();

    rerender(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <ApprovalRequestDetail
          key="view-only"
          initialRequest={pendingRequest}
          evaluation={null}
          apiKeyNames={{}}
          canDecide={false}
        />
      </I18nProvider>
    );
    expect(screen.queryByText(REVIEW_DESCRIPTION)).toBeNull();
    expect(
      screen.getByText("You can review approval requests, but your role cannot decide them.")
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  describe("approved request execution", () => {
    function renderApproved(operation: Partial<WalletApprovalRequestSummary["operation"]>) {
      return render(
        <I18nProvider locale="en" messages={getMessages("en")}>
          <ApprovalRequestDetail
            initialRequest={approvedRequest(operation)}
            evaluation={null}
            apiKeyNames={{}}
            canDecide
          />
        </I18nProvider>
      );
    }

    it("says the operation executed, and when", () => {
      const { container } = renderApproved({
        status: "completed",
        executionCompletedAt: "2026-09-11T10:05:00.000Z",
      });

      expect(screen.getByText("Executed")).toBeTruthy();
      expect(container.querySelector('time[datetime="2026-09-11T10:05:00.000Z"]')).toBeTruthy();
      expect(screen.getAllByText("Approved").length).toBeGreaterThan(0);
      expect(screen.queryByText("Execution failed")).toBeNull();
      expect(screen.queryByText(REVIEW_DESCRIPTION)).toBeNull();
    });

    // A ramp quote that expires while the approval waits fails on replay; the
    // approver has to see that, in the API's words.
    it("marks a failed execution and shows the API's message", () => {
      renderApproved({
        status: "failed",
        executionCompletedAt: "2026-09-11T10:05:00.000Z",
        executionError: "Provider quote/session reference has expired; create a new quote.",
      });

      expect(screen.getByText("Execution failed")).toBeTruthy();
      expect(
        screen.getByText("Provider quote/session reference has expired; create a new quote.")
      ).toBeTruthy();
      expect(screen.queryByText("Executed")).toBeNull();
    });

    it("says so when a failed execution recorded no message", () => {
      renderApproved({ status: "failed", executionCompletedAt: "2026-09-11T10:05:00.000Z" });

      expect(screen.getByText("Execution failed")).toBeTruthy();
      expect(screen.getByText("No error message was recorded")).toBeTruthy();
    });

    it("says execution has not finished while it is still running", () => {
      renderApproved({
        status: "executing",
        executionStartedAt: "2026-09-11T10:00:00.000Z",
      });

      const notice = screen.getByText("Execution has not finished");
      expect(notice.parentElement?.querySelector("time")).toBeNull();
    });

    it("says the operation did not run when it was never claimed", () => {
      renderApproved({ status: "canceled" });

      expect(screen.getByText("Not executed")).toBeTruthy();
    });

    it("shows no execution line for a request that was not approved", () => {
      render(
        <I18nProvider locale="en" messages={getMessages("en")}>
          <ApprovalRequestDetail
            initialRequest={{
              ...pendingRequest,
              status: "rejected",
              operation: { ...pendingRequest.operation, status: "canceled" },
            }}
            evaluation={null}
            apiKeyNames={{}}
            canDecide
          />
        </I18nProvider>
      );

      expect(screen.queryByText("Not executed")).toBeNull();
      expect(screen.queryByText(REVIEW_DESCRIPTION)).toBeNull();
    });
  });

  it("does not announce a plain success when approving ran and failed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          data: {
            approvalRequest: approvedRequest({
              status: "failed",
              executionCompletedAt: "2026-09-11T10:05:00.000Z",
              executionError: "Provider quote/session reference has expired; create a new quote.",
            }),
          },
        })
      )
    );
    const user = userEvent.setup();
    render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <ApprovalRequestDetail
          initialRequest={pendingRequest}
          evaluation={null}
          apiKeyNames={{}}
          canDecide
        />
        <Toaster theme="light" />
      </I18nProvider>
    );

    await user.click(screen.getByRole("button", { name: "Approve" }));
    await user.click(screen.getByRole("button", { name: "Approve request" }));

    expect(await screen.findByText("Request approved, but execution failed")).toBeTruthy();
    // The timeline still reads "Request approved"; only the toast must not.
    expect(
      [...document.querySelectorAll("[data-sonner-toast]")].map((toast) => toast.textContent)
    ).toEqual(["Request approved, but execution failed"]);
    expect(
      screen.getByText("Provider quote/session reference has expired; create a new quote.")
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  // The API names the rule the caller did not meet; the role line was wrong
  // for most of them.
  it("shows the API's reason when a decision is forbidden", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json(
          {
            error: {
              message: "Approval request must be decided by an active approval-group member",
            },
          },
          { status: 403 }
        )
      )
    );
    const user = userEvent.setup();
    render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <ApprovalRequestDetail
          initialRequest={pendingRequest}
          evaluation={null}
          apiKeyNames={{}}
          canDecide
        />
        <Toaster theme="light" />
      </I18nProvider>
    );

    await user.click(screen.getByRole("button", { name: "Approve" }));
    await user.click(screen.getByRole("button", { name: "Approve request" }));

    expect(
      await screen.findByText("Approval request must be decided by an active approval-group member")
    ).toBeTruthy();
    expect(
      screen.queryByText("Your role does not have permission to decide approval requests.")
    ).toBeNull();
  });
});
