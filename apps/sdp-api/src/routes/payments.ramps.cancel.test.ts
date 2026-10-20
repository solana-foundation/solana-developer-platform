import { SdpPaymentsError } from "@sdp/payments/errors";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { getDb } from "@/db/client";
import { app } from "@/index";
import { RedisKVStore } from "@/runtime/kv-redis";
import { env } from "@/test/helpers/env";
import {
  cancelMoonpaySaleMock,
  installPaymentsRouteTestHooks,
  TEST_API_KEY,
  TEST_CUSTODY_WALLET_ID,
  TEST_ORG,
  TEST_PROJECT,
  TEST_WALLET_ID,
} from "@/test/helpers/payments-routes";
import { required } from "@/test/helpers/required";

async function seedRamp(input: {
  id: string;
  type: "onramp" | "offramp";
  status: "pending" | "awaiting_payment";
}) {
  const now = new Date().toISOString();
  await getDb(env)
    .prepare(
      `INSERT INTO payment_transfers
         (id, organization_id, project_id, wallet_id, custody_wallet_id, token, amount, type,
          direction, status, provider, provider_reference, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'USDC', '25', ?, ?, ?, 'moonpay', ?, ?, ?)`
    )
    .bind(
      input.id,
      TEST_ORG.id,
      TEST_PROJECT.id,
      TEST_WALLET_ID,
      TEST_CUSTODY_WALLET_ID,
      input.type,
      input.type === "onramp" ? "inbound" : "outbound",
      input.status,
      `moonpay_${input.id}`,
      now,
      now
    )
    .run();
}

function cancel(transferId: string) {
  return app.request(
    "/v1/payments/ramps/transfers/cancel",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_API_KEY.raw}`,
      },
      body: JSON.stringify({ transferId }),
    },
    env
  );
}

async function readStatus(transferId: string): Promise<string> {
  return required(
    await getDb(env)
      .prepare("SELECT status FROM payment_transfers WHERE id = ?")
      .bind(transferId)
      .first<{ status: string }>()
  ).status;
}

async function readCancelAudits(transferId: string) {
  const { results } = await getDb(env)
    .prepare(
      `SELECT action, resource_type, metadata FROM audit_logs
        WHERE resource_id = ? AND action = 'cancel'`
    )
    .bind(transferId)
    .all<{ action: string; resource_type: string; metadata: string }>();
  return results.map((row) => {
    const metadata: unknown = JSON.parse(row.metadata);
    return { ...row, metadata };
  });
}

describe("Payments routes: canceling a ramp transfer", () => {
  installPaymentsRouteTestHooks();

  it("cancels MoonPay's sale once SDP's own cancel holds, and audits it", async () => {
    await seedRamp({ id: "xfr_cancel_sale", type: "offramp", status: "awaiting_payment" });

    const response = await cancel("xfr_cancel_sale");

    expect(response.status).toBe(200);
    expect(await readStatus("xfr_cancel_sale")).toBe("canceled");
    expect(cancelMoonpaySaleMock).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      "xfr_cancel_sale",
      expect.any(AbortSignal)
    );
    expect(await readCancelAudits("xfr_cancel_sale")).toEqual([
      {
        action: "cancel",
        resource_type: "payment_transfer",
        metadata: expect.objectContaining({
          type: "offramp",
          provider: "moonpay",
          status: "canceled",
          fromStatus: "awaiting_payment",
        }),
      },
    ]);
  });

  it("answers a second cancel with the canceled transfer and asks MoonPay again", async () => {
    await seedRamp({ id: "xfr_cancel_twice", type: "offramp", status: "pending" });

    const first = await cancel("xfr_cancel_twice");
    const second = await cancel("xfr_cancel_twice");

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      data: { transfer: { id: "xfr_cancel_twice", status: "canceled" } },
    });
    expect(cancelMoonpaySaleMock).toHaveBeenCalledTimes(2);
    expect(await readCancelAudits("xfr_cancel_twice")).toHaveLength(1);
  });

  it("keeps the sale open when its cancel cannot be recorded", async () => {
    await seedRamp({ id: "xfr_cancel_unaudited", type: "offramp", status: "awaiting_payment" });
    // The ledger's pending witness is refused, so the record never seals.
    const witness = vi.spyOn(RedisKVStore.prototype, "compareAndSet").mockResolvedValueOnce(false);
    onTestFinished(() => witness.mockRestore());

    const response = await cancel("xfr_cancel_unaudited");

    expect(response.status).toBe(500);
    expect(await readStatus("xfr_cancel_unaudited")).toBe("awaiting_payment");
    expect(await readCancelAudits("xfr_cancel_unaudited")).toEqual([]);
    expect(cancelMoonpaySaleMock).not.toHaveBeenCalled();
  });

  it("keeps SDP's cancel when MoonPay cannot be reached", async () => {
    await seedRamp({ id: "xfr_cancel_offline", type: "offramp", status: "awaiting_payment" });
    cancelMoonpaySaleMock.mockRejectedValueOnce(
      new SdpPaymentsError("PROVIDER_UNAVAILABLE", "Failed to reach the moonpay API")
    );

    const response = await cancel("xfr_cancel_offline");

    expect(response.status).toBe(200);
    expect(await readStatus("xfr_cancel_offline")).toBe("canceled");
  });

  it("never asks MoonPay to cancel a buy", async () => {
    await seedRamp({ id: "xfr_cancel_buy", type: "onramp", status: "awaiting_payment" });

    const response = await cancel("xfr_cancel_buy");

    expect(response.status).toBe(200);
    expect(await readStatus("xfr_cancel_buy")).toBe("canceled");
    expect(cancelMoonpaySaleMock).not.toHaveBeenCalled();
  });
});
