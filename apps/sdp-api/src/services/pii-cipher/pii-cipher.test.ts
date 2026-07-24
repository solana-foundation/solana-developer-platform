import { describe, expect, it, vi } from "vitest";
import {
  KmsPiiCipher,
  LocalPiiCipher,
  type PiiCipherContext,
  type PiiEnvelopeKms,
} from "./pii-cipher";

const context: PiiCipherContext = {
  organizationId: "org_1",
  projectId: "project_1",
  resourceType: "counterparty",
  resourceId: "counterparty_1",
  field: "identity",
};

function fakeKms(): PiiEnvelopeKms {
  const wrapped = new Map<string, { plaintext: Uint8Array; aad: string }>();
  return {
    encrypt: vi.fn(async (plaintext, aad) => {
      const id = `wrapped-${wrapped.size}`;
      wrapped.set(id, { plaintext: Uint8Array.from(plaintext), aad });
      return id;
    }),
    decrypt: vi.fn(async (ciphertext, aad) => {
      const entry = wrapped.get(ciphertext);
      if (!entry || entry.aad !== aad) {
        throw new Error("KMS authentication failed");
      }
      return Uint8Array.from(entry.plaintext);
    }),
  };
}

describe("KmsPiiCipher", () => {
  it("round-trips and binds the envelope and payload to the complete context", async () => {
    const cipher = new KmsPiiCipher(fakeKms());
    const encrypted = await cipher.encrypt(context, '{"email":"person@example.com"}');

    expect(encrypted).toMatch(/^pii-v1\./);
    await expect(cipher.decrypt(context, encrypted)).resolves.toBe(
      '{"email":"person@example.com"}'
    );
    await expect(
      cipher.decrypt({ ...context, organizationId: "org_2" }, encrypted)
    ).rejects.toThrow();
    await expect(
      cipher.decrypt({ ...context, field: "provider_data" }, encrypted)
    ).rejects.toThrow();
  });

  it("rejects tampered and malformed ciphertext", async () => {
    const cipher = new KmsPiiCipher(fakeKms());
    const encrypted = await cipher.encrypt(context, "secret");
    const tamperIndex = encrypted.length - 5;
    const original = encrypted[tamperIndex];
    const replacement = original === "A" ? "B" : "A";
    const tampered = `${encrypted.slice(0, tamperIndex)}${replacement}${encrypted.slice(
      tamperIndex + 1
    )}`;

    await expect(cipher.decrypt(context, tampered)).rejects.toThrow(/authentication/i);
    await expect(cipher.decrypt(context, "pii-v1.only-one-part")).rejects.toThrow(/malformed/i);
    await expect(cipher.decrypt(context, "not-pii")).rejects.toThrow(/envelope/i);
  });

  it("fails closed when KMS is unavailable", async () => {
    const unavailable: PiiEnvelopeKms = {
      encrypt: vi.fn(async () => {
        throw new Error("KMS unavailable");
      }),
      decrypt: vi.fn(async () => {
        throw new Error("KMS unavailable");
      }),
    };
    const cipher = new KmsPiiCipher(unavailable);

    await expect(cipher.encrypt(context, "secret")).rejects.toThrow(/unavailable/i);
    await expect(cipher.decrypt(context, "pii-v1.wrapped.AAAAAAAAAAAAAAAAAAAAAA")).rejects.toThrow(
      /unavailable/i
    );
  });

  it("decrypts envelopes created before and after KMS key rotation", async () => {
    let version = 1;
    const wrapped = new Map<string, { plaintext: Uint8Array; aad: string }>();
    const kms: PiiEnvelopeKms = {
      async encrypt(plaintext, aad) {
        const id = `version-${version}-wrapped-${wrapped.size}`;
        wrapped.set(id, { plaintext: Uint8Array.from(plaintext), aad });
        return id;
      },
      async decrypt(ciphertext, aad) {
        const entry = wrapped.get(ciphertext);
        if (!entry || entry.aad !== aad) {
          throw new Error("KMS authentication failed");
        }
        return Uint8Array.from(entry.plaintext);
      },
    };
    const cipher = new KmsPiiCipher(kms);
    const beforeRotation = await cipher.encrypt(context, "before");
    version = 2;
    const afterRotation = await cipher.encrypt(context, "after");

    await expect(cipher.decrypt(context, beforeRotation)).resolves.toBe("before");
    await expect(cipher.decrypt(context, afterRotation)).resolves.toBe("after");
  });
});

describe("LocalPiiCipher", () => {
  it("round-trips with a separate self-hosted key and enforces AAD", async () => {
    const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
    const cipher = new LocalPiiCipher(key);
    const encrypted = await cipher.encrypt(context, "local-secret");

    expect(encrypted).toMatch(/^pii-local-v1\./);
    await expect(cipher.decrypt(context, encrypted)).resolves.toBe("local-secret");
    await expect(
      cipher.decrypt({ ...context, resourceId: "counterparty_2" }, encrypted)
    ).rejects.toThrow(/authentication/i);
  });
});
