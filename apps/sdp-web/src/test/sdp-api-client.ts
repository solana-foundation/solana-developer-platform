import { type Mock, vi } from "vitest";
import { z } from "zod";
import { type JsonValue, parseJsonValue } from "@/lib/idempotency";
import * as sdpApi from "@/lib/sdp-api";
import { required } from "./required";

/** The mocks behind the client `createSdpApiClient` answers with. */
export interface StubSdpApiClient {
  request: Mock<sdpApi.SdpApiClient["request"]>;
  /** Answers each `fetch` with sdp-api's `data` for it, or rejects as the client would. */
  fetch: Mock<(path: string, options?: RequestInit) => Promise<JsonValue>>;
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
    fetch: vi.fn<(path: string, options?: RequestInit) => Promise<JsonValue>>(),
  };
  vi.spyOn(sdpApi, "createSdpApiClient").mockResolvedValue({
    request: stub.request,
    fetch: async <T>(path: string, options?: RequestInit): Promise<T> =>
      // SAFETY: `fetch<T>` trusts the caller's T for sdp-api's `data`, as the real client does;
      // the test answers each path with the JSON sdp-api sends for it.
      (await stub.fetch(path, options)) as T,
  });
  return stub;
}

/**
 * Answers each `fetch` by its path with sdp-api's `data` for that path; a request to a path with
 * no answer fails where it is sent.
 *
 * @param client - The stub from {@link stubSdpApiClient}.
 * @param answers - The `data` each path answers with, keyed by the path the action sends.
 */
export function answerSdpApiPaths(
  client: StubSdpApiClient,
  answers: Readonly<Record<string, JsonValue>>
): void {
  client.fetch.mockImplementation(async (path) => {
    const answer = answers[path];
    if (answer === undefined) throw new Error(`No sdp-api answer for ${path}`);
    return answer;
  });
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
