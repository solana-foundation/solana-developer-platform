import type { MovementOf } from "@sdp/types";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { getDb } from "@/db/client";
import { app } from "@/index";
import * as moneyAdmission from "@/lib/money-admission";
import { errorResponseSchema } from "@/openapi/schemas/base";
import { env } from "@/test/helpers/env";
import {
  installPaymentsRouteTestHooks,
  seedCounterparty,
  TEST_API_KEY,
  TEST_CUSTODY_WALLET_ID,
  TEST_ORG,
  TEST_PROJECT,
} from "@/test/helpers/payments-routes";
import { required } from "@/test/helpers/required";
import { installStripeTestEnv } from "@/test/helpers/stripe-env";

const ADMISSION_SCOPE = { organizationId: TEST_ORG.id, projectId: TEST_PROJECT.id };

function admissionContext(movement: MovementOf<"ramps">) {
  return { surface: "http", movement, subjectId: TEST_CUSTODY_WALLET_ID };
}

async function requestQuote(
  direction: "onramp" | "offramp",
  body: Record<string, unknown>
): Promise<Response> {
  return app.request(
    `/v1/payments/ramps/${direction}/quote`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_API_KEY.raw}`,
      },
      body: JSON.stringify(body),
    },
    env
  );
}

function requestMoonPayQuote(
  direction: "onramp" | "offramp",
  counterpartyId: string
): Promise<Response> {
  return direction === "onramp"
    ? requestQuote("onramp", {
        provider: "moonpay",
        counterpartyId,
        destinationCustodyWalletId: TEST_CUSTODY_WALLET_ID,
        assetRail: "sol.solana",
        fiatCurrency: "USD",
        fiatAmount: "120.50",
      })
    : requestQuote("offramp", {
        provider: "moonpay",
        counterpartyId,
        sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
        assetRail: "sol.solana",
        fiatCurrency: "USD",
        cryptoAmount: "75.25",
      });
}

async function countCounterpartyTransfers(counterpartyId: string): Promise<number> {
  const row = await getDb(env)
    .prepare(
      `SELECT COUNT(*)::int AS count
         FROM payment_transfers
        WHERE organization_id = ? AND counterparty_id = ?`
    )
    .bind(TEST_ORG.id, counterpartyId)
    .first<{ count: number }>();
  return required(row).count;
}

/** Refuses the next money start, as admission does for a suspended organization. */
function refuseNextMoneyStart() {
  const admission = vi
    .spyOn(moneyAdmission, "assertMoneyStartAdmitted")
    .mockRejectedValueOnce(new moneyAdmission.MoneyMovementRefusedError("organization_inactive"));
  onTestFinished(() => admission.mockRestore());
  return admission;
}

async function expectMoneyStartRefused(response: Response): Promise<void> {
  expect(response.status).toBe(403);
  const body: unknown = await response.json();
  expect(errorResponseSchema.parse(body).error).toEqual({
    code: "FORBIDDEN",
    message: "Organization is not active",
    details: { reason: "organization_inactive" },
  });
  expect(body).not.toHaveProperty("data");
}

describe("Payments routes: ramp quote money admission (HOO-2029)", () => {
  installPaymentsRouteTestHooks();
  installStripeTestEnv();

  it.each([
    ["onramp", "ramps.onramp_quote"],
    ["offramp", "ramps.offramp_quote"],
  ] as const)(
    "admits a %s quote once, as %s on the requested wallet",
    async (direction, movement) => {
      const counterpartyId = await seedCounterparty({
        externalId: `admission_${direction}_admitted`,
      });
      const admission = vi.spyOn(moneyAdmission, "assertMoneyStartAdmitted");
      onTestFinished(() => admission.mockRestore());

      const response = await requestMoonPayQuote(direction, counterpartyId);

      expect(response.status).toBe(200);
      expect(admission).toHaveBeenCalledExactlyOnceWith(
        env,
        ADMISSION_SCOPE,
        admissionContext(movement)
      );
    }
  );

  it.each([
    {
      quote: "a Stripe onramp quote",
      movement: "ramps.onramp_quote",
      request: (counterpartyId: string) =>
        requestQuote("onramp", {
          provider: "stripe",
          counterpartyId,
          destinationCustodyWalletId: TEST_CUSTODY_WALLET_ID,
          assetRail: "usdc.solana",
          fiatCurrency: "USD",
          fiatAmount: "25",
        }),
    },
    {
      quote: "a MoonPay offramp quote",
      movement: "ramps.offramp_quote",
      request: (counterpartyId: string) => requestMoonPayQuote("offramp", counterpartyId),
    },
  ] as const)(
    "refuses $quote before any provider call or transfer write",
    async ({ movement, request }) => {
      const counterpartyId = await seedCounterparty({
        externalId: `admission_${movement}_refused`,
      });
      const admission = refuseNextMoneyStart();
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        throw new Error("A refused quote reached the provider");
      });
      onTestFinished(() => fetchSpy.mockRestore());

      await expectMoneyStartRefused(await request(counterpartyId));

      expect(admission).toHaveBeenCalledExactlyOnceWith(
        env,
        ADMISSION_SCOPE,
        admissionContext(movement)
      );
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(await countCounterpartyTransfers(counterpartyId)).toBe(0);
    }
  );
});
