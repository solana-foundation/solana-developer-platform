import type { Token } from "@sdp/types";
import type {
  ActionExecutionInput,
  ActionExecutionResult,
  AllowlistFormState,
  AuthorityFormState,
  BurnFormState,
  ExecuteRouteResponse,
  ExtensionRow,
  ForceBurnFormState,
  FreezeFormState,
  MetadataFormState,
  MintFormState,
  PermissionRow,
  SeizeFormState,
} from "./token-management-workspace.types";

export function createInitialMetadataForm(token: Token): MetadataFormState {
  return {
    name: token.name,
    description: token.description ?? "",
    uri: token.uri ?? "",
    imageUrl: token.imageUrl ?? "",
    status: token.status === "paused" ? "paused" : "active",
  };
}

export function createInitialMintForm(): MintFormState {
  return {
    destination: "",
    amount: "",
    memo: "",
  };
}

export function createInitialBurnForm(): BurnFormState {
  return {
    source: "",
    amount: "",
    memo: "",
  };
}

export function createInitialSeizeForm(): SeizeFormState {
  return {
    source: "",
    destination: "",
    amount: "",
    delegateAuthority: "",
    memo: "",
  };
}

export function createInitialForceBurnForm(): ForceBurnFormState {
  return {
    source: "",
    amount: "",
    delegateAuthority: "",
    memo: "",
  };
}

export function createInitialAuthorityForm(): AuthorityFormState {
  return {
    role: "mint",
    currentAuthority: "",
    newAuthority: "",
  };
}

export function createInitialFreezeForm(): FreezeFormState {
  return {
    accountAddress: "",
    reason: "",
  };
}

export function createInitialAllowlistForm(): AllowlistFormState {
  return {
    address: "",
    label: "",
  };
}

export function formatDate(value: string | null | undefined): string {
  if (!value) {
    return "—";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
  });
}

export function stringifyBody(body: unknown): string {
  try {
    return JSON.stringify(body, null, 2);
  } catch {
    return String(body);
  }
}

export function asOptionalString(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function isPositiveAmount(value: string): boolean {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

export function formatValue(value: string | null | undefined): string {
  if (!value) {
    return "None";
  }

  if (value.length <= 16) {
    return value;
  }

  return `${value.slice(0, 6)}...${value.slice(-6)}`;
}

export function extractApiError(body: unknown): string {
  if (typeof body === "string") {
    return body;
  }

  if (body && typeof body === "object") {
    const maybeError = (body as { error?: { message?: string } }).error;
    if (maybeError?.message) {
      return maybeError.message;
    }

    const maybeMessage = (body as { message?: string }).message;
    if (typeof maybeMessage === "string" && maybeMessage) {
      return maybeMessage;
    }
  }

  return "Unknown error";
}

export function getExplorerHref(mintAddress: string | null): string | null {
  if (!mintAddress) {
    return null;
  }

  const cluster = process.env.NEXT_PUBLIC_SOLANA_NETWORK?.trim() || "devnet";
  const clusterQuery =
    cluster === "mainnet-beta" || cluster === "mainnet"
      ? ""
      : `?cluster=${encodeURIComponent(cluster)}`;
  return `https://explorer.solana.com/address/${mintAddress}${clusterQuery}`;
}

export async function executeActionRequest(
  input: ActionExecutionInput
): Promise<ActionExecutionResult> {
  try {
    const response = await fetch("/api/playground/execute", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        method: input.method,
        path: input.path,
        body: input.body,
      }),
    });

    const payload = (await response.json()) as ExecuteRouteResponse;

    if (!response.ok) {
      return {
        ok: false,
        message: payload.error ?? `Execution route failed (${response.status})`,
        status: response.status,
        body: payload,
      };
    }

    if (!payload.ok) {
      const status = payload.status ?? null;
      return {
        ok: false,
        message: `${input.label} failed (${status ?? "unknown"}): ${extractApiError(payload.body)}`,
        status,
        body: payload.body,
      };
    }

    return {
      ok: true,
      message: `${input.label} succeeded (${payload.status ?? "ok"})`,
      status: payload.status ?? null,
      body: payload.body ?? null,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Request failed",
      status: null,
      body: null,
    };
  }
}

export function getPermissionRows(token: Token, metadataAuthority: string | null): PermissionRow[] {
  return [
    {
      id: "mint-authority",
      title: "Mint Authority",
      helper: "Can mint new tokens.",
      value: token.mintAuthority,
      action: "authority",
    },
    {
      id: "freeze-authority",
      title: "Freeze Authority",
      helper: "Can freeze and unfreeze token accounts.",
      value: token.freezeAuthority,
      action: "freeze",
    },
    {
      id: "metadata-authority",
      title: "Metadata Authority",
      helper: "Can update token metadata.",
      value: metadataAuthority,
      action: "update-metadata",
    },
    {
      id: "pausable-authority",
      title: "Pausable Authority",
      helper: "Can pause and unpause token transfers.",
      value: token.extensions?.pausable?.authority ?? null,
      action: "pause",
    },
    {
      id: "permanent-delegate",
      title: "Permanent Delegate Authority",
      helper: "Can perform delegated transfer/burn operations.",
      value: token.extensions?.permanentDelegate ?? null,
      action: "authority",
    },
  ];
}

export function getExtensionRows(token: Token): ExtensionRow[] {
  return [
    {
      id: "template",
      title: "Template",
      helper: "Base template applied to this token.",
      value: token.template,
    },
    {
      id: "allowlist",
      title: "Allowlist Enforcement",
      helper: "Requires destination allowlisting for controlled actions.",
      value: token.requiresAllowlist ? "Enabled" : "Disabled",
    },
    {
      id: "mintable",
      title: "Mintable",
      helper: "Allows mint operations after deployment.",
      value: token.isMintable ? "Enabled" : "Disabled",
    },
    {
      id: "freezable",
      title: "Freezable",
      helper: "Allows freeze/unfreeze account controls.",
      value: token.isFreezable ? "Enabled" : "Disabled",
    },
    {
      id: "default-account-state",
      title: "Default Account State",
      helper: "Default state for newly created token accounts.",
      value: token.extensions?.defaultAccountState ?? "initialized",
    },
    {
      id: "transfer-fee",
      title: "Transfer Fee",
      helper: "Fee configuration for token transfers.",
      value: token.extensions?.transferFee ? "Configured" : "Not configured",
    },
    {
      id: "scaled-ui",
      title: "Scaled UI Amount",
      helper: "UI supply multiplier controls.",
      value: token.extensions?.scaledUiAmount ? "Configured" : "Not configured",
    },
    {
      id: "transfer-hook",
      title: "Transfer Hook",
      helper: "Custom transfer logic program hook.",
      value: token.extensions?.transferHook ? "Configured" : "Not configured",
    },
    {
      id: "interest-bearing",
      title: "Interest Bearing",
      helper: "Interest-rate based balance updates.",
      value: token.extensions?.interestBearing ? "Configured" : "Not configured",
    },
    {
      id: "non-transferable",
      title: "Non-transferable",
      helper: "Disables standard transfers between accounts.",
      value: token.extensions?.nonTransferable ? "Enabled" : "Disabled",
    },
  ];
}
