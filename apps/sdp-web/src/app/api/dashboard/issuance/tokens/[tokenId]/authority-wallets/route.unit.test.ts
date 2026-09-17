import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as SdpApi from "@/lib/sdp-api";
import { GET } from "./route";

afterEach(() => vi.restoreAllMocks());

let metadataResponse: Response;
let allowlistResponse: Response;
let freezeResponse: Response;
let pauseResponse: Response;
let requestMock: ReturnType<typeof vi.fn<SdpApi.SdpApiClient["request"]>>;
beforeEach(() => {
  metadataResponse = Response.json({
    data: { token: { metadataAuthority: "authority_a" }, metadataAuthority: "authority_b" },
  });
  allowlistResponse = Response.json({ data: { allowlistAuthority: "list_authority" } });
  freezeResponse = Response.json({ data: { freezeAuthority: "freeze_authority" } });
  pauseResponse = Response.json({ data: { pauseAuthority: "pause_authority" } });
  requestMock = vi.fn<SdpApi.SdpApiClient["request"]>().mockImplementation(async (path) => {
    if (path.startsWith("/v1/wallets?")) {
      return Response.json({
        data: {
          wallets: [
            {
              id: "cwlt_b",
              walletId: "provider_b",
              publicKey: "authority_b",
              custodyConfigId: "config_b",
              isRuntimeExecutionAllowed: true,
            },
          ],
        },
      });
    }
    if (
      path ===
      "/v1/issuance/tokens/tok_1?includeAllowlistAuthority=true&includeFreezeAuthority=true&includeMetadataAuthority=true&includePauseAuthority=true"
    ) {
      const failedResponse = [
        allowlistResponse,
        freezeResponse,
        metadataResponse,
        pauseResponse,
      ].find((response) => !response.ok);
      if (failedResponse) return new Response(null, { status: failedResponse.status });
      const [allowlistBody, freezeBody, metadataBody, pauseBody] = await Promise.all([
        allowlistResponse.clone().json(),
        freezeResponse.clone().json(),
        metadataResponse.clone().json(),
        pauseResponse.clone().json(),
      ]);
      return Response.json({
        data: {
          ...allowlistBody.data,
          ...freezeBody.data,
          ...metadataBody.data,
          ...pauseBody.data,
        },
      });
    }
    if (path === "/v1/issuance/tokens/tok_1?includeMetadataAuthority=true") {
      return metadataResponse;
    }
    if (path === "/v1/issuance/tokens/tok_1?includeAllowlistAuthority=true") {
      return allowlistResponse;
    }
    if (path === "/v1/issuance/tokens/tok_1?includeFreezeAuthority=true") {
      return freezeResponse;
    }
    if (path === "/v1/issuance/tokens/tok_1?includePauseAuthority=true") {
      return pauseResponse;
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.spyOn(SdpApi, "createSdpApiClient").mockResolvedValue({
    request: requestMock,
    fetch: async () => {
      throw new Error("Unexpected fetch helper");
    },
  });
});

async function readAuthorityWallets() {
  return GET(new Request("https://dashboard.example.com/authority-wallets"), {
    params: Promise.resolve({ tokenId: "tok_1" }),
  });
}

it("loads live metadata authority independently of the stored token authority", async () => {
  const response = await readAuthorityWallets();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    data: {
      metadataAuthority: "authority_b",
      metadataAuthorityError: null,
      allowlistAuthority: "list_authority",
      allowlistAuthorityError: null,
      freezeAuthority: "freeze_authority",
      freezeAuthorityError: null,
      pauseAuthority: "pause_authority",
      pauseAuthorityError: null,
      authorityWallets: [{ id: "cwlt_b" }],
    },
  });
  expect(requestMock).toHaveBeenCalledWith(
    "/v1/issuance/tokens/tok_1?includeAllowlistAuthority=true&includeFreezeAuthority=true&includeMetadataAuthority=true&includePauseAuthority=true",
    { method: "GET" }
  );
  expect(
    requestMock.mock.calls.filter(([path]) => path.startsWith("/v1/issuance/tokens/"))
  ).toHaveLength(1);
});

it("keeps allowlist and wallets available when the metadata read fails", async () => {
  metadataResponse = new Response(null, { status: 502 });
  const response = await readAuthorityWallets();
  expect(await response.json()).toMatchObject({
    data: {
      metadataAuthority: null,
      metadataAuthorityError: "Metadata authority API 502",
      allowlistAuthority: "list_authority",
      allowlistAuthorityError: null,
      authorityWallets: [{ id: "cwlt_b" }],
    },
  });
});

it("keeps metadata available when the allowlist read fails", async () => {
  allowlistResponse = new Response(null, { status: 502 });
  const response = await readAuthorityWallets();
  expect(await response.json()).toMatchObject({
    data: {
      metadataAuthority: "authority_b",
      metadataAuthorityError: null,
      allowlistAuthority: null,
      allowlistAuthorityError: "Allowlist authority API 502",
    },
  });
});

it("reports a freeze-authority read failure without substituting the stored authority", async () => {
  freezeResponse = new Response(null, { status: 502 });
  const response = await readAuthorityWallets();
  expect(await response.json()).toMatchObject({
    data: {
      freezeAuthority: null,
      freezeAuthorityError: "Freeze authority API 502",
      metadataAuthority: "authority_b",
      authorityWallets: [{ id: "cwlt_b" }],
    },
  });
});

it.each([{}, { metadataAuthority: 42 }, { metadataAuthority: "" }])(
  "does not infer a live authority from malformed metadata response %j",
  async (fields) => {
    metadataResponse = Response.json({
      data: { token: { metadataAuthority: "authority_a" }, ...fields },
    });
    const response = await readAuthorityWallets();
    expect(await response.json()).toMatchObject({
      data: {
        metadataAuthority: null,
        metadataAuthorityError: expect.any(String),
      },
    });
  }
);
