import { describe, expect, it, vi } from "vitest";
import { createAuthClient, spcLogin, spcRegister } from "./auth";
import { PrivateChannelError } from "./errors";

const BASE = "http://auth.example:8903";

/** A fetch stub that records the last call and returns a canned response. */
function stubFetch(response: Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("createAuthClient", () => {
  it("login returns the token", async () => {
    const { fetchImpl, calls } = stubFetch(json({ token: "jwt-123" }));
    const client = createAuthClient(BASE, { fetchImpl });
    await expect(client.login({ username: "u", password: "p" })).resolves.toEqual({
      token: "jwt-123",
    });
    expect(calls[0].url).toBe("http://auth.example:8903/auth/login");
  });

  it("challengeWallet sends the bearer token and no body", async () => {
    const { fetchImpl, calls } = stubFetch(
      json({ message: "PrivateChannel wallet verification\n…", nonce: "n1", expires_at: "later" })
    );
    const client = createAuthClient(BASE, { fetchImpl });

    const challenge = await client.challengeWallet("jwt-123");

    expect(challenge.nonce).toBe("n1");
    expect(calls[0].url).toBe("http://auth.example:8903/auth/challenge-wallet");
    const headers = new Headers(calls[0].init.headers);
    expect(headers.get("Authorization")).toBe("Bearer jwt-123");
    expect(calls[0].init.body).toBeUndefined();
  });

  it("verifyWallet sends bearer + body and returns the verified wallet", async () => {
    const { fetchImpl, calls } = stubFetch(
      json({ pubkey: "PubKey11111", created_at: "2026-07-15T00:00:00Z" })
    );
    const client = createAuthClient(BASE, { fetchImpl });

    const wallet = await client.verifyWallet("jwt-123", {
      pubkey: "PubKey11111",
      nonce: "n1",
      signature: "base58sig",
    });

    expect(wallet.pubkey).toBe("PubKey11111");
    const headers = new Headers(calls[0].init.headers);
    expect(headers.get("Authorization")).toBe("Bearer jwt-123");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      pubkey: "PubKey11111",
      nonce: "n1",
      signature: "base58sig",
    });
  });

  it("deleteWallet sends a bearer DELETE and resolves with no content", async () => {
    const { fetchImpl, calls } = stubFetch(new Response("", { status: 200 }));
    const client = createAuthClient(BASE, { fetchImpl });

    await expect(client.deleteWallet("jwt-123", "PubKey11111")).resolves.toBeUndefined();
    expect(calls[0].url).toBe("http://auth.example:8903/auth/wallets/PubKey11111");
    expect(calls[0].init.method).toBe("DELETE");
    const headers = new Headers(calls[0].init.headers);
    expect(headers.get("Authorization")).toBe("Bearer jwt-123");
  });

  it("classifies a 401 as UNAUTHORIZED", async () => {
    const { fetchImpl } = stubFetch(json({ error: "bad credentials" }, 401));
    const client = createAuthClient(BASE, { fetchImpl });
    await expect(client.login({ username: "u", password: "p" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("classifies a 5xx as AUTH_UNAVAILABLE", async () => {
    const { fetchImpl } = stubFetch(json({ error: "boom" }, 503));
    const client = createAuthClient(BASE, { fetchImpl });
    await expect(client.challengeWallet("t")).rejects.toMatchObject({
      code: "AUTH_UNAVAILABLE",
    });
  });

  it("maps a network failure to AUTH_UNAVAILABLE", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const client = createAuthClient(BASE, { fetchImpl });
    await expect(client.login({ username: "u", password: "p" })).rejects.toBeInstanceOf(
      PrivateChannelError
    );
    await expect(client.login({ username: "u", password: "p" })).rejects.toMatchObject({
      code: "AUTH_UNAVAILABLE",
    });
  });

  it("throws BAD_REQUEST when the auth base URL is empty", async () => {
    const { fetchImpl } = stubFetch(json({}));
    const client = createAuthClient("", { fetchImpl });
    await expect(client.login({ username: "u", password: "p" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });
});

describe("spcRegister / spcLogin", () => {
  it("spcRegister posts credentials and maps the user to camelCase", async () => {
    const { fetchImpl, calls } = stubFetch(
      json({ id: "u1", username: "sdp_abc", role: "user", created_at: "2026-07-15T00:00:00Z" })
    );

    const user = await spcRegister(BASE, { username: "sdp_abc", password: "pw" }, { fetchImpl });

    expect(user).toEqual({
      id: "u1",
      username: "sdp_abc",
      role: "user",
      createdAt: "2026-07-15T00:00:00Z",
    });
    expect(calls[0].url).toBe("http://auth.example:8903/auth/register");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ username: "sdp_abc", password: "pw" });
  });

  it("spcRegister preserves the operator role", async () => {
    const { fetchImpl } = stubFetch(
      json({ id: "u2", username: "op", role: "operator", created_at: "2026-07-15T00:00:00Z" })
    );
    const user = await spcRegister(BASE, { username: "op", password: "pw" }, { fetchImpl });
    expect(user.role).toBe("operator");
  });

  it("spcRegister surfaces a 409 as CONFLICT with the server's message", async () => {
    const { fetchImpl } = stubFetch(json({ error: "username already taken" }, 409));
    await expect(
      spcRegister(BASE, { username: "u", password: "p" }, { fetchImpl })
    ).rejects.toMatchObject({ code: "CONFLICT", message: "username already taken" });
  });

  it("spcLogin returns the token", async () => {
    const { fetchImpl } = stubFetch(json({ token: "jwt-xyz" }));
    await expect(spcLogin(BASE, { username: "u", password: "p" }, { fetchImpl })).resolves.toEqual({
      token: "jwt-xyz",
    });
  });
});
