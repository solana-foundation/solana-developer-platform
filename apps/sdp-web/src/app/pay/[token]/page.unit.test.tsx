import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { nextNavigationMock, resetDashboardNavigation } from "@/test/dashboard-navigation";
import PayPage from "./page";
import { payTokenSchema } from "./pay-token";

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("next/headers", () => import("@/test/next-headers"));

const fetchMock = vi.fn<typeof fetch>();

function renderPage(token: string) {
  return PayPage({ params: Promise.resolve({ token }) });
}

beforeEach(() => {
  vi.stubEnv("SDP_API_BASE_URL", "http://sdp-api.test");
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  resetDashboardNavigation();
});

// HOO-2619: the page has no loading boundary, so `notFound()` runs before anything streams and
// the response is a real 404.
describe("PayPage unknown links", () => {
  it.each(["short", "has space here", "../../v1/projects", "a".repeat(65), "tok%2Fen"])(
    "answers 404 for the malformed token %j without reading the API",
    async (token) => {
      await expect(renderPage(token)).rejects.toThrow("NEXT_NOT_FOUND");
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it("answers 404 for a token the API does not know, with one read", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 404 }));

    await expect(renderPage("AbCdEfGh12345-xy")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://sdp-api.test/pay/AbCdEfGh12345-xy");
  });

  it("does not call a refused or failed read a missing link", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 429 }));

    await expect(renderPage("AbCdEfGh12345-xy")).rejects.toThrow("Pay link read failed (429)");
    expect(nextNavigationMock.notFound).not.toHaveBeenCalled();
  });

  it("refuses a read whose body is not a payment link instead of drawing it", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: "paid" }), { status: 200 }));

    await expect(renderPage("AbCdEfGh12345-xy")).rejects.toThrow(ZodError);
  });
});

describe("PayPage open requests", () => {
  const openRequest = {
    amount: "1.5",
    tokenSymbol: "USDC",
    recipient: "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV",
    status: "awaiting_payment",
    expiresAt: null,
    network: "devnet",
  };

  it("tells the payer an open request without a Solana Pay link can't be paid (HOO-2009)", async () => {
    fetchMock.mockResolvedValue(Response.json({ ...openRequest, solanaPayUrl: null }));

    const html = renderToStaticMarkup(await renderPage("AbCdEfGh12345-xy"));

    expect(html).toContain("Payment unavailable");
    expect(html).not.toContain("Scan with a Solana wallet to pay");
  });

  it("offers the Solana Pay link while the request can be paid", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ ...openRequest, solanaPayUrl: "solana:https://sdp-api.test/pay/x/tx" })
    );

    const html = renderToStaticMarkup(await renderPage("AbCdEfGh12345-xy"));

    expect(html).toContain("Scan with a Solana wallet to pay");
    expect(html).not.toContain("Payment unavailable");
  });
});

describe("payTokenSchema", () => {
  it("accepts the API's 16-character tokens", () => {
    expect(payTokenSchema.safeParse("0123456789ABCDEF").success).toBe(true);
    expect(payTokenSchema.safeParse("abc-DEF-ghi-JKL-").success).toBe(true);
  });
});
