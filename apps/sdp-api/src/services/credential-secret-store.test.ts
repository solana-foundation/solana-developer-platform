import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "@/types/env";
import {
  CredentialSecretStoreError,
  createCredentialSecretStore,
  EncryptedDbCredentialSecretStore,
  GcpSecretManagerCredentialSecretStore,
  prepareGcpCredentialSecret,
  RuntimeEnvCredentialSecretStore,
  resolveCredentialSecretStoreBackend,
} from "./credential-secret-store";
import { createCustodyCipher } from "./custody-cipher/cipher-router";

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

// Secret Manager canonicalizes resource names to the numeric project id, so
// every ref it returns -- and therefore every ref we persist -- is spelled with
// the number even though we address it by project id. Fixtures that answered
// with the project id instead were what let HOO-1390 ship: they asserted the
// bug was correct behaviour.
const PROJECT_ID = "sdp-dev-123";
const PROJECT_NUMBER = "1049637352508";
const SECRET_ID = "sdp-dev-provider-credentials-pcred_123";

describe("GcpSecretManagerCredentialSecretStore", () => {
  afterEach(() => vi.restoreAllMocks());

  it("prepares the same dedicated parent as a later write without contacting GCP", async () => {
    const env = {
      GCP_SECRET_MANAGER_PROJECT_ID: PROJECT_ID,
      GCP_SECRET_MANAGER_SECRET_PREFIX: "sdp-dev-provider-credentials",
    } as Env;
    const prepared = prepareGcpCredentialSecret(env, "pcred_123");
    expect(prepared).toEqual({
      storageBackend: "gcp_secret_manager",
      secretRef: `projects/${PROJECT_ID}/secrets/${SECRET_ID}`,
    });
    const store = new GcpSecretManagerCredentialSecretStore({
      projectId: PROJECT_ID,
      projectNumber: PROJECT_NUMBER,
      secretPrefix: "sdp-dev-provider-credentials",
      accessToken: "test-token",
      fetcher: async (input) => {
        if (String(input).endsWith(":addVersion")) {
          return Response.json({
            name: `projects/${PROJECT_NUMBER}/secrets/${SECRET_ID}/versions/1`,
          });
        }
        return Response.json({ name: prepared.secretRef });
      },
    });
    const stored = await store.write({
      orgId: "org_123",
      provider: "privy",
      providerCredentialId: "pcred_123",
      payload: { appSecret: "secret" },
    });
    expect(stored.secretRef).toBe(prepared.secretRef);
  });

  it("lists one bounded metadata page for the exact dedicated parent", async () => {
    const secretRef = `projects/${PROJECT_ID}/secrets/${SECRET_ID}`;
    const versionRef = `projects/${PROJECT_NUMBER}/secrets/${SECRET_ID}/versions/7`;
    const urls: string[] = [];
    const store = new GcpSecretManagerCredentialSecretStore({
      projectId: PROJECT_ID,
      projectNumber: PROJECT_NUMBER,
      secretPrefix: "sdp-dev-provider-credentials",
      accessToken: "test-token",
      fetcher: async (input) => {
        urls.push(String(input));
        return Response.json({
          versions: [{ name: versionRef, state: "ENABLED", createTime: "2026-01-01" }],
          nextPageToken: "next/page=2",
        });
      },
    });
    await expect(store.listVersions({ secretRef, pageToken: "prior/page=1" })).resolves.toEqual({
      versions: [{ secretVersionRef: versionRef, state: "ENABLED" }],
      nextPageToken: "next/page=2",
    });
    expect(urls).toEqual([
      `https://secretmanager.googleapis.com/v1/${secretRef}/versions?pageSize=25&pageToken=prior%2Fpage%3D1`,
    ]);
  });

  it("can omit destroyed history from a live-version cleanup inventory", async () => {
    const urls: string[] = [];
    const store = new GcpSecretManagerCredentialSecretStore({
      projectId: PROJECT_ID,
      projectNumber: PROJECT_NUMBER,
      secretPrefix: "sdp-dev-provider-credentials",
      accessToken: "test-token",
      fetcher: async (input) => {
        urls.push(String(input));
        return Response.json({});
      },
    });
    await store.listVersions({
      secretRef: `projects/${PROJECT_ID}/secrets/${SECRET_ID}`,
      liveOnly: true,
    });
    expect(new URL(urls[0] ?? "").searchParams.get("filter")).toBe("state:(ENABLED OR DISABLED)");
  });

  it.each([
    [
      "another managed secret",
      {
        versions: [
          {
            name: `projects/${PROJECT_NUMBER}/secrets/sdp-dev-provider-credentials-other/versions/7`,
            state: "ENABLED",
          },
        ],
      },
    ],
    [
      "another project",
      {
        versions: [
          { name: `projects/9999999999/secrets/${SECRET_ID}/versions/7`, state: "ENABLED" },
        ],
      },
    ],
    [
      "another prefix",
      {
        versions: [
          { name: `projects/${PROJECT_NUMBER}/secrets/unmanaged/versions/7`, state: "ENABLED" },
        ],
      },
    ],
    [
      "an alias",
      {
        versions: [
          {
            name: `projects/${PROJECT_NUMBER}/secrets/${SECRET_ID}/versions/latest`,
            state: "ENABLED",
          },
        ],
      },
    ],
    [
      "an unknown state",
      {
        versions: [
          { name: `projects/${PROJECT_NUMBER}/secrets/${SECRET_ID}/versions/7`, state: "UNKNOWN" },
        ],
      },
    ],
    ["a missing name", { versions: [{ state: "ENABLED" }] }],
    ["a malformed version", { versions: [null] }],
    ["a malformed page", { versions: {} }],
    ["a malformed token", { nextPageToken: 7 }],
    ["an absent body", null],
  ])("refuses a list response containing %s", async (_reason, body) => {
    const store = new GcpSecretManagerCredentialSecretStore({
      projectId: PROJECT_ID,
      projectNumber: PROJECT_NUMBER,
      secretPrefix: "sdp-dev-provider-credentials",
      accessToken: "test-token",
      fetcher: async () => Response.json(body),
    });
    await expect(
      store.listVersions({
        secretRef: `projects/${PROJECT_ID}/secrets/${SECRET_ID}`,
      })
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  });

  it("rejects a page that exceeds the requested cleanup bound", async () => {
    const store = new GcpSecretManagerCredentialSecretStore({
      projectId: PROJECT_ID,
      projectNumber: PROJECT_NUMBER,
      secretPrefix: "sdp-dev-provider-credentials",
      accessToken: "test-token",
      fetcher: async () =>
        Response.json({
          versions: Array.from({ length: 26 }, (_, index) => ({
            name: `projects/${PROJECT_NUMBER}/secrets/${SECRET_ID}/versions/${index + 1}`,
            state: "ENABLED",
          })),
        }),
    });
    await expect(
      store.listVersions({ secretRef: `projects/${PROJECT_ID}/secrets/${SECRET_ID}` })
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  });

  it("treats an absent parent on the first inventory page as an empty observation", async () => {
    const store = new GcpSecretManagerCredentialSecretStore({
      projectId: PROJECT_ID,
      projectNumber: PROJECT_NUMBER,
      secretPrefix: "sdp-dev-provider-credentials",
      accessToken: "test-token",
      fetcher: async () => Response.json({ error: { status: "NOT_FOUND" } }, { status: 404 }),
    });
    await expect(
      store.listVersions({
        secretRef: `projects/${PROJECT_ID}/secrets/${SECRET_ID}`,
      })
    ).resolves.toEqual({ versions: [] });
  });

  it.each([
    "not a GCP error response",
    JSON.stringify({ error: { status: "PERMISSION_DENIED" } }),
    JSON.stringify({ error: { status: "NOT_FOUND", code: 500 } }),
  ])(
    "does not treat a malformed 404 body as a successful absence observation: %s",
    async (body) => {
      const store = new GcpSecretManagerCredentialSecretStore({
        projectId: PROJECT_ID,
        projectNumber: PROJECT_NUMBER,
        secretPrefix: "sdp-dev-provider-credentials",
        accessToken: "test-token",
        fetcher: async () => new Response(body, { status: 404 }),
      });
      await expect(
        store.listVersions({
          secretRef: `projects/${PROJECT_ID}/secrets/${SECRET_ID}`,
        })
      ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    }
  );

  it("returns empty metadata pages but keeps a missing pagination parent as an upstream error", async () => {
    const store = new GcpSecretManagerCredentialSecretStore({
      projectId: PROJECT_ID,
      projectNumber: PROJECT_NUMBER,
      secretPrefix: "sdp-dev-provider-credentials",
      accessToken: "test-token",
      fetcher: async (input) =>
        String(input).includes("pageToken=missing")
          ? Response.json({ error: { status: "NOT_FOUND" } }, { status: 404 })
          : Response.json({}),
    });
    const secretRef = `projects/${PROJECT_ID}/secrets/${SECRET_ID}`;
    await expect(store.listVersions({ secretRef })).resolves.toEqual({ versions: [] });
    await expect(store.listVersions({ secretRef, pageToken: "missing" })).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
    });
  });

  it.each([403, 429, 500, 503])("never treats inventory HTTP %i as absence", async (status) => {
    const store = new GcpSecretManagerCredentialSecretStore({
      projectId: PROJECT_ID,
      projectNumber: PROJECT_NUMBER,
      secretPrefix: "sdp-dev-provider-credentials",
      accessToken: "test-token",
      fetcher: async () => new Response(null, { status }),
    });
    await expect(
      store.listVersions({
        secretRef: `projects/${PROJECT_ID}/secrets/${SECRET_ID}`,
      })
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  });

  it("does not mistake a metadata-server 404 for an absent secret parent", async () => {
    const store = new GcpSecretManagerCredentialSecretStore({
      projectId: PROJECT_ID,
      secretPrefix: "sdp-dev-provider-credentials",
      metadataProjectNumberUrl: "https://metadata.test/absent-project",
      fetcher: async () => new Response(null, { status: 404 }),
    });
    await expect(
      store.listVersions({
        secretRef: `projects/${PROJECT_ID}/secrets/${SECRET_ID}`,
      })
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  });

  it("makes no new requests after cancellation even with cached project metadata and token", async () => {
    const requests: string[] = [];
    const store = new GcpSecretManagerCredentialSecretStore({
      projectId: PROJECT_ID,
      secretPrefix: "sdp-dev-provider-credentials",
      metadataProjectNumberUrl: "https://metadata.test/pre-aborted/project",
      metadataTokenUrl: "https://metadata.test/pre-aborted/token",
      fetcher: async (input) => {
        const url = String(input);
        requests.push(url);
        if (url.endsWith("/project")) return new Response(PROJECT_NUMBER);
        if (url.endsWith("/token"))
          return Response.json({ access_token: "test-token", expires_in: 300 });
        return Response.json({});
      },
    });
    const secretRef = `projects/${PROJECT_ID}/secrets/${SECRET_ID}`;
    await store.listVersions({ secretRef });
    const count = requests.length;
    const signal = AbortSignal.abort();
    await expect(store.listVersions({ secretRef, signal })).rejects.toThrow();
    await expect(
      store.destroyVersion({ secretVersionRef: `${secretRef}/versions/7`, signal })
    ).rejects.toThrow();
    expect(requests).toHaveLength(count);
  });

  it.each(["project-number", "token", "secret"] as const)(
    "bounds a stalled %s response body and reports an upstream failure",
    async (stalled) => {
      const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
      const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => nativeTimeout(10));
      let observedSignal: AbortSignal | null | undefined;
      const projectUrl = `https://metadata.test/${stalled}/project-number`;
      const tokenUrl = `https://metadata.test/${stalled}/token`;
      const store = new GcpSecretManagerCredentialSecretStore({
        projectId: PROJECT_ID,
        secretPrefix: "sdp-dev-provider-credentials",
        metadataProjectNumberUrl: projectUrl,
        metadataTokenUrl: tokenUrl,
        fetcher: async (input, init) => {
          const url = String(input);
          const phase =
            url === projectUrl ? "project-number" : url === tokenUrl ? "token" : "secret";
          if (phase === stalled) {
            observedSignal = init?.signal;
            if (!observedSignal) throw new Error("Missing request deadline");
            const signal = observedSignal;
            return new Response(
              new ReadableStream({
                start(controller) {
                  signal.addEventListener("abort", () => controller.error(signal.reason), {
                    once: true,
                  });
                },
              })
            );
          }
          if (phase === "project-number") return new Response(PROJECT_NUMBER);
          return Response.json({ access_token: "test-token", expires_in: 300 });
        },
      });

      await expect(
        store.read({
          orgId: "org_123",
          stored: {
            storageBackend: "gcp_secret_manager",
            secretVersionRef: `projects/${PROJECT_NUMBER}/secrets/${SECRET_ID}/versions/1`,
          },
        })
      ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
      expect(timeout).toHaveBeenCalledWith(10_000);
      expect(observedSignal?.aborted).toBe(true);
    }
  );

  it("does not retry an add-version request after its deadline expires", async () => {
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => nativeTimeout(10));
    const requests: string[] = [];
    const store = new GcpSecretManagerCredentialSecretStore({
      projectId: PROJECT_ID,
      projectNumber: PROJECT_NUMBER,
      secretPrefix: "sdp-dev-provider-credentials",
      accessToken: "test-token",
      fetcher: async (input, init) => {
        requests.push(String(input));
        const signal = init?.signal;
        if (!signal) throw new Error("Missing request deadline");
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    });
    await expect(
      store.write({
        orgId: "org_123",
        provider: "privy",
        providerCredentialId: "pcred_123",
        existingSecretRef: `projects/${PROJECT_ID}/secrets/${SECRET_ID}`,
        payload: { appId: "app", appSecret: "secret" },
      })
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    expect(requests).toEqual([
      `https://secretmanager.googleapis.com/v1/projects/${PROJECT_ID}/secrets/${SECRET_ID}:addVersion`,
    ]);
  });

  it.each([false, true])(
    "verifies a timed-out destroy with a fresh deadline (outer signal: %s)",
    async (withOuterSignal) => {
      const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
      vi.spyOn(AbortSignal, "timeout").mockImplementation(() => nativeTimeout(10));
      const versionRef = `projects/${PROJECT_NUMBER}/secrets/${SECRET_ID}/versions/7`;
      const signals: AbortSignal[] = [];
      const urls: string[] = [];
      const store = new GcpSecretManagerCredentialSecretStore({
        projectId: PROJECT_ID,
        projectNumber: PROJECT_NUMBER,
        secretPrefix: "sdp-dev-provider-credentials",
        accessToken: "test-token",
        fetcher: async (input, init) => {
          urls.push(String(input));
          const signal = init?.signal;
          if (!signal) throw new Error("Missing request deadline");
          signals.push(signal);
          signal.throwIfAborted();
          if (init?.method === "POST") {
            return new Promise<Response>((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
          }
          return Response.json({ name: versionRef, state: "DESTROYED" });
        },
      });
      await expect(
        store.destroyVersion({
          secretVersionRef: versionRef,
          ...(withOuterSignal ? { signal: new AbortController().signal } : {}),
        })
      ).resolves.toBeUndefined();
      expect(urls).toEqual([
        `https://secretmanager.googleapis.com/v1/${versionRef}:destroy`,
        `https://secretmanager.googleapis.com/v1/${versionRef}`,
      ]);
      expect(signals[0]?.aborted).toBe(true);
      expect(signals[1]).not.toBe(signals[0]);
      expect(signals[1]?.aborted).toBe(false);
    }
  );

  it("does not start verification after the cleanup deadline expires during destroy", async () => {
    const controller = new AbortController();
    const versionRef = `projects/${PROJECT_NUMBER}/secrets/${SECRET_ID}/versions/7`;
    const requests: string[] = [];
    const store = new GcpSecretManagerCredentialSecretStore({
      projectId: PROJECT_ID,
      projectNumber: PROJECT_NUMBER,
      secretPrefix: "sdp-dev-provider-credentials",
      accessToken: "test-token",
      fetcher: async (input, init) => {
        requests.push(String(input));
        if (init?.method === "POST") {
          controller.abort();
          throw new Error("destroy response lost");
        }
        return Response.json({ name: versionRef, state: "DESTROYED" });
      },
    });
    await expect(
      store.destroyVersion({ secretVersionRef: versionRef, signal: controller.signal })
    ).rejects.toThrow();
    expect(requests).toEqual([`https://secretmanager.googleapis.com/v1/${versionRef}:destroy`]);
  });

  it.each(["project-number", "token", "destroy", "verification", "list"] as const)(
    "cancels a stalled %s body at the cleanup deadline",
    async (stalled) => {
      const controller = new AbortController();
      const projectUrl = `https://metadata.test/outer-abort/${stalled}/project`;
      const tokenUrl = `https://metadata.test/outer-abort/${stalled}/token`;
      const versionRef = `projects/${PROJECT_NUMBER}/secrets/${SECRET_ID}/versions/7`;
      const requests: string[] = [];
      let pendingBody: ReadableStreamDefaultController<Uint8Array> | undefined;
      let observedSignal: AbortSignal | null | undefined;
      let bodyReady!: () => void;
      const ready = new Promise<void>((resolve) => {
        bodyReady = resolve;
      });
      const store = new GcpSecretManagerCredentialSecretStore({
        projectId: PROJECT_ID,
        secretPrefix: "sdp-dev-provider-credentials",
        metadataProjectNumberUrl: projectUrl,
        metadataTokenUrl: tokenUrl,
        fetcher: async (input, init) => {
          const url = String(input);
          requests.push(url);
          const phase =
            url === projectUrl
              ? "project-number"
              : url === tokenUrl
                ? "token"
                : url.includes("/versions?")
                  ? "list"
                  : init?.method === "POST"
                    ? "destroy"
                    : "verification";
          if (phase === stalled) {
            observedSignal = init?.signal;
            if (!observedSignal) throw new Error("Missing request signal");
            const signal = observedSignal;
            return new Response(
              new ReadableStream<Uint8Array>({
                start(body) {
                  pendingBody = body;
                  signal.addEventListener("abort", () => body.error(signal.reason), { once: true });
                  bodyReady();
                },
              })
            );
          }
          if (phase === "project-number") return new Response(PROJECT_NUMBER);
          if (phase === "token")
            return Response.json({ access_token: "test-token", expires_in: 300 });
          if (phase === "destroy")
            return Response.json({ error: { status: "UNAVAILABLE" } }, { status: 503 });
          return Response.json({ name: versionRef, state: "DESTROYED" });
        },
      });
      const operation =
        stalled === "list"
          ? store.listVersions({
              secretRef: `projects/${PROJECT_ID}/secrets/${SECRET_ID}`,
              signal: controller.signal,
            })
          : store.destroyVersion({ secretVersionRef: versionRef, signal: controller.signal });
      // Attach a rejection handler before aborting the in-flight HTTP body.
      const outcome = operation.then(
        () => "completed",
        () => "rejected"
      );
      await ready;
      const countAtDeadline = requests.length;
      controller.abort();
      const cancelled = observedSignal?.aborted;
      // Let a broken implementation settle too, without waiting for its 10-second timer.
      if (!cancelled) pendingBody?.error(new Error("test released ignored deadline"));
      expect(await outcome).toBe("rejected");
      expect(cancelled).toBe(true);
      expect(requests).toHaveLength(countAtDeadline);
    }
  );

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

      // Addressed by project id, answered with the project number.
      if (url.endsWith(`/v1/projects/${PROJECT_ID}/secrets?secretId=${SECRET_ID}`)) {
        return new Response(
          JSON.stringify({
            name: `projects/${PROJECT_NUMBER}/secrets/${SECRET_ID}`,
          })
        );
      }

      if (url.endsWith(`/v1/projects/${PROJECT_ID}/secrets/${SECRET_ID}:addVersion`)) {
        return new Response(
          JSON.stringify({
            name: `projects/${PROJECT_NUMBER}/secrets/${SECRET_ID}/versions/1`,
          })
        );
      }

      // The persisted ref is normalized back to the project-ID spelling, so
      // the reads that follow are addressed by id (GCP accepts either).
      if (url.endsWith(`/v1/projects/${PROJECT_ID}/secrets/${SECRET_ID}/versions/1:access`)) {
        return new Response(
          JSON.stringify({
            payload: {
              data: encodeBase64(JSON.stringify(payload)),
            },
          })
        );
      }

      if (url.endsWith(`/v1/projects/${PROJECT_ID}/secrets/${SECRET_ID}/versions/1:destroy`)) {
        return new Response(
          JSON.stringify({
            name: `projects/${PROJECT_NUMBER}/secrets/${SECRET_ID}/versions/1`,
            state: "DESTROYED",
          })
        );
      }

      return new Response(JSON.stringify({ error: { status: "NOT_FOUND" } }), { status: 404 });
    };

    const store = new GcpSecretManagerCredentialSecretStore({
      projectId: PROJECT_ID,
      projectNumber: PROJECT_NUMBER,
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
      secretRef: `projects/${PROJECT_ID}/secrets/${SECRET_ID}`,
      secretVersionRef: `projects/${PROJECT_ID}/secrets/${SECRET_ID}/versions/1`,
    });
    expect(await store.read({ orgId: "org_123", stored })).toEqual(payload);
    await store.destroyVersion({ secretVersionRef: stored.secretVersionRef as string });

    expect(requests.map((request) => request.method)).toEqual(["POST", "POST", "GET", "POST"]);
    expect(requests.map((request) => request.url).join("\n")).not.toContain(":list");
    expect(requests[0]?.body).not.toContain("privy-secret");
    expect(requests[1]?.body).toContain(encodeBase64(JSON.stringify(payload)));
  });

  it("accepts a failed destroy only after the same exact version is confirmed DESTROYED", async () => {
    const versionRef = `projects/${PROJECT_NUMBER}/secrets/${SECRET_ID}/versions/7`;
    const requests: { url: string; method: string }[] = [];
    const store = new GcpSecretManagerCredentialSecretStore({
      projectId: PROJECT_ID,
      projectNumber: PROJECT_NUMBER,
      secretPrefix: "sdp-dev-provider-credentials",
      accessToken: "test-token",
      fetcher: async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        requests.push({ url, method });
        if (method === "POST") {
          throw new TypeError("connection reset after request");
        }
        return new Response(JSON.stringify({ name: versionRef, state: "DESTROYED" }));
      },
    });

    await expect(store.destroyVersion({ secretVersionRef: versionRef })).resolves.toBeUndefined();
    expect(requests).toEqual([
      {
        url: `https://secretmanager.googleapis.com/v1/${versionRef}:destroy`,
        method: "POST",
      },
      { url: `https://secretmanager.googleapis.com/v1/${versionRef}`, method: "GET" },
    ]);
  });

  it("accepts a successful delayed destruction request by default without requiring a metadata lookup", async () => {
    const versionRef = `projects/${PROJECT_NUMBER}/secrets/${SECRET_ID}/versions/7`;
    const fetcher = vi.fn(async () =>
      Response.json({
        name: versionRef,
        state: "DISABLED",
        scheduledDestroyTime: "2099-01-01T00:00:00Z",
      })
    );
    const store = new GcpSecretManagerCredentialSecretStore({
      projectId: PROJECT_ID,
      projectNumber: PROJECT_NUMBER,
      secretPrefix: "sdp-dev-provider-credentials",
      accessToken: "test-token",
      fetcher,
    });

    await expect(store.destroyVersion({ secretVersionRef: versionRef })).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("does not report delayed destruction as confirmed payload destruction when required", async () => {
    const versionRef = `projects/${PROJECT_NUMBER}/secrets/${SECRET_ID}/versions/7`;
    const store = new GcpSecretManagerCredentialSecretStore({
      projectId: PROJECT_ID,
      projectNumber: PROJECT_NUMBER,
      secretPrefix: "sdp-dev-provider-credentials",
      accessToken: "test-token",
      fetcher: async () => Response.json({ name: versionRef, state: "DISABLED" }),
    });
    await expect(
      store.destroyVersion({ secretVersionRef: versionRef, requireDestroyed: true })
    ).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
    });
  });

  it.each(["ENABLED", "DISABLED", undefined])(
    "keeps a failed destroy retryable when exact-version state is %s",
    async (state) => {
      const versionRef = `projects/${PROJECT_NUMBER}/secrets/${SECRET_ID}/versions/8`;
      const store = new GcpSecretManagerCredentialSecretStore({
        projectId: PROJECT_ID,
        projectNumber: PROJECT_NUMBER,
        secretPrefix: "sdp-dev-provider-credentials",
        accessToken: "test-token",
        fetcher: async (_input, init) =>
          init?.method === "POST"
            ? new Response(JSON.stringify({ error: { status: "FAILED_PRECONDITION" } }), {
                status: 400,
              })
            : new Response(JSON.stringify(state ? { name: versionRef, state } : {})),
      });

      await expect(store.destroyVersion({ secretVersionRef: versionRef })).rejects.toMatchObject({
        code: "UPSTREAM_ERROR",
      });
    }
  );

  it("keeps a failed destroy retryable when exact-version verification fails", async () => {
    const versionRef = `projects/${PROJECT_NUMBER}/secrets/${SECRET_ID}/versions/9`;
    const store = new GcpSecretManagerCredentialSecretStore({
      projectId: PROJECT_ID,
      projectNumber: PROJECT_NUMBER,
      secretPrefix: "sdp-dev-provider-credentials",
      accessToken: "test-token",
      fetcher: async (_input, init) =>
        init?.method === "POST"
          ? new Response(JSON.stringify({ error: { status: "UNAVAILABLE" } }), { status: 503 })
          : new Response(JSON.stringify({ error: { status: "UNAVAILABLE" } }), { status: 503 }),
    });

    await expect(store.destroyVersion({ secretVersionRef: versionRef })).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
    });
  });

  it("rejects refs outside the managed project, prefix, or exact numeric version", async () => {
    const store = new GcpSecretManagerCredentialSecretStore({
      projectId: "sdp-dev-123",
      secretPrefix: "sdp-dev-provider-credentials",
      projectNumber: PROJECT_NUMBER,
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

    // Accepting the canonical spelling must not become "accept any digits".
    await expect(
      store.write({
        orgId: "org_123",
        provider: "privy",
        providerCredentialId: "pcred_123",
        existingSecretRef: `projects/9999999999/secrets/${SECRET_ID}`,
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

      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer metadata-token");

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
      projectNumber: PROJECT_NUMBER,
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

  it("resolves the project number from the metadata server and reuses it", async () => {
    const metadataUrl = "http://metadata.test/numeric-project-id";
    const requests: { url: string; headers?: HeadersInit }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, headers: init?.headers });

      if (url === metadataUrl) {
        return new Response(`${PROJECT_NUMBER}\n`);
      }

      if (url.endsWith(":addVersion")) {
        return new Response(
          JSON.stringify({ name: `projects/${PROJECT_NUMBER}/secrets/${SECRET_ID}/versions/1` })
        );
      }

      return new Response(
        JSON.stringify({ name: `projects/${PROJECT_NUMBER}/secrets/${SECRET_ID}` })
      );
    };

    const store = new GcpSecretManagerCredentialSecretStore({
      projectId: PROJECT_ID,
      secretPrefix: "sdp-dev-provider-credentials",
      accessToken: "test-token",
      metadataProjectNumberUrl: metadataUrl,
      fetcher,
    });

    const write = async () =>
      store.write({
        orgId: "org_123",
        provider: "privy",
        providerCredentialId: "pcred_123",
        payload: { appSecret: "secret" },
      });

    // GCP answers with the project-number spelling; the store normalizes back
    // to the project-ID spelling the write was addressed with, so every
    // recorded ref lives in one spelling.
    expect(await write()).toMatchObject({
      secretVersionRef: `projects/${PROJECT_ID}/secrets/${SECRET_ID}/versions/1`,
    });
    await write();

    expect(requests[0]).toMatchObject({
      url: metadataUrl,
      headers: { "Metadata-Flavor": "Google" },
    });
    // Cached across stores, not just within one, because a store is built per
    // request.
    expect(requests.filter((request) => request.url === metadataUrl)).toHaveLength(1);
  });

  it("rejects a metadata project number that is not numeric", async () => {
    const store = new GcpSecretManagerCredentialSecretStore({
      projectId: PROJECT_ID,
      secretPrefix: "sdp-dev-provider-credentials",
      accessToken: "test-token",
      metadataProjectNumberUrl: "http://metadata.test/bad-project-number",
      fetcher: async () => new Response("not-a-number"),
    });

    await expect(
      store.write({
        orgId: "org_123",
        provider: "privy",
        providerCredentialId: "pcred_123",
        payload: { appSecret: "secret" },
      })
    ).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
  });

  it("wraps malformed successful GCP responses in CredentialSecretStoreError", async () => {
    const store = new GcpSecretManagerCredentialSecretStore({
      projectId: "sdp-dev-123",
      secretPrefix: "sdp-dev-provider-credentials",
      projectNumber: PROJECT_NUMBER,
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

  it.each([
    ["a missing name", {}],
    ["a non-string name", { name: 7 }],
    [
      "a different project",
      {
        name: "projects/other-project/secrets/sdp-dev-provider-credentials-pcred_123/versions/1",
      },
    ],
    [
      "a different project number",
      {
        name: `projects/9999999999/secrets/${SECRET_ID}/versions/1`,
      },
    ],
    [
      "a different secret prefix",
      {
        name: "projects/sdp-dev-123/secrets/other-prefix-pcred_123/versions/1",
      },
    ],
    [
      "a different managed secret",
      {
        name: "projects/sdp-dev-123/secrets/sdp-dev-provider-credentials-pcred_456/versions/1",
      },
    ],
    [
      "a non-exact version",
      {
        name: "projects/sdp-dev-123/secrets/sdp-dev-provider-credentials-pcred_123/versions/latest",
      },
    ],
  ])("treats a successful addVersion response with %s as an upstream error", async (_, body) => {
    const store = new GcpSecretManagerCredentialSecretStore({
      projectId: "sdp-dev-123",
      secretPrefix: "sdp-dev-provider-credentials",
      projectNumber: PROJECT_NUMBER,
      accessToken: "test-token",
      fetcher: async (input) =>
        String(input).endsWith(":addVersion")
          ? new Response(JSON.stringify(body))
          : new Response(null, { status: 409 }),
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

  it("wraps invalid GCP payload base64 in CredentialSecretStoreError", async () => {
    const store = new GcpSecretManagerCredentialSecretStore({
      projectId: "sdp-dev-123",
      projectNumber: PROJECT_NUMBER,
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
      createCustodyCipher({ CUSTODY_ENCRYPTION_KEY: testEncryptionKey() } as Env)
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
    const store = new EncryptedDbCredentialSecretStore(
      createCustodyCipher({ CUSTODY_ENCRYPTION_KEY: "not-a-valid-key" } as Env)
    );

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
      createCustodyCipher({ CUSTODY_ENCRYPTION_KEY: testEncryptionKey() } as Env)
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
