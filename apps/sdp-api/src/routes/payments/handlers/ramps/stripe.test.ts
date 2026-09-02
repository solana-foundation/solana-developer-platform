import type { PaymentRampQuote } from "@sdp/types";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { CounterpartyRow } from "@/db/repositories/counterparty.repository";
import type { Env } from "@/types/env";
import { stripeOnrampQuote } from "./stripe";

const { createOnrampQuoteMock } = vi.hoisted(() => ({
  createOnrampQuoteMock: vi.fn(),
}));

vi.mock("@sdp/payments/ramps", () => ({
  RAMP_PROVIDER_CLIENTS: {
    stripe: { createOnrampQuote: createOnrampQuoteMock },
  },
}));

const STRIPE_QUOTE = {
  id: "stripe_quote_123",
  provider: "stripe",
  status: "pending",
  deliveryMode: "session_widget",
  clientSecret: "secret_123",
  sessionId: "session_123",
  publishableKey: "pk_test_123",
} as const satisfies PaymentRampQuote;

const COUNTERPARTY = {
  id: "counterparty_1",
  organization_id: "org_1",
  project_id: "proj_1",
  external_id: null,
  entity_type: "individual",
  display_name: "Jane Doe",
  provider_data: {},
  status: "active",
  created_by: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
} as const satisfies CounterpartyRow;

const TEST_ENV = {
  ENVIRONMENT: "development",
  API_VERSION: "v1",
} as const satisfies Env;

describe("stripeOnrampQuote", () => {
  it("creates a quote without stored customer prefill", async () => {
    createOnrampQuoteMock.mockImplementationOnce(async () => STRIPE_QUOTE);
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", async (c, next) => {
      c.set("projectEnvironment", "sandbox");
      await next();
    });
    app.get("/", async (c) =>
      c.json(
        await stripeOnrampQuote(c, {
          counterparty: COUNTERPARTY,
          destinationWalletAddress: "wallet_123",
          cryptoToken: "USDC",
          fiatCurrency: "USD",
          fiatAmount: "100",
        })
      )
    );

    const response = await app.request("/", {}, TEST_ENV);

    expect(response.status).toBe(200);
    expect(createOnrampQuoteMock).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "sandbox" }),
      expect.not.objectContaining({ stripeCustomerInfo: expect.anything() })
    );
  });
});
