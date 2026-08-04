import { describe, expect, it, vi } from "vitest";
import { KmsClient } from "./kms-client";

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const KEY = "projects/p/locations/us-central1/keyRings/sdp/cryptoKeys/custody";

function tokenProvider() {
  return { getToken: vi.fn().mockResolvedValue("tok-1") };
}

describe("KmsClient", () => {
  it("wraps plaintext via the KMS :encrypt endpoint with AAD", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ciphertext: b64(new Uint8Array([9, 9, 9])) }), {
        status: 200,
      })
    );
    const client = new KmsClient({
      keyName: KEY,
      apiBaseUrl: "https://cloudkms.googleapis.com",
      tokenProvider: tokenProvider(),
      fetchImpl: fetchMock,
    });

    const wrapped = await client.encrypt(new Uint8Array([1, 2, 3]), "org:o1");

    expect(wrapped).toBe(b64(new Uint8Array([9, 9, 9])));
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`https://cloudkms.googleapis.com/v1/${KEY}:encrypt`);
    const body = JSON.parse(init.body as string);
    expect(body.plaintext).toBe(b64(new Uint8Array([1, 2, 3])));
    expect(body.additionalAuthenticatedData).toBe(btoa("org:o1"));
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-1");
  });

  it("unwraps ciphertext via :decrypt and returns bytes", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ plaintext: b64(new Uint8Array([1, 2, 3])) }), { status: 200 })
      );
    const client = new KmsClient({
      keyName: KEY,
      apiBaseUrl: "https://cloudkms.googleapis.com",
      tokenProvider: tokenProvider(),
      fetchImpl: fetchMock,
    });

    const out = await client.decrypt(b64(new Uint8Array([9, 9, 9])), "org:o1");

    expect(Array.from(out)).toEqual([1, 2, 3]);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      `https://cloudkms.googleapis.com/v1/${KEY}:decrypt`
    );
  });

  it("throws on a KMS error response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("denied", { status: 403 }));
    const client = new KmsClient({
      keyName: KEY,
      apiBaseUrl: "https://cloudkms.googleapis.com",
      tokenProvider: tokenProvider(),
      fetchImpl: fetchMock,
    });
    await expect(client.encrypt(new Uint8Array([1]), "org:o1")).rejects.toThrow(/kms/i);
  });
});
