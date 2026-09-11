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
};

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
});
