import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ proxyToSdpApi: vi.fn() }));
vi.mock("@/lib/sdp-api", () => mocks);
vi.mock("@/i18n/server", () => ({ getTranslations: async () => (key: string) => key }));

import { GET as listRuns } from "./collection-attempts/route";
import { GET, PATCH } from "./route";

const handlers = [
  ["GET", GET, "/v1/payments/recurring-payments/prp%2F1"],
  ["PATCH", PATCH, "/v1/payments/recurring-payments/prp%2F1"],
  ["GET runs", listRuns, "/v1/payments/recurring-payments/prp%2F1/collection-attempts"],
] as const;

describe("recurring payment routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.proxyToSdpApi.mockResolvedValue(new Response(null, { status: 200 }));
  });

  it.each(handlers)(
    "%s sends an encoded schedule id upstream encoded once",
    async (_name, handler, path) => {
      await handler(new Request("https://dashboard.example.test/recurring"), {
        params: Promise.resolve({ recurringPaymentId: "prp%2F1" }),
      });

      expect(mocks.proxyToSdpApi).toHaveBeenCalledWith(expect.objectContaining({ path }));
    }
  );

  it.each(handlers)(
    "%s refuses a malformed schedule id before forwarding",
    async (_name, handler) => {
      const response = await handler(new Request("https://dashboard.example.test/recurring"), {
        params: Promise.resolve({ recurringPaymentId: "prp%E0%A4%A" }),
      });

      expect(response.status).toBe(400);
      expect(mocks.proxyToSdpApi).not.toHaveBeenCalled();
    }
  );
});
