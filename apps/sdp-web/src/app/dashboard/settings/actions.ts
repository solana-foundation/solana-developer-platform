"use server";

import { sdpApiFetch, sdpApiRequest } from "@/lib/sdp-api";
import { ORGANIZATION_RPC_PROVIDERS, type OrganizationRpcProvider } from "@sdp/types";

type OrganizationSettings = {
  rpcProvider?: OrganizationRpcProvider;
};

type OrganizationRecord = {
  id: string;
  settings: OrganizationSettings | null;
};

type UpdateOrganizationRpcSettingsResult = {
  status: "success" | "error";
  message: string;
  savedOrganizationId?: string;
  savedRpcProvider?: OrganizationRpcProvider;
};

export type TestOrganizationRpcProviderResult = {
  status: "success" | "error";
  message: string;
  requestedProvider: OrganizationRpcProvider;
  resolvedProvider?: string;
  selectionMode?: string;
  endpoint?: string;
  upstreamStatus?: number;
  upstreamStatusText?: string;
  latencyMs?: number;
};

type RpcProxyResponse = {
  provider: {
    id: string;
    selectionMode: string;
    endpoint: string;
  };
  upstream: {
    ok: boolean;
    status: number;
    statusText: string;
  };
};

function isOrganizationRpcProvider(value: string): value is OrganizationRpcProvider {
  return ORGANIZATION_RPC_PROVIDERS.includes(value as OrganizationRpcProvider);
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "Failed to save RPC settings.";
}

function toRpcTestErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "Failed to test RPC provider.";
}

export async function updateOrganizationRpcSettingsAction(
  formData: FormData
): Promise<UpdateOrganizationRpcSettingsResult> {
  const organizationId = String(formData.get("organizationId") ?? "").trim();
  const rpcProvider = String(formData.get("rpcProvider") ?? "default").trim();

  if (!organizationId) {
    return {
      status: "error",
      message: "Missing organization id.",
    };
  }

  const resolvedProvider: OrganizationRpcProvider = isOrganizationRpcProvider(rpcProvider)
    ? rpcProvider
    : "default";

  try {
    const updated = await sdpApiFetch<OrganizationRecord>(`/v1/organizations/${organizationId}`, {
      method: "PATCH",
      body: JSON.stringify({
        settings: { rpcProvider: resolvedProvider },
      }),
    });

    const persistedProvider = updated.settings?.rpcProvider ?? "default";
    if (persistedProvider !== resolvedProvider) {
      return {
        status: "error",
        message: `RPC provider save mismatch (requested ${resolvedProvider}, persisted ${persistedProvider}).`,
      };
    }

    return {
      status: "success",
      message: "RPC settings saved.",
      savedOrganizationId: organizationId,
      savedRpcProvider: persistedProvider,
    };
  } catch (error) {
    return {
      status: "error",
      message: toErrorMessage(error),
    };
  }
}

export async function testOrganizationRpcProviderAction(
  formData: FormData
): Promise<TestOrganizationRpcProviderResult> {
  const rpcProvider = String(formData.get("rpcProvider") ?? "default").trim();
  const requestedProvider: OrganizationRpcProvider = isOrganizationRpcProvider(rpcProvider)
    ? rpcProvider
    : "default";

  const startedAt = Date.now();

  try {
    const response = await sdpApiRequest("/v1/rpc/proxy", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "org-rpc-test",
        method: "getVersion",
        params: [],
      }),
    });

    const latencyMs = Date.now() - startedAt;
    const payload = (await response.json()) as { data?: RpcProxyResponse; error?: { message?: string } };

    if (!response.ok || !payload.data) {
      return {
        status: "error",
        message: payload.error?.message || `RPC test failed (${response.status}).`,
        requestedProvider,
        latencyMs,
      };
    }

    const {
      provider: { id: resolvedProvider, endpoint, selectionMode },
      upstream,
    } = payload.data;

    if (resolvedProvider !== requestedProvider) {
      return {
        status: "error",
        message: `RPC test mismatch (requested ${requestedProvider}, resolved ${resolvedProvider}).`,
        requestedProvider,
        resolvedProvider,
        selectionMode,
        endpoint,
        upstreamStatus: upstream.status,
        upstreamStatusText: upstream.statusText,
        latencyMs,
      };
    }

    if (!upstream.ok) {
      return {
        status: "error",
        message: `RPC upstream returned ${upstream.status} ${upstream.statusText}.`,
        requestedProvider,
        resolvedProvider,
        selectionMode,
        endpoint,
        upstreamStatus: upstream.status,
        upstreamStatusText: upstream.statusText,
        latencyMs,
      };
    }

    return {
      status: "success",
      message: `RPC test passed (${upstream.status} ${upstream.statusText}) in ${latencyMs}ms.`,
      requestedProvider,
      resolvedProvider,
      selectionMode,
      endpoint,
      upstreamStatus: upstream.status,
      upstreamStatusText: upstream.statusText,
      latencyMs,
    };
  } catch (error) {
    return {
      status: "error",
      message: toRpcTestErrorMessage(error),
      requestedProvider,
      latencyMs: Date.now() - startedAt,
    };
  }
}
