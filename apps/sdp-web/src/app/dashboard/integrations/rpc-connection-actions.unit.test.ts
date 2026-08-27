import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/sdp-api", () => ({
  createSdpApiClient: async () => ({ fetch: fetchMock }),
}));

import { submitRpcConnectionAction } from "./rpc-connection-actions";

/**
 * These actions were the one layer without tests, and the gap showed: the
 * submit action kept requiring an endpoint after the form stopped sending one
 * for providers that publish a single host, so every Helius submission was
 * rejected before it left the browser.
 */
function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    data.set(key, value);
  }
  return data;
}

const BASE = {
  provider: "helius",
  network: "devnet",
  scope: "organization",
  credentialLabel: "dev-key",
  apiKey: "tenant-key-1234",
};

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ id: "rconn_1", provider: "helius" });
});

describe("submitRpcConnectionAction", () => {
  it("accepts a submission with no endpoint for a provider that publishes one", async () => {
    // The form omits the field entirely for Helius and Alchemy.
    const result = await submitRpcConnectionAction(form(BASE));

    expect(result.status).toBe("success");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("omits the endpoint rather than sending an empty string", async () => {
    // The API validates endpointUrl as a URL when present, so "" is a 400.
    await submitRpcConnectionAction(form({ ...BASE, endpointUrl: "" }));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).not.toHaveProperty("endpointUrl");
    expect(body.apiKey).toBe("tenant-key-1234");
  });

  it("passes an endpoint through when the provider needs one", async () => {
    await submitRpcConnectionAction(
      form({ ...BASE, provider: "quicknode", endpointUrl: "https://x.quiknode.pro" })
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.endpointUrl).toBe("https://x.quiknode.pro");
  });

  it("still rejects a submission with no name or no key", async () => {
    const noLabel = await submitRpcConnectionAction(form({ ...BASE, credentialLabel: "  " }));
    const noKey = await submitRpcConnectionAction(form({ ...BASE, apiKey: "   " }));

    expect(noLabel.status).toBe("invalid");
    expect(noKey.status).toBe("invalid");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces the API's message rather than a raw request failure", async () => {
    fetchMock.mockRejectedValue(
      new Error('SDP API request failed (409): {"error":{"message":"Provider rejected it"}}')
    );

    const result = await submitRpcConnectionAction(form(BASE));

    expect(result).toEqual({ status: "error", message: "Provider rejected it" });
  });
});
