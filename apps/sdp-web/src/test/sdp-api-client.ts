import { type Mock, vi } from "vitest";
import { z } from "zod";
import { type JsonValue, parseJsonValue } from "@/lib/idempotency";
import * as sdpApi from "@/lib/sdp-api";
import { required } from "./required";

/** The mocks behind the client `createSdpApiClient` answers with. */
export interface StubSdpApiClient {
  request: Mock<sdpApi.SdpApiClient["request"]>;
  /** Answers each `fetch`; what it resolves is what the action reads back. */
  fetch: Mock<(path: string, options?: RequestInit) => Promise<unknown>>;
}

/** One request a server action sent through `fetch`, with its JSON body parsed. */
export interface SentSdpApiRequest {
  path: string;
  method: string | undefined;
  headers: HeadersInit | undefined;
  body: JsonValue;
}

/**
 * Spies on `createSdpApiClient` to answer with a fresh client whose `request` and `fetch` are
 * mocks. Call it in `beforeEach`.
 *
 * @returns The client the code under test receives.
 */
export function stubSdpApiClient(): StubSdpApiClient {
  const stub: StubSdpApiClient = {
    request: vi.fn<sdpApi.SdpApiClient["request"]>(),
    fetch: vi.fn<(path: string, options?: RequestInit) => Promise<unknown>>(),
  };
  vi.spyOn(sdpApi, "createSdpApiClient").mockResolvedValue({
    request: stub.request,
    fetch: async <T>(path: string, options?: RequestInit): Promise<T> =>
      // SAFETY: `fetch<T>` trusts the caller's T for sdp-api's answer, as the real client does;
      // the test answers with the body the action expects.
      (await stub.fetch(path, options)) as T,
  });
  return stub;
}

/**
 * Every request sent through the stub's `fetch`, in order; a request without a JSON string
 * body fails where it is read.
 *
 * @param client - The stub from {@link stubSdpApiClient}.
 * @returns The sent requests.
 */
export function sentSdpApiRequests(client: StubSdpApiClient): SentSdpApiRequest[] {
  return client.fetch.mock.calls.map(([path, options]) => {
    const init = required(options);
    return {
      path,
      method: init.method,
      headers: init.headers,
      body: parseJsonValue(z.string().parse(init.body)),
    };
  });
}
