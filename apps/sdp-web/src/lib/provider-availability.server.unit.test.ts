import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTokenSdpApiClient, SdpApiResponseError } from "@/lib/sdp-api";
import { SANDBOX_PROJECT } from "@/test/projects";
import { projectProviderAvailability } from "@/test/provider-availability";
import { resetRequestProject, setPageRequest } from "@/test/request-project";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => import("@/test/next-headers"));

import { fetchProjectProviderAvailability } from "./provider-availability.server";

const API_BASE_URL = "https://sdp-api.test";

const AVAILABILITY = projectProviderAvailability({
  project: SANDBOX_PROJECT,
  custody: [{ provider: "privy", modes: ["managed", "byok"] }],
  compliance: ["range"],
  ramps: ["moonpay"],
  earn: [],
});

function stubApiResponse(response: Response) {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("fetchProjectProviderAvailability", () => {
  beforeEach(() => {
    resetRequestProject();
    setPageRequest(`/dashboard/${SANDBOX_PROJECT.id}/wallets/setup`);
    vi.stubEnv("SDP_API_BASE_URL", API_BASE_URL);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("reads the request project's availability and returns it parsed", async () => {
    const fetchMock = stubApiResponse(Response.json({ data: AVAILABILITY }));

    await expect(
      fetchProjectProviderAvailability(createTokenSdpApiClient("token_test"))
    ).resolves.toEqual(AVAILABILITY);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${API_BASE_URL}/v1/projects/${SANDBOX_PROJECT.id}/provider-availability`,
    ]);
  });

  it("throws when the read fails", async () => {
    stubApiResponse(new Response("unavailable", { status: 503 }));

    await expect(
      fetchProjectProviderAvailability(createTokenSdpApiClient("token_test"))
    ).rejects.toThrow(new SdpApiResponseError(503, "unavailable"));
  });

  it("throws on a body that does not match the availability schema", async () => {
    stubApiResponse(Response.json({ data: { ...AVAILABILITY, environment: "staging" } }));

    await expect(
      fetchProjectProviderAvailability(createTokenSdpApiClient("token_test"))
    ).rejects.toMatchObject({ name: "ZodError" });
  });
});
