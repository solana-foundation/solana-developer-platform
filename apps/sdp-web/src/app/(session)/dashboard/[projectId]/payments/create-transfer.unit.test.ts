// @vitest-environment jsdom
/** What `createTransfer` sends the transfer endpoint, and what it makes of each answer. */

import { address } from "@solana/kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dashboardDataResponse,
  sentDashboardRequests,
  stubDashboardFetch,
} from "@/test/dashboard-fetch";
import { createTransfer, TransferRequestError, type Translate } from "./payments-workspace.data";

const t: Translate = (key) => key;

const SUBMISSION = {
  sourceCustodyWalletId: "cwlt_1",
  destination: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
  token: address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"),
  amount: "250",
};

const KEY = { value: "key_1", persisted: true };

const recorded = () =>
  dashboardDataResponse(201, { transfer: { id: "xfr_1", status: "confirmed", signature: null } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createTransfer", () => {
  it("posts the payment with the caller's key as a header, never in the body", async () => {
    const fetchMock = stubDashboardFetch(recorded);

    const transfer = await createTransfer(SUBMISSION, t, KEY);

    expect(transfer).toEqual({ id: "xfr_1", status: "confirmed", signature: null });
    expect(sentDashboardRequests(fetchMock)).toEqual([
      {
        path: "/api/dashboard/payments/transfers",
        method: "POST",
        idempotencyKey: "key_1",
        body: SUBMISSION,
      },
    ]);
  });

  it("gives a caller without its own key a key for its action", async () => {
    const fetchMock = stubDashboardFetch(recorded);

    await createTransfer({ ...SUBMISSION, transferId: "xfr_ramp" }, t, null);

    const [sent] = sentDashboardRequests(fetchMock);
    expect(sent?.body).toEqual({ ...SUBMISSION, transferId: "xfr_ramp" });
    expect(sent?.idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it("names the contact account and the memo only when given", async () => {
    const fetchMock = stubDashboardFetch(recorded);

    await createTransfer(
      { ...SUBMISSION, counterpartyAccountId: "cpacct_1", memo: "invoice 7" },
      t,
      KEY
    );
    await createTransfer({ ...SUBMISSION, memo: "" }, t, { value: "key_2", persisted: true });

    expect(sentDashboardRequests(fetchMock).map((request) => request.body)).toEqual([
      { ...SUBMISSION, counterpartyAccountId: "cpacct_1", memo: "invoice 7" },
      SUBMISSION,
    ]);
  });

  it("refuses a success answer that carries no transfer", async () => {
    stubDashboardFetch(() => dashboardDataResponse(200, {}));

    await expect(createTransfer(SUBMISSION, t, KEY)).rejects.toThrow(
      "DashboardPayments.workspace.transferMissing"
    );
  });

  // The status, code and replay mark decide the key's fate, so the error carries them.
  it("throws the API's refusal with its message, status, code and replay mark", async () => {
    stubDashboardFetch(() =>
      Response.json(
        { error: { code: "INSUFFICIENT_BALANCE", message: "Insufficient balance" } },
        { status: 422, headers: { "Idempotent-Replayed": "true" } }
      )
    );

    const refusal = await createTransfer(SUBMISSION, t, KEY).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(TransferRequestError);
    expect(refusal).toMatchObject({
      message: "Insufficient balance",
      status: 422,
      code: "INSUFFICIENT_BALANCE",
      replayed: true,
    });
  });

  it("names the status when a refusal carries no message", async () => {
    stubDashboardFetch(() => new Response("<html>502</html>", { status: 502 }));

    await expect(createTransfer(SUBMISSION, t, KEY)).rejects.toMatchObject({
      message: "DashboardPayments.workspace.transferRequestFailed",
      status: 502,
      code: null,
      replayed: false,
    });
  });
});
