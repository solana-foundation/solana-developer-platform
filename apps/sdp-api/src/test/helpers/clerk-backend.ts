import { vi } from "vitest";
import { z } from "zod";
import type { Env } from "@/types/env";

const CLERK_API_URL = "https://clerk-backend.example.test/v1";

interface ClerkBackendRequest {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

export interface ClerkBackendAnswer {
  status: number;
  body: Record<string, unknown>;
}

export interface ClerkBackend {
  requests: ClerkBackendRequest[];
  answer: (...answers: ClerkBackendAnswer[]) => void;
}

/**
 * Points the Clerk Backend API at a stub that records every request and
 * answers them in order from the queued answers; a request with no answer
 * queued fails it. Session-token key lookups still reach the test issuer.
 *
 * @param env - The test env; its Clerk API URL and secret key are set.
 * @returns The recorded requests and the queue to answer them from.
 */
export function stubClerkBackend(env: Env): ClerkBackend {
  env.CLERK_API_URL = CLERK_API_URL;
  env.CLERK_SECRET_KEY = "sk_test_clerk_backend";
  const requests: ClerkBackendRequest[] = [];
  const queued: ClerkBackendAnswer[] = [];
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (env.CLERK_JWKS_URL !== undefined && request.url.startsWith(env.CLERK_JWKS_URL)) {
      return realFetch(input, init);
    }
    const url = new URL(request.url);
    if (!request.url.startsWith(CLERK_API_URL)) {
      throw new Error(`Unexpected fetch in test: ${request.method} ${request.url}`);
    }
    const text = await request.text();
    const path = `${url.pathname.slice(new URL(CLERK_API_URL).pathname.length)}${url.search}`;
    requests.push({
      method: request.method,
      path,
      body: text === "" ? null : z.record(z.string(), z.unknown()).parse(JSON.parse(text)),
    });
    const next = queued.shift();
    if (next === undefined) {
      throw new Error(`No Clerk answer queued for ${request.method} ${path}`);
    }
    return Response.json(next.body, { status: next.status });
  });
  return { requests, answer: (...answers) => queued.push(...answers) };
}
