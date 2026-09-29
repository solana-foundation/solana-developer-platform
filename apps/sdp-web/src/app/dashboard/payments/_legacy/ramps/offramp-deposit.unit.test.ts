// @vitest-environment jsdom
import { address } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTransfer, type Translate } from "../payments-workspace.data";
import { submitOfframpDeposit } from "./offramp-deposit";

const feedback = vi.hoisted(() => ({
  loading: vi.fn(() => "toast_deposit"),
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: feedback }));
const t: Translate = (key) => key;
const submission = {
  transferId: "xfr_quote",
  sourceCustodyWalletId: "cwlt_treasury",
  destination: "11111111111111111111111111111111",
  token: address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"),
  amount: "25",
};
const send = (input: Parameters<typeof createTransfer>[0]) => createTransfer(input, t, null);

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("off-ramp deposit feedback", () => {
  it("reports approval hold without reporting a completed or failed deposit", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json(
        {
          error: {
            code: "SIGNING_PENDING",
            details: { approvalRequestId: "apr_1" },
          },
        },
        { status: 202 }
      )
    );
    vi.stubGlobal("fetch", request);
    await submitOfframpDeposit(submission, send, t);
    expect(request).toHaveBeenCalledOnce();
    expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toMatchObject({
      transferId: "xfr_quote",
    });
    expect(feedback.info).toHaveBeenCalledWith(
      "DashboardPayments.onchainSend.approvalPendingTitle",
      expect.objectContaining({ id: "toast_deposit" })
    );
    expect(feedback.success).not.toHaveBeenCalled();
    expect(feedback.error).not.toHaveBeenCalled();
  });

  it.each(["sig_1", null])(
    "reports the submitted quote transfer with signature %s",
    async (signature) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json({
            data: {
              transfer: {
                id: submission.transferId,
                status: "processing",
                signature,
              },
            },
          })
        )
      );
      await submitOfframpDeposit(submission, send, t);
      expect(feedback.success).toHaveBeenCalledWith(
        "DashboardPayments.ramps.transferSubmitted",
        expect.objectContaining({
          description: signature
            ? "DashboardPayments.ramps.transactionSentSuccessfully"
            : "DashboardPayments.ramps.transferStatus",
        })
      );
      expect(feedback.info).not.toHaveBeenCalled();
      expect(feedback.error).not.toHaveBeenCalled();
    }
  );

  it("refuses a response naming a different quote transfer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ data: { transfer: { id: "xfr_other" } } }))
    );
    await submitOfframpDeposit(submission, send, t);
    expect(feedback.error).toHaveBeenCalledWith(
      "DashboardPayments.ramps.transferFailed",
      expect.objectContaining({ description: "DashboardPayments.ramps.transferFailed" })
    );
    expect(feedback.success).not.toHaveBeenCalled();
  });

  it("preserves the refusal reason without reporting a send", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: { message: "Quote expired" } }, { status: 409 }))
    );
    await submitOfframpDeposit(submission, send, t);
    expect(feedback.error).toHaveBeenCalledWith(
      "DashboardPayments.ramps.transferFailed",
      expect.objectContaining({ description: "Quote expired" })
    );
    expect(feedback.success).not.toHaveBeenCalled();
  });

  it("reports a lost response without claiming success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("connection lost");
      })
    );
    await submitOfframpDeposit(submission, send, t);
    expect(feedback.error).toHaveBeenCalledWith(
      "DashboardPayments.ramps.transferFailed",
      expect.objectContaining({ description: "connection lost" })
    );
    expect(feedback.success).not.toHaveBeenCalled();
  });
});
