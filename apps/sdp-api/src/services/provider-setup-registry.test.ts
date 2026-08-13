import type { ResolvedRpcTarget } from "@sdp/rpc/relay";
import {
  COMPLIANCE_PROVIDERS,
  CUSTODY_PROVIDERS,
  ORGANIZATION_RPC_PROVIDERS,
  RAMP_PROVIDERS,
} from "@sdp/types";
import type { Context } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "@/types/env";

const credentialOperations = vi.hoisted(() => ({
  submit: vi.fn(),
  replace: vi.fn(),
  complete: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock("@/services/provider-credential-submission.service", () => ({
  submitProviderCredential: credentialOperations.submit,
  replaceProviderCredential: credentialOperations.replace,
}));

vi.mock("@/services/provider-credential-installation.service", () => ({
  completeProviderCredentialInstallation: credentialOperations.complete,
  cancelProviderCredentialInstallation: credentialOperations.cancel,
}));

import {
  getProviderSetupDefinition,
  PROVIDER_SETUP_REGISTRY,
} from "@/services/provider-setup-registry";

describe("provider setup registry", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("covers every supported provider in each setup family", () => {
    expect(Object.keys(PROVIDER_SETUP_REGISTRY.custody).sort()).toEqual(
      [...CUSTODY_PROVIDERS].sort()
    );
    expect(Object.keys(PROVIDER_SETUP_REGISTRY.rpc).sort()).toEqual(
      [...ORGANIZATION_RPC_PROVIDERS].sort()
    );
    expect(Object.keys(PROVIDER_SETUP_REGISTRY.compliance).sort()).toEqual(
      [...COMPLIANCE_PROVIDERS].sort()
    );
    expect(Object.keys(PROVIDER_SETUP_REGISTRY.ramps).sort()).toEqual([...RAMP_PROVIDERS].sort());
  });

  it("validates and delegates the existing Privy credential lifecycle", async () => {
    const privy = getProviderSetupDefinition("custody", "privy");
    const context = {} as Context<{ Bindings: Env }>;
    const payload = {
      provider: "privy",
      fields: {
        credentialLabel: "Production Privy",
        scope: "project",
        appId: "app-123",
        appSecret: "secret-123",
      },
    } as const;

    const parsed = privy.validateSetupPayload(payload, "submit");
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw parsed.error;

    credentialOperations.submit.mockResolvedValue({ connectionId: "cconn_1" });
    credentialOperations.replace.mockResolvedValue({ connectionId: "cconn_1" });
    credentialOperations.complete.mockResolvedValue({ connectionId: "cconn_1" });
    credentialOperations.cancel.mockResolvedValue({ connection: { id: "cconn_1" } });

    await privy.storeCredentials({
      context,
      idempotencyKey: "submit-key",
      payload: parsed.data,
    });

    const replacement = privy.validateSetupPayload(payload, "replace");
    expect(replacement.success).toBe(true);
    if (!replacement.success) throw replacement.error;
    await privy.storeCredentials({
      context,
      connectionId: "cconn_1",
      idempotencyKey: "replace-key",
      payload: replacement.data,
    });
    await privy.activate({ context, connectionId: "cconn_1" });
    await privy.deactivate({ context, connectionId: "cconn_1" });

    expect(credentialOperations.submit).toHaveBeenCalledWith(context, parsed.data, "submit-key");
    expect(credentialOperations.replace).toHaveBeenCalledWith(
      context,
      "cconn_1",
      replacement.data,
      "replace-key"
    );
    expect(credentialOperations.complete).toHaveBeenCalledWith(context, "cconn_1");
    expect(credentialOperations.cancel).toHaveBeenCalledWith(context, "cconn_1");
  });

  it("keeps Privy payload validation strict and requires fields for replacement", () => {
    const privy = getProviderSetupDefinition("custody", "privy");

    expect(
      privy.validateSetupPayload({ provider: "privy", unexpected: "value" }, "submit").success
    ).toBe(false);
    expect(privy.validateSetupPayload({ provider: "privy" }, "replace").success).toBe(false);
  });

  it("represents managed RPC testing with the existing getVersion probe", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: "rpc-connectivity-test", result: {} }), {
        status: 200,
        statusText: "OK",
      })
    );
    const target: ResolvedRpcTarget = {
      providerId: "helius",
      projectId: "prj_1",
      endpoint: "https://rpc.example.test/secret-path",
      endpointLabel: "https://rpc.example.test/***",
      headers: { Authorization: "Bearer secret" },
      selectionMode: "project_provider",
    };

    const result = await getProviderSetupDefinition("rpc", "helius").checkConnection({ target });

    expect(result.upstream.status).toBe(200);
    expect(result.upstreamBody).toMatchObject({ id: "rpc-connectivity-test", result: {} });
    expect(fetchSpy).toHaveBeenCalledWith(
      target.endpoint,
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer secret",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "rpc-connectivity-test",
          method: "getVersion",
          params: [],
        }),
      })
    );
  });

  it("checks compliance configuration without screening an address", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const range = getProviderSetupDefinition("compliance", "range");

    expect(range.setupMode).toBe("contact");
    expect(range.checkConnection({ env: { RANGE_API_KEY: "range-key" } as Env })).toMatchObject({
      kind: "configuration",
      status: "configured",
    });
    expect(range.checkConnection({ env: {} as Env })).toMatchObject({
      kind: "configuration",
      status: "not_configured",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports ramps as platform-managed and respects sandbox configuration", () => {
    const moonpay = getProviderSetupDefinition("ramps", "moonpay");
    const env = {
      MOONPAY_SANDBOX_API_KEY: "sandbox-key",
      MOONPAY_SANDBOX_SECRET_KEY: "sandbox-secret",
    } as Env;

    expect(moonpay.setupMode).toBe("platform_managed");
    expect(moonpay.checkConnection({ env, testMode: true }).status).toBe("configured");
    expect(moonpay.checkConnection({ env, testMode: false }).status).toBe("not_configured");
    expect("storeCredentials" in moonpay).toBe(false);
  });
});
