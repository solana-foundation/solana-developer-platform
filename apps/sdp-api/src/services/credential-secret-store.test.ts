import { describe, expect, it } from "vitest";
import type { Env } from "@/types/env";
import {
  CredentialSecretStoreError,
  createCredentialSecretStore,
  EncryptedDbCredentialSecretStore,
  GcpSecretManagerCredentialSecretStore,
  RuntimeEnvCredentialSecretStore,
  resolveCredentialSecretStoreBackend,
} from "./credential-secret-store";
import { createEncryptionService } from "./encryption.service";

function encodeBase64(value: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function testEncryptionKey(): string {
  let binary = "";
  for (const byte of new Uint8Array(32).fill(7)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

describe("GcpSecretManagerCredentialSecretStore", () => {
  it("creates, versions, reads, and destroys credential payloads by exact refs", async () => {
    const payload = {
      appId: "privy-app-id",
      appSecret: "privy-secret",
    };
    const requests: { url: string; method: string; body?: string }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? init.body : undefined;
      requests.push({ url, method, body });

      if (
        url.endsWith(
          "/v1/projects/sdp-dev-123/secrets?secretId=sdp-dev-provider-credentials-pcred_123"
        )
      ) {
        return new Response(
          JSON.stringify({
            name: "projects/sdp-dev-123/secrets/sdp-dev-provider-credentials-pcred_123",
          })
        );
      }

      if (
        url.endsWith(
          "/v1/projects/sdp-dev-123/secrets/sdp-dev-provider-credentials-pcred_123:addVersion"
        )
      ) {
        return new Response(
          JSON.stringify({
            name: "projects/sdp-dev-123/secrets/sdp-dev-provider-credentials-pcred_123/versions/1",
          })
        );
      }

      if (
        url.endsWith(
          "/v1/projects/sdp-dev-123/secrets/sdp-dev-provider-credentials-pcred_123/versions/1:access"
        )
      ) {
        return new Response(
          JSON.stringify({
            payload: {
              data: encodeBase64(JSON.stringify(payload)),
            },
          })
        );
      }

      if (
        url.endsWith(
          "/v1/projects/sdp-dev-123/secrets/sdp-dev-provider-credentials-pcred_123/versions/1:destroy"
        )
      ) {
        return new Response(
          JSON.stringify({
            name: "projects/sdp-dev-123/secrets/sdp-dev-provider-credentials-pcred_123/versions/1",
            state: "DESTROYED",
          })
        );
      }

      return new Response(JSON.stringify({ error: { status: "NOT_FOUND" } }), { status: 404 });
    };

    const store = new GcpSecretManagerCredentialSecretStore({
      projectId: "sdp-dev-123",
      secretPrefix: "sdp-dev-provider-credentials",
      accessToken: "test-token",
      fetcher,
    });

    const stored = await store.write({
      orgId: "org_123",
      provider: "privy",
      providerCredentialId: "pcred_123",
      payload,
    });

    expect(stored).toEqual({
      storageBackend: "gcp_secret_manager",
      secretRef: "projects/sdp-dev-123/secrets/sdp-dev-provider-credentials-pcred_123",
      secretVersionRef:
        "projects/sdp-dev-123/secrets/sdp-dev-provider-credentials-pcred_123/versions/1",
    });
    expect(await store.read({ orgId: "org_123", stored })).toEqual(payload);
    await store.destroyVersion({ secretVersionRef: stored.secretVersionRef as string });

    expect(requests.map((request) => request.method)).toEqual(["POST", "POST", "GET", "POST"]);
    expect(requests.map((request) => request.url).join("\n")).not.toContain(":list");
    expect(requests[0]?.body).not.toContain("privy-secret");
    expect(requests[1]?.body).toContain(encodeBase64(JSON.stringify(payload)));
  });

  it("rejects refs outside the managed project, prefix, or exact numeric version", async () => {
    const store = new GcpSecretManagerCredentialSecretStore({
      projectId: "sdp-dev-123",
      secretPrefix: "sdp-dev-provider-credentials",
      accessToken: "test-token",
      fetcher: async () => new Response("{}"),
    });

    await expect(
      store.write({
        orgId: "org_123",
        provider: "privy",
        providerCredentialId: "pcred_123",
        existingSecretRef: "projects/other-project/secrets/sdp-dev-provider-credentials-pcred_123",
        payload: { appSecret: "secret" },
      })
    ).rejects.toMatchObject({ code: "INVALID_SECRET_REF" });

    await expect(
      store.read({
        orgId: "org_123",
        stored: {
          storageBackend: "gcp_secret_manager",
          secretVersionRef:
            "projects/sdp-dev-123/secrets/sdp-dev-provider-credentials-pcred_123/versions/latest",
        },
      })
    ).rejects.toMatchObject({ code: "INVALID_SECRET_REF" });

    await expect(
      store.destroyVersion({
        secretVersionRef: "projects/sdp-dev-123/secrets/other-prefix-pcred_123/versions/1",
      })
    ).rejects.toMatchObject({ code: "INVALID_SECRET_REF" });
  });

  it("rejects project IDs outside GCP's 6-30 character limit", () => {
    expect(
      () =>
        new GcpSecretManagerCredentialSecretStore({
          projectId: "sdp-dev-123456789012345678901234",
          secretPrefix: "sdp-dev-provider-credentials",
          accessToken: "test-token",
          fetcher: async () => new Response("{}"),
        })
    ).toThrow(CredentialSecretStoreError);
  });

  it("uses the metadata server token flow when no token override is provided", async () => {
    const requests: { url: string; headers?: HeadersInit }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, headers: init?.headers });

      if (url === "http://metadata.test/token") {
        return new Response(JSON.stringify({ access_token: "metadata-token", expires_in: 300 }));
      }

      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer metadata-token");

      if (
        url.endsWith(
          "/v1/projects/sdp-dev-123/secrets?secretId=sdp-dev-provider-credentials-pcred_123"
        )
      ) {
        return new Response(
          JSON.stringify({
            name: "projects/sdp-dev-123/secrets/sdp-dev-provider-credentials-pcred_123",
          })
        );
      }

      return new Response(
        JSON.stringify({
          name: "projects/sdp-dev-123/secrets/sdp-dev-provider-credentials-pcred_123/versions/1",
        })
      );
    };

    const store = new GcpSecretManagerCredentialSecretStore({
      projectId: "sdp-dev-123",
      secretPrefix: "sdp-dev-provider-credentials",
      metadataTokenUrl: "http://metadata.test/token",
      fetcher,
      now: () => 1_000,
    });

    await store.write({
      orgId: "org_123",
      provider: "privy",
      providerCredentialId: "pcred_123",
      payload: { appSecret: "secret" },
    });

    expect(requests[0]).toMatchObject({
      url: "http://metadata.test/token",
      headers: { "Metadata-Flavor": "Google" },
    });
  });

  it("wraps malformed successful GCP responses in CredentialSecretStoreError", async () => {
    const store = new GcpSecretManagerCredentialSecretStore({
      projectId: "sdp-dev-123",
      secretPrefix: "sdp-dev-provider-credentials",
      accessToken: "test-token",
      fetcher: async () => new Response("not-json"),
    });

    await expect(
      store.write({
        orgId: "org_123",
        provider: "privy",
        providerCredentialId: "pcred_123",
        payload: { appSecret: "secret" },
      })
    ).rejects.toBeInstanceOf(CredentialSecretStoreError);
  });

  it("wraps invalid GCP payload base64 in CredentialSecretStoreError", async () => {
    const store = new GcpSecretManagerCredentialSecretStore({
      projectId: "sdp-dev-123",
      secretPrefix: "sdp-dev-provider-credentials",
      accessToken: "test-token",
      fetcher: async () =>
        new Response(
          JSON.stringify({
            payload: {
              data: "not valid base64!",
            },
          })
        ),
    });

    await expect(
      store.read({
        orgId: "org_123",
        stored: {
          storageBackend: "gcp_secret_manager",
          secretVersionRef:
            "projects/sdp-dev-123/secrets/sdp-dev-provider-credentials-pcred_123/versions/1",
        },
      })
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  });

  it("wraps GCP API network failures in CredentialSecretStoreError", async () => {
    const store = new GcpSecretManagerCredentialSecretStore({
      projectId: "sdp-dev-123",
      secretPrefix: "sdp-dev-provider-credentials",
      accessToken: "test-token",
      fetcher: async () => {
        throw new TypeError("network failure");
      },
    });

    await expect(
      store.write({
        orgId: "org_123",
        provider: "privy",
        providerCredentialId: "pcred_123",
        payload: { appSecret: "secret" },
      })
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  });

  it("wraps metadata token network failures in CredentialSecretStoreError", async () => {
    const store = new GcpSecretManagerCredentialSecretStore({
      projectId: "sdp-dev-123",
      secretPrefix: "sdp-dev-provider-credentials",
      fetcher: async () => {
        throw new TypeError("metadata unavailable");
      },
    });

    await expect(
      store.write({
        orgId: "org_123",
        provider: "privy",
        providerCredentialId: "pcred_123",
        payload: { appSecret: "secret" },
      })
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  });
});

describe("EncryptedDbCredentialSecretStore", () => {
  it("stores only ciphertext and decrypts with the organization key scope", async () => {
    const store = new EncryptedDbCredentialSecretStore(
      createEncryptionService(testEncryptionKey())
    );
    const payload = {
      appId: "privy-app-id",
      appSecret: "privy-secret",
    };

    const stored = await store.write({
      orgId: "org_123",
      provider: "privy",
      providerCredentialId: "pcred_123",
      payload,
    });

    expect(stored.storageBackend).toBe("encrypted_db");
    expect(stored.encryptedSecretPayload).toBeTruthy();
    expect(stored.encryptedSecretPayload).not.toContain("privy-secret");
    await expect(store.read({ orgId: "other_org", stored })).rejects.toBeInstanceOf(
      CredentialSecretStoreError
    );
    await expect(store.read({ orgId: "org_123", stored })).resolves.toEqual(payload);
  });

  it("wraps encryption failures in CredentialSecretStoreError", async () => {
    const store = new EncryptedDbCredentialSecretStore(createEncryptionService("not-a-valid-key"));

    await expect(
      store.write({
        orgId: "org_123",
        provider: "privy",
        providerCredentialId: "pcred_123",
        payload: { appSecret: "secret" },
      })
    ).rejects.toBeInstanceOf(CredentialSecretStoreError);
  });

  it("does not expose external version deletion for DB-backed storage", async () => {
    const store = new EncryptedDbCredentialSecretStore(
      createEncryptionService(testEncryptionKey())
    );

    await expect(
      store.destroyVersion({
        secretVersionRef: "projects/sdp-dev-123/secrets/foo/versions/1",
      })
    ).rejects.toBeInstanceOf(CredentialSecretStoreError);
  });
});

describe("RuntimeEnvCredentialSecretStore", () => {
  it("resolves configured runtime env vars without a persisted secret ref", async () => {
    const env = {
      PRIVY_APP_ID: "runtime-app-id",
      PRIVY_APP_SECRET: "runtime-app-secret",
    } as Env;
    const store = new RuntimeEnvCredentialSecretStore(env);

    await expect(
      store.read({
        orgId: "org_123",
        stored: {
          storageBackend: "runtime_env",
          runtimeEnvFields: {
            appId: "PRIVY_APP_ID",
            appSecret: "PRIVY_APP_SECRET",
          },
        },
      })
    ).resolves.toEqual({
      appId: "runtime-app-id",
      appSecret: "runtime-app-secret",
    });
  });

  it("is read-only and fails closed when runtime metadata or env vars are missing", async () => {
    const store = new RuntimeEnvCredentialSecretStore({} as Env);

    await expect(
      store.write({
        orgId: "org_123",
        provider: "privy",
        providerCredentialId: "pcred_123",
        payload: { appSecret: "secret" },
      })
    ).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });

    await expect(
      store.read({
        orgId: "org_123",
        stored: { storageBackend: "runtime_env" },
      })
    ).rejects.toMatchObject({ code: "MISSING_SECRET" });

    await expect(
      store.read({
        orgId: "org_123",
        stored: {
          storageBackend: "runtime_env",
          runtimeEnvFields: {
            appSecret: "PRIVY_APP_SECRET",
          },
        },
      })
    ).rejects.toMatchObject({ code: "MISSING_SECRET" });
  });
});

describe("resolveCredentialSecretStoreBackend", () => {
  it("defaults managed SDP to GCP Secret Manager and self-hosted SDP to encrypted DB", () => {
    expect(resolveCredentialSecretStoreBackend({ SDP_DEPLOYMENT_MODE: "managed" } as Env)).toBe(
      "gcp_secret_manager"
    );
    expect(resolveCredentialSecretStoreBackend({ SDP_DEPLOYMENT_MODE: "self_hosted" } as Env)).toBe(
      "encrypted_db"
    );
  });

  it("allows runtime env as an explicit override", () => {
    expect(
      resolveCredentialSecretStoreBackend({
        CREDENTIAL_SECRET_STORE_BACKEND: "runtime_env",
      } as Env)
    ).toBe("runtime_env");
  });

  it("wraps invalid deployment mode defaults in CredentialSecretStoreError", () => {
    let thrown: unknown;
    try {
      resolveCredentialSecretStoreBackend({ SDP_DEPLOYMENT_MODE: "invalid" } as unknown as Env);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CredentialSecretStoreError);
    expect(thrown).toMatchObject({ code: "INVALID_CONFIGURATION" });
  });
});

describe("createCredentialSecretStore", () => {
  it("wraps missing encrypted DB key configuration in CredentialSecretStoreError", () => {
    expect(() =>
      createCredentialSecretStore({
        CREDENTIAL_SECRET_STORE_BACKEND: "encrypted_db",
      } as Env)
    ).toThrow(CredentialSecretStoreError);
  });
});
