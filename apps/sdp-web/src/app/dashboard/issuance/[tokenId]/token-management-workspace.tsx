"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { FrozenAccount, Token, TokenAllowlistEntry, TokenTransaction } from "@sdp/types";
import {
  ArrowUpRight,
  ChevronDown,
  Copy,
  Loader2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";

type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";
type SettingsTab = "permissions" | "extensions";
type AdminAction =
  | "update-metadata"
  | "refresh-supply"
  | "mint"
  | "burn"
  | "seize"
  | "force-burn"
  | "authority"
  | "pause"
  | "freeze"
  | "allowlist";

interface ActionExecutionInput {
  label: string;
  method: HttpMethod;
  path: string;
  body?: unknown;
}

interface ExecuteRouteResponse {
  ok?: boolean;
  status?: number;
  body?: unknown;
  error?: string;
}

interface ActionExecutionResult {
  ok: boolean;
  message: string;
  status: number | null;
  body: unknown;
}

interface RunActionOptions {
  requiresConfirmation?: boolean;
  confirmationTitle?: string;
  confirmationDescription?: string;
  confirmButtonLabel?: string;
  submitToast?: string;
  successToast?: string;
}

interface ActionConfirmationState {
  input: ActionExecutionInput;
  options: Required<
    Pick<
      RunActionOptions,
      | "confirmationTitle"
      | "confirmationDescription"
      | "confirmButtonLabel"
      | "submitToast"
      | "successToast"
    >
  >;
}

interface TokenManagementWorkspaceProps {
  token: Token;
  tokenError: string | null;
  transactions: TokenTransaction[];
  transactionsError: string | null;
  allowlistEntries: TokenAllowlistEntry[];
  allowlistError: string | null;
  frozenAccounts: FrozenAccount[];
  frozenAccountsError: string | null;
}

interface MetadataFormState {
  name: string;
  description: string;
  uri: string;
  imageUrl: string;
  status: "active" | "paused";
}

interface MintFormState {
  destination: string;
  amount: string;
  memo: string;
}

interface BurnFormState {
  source: string;
  amount: string;
  memo: string;
}

interface SeizeFormState {
  source: string;
  destination: string;
  amount: string;
  delegateAuthority: string;
  memo: string;
}

interface ForceBurnFormState {
  source: string;
  amount: string;
  delegateAuthority: string;
  memo: string;
}

interface AuthorityFormState {
  role: "mint" | "freeze" | "permanentDelegate" | "metadata";
  currentAuthority: string;
  newAuthority: string;
}

interface FreezeFormState {
  accountAddress: string;
  reason: string;
}

interface AllowlistFormState {
  address: string;
  label: string;
}

interface PermissionRow {
  id: string;
  title: string;
  helper: string;
  value: string | null;
  action: AdminAction;
}

interface ExtensionRow {
  id: string;
  title: string;
  helper: string;
  value: string;
}

function createInitialMetadataForm(token: Token): MetadataFormState {
  return {
    name: token.name,
    description: token.description ?? "",
    uri: token.uri ?? "",
    imageUrl: token.imageUrl ?? "",
    status: token.status === "paused" ? "paused" : "active",
  };
}

function createInitialMintForm(): MintFormState {
  return {
    destination: "",
    amount: "",
    memo: "",
  };
}

function createInitialBurnForm(): BurnFormState {
  return {
    source: "",
    amount: "",
    memo: "",
  };
}

function createInitialSeizeForm(): SeizeFormState {
  return {
    source: "",
    destination: "",
    amount: "",
    delegateAuthority: "",
    memo: "",
  };
}

function createInitialForceBurnForm(): ForceBurnFormState {
  return {
    source: "",
    amount: "",
    delegateAuthority: "",
    memo: "",
  };
}

function createInitialAuthorityForm(): AuthorityFormState {
  return {
    role: "mint",
    currentAuthority: "",
    newAuthority: "",
  };
}

function createInitialFreezeForm(): FreezeFormState {
  return {
    accountAddress: "",
    reason: "",
  };
}

function createInitialAllowlistForm(): AllowlistFormState {
  return {
    address: "",
    label: "",
  };
}

function formatDate(value: string | null | undefined): string {
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

function stringifyBody(body: unknown): string {
  try {
    return JSON.stringify(body, null, 2);
  } catch {
    return String(body);
  }
}

function asOptionalString(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function formatValue(value: string | null | undefined): string {
  if (!value) {
    return "None";
  }

  if (value.length <= 16) {
    return value;
  }

  return `${value.slice(0, 6)}...${value.slice(-6)}`;
}

function extractApiError(body: unknown): string {
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

function getExplorerHref(mintAddress: string | null): string | null {
  if (!mintAddress) {
    return null;
  }

  const cluster = process.env.NEXT_PUBLIC_SOLANA_NETWORK;
  const query = cluster && cluster !== "mainnet-beta" ? `?cluster=${encodeURIComponent(cluster)}` : "";
  return `https://explorer.solana.com/address/${mintAddress}${query}`;
}

async function executeActionRequest(input: ActionExecutionInput): Promise<ActionExecutionResult> {
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

function ActionCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );
}

function OverviewRow({ label, value, monospace = false }: { label: string; value: string; monospace?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-[rgba(28,28,29,0.08)] px-4 py-3 last:border-b-0">
      <p className="text-[15px] text-[rgba(28,28,29,0.68)]">{label}</p>
      <p className={["text-right text-[15px] text-[#1c1c1d]", monospace ? "font-mono text-xs" : ""].join(" ")}>
        {value}
      </p>
    </div>
  );
}

export function TokenManagementWorkspace({
  token,
  tokenError,
  transactions,
  transactionsError,
  allowlistEntries,
  allowlistError,
  frozenAccounts,
  frozenAccountsError,
}: TokenManagementWorkspaceProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("permissions");
  const [isActionMenuOpen, setIsActionMenuOpen] = useState(false);
  const [activeAction, setActiveAction] = useState<AdminAction | null>("update-metadata");
  const [actionConfirmation, setActionConfirmation] = useState<ActionConfirmationState | null>(null);
  const [metadataForm, setMetadataForm] = useState<MetadataFormState>(() =>
    createInitialMetadataForm(token)
  );
  const [mintForm, setMintForm] = useState<MintFormState>(createInitialMintForm);
  const [burnForm, setBurnForm] = useState<BurnFormState>(createInitialBurnForm);
  const [seizeForm, setSeizeForm] = useState<SeizeFormState>(createInitialSeizeForm);
  const [forceBurnForm, setForceBurnForm] = useState<ForceBurnFormState>(createInitialForceBurnForm);
  const [authorityForm, setAuthorityForm] = useState<AuthorityFormState>(createInitialAuthorityForm);
  const [freezeForm, setFreezeForm] = useState<FreezeFormState>(createInitialFreezeForm);
  const [allowlistForm, setAllowlistForm] = useState<AllowlistFormState>(createInitialAllowlistForm);
  const [lastActionResult, setLastActionResult] = useState<ActionExecutionResult | null>(null);

  const tokenBasePath = useMemo(() => `/v1/issuance/tokens/${token.id}`, [token.id]);
  const explorerHref = useMemo(() => getExplorerHref(token.mintAddress), [token.mintAddress]);
  const canDeployToken = token.status === "pending" && !token.mintAddress;

  const permissionRows = useMemo<PermissionRow[]>(
    () => [
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
        value: token.mintAuthority,
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
    ],
    [token]
  );

  const extensionRows = useMemo<ExtensionRow[]>(
    () => [
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
    ],
    [token]
  );

  const executeAction = (input: ActionExecutionInput, options: RunActionOptions = {}) => {
    const submitToast = options.submitToast ?? `Submitting ${input.label.toLowerCase()}...`;
    const successToast = options.successToast ?? "Transaction finalized successfully.";
    const toastId = toast.loading(submitToast);

    startTransition(async () => {
      const result = await executeActionRequest(input);
      setLastActionResult(result);

      if (result.ok) {
        setActionConfirmation(null);
        toast.success(successToast, { id: toastId });
        router.refresh();
        return;
      }

      toast.error(result.message, { id: toastId });
    });
  };

  const runAction = (input: ActionExecutionInput, options: RunActionOptions = {}) => {
    if (options.requiresConfirmation) {
      setActionConfirmation({
        input,
        options: {
          confirmationTitle: options.confirmationTitle ?? "Send transaction?",
          confirmationDescription:
            options.confirmationDescription ??
            "This will submit an on-chain transaction. Do you want to continue?",
          confirmButtonLabel: options.confirmButtonLabel ?? "Go ahead",
          submitToast: options.submitToast ?? `Submitting ${input.label.toLowerCase()}...`,
          successToast: options.successToast ?? "Transaction finalized successfully.",
        },
      });
      return;
    }

    executeAction(input, options);
  };

  const handleCopy = async (value: string | null) => {
    if (!value) {
      return;
    }

    try {
      await navigator.clipboard.writeText(value);
      toast.success("Copied");
    } catch {
      toast.error("Unable to copy");
    }
  };

  const handleUpdateMetadata = () => {
    const nextName = metadataForm.name.trim();
    if (!nextName) {
      toast.error("Token name is required.");
      return;
    }

    runAction({
      label: "Update token",
      method: "PATCH",
      path: tokenBasePath,
      body: {
        name: nextName,
        description: metadataForm.description.trim() ? metadataForm.description.trim() : null,
        uri: metadataForm.uri.trim() ? metadataForm.uri.trim() : null,
        imageUrl: metadataForm.imageUrl.trim() ? metadataForm.imageUrl.trim() : null,
        status: metadataForm.status,
      },
    });
  };

  const handleDeploy = (mode: "prepare" | "execute") => {
    runAction({
      label: `Deploy token (${mode})`,
      method: "POST",
      path: `${tokenBasePath}/deploy${mode === "prepare" ? "/prepare" : ""}`,
      body: {},
    },
    mode === "execute"
      ? {
          requiresConfirmation: true,
          confirmationTitle: "Deploy token?",
          confirmationDescription: "This will submit the deploy transaction on-chain.",
          confirmButtonLabel: "Deploy now",
          submitToast: "Submitting deploy transaction...",
          successToast: "Deploy transaction finalized.",
        }
      : undefined);
  };

  const handleRefreshSupply = () => {
    runAction({
      label: "Refresh supply",
      method: "POST",
      path: `${tokenBasePath}/supply/refresh`,
      body: {},
    });
  };

  const handleMint = (mode: "prepare" | "execute") => {
    const destination = mintForm.destination.trim();
    const amount = mintForm.amount.trim();
    if (!destination || !amount) {
      toast.error("Mint destination and amount are required.");
      return;
    }

    runAction({
      label: `Mint (${mode})`,
      method: "POST",
      path: `${tokenBasePath}/mint${mode === "prepare" ? "/prepare" : ""}`,
      body: {
        mint: {
          destination,
          amount,
          memo: asOptionalString(mintForm.memo),
        },
      },
    },
    mode === "execute"
      ? {
          requiresConfirmation: true,
          confirmationTitle: "Mint tokens?",
          confirmationDescription: "This will submit a mint transaction on-chain.",
          confirmButtonLabel: "Mint now",
          submitToast: "Submitting mint transaction...",
          successToast: "Mint transaction finalized.",
        }
      : undefined);
  };

  const handleBurn = (mode: "prepare" | "execute") => {
    const source = burnForm.source.trim();
    const amount = burnForm.amount.trim();
    if (!source || !amount) {
      toast.error("Burn source and amount are required.");
      return;
    }

    runAction({
      label: `Burn (${mode})`,
      method: "POST",
      path: `${tokenBasePath}/burn${mode === "prepare" ? "/prepare" : ""}`,
      body: {
        burn: {
          source,
          amount,
          memo: asOptionalString(burnForm.memo),
        },
      },
    },
    mode === "execute"
      ? {
          requiresConfirmation: true,
          confirmationTitle: "Burn tokens?",
          confirmationDescription: "This will submit a burn transaction on-chain.",
          confirmButtonLabel: "Burn now",
          submitToast: "Submitting burn transaction...",
          successToast: "Burn transaction finalized.",
        }
      : undefined);
  };

  const handleSeize = (mode: "prepare" | "execute") => {
    const source = seizeForm.source.trim();
    const destination = seizeForm.destination.trim();
    const amount = seizeForm.amount.trim();
    if (!source || !destination || !amount) {
      toast.error("Seize source, destination, and amount are required.");
      return;
    }

    runAction({
      label: `Seize (${mode})`,
      method: "POST",
      path: `${tokenBasePath}/seize${mode === "prepare" ? "/prepare" : ""}`,
      body: {
        seize: {
          source,
          destination,
          amount,
          delegateAuthority: asOptionalString(seizeForm.delegateAuthority),
          memo: asOptionalString(seizeForm.memo),
        },
      },
    },
    mode === "execute"
      ? {
          requiresConfirmation: true,
          confirmationTitle: "Force transfer?",
          confirmationDescription: "This will submit a seize (force transfer) transaction on-chain.",
          confirmButtonLabel: "Transfer now",
          submitToast: "Submitting force transfer transaction...",
          successToast: "Force transfer transaction finalized.",
        }
      : undefined);
  };

  const handleForceBurn = (mode: "prepare" | "execute") => {
    const source = forceBurnForm.source.trim();
    const amount = forceBurnForm.amount.trim();
    if (!source || !amount) {
      toast.error("Force-burn source and amount are required.");
      return;
    }

    runAction({
      label: `Force Burn (${mode})`,
      method: "POST",
      path: `${tokenBasePath}/force-burn${mode === "prepare" ? "/prepare" : ""}`,
      body: {
        forceBurn: {
          source,
          amount,
          delegateAuthority: asOptionalString(forceBurnForm.delegateAuthority),
          memo: asOptionalString(forceBurnForm.memo),
        },
      },
    },
    mode === "execute"
      ? {
          requiresConfirmation: true,
          confirmationTitle: "Force burn tokens?",
          confirmationDescription: "This will submit a force-burn transaction on-chain.",
          confirmButtonLabel: "Force burn now",
          submitToast: "Submitting force-burn transaction...",
          successToast: "Force-burn transaction finalized.",
        }
      : undefined);
  };

  const handleAuthorityUpdate = (mode: "prepare" | "execute") => {
    runAction({
      label: `Update authority (${mode})`,
      method: "POST",
      path: `${tokenBasePath}/authority${mode === "prepare" ? "/prepare" : ""}`,
      body: {
        authority: {
          role: authorityForm.role,
          currentAuthority: asOptionalString(authorityForm.currentAuthority),
          newAuthority: authorityForm.newAuthority.trim() || null,
        },
      },
    },
    mode === "execute"
      ? {
          requiresConfirmation: true,
          confirmationTitle: "Update authority?",
          confirmationDescription: "This will submit an authority update transaction on-chain.",
          confirmButtonLabel: "Update now",
          submitToast: "Submitting authority update transaction...",
          successToast: "Authority update finalized.",
        }
      : undefined);
  };

  const handlePause = (pause: boolean) => {
    runAction({
      label: pause ? "Pause token" : "Unpause token",
      method: "POST",
      path: `${tokenBasePath}/${pause ? "pause" : "unpause"}`,
      body: {},
    },
    {
      requiresConfirmation: true,
      confirmationTitle: pause ? "Pause token?" : "Unpause token?",
      confirmationDescription: pause
        ? "This will submit a pause transaction on-chain."
        : "This will submit an unpause transaction on-chain.",
      confirmButtonLabel: pause ? "Pause now" : "Unpause now",
      submitToast: pause ? "Submitting pause transaction..." : "Submitting unpause transaction...",
      successToast: pause ? "Pause transaction finalized." : "Unpause transaction finalized.",
    });
  };

  const handleFreeze = (unfreeze: boolean) => {
    const accountAddress = freezeForm.accountAddress.trim();
    if (!accountAddress) {
      toast.error("Account address is required.");
      return;
    }

    if (unfreeze) {
      runAction({
        label: "Unfreeze account",
        method: "POST",
        path: `${tokenBasePath}/unfreeze`,
        body: {
          accountAddress,
        },
      },
      {
        requiresConfirmation: true,
        confirmationTitle: "Unfreeze account?",
        confirmationDescription: "This will submit an unfreeze transaction on-chain.",
        confirmButtonLabel: "Unfreeze now",
        submitToast: "Submitting unfreeze transaction...",
        successToast: "Unfreeze transaction finalized.",
      });
      return;
    }

    runAction({
      label: "Freeze account",
      method: "POST",
      path: `${tokenBasePath}/freeze`,
      body: {
        accountAddress,
        reason: asOptionalString(freezeForm.reason),
      },
    },
    {
      requiresConfirmation: true,
      confirmationTitle: "Freeze account?",
      confirmationDescription: "This will submit a freeze transaction on-chain.",
      confirmButtonLabel: "Freeze now",
      submitToast: "Submitting freeze transaction...",
      successToast: "Freeze transaction finalized.",
    });
  };

  const handleAddAllowlist = () => {
    const address = allowlistForm.address.trim();
    if (!address) {
      toast.error("Allowlist address is required.");
      return;
    }

    runAction({
      label: "Add allowlist entry",
      method: "POST",
      path: `${tokenBasePath}/allowlist`,
      body: {
        address,
        label: asOptionalString(allowlistForm.label),
      },
    });
  };

  const handleRemoveAllowlist = (entryId: string) => {
    runAction({
      label: "Remove allowlist entry",
      method: "DELETE",
      path: `${tokenBasePath}/allowlist/${entryId}`,
    });
  };

  const selectAction = (action: AdminAction) => {
    setActiveAction(action);
    setIsActionMenuOpen(false);
  };

  return (
    <div className="space-y-8 pb-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-[rgba(28,28,29,0.14)] bg-white text-[18px] font-semibold text-[rgba(28,28,29,0.66)]">
            {token.symbol.slice(0, 1) || "T"}
          </div>
          <div className="min-w-0">
            <h2 className="truncate text-[30px] leading-[1.1] font-medium text-[#1c1c1d]">{token.name}</h2>
            <p className="truncate text-[17px] text-[rgba(28,28,29,0.66)]">{token.symbol}</p>
          </div>
        </div>

        <div className="relative flex items-center gap-2">
          {explorerHref ? (
            <Button variant="outline" asChild>
              <Link href={explorerHref} target="_blank" rel="noopener noreferrer">
                Explorer
                <ArrowUpRight className="h-4 w-4" />
              </Link>
            </Button>
          ) : (
            <Button variant="outline" disabled>
              Explorer
            </Button>
          )}
          <Button
            type="button"
            variant="secondary"
            onClick={() => setIsActionMenuOpen((open) => !open)}
          >
            Admin Actions
            <ChevronDown className="h-4 w-4" />
          </Button>

          {isActionMenuOpen ? (
            <div className="absolute top-[44px] right-0 z-20 w-[260px] overflow-hidden rounded-xl border border-[rgba(28,28,29,0.12)] bg-white shadow-[0_14px_28px_rgba(28,28,29,0.16)]">
              <div className="border-b border-[rgba(28,28,29,0.08)] px-3 py-2 text-xs font-medium tracking-wide text-[rgba(28,28,29,0.6)] uppercase">
                Token Actions
              </div>
              <div className="p-1">
                <button
                  type="button"
                  onClick={() => selectAction("mint")}
                  className="flex w-full items-center rounded-lg px-3 py-2 text-left text-sm hover:bg-[rgba(28,28,29,0.05)]"
                >
                  Mint Tokens
                </button>
                <button
                  type="button"
                  onClick={() => selectAction("burn")}
                  className="flex w-full items-center rounded-lg px-3 py-2 text-left text-sm hover:bg-[rgba(28,28,29,0.05)]"
                >
                  Burn Tokens
                </button>
                <button
                  type="button"
                  onClick={() => selectAction("update-metadata")}
                  className="flex w-full items-center rounded-lg px-3 py-2 text-left text-sm hover:bg-[rgba(28,28,29,0.05)]"
                >
                  Update Metadata
                </button>
                <button
                  type="button"
                  onClick={() => selectAction("refresh-supply")}
                  className="flex w-full items-center rounded-lg px-3 py-2 text-left text-sm hover:bg-[rgba(28,28,29,0.05)]"
                >
                  Refresh Supply
                </button>
              </div>
              <div className="border-y border-[rgba(28,28,29,0.08)] px-3 py-2 text-xs font-medium tracking-wide text-[rgba(28,28,29,0.6)] uppercase">
                Administrative
              </div>
              <div className="p-1">
                <button
                  type="button"
                  onClick={() => {
                    if (!canDeployToken) {
                      return;
                    }
                    setIsActionMenuOpen(false);
                    handleDeploy("execute");
                  }}
                  disabled={!canDeployToken || isPending}
                  className={[
                    "flex w-full items-center rounded-lg px-3 py-2 text-left text-sm",
                    canDeployToken
                      ? "hover:bg-[rgba(28,28,29,0.05)]"
                      : "cursor-not-allowed text-[rgba(28,28,29,0.42)] opacity-60",
                  ].join(" ")}
                >
                  Deploy Token
                </button>
                <button
                  type="button"
                  onClick={() => selectAction("seize")}
                  className="flex w-full items-center rounded-lg px-3 py-2 text-left text-sm hover:bg-[rgba(28,28,29,0.05)]"
                >
                  Force Transfer
                </button>
                <button
                  type="button"
                  onClick={() => selectAction("force-burn")}
                  className="flex w-full items-center rounded-lg px-3 py-2 text-left text-sm hover:bg-[rgba(28,28,29,0.05)]"
                >
                  Force Burn
                </button>
                <button
                  type="button"
                  onClick={() => selectAction("freeze")}
                  className="flex w-full items-center rounded-lg px-3 py-2 text-left text-sm hover:bg-[rgba(28,28,29,0.05)]"
                >
                  Freeze / Unfreeze Account
                </button>
                <button
                  type="button"
                  onClick={() => selectAction("pause")}
                  className="flex w-full items-center rounded-lg px-3 py-2 text-left text-sm hover:bg-[rgba(28,28,29,0.05)]"
                >
                  Pause / Unpause Token
                </button>
                <button
                  type="button"
                  onClick={() => selectAction("authority")}
                  className="flex w-full items-center rounded-lg px-3 py-2 text-left text-sm hover:bg-[rgba(28,28,29,0.05)]"
                >
                  Update Authority
                </button>
                <button
                  type="button"
                  onClick={() => selectAction("allowlist")}
                  className="flex w-full items-center rounded-lg px-3 py-2 text-left text-sm hover:bg-[rgba(28,28,29,0.05)]"
                >
                  Manage Allowlist
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {tokenError ? (
        <div className="rounded-xl border border-[#c71f37]/20 bg-[#c71f37]/[0.03] px-4 py-3">
          <p className="text-sm font-medium text-[#8a1f2a]">Token load warning</p>
          <p className="mt-1 text-sm text-[#8a1f2a]">{tokenError}</p>
        </div>
      ) : null}

      <section className="space-y-3">
        <h3 className="text-[36px] leading-[40px] font-medium tracking-[-0.3px] text-[#1c1c1d]">Token Overview</h3>
        <div className="overflow-hidden rounded-2xl border border-[rgba(28,28,29,0.12)] bg-white">
          <OverviewRow label="Token Address" value={token.mintAddress ?? "Not deployed"} monospace />
          <OverviewRow label="Mint Authority" value={token.mintAuthority ?? "None"} monospace />
          <OverviewRow label="Supply" value={token.totalSupply} />
          <OverviewRow label="Created" value={formatDate(token.createdAt)} />
          <OverviewRow label="Template" value={token.template} />
          <OverviewRow label="Decimals" value={String(token.decimals)} />
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="text-[36px] leading-[40px] font-medium tracking-[-0.3px] text-[#1c1c1d]">Settings</h3>
        <div className="border-b border-[rgba(28,28,29,0.12)]">
          <div className="flex gap-8">
            <button
              type="button"
              onClick={() => setSettingsTab("permissions")}
              className={[
                "relative pb-3 text-[16px] leading-[24px] font-medium",
                settingsTab === "permissions" ? "text-[#1c1c1d]" : "text-[rgba(28,28,29,0.58)]",
              ].join(" ")}
            >
              Permissions
              {settingsTab === "permissions" ? (
                <span className="absolute right-0 bottom-[-1px] left-0 h-[2px] bg-[#1c1c1d]" />
              ) : null}
            </button>
            <button
              type="button"
              onClick={() => setSettingsTab("extensions")}
              className={[
                "relative pb-3 text-[16px] leading-[24px] font-medium",
                settingsTab === "extensions" ? "text-[#1c1c1d]" : "text-[rgba(28,28,29,0.58)]",
              ].join(" ")}
            >
              Extensions
              {settingsTab === "extensions" ? (
                <span className="absolute right-0 bottom-[-1px] left-0 h-[2px] bg-[#1c1c1d]" />
              ) : null}
            </button>
          </div>
        </div>

        {settingsTab === "permissions" ? (
          <div className="overflow-hidden rounded-2xl border border-[rgba(28,28,29,0.12)] bg-white">
            {permissionRows.map((row) => (
              <div
                key={row.id}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-[rgba(28,28,29,0.08)] px-4 py-3 last:border-b-0"
              >
                <div>
                  <p className="text-[17px] font-medium text-[#1c1c1d]">{row.title}</p>
                  <p className="text-sm text-[rgba(28,28,29,0.62)]">{row.helper}</p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleCopy(row.value)}
                    className="inline-flex items-center gap-1 rounded-full border border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.02)] px-3 py-1 text-xs font-mono text-[rgba(28,28,29,0.75)]"
                  >
                    {formatValue(row.value)}
                    {row.value ? <Copy className="h-3 w-3" /> : null}
                  </button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setActiveAction(row.action)}
                  >
                    Edit
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-[rgba(28,28,29,0.12)] bg-white">
            {extensionRows.map((row) => (
              <div
                key={row.id}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-[rgba(28,28,29,0.08)] px-4 py-3 last:border-b-0"
              >
                <div>
                  <p className="text-[17px] font-medium text-[#1c1c1d]">{row.title}</p>
                  <p className="text-sm text-[rgba(28,28,29,0.62)]">{row.helper}</p>
                </div>
                <span className="rounded-full border border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.02)] px-3 py-1 text-sm text-[rgba(28,28,29,0.75)]">
                  {row.value}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      {activeAction === "update-metadata" ? (
        <ActionCard title="Update Metadata" description="Edit token metadata and status.">
          <div className="grid gap-3 md:grid-cols-2">
            <Label>
              Name
              <Input
                value={metadataForm.name}
                onChange={(event) =>
                  setMetadataForm((previous) => ({ ...previous, name: event.currentTarget.value }))
                }
              />
            </Label>
            <Label>
              Status
              <select
                className="h-10 w-full rounded-[10px] border border-[rgba(28,28,29,0.16)] bg-white px-3 text-sm"
                value={metadataForm.status}
                onChange={(event) =>
                  setMetadataForm((previous) => ({
                    ...previous,
                    status: event.currentTarget.value as "active" | "paused",
                  }))
                }
              >
                <option value="active">active</option>
                <option value="paused">paused</option>
              </select>
            </Label>
            <Label>
              Description
              <Input
                value={metadataForm.description}
                onChange={(event) =>
                  setMetadataForm((previous) => ({ ...previous, description: event.currentTarget.value }))
                }
              />
            </Label>
            <Label>
              URI
              <Input
                value={metadataForm.uri}
                onChange={(event) =>
                  setMetadataForm((previous) => ({ ...previous, uri: event.currentTarget.value }))
                }
              />
            </Label>
            <Label className="md:col-span-2">
              Image URL
              <Input
                value={metadataForm.imageUrl}
                onChange={(event) =>
                  setMetadataForm((previous) => ({ ...previous, imageUrl: event.currentTarget.value }))
                }
              />
            </Label>
          </div>
          <Button type="button" onClick={handleUpdateMetadata} disabled={isPending}>
            Save metadata
          </Button>
        </ActionCard>
      ) : null}

      {activeAction === "refresh-supply" ? (
        <ActionCard title="Refresh Supply" description="Fetch supply from RPC and update cache.">
          <Button type="button" variant="secondary" onClick={handleRefreshSupply} disabled={isPending}>
            Refresh supply
          </Button>
        </ActionCard>
      ) : null}

      {activeAction === "mint" ? (
        <ActionCard title="Mint Tokens" description="Mint to destination wallet/token account.">
          <div className="grid gap-3 md:grid-cols-2">
            <Label>
              Destination
              <Input
                value={mintForm.destination}
                onChange={(event) =>
                  setMintForm((previous) => ({ ...previous, destination: event.currentTarget.value }))
                }
              />
            </Label>
            <Label>
              Amount
              <Input
                value={mintForm.amount}
                onChange={(event) =>
                  setMintForm((previous) => ({ ...previous, amount: event.currentTarget.value }))
                }
              />
            </Label>
            <Label className="md:col-span-2">
              Memo
              <Input
                value={mintForm.memo}
                onChange={(event) =>
                  setMintForm((previous) => ({ ...previous, memo: event.currentTarget.value }))
                }
              />
            </Label>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={() => handleMint("prepare")} disabled={isPending}>
              Mint (prepare)
            </Button>
            <Button type="button" onClick={() => handleMint("execute")} disabled={isPending}>
              Mint (execute)
            </Button>
          </div>
        </ActionCard>
      ) : null}

      {activeAction === "burn" ? (
        <ActionCard title="Burn Tokens" description="Burn from source wallet/token account.">
          <div className="grid gap-3 md:grid-cols-2">
            <Label>
              Source
              <Input
                value={burnForm.source}
                onChange={(event) =>
                  setBurnForm((previous) => ({ ...previous, source: event.currentTarget.value }))
                }
              />
            </Label>
            <Label>
              Amount
              <Input
                value={burnForm.amount}
                onChange={(event) =>
                  setBurnForm((previous) => ({ ...previous, amount: event.currentTarget.value }))
                }
              />
            </Label>
            <Label className="md:col-span-2">
              Memo
              <Input
                value={burnForm.memo}
                onChange={(event) =>
                  setBurnForm((previous) => ({ ...previous, memo: event.currentTarget.value }))
                }
              />
            </Label>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={() => handleBurn("prepare")} disabled={isPending}>
              Burn (prepare)
            </Button>
            <Button type="button" onClick={() => handleBurn("execute")} disabled={isPending}>
              Burn (execute)
            </Button>
          </div>
        </ActionCard>
      ) : null}

      {activeAction === "seize" ? (
        <ActionCard title="Force Transfer" description="Administrative seizure transfer between accounts.">
          <div className="grid gap-3 md:grid-cols-2">
            <Label>
              Source
              <Input
                value={seizeForm.source}
                onChange={(event) =>
                  setSeizeForm((previous) => ({ ...previous, source: event.currentTarget.value }))
                }
              />
            </Label>
            <Label>
              Destination
              <Input
                value={seizeForm.destination}
                onChange={(event) =>
                  setSeizeForm((previous) => ({ ...previous, destination: event.currentTarget.value }))
                }
              />
            </Label>
            <Label>
              Amount
              <Input
                value={seizeForm.amount}
                onChange={(event) =>
                  setSeizeForm((previous) => ({ ...previous, amount: event.currentTarget.value }))
                }
              />
            </Label>
            <Label>
              Delegate Authority (optional)
              <Input
                value={seizeForm.delegateAuthority}
                onChange={(event) =>
                  setSeizeForm((previous) => ({ ...previous, delegateAuthority: event.currentTarget.value }))
                }
              />
            </Label>
            <Label className="md:col-span-2">
              Memo
              <Input
                value={seizeForm.memo}
                onChange={(event) =>
                  setSeizeForm((previous) => ({ ...previous, memo: event.currentTarget.value }))
                }
              />
            </Label>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={() => handleSeize("prepare")} disabled={isPending}>
              Seize (prepare)
            </Button>
            <Button type="button" onClick={() => handleSeize("execute")} disabled={isPending}>
              Seize (execute)
            </Button>
          </div>
        </ActionCard>
      ) : null}

      {activeAction === "force-burn" ? (
        <ActionCard title="Force Burn" description="Administrative forced burn from source account.">
          <div className="grid gap-3 md:grid-cols-2">
            <Label>
              Source
              <Input
                value={forceBurnForm.source}
                onChange={(event) =>
                  setForceBurnForm((previous) => ({ ...previous, source: event.currentTarget.value }))
                }
              />
            </Label>
            <Label>
              Amount
              <Input
                value={forceBurnForm.amount}
                onChange={(event) =>
                  setForceBurnForm((previous) => ({ ...previous, amount: event.currentTarget.value }))
                }
              />
            </Label>
            <Label>
              Delegate Authority (optional)
              <Input
                value={forceBurnForm.delegateAuthority}
                onChange={(event) =>
                  setForceBurnForm((previous) => ({ ...previous, delegateAuthority: event.currentTarget.value }))
                }
              />
            </Label>
            <Label>
              Memo
              <Input
                value={forceBurnForm.memo}
                onChange={(event) =>
                  setForceBurnForm((previous) => ({ ...previous, memo: event.currentTarget.value }))
                }
              />
            </Label>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => handleForceBurn("prepare")}
              disabled={isPending}
            >
              Force Burn (prepare)
            </Button>
            <Button type="button" onClick={() => handleForceBurn("execute")} disabled={isPending}>
              Force Burn (execute)
            </Button>
          </div>
        </ActionCard>
      ) : null}

      {activeAction === "authority" ? (
        <ActionCard title="Update Authority" description="Rotate or remove token authorities.">
          <div className="grid gap-3 md:grid-cols-2">
            <Label>
              Role
              <select
                className="h-10 w-full rounded-[10px] border border-[rgba(28,28,29,0.16)] bg-white px-3 text-sm"
                value={authorityForm.role}
                onChange={(event) =>
                  setAuthorityForm((previous) => ({
                    ...previous,
                    role: event.currentTarget.value as AuthorityFormState["role"],
                  }))
                }
              >
                <option value="mint">mint</option>
                <option value="freeze">freeze</option>
                <option value="permanentDelegate">permanentDelegate</option>
                <option value="metadata">metadata</option>
              </select>
            </Label>
            <Label>
              Current Authority (optional)
              <Input
                value={authorityForm.currentAuthority}
                onChange={(event) =>
                  setAuthorityForm((previous) => ({
                    ...previous,
                    currentAuthority: event.currentTarget.value,
                  }))
                }
              />
            </Label>
            <Label className="md:col-span-2">
              New Authority (empty to remove)
              <Input
                value={authorityForm.newAuthority}
                onChange={(event) =>
                  setAuthorityForm((previous) => ({ ...previous, newAuthority: event.currentTarget.value }))
                }
              />
            </Label>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => handleAuthorityUpdate("prepare")}
              disabled={isPending}
            >
              Authority (prepare)
            </Button>
            <Button type="button" onClick={() => handleAuthorityUpdate("execute")} disabled={isPending}>
              Authority (execute)
            </Button>
          </div>
        </ActionCard>
      ) : null}

      {activeAction === "pause" ? (
        <ActionCard title="Pause Controls" description="Pause or resume token-wide transfers.">
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={() => handlePause(true)} disabled={isPending}>
              Pause token
            </Button>
            <Button type="button" onClick={() => handlePause(false)} disabled={isPending}>
              Unpause token
            </Button>
          </div>
        </ActionCard>
      ) : null}

      {activeAction === "freeze" ? (
        <ActionCard title="Freeze Controls" description="Freeze or thaw a token account.">
          <div className="grid gap-3 md:grid-cols-2">
            <Label>
              Account Address
              <Input
                value={freezeForm.accountAddress}
                onChange={(event) =>
                  setFreezeForm((previous) => ({ ...previous, accountAddress: event.currentTarget.value }))
                }
              />
            </Label>
            <Label>
              Reason (freeze only)
              <Input
                value={freezeForm.reason}
                onChange={(event) =>
                  setFreezeForm((previous) => ({ ...previous, reason: event.currentTarget.value }))
                }
              />
            </Label>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={() => handleFreeze(false)} disabled={isPending}>
              Freeze account
            </Button>
            <Button type="button" onClick={() => handleFreeze(true)} disabled={isPending}>
              Unfreeze account
            </Button>
          </div>
        </ActionCard>
      ) : null}

      {activeAction === "allowlist" ? (
        <ActionCard title="Allowlist" description="Add or remove allowlist addresses.">
          <div className="grid gap-3 md:grid-cols-2">
            <Label>
              Address
              <Input
                value={allowlistForm.address}
                onChange={(event) =>
                  setAllowlistForm((previous) => ({ ...previous, address: event.currentTarget.value }))
                }
              />
            </Label>
            <Label>
              Label
              <Input
                value={allowlistForm.label}
                onChange={(event) =>
                  setAllowlistForm((previous) => ({ ...previous, label: event.currentTarget.value }))
                }
              />
            </Label>
          </div>
          <Button type="button" onClick={handleAddAllowlist} disabled={isPending}>
            Add allowlist entry
          </Button>

          {allowlistError ? (
            <p className="text-sm text-[#8a1f2a]">{allowlistError}</p>
          ) : allowlistEntries.length === 0 ? (
            <p className="text-sm text-[rgba(28,28,29,0.68)]">No active allowlist entries.</p>
          ) : (
            <div className="space-y-2">
              {allowlistEntries.map((entry) => (
                <div
                  key={entry.id}
                  className="flex items-center justify-between gap-2 rounded-lg border border-[rgba(28,28,29,0.12)] px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate font-mono text-xs text-[#1c1c1d]">{entry.address}</p>
                    <p className="text-xs text-[rgba(28,28,29,0.62)]">{entry.label ?? "No label"}</p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => handleRemoveAllowlist(entry.id)}
                    disabled={isPending}
                  >
                    Remove
                  </Button>
                </div>
              ))}
            </div>
          )}
        </ActionCard>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="gap-4">
          <CardHeader>
            <CardTitle>Transactions</CardTitle>
            <CardDescription>Recent token operations</CardDescription>
          </CardHeader>
          <CardContent>
            {transactionsError ? (
              <p className="text-sm text-[#8a1f2a]">{transactionsError}</p>
            ) : transactions.length === 0 ? (
              <p className="text-sm text-[rgba(28,28,29,0.68)]">No transactions yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Type</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Signature</TableHead>
                    <TableHead>Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {transactions.slice(0, 12).map((transaction) => (
                    <TableRow key={transaction.id}>
                      <TableCell>{transaction.type}</TableCell>
                      <TableCell>{transaction.status}</TableCell>
                      <TableCell className="max-w-[220px] truncate font-mono text-xs">
                        {transaction.signature ?? "—"}
                      </TableCell>
                      <TableCell>{formatDate(transaction.createdAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card className="gap-4">
          <CardHeader>
            <CardTitle>Control Lists</CardTitle>
            <CardDescription>Allowlist and frozen account status</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-xl border border-[rgba(28,28,29,0.12)] p-3">
              <p className="text-sm font-medium text-[#1c1c1d]">Allowlist Entries</p>
              {allowlistError ? (
                <p className="mt-1 text-sm text-[#8a1f2a]">{allowlistError}</p>
              ) : (
                <p className="mt-1 text-sm text-[rgba(28,28,29,0.66)]">{allowlistEntries.length} entries</p>
              )}
            </div>
            <div className="rounded-xl border border-[rgba(28,28,29,0.12)] p-3">
              <p className="text-sm font-medium text-[#1c1c1d]">Frozen Accounts</p>
              {frozenAccountsError ? (
                <p className="mt-1 text-sm text-[#8a1f2a]">{frozenAccountsError}</p>
              ) : (
                <p className="mt-1 text-sm text-[rgba(28,28,29,0.66)]">{frozenAccounts.length} accounts</p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="gap-4">
        <CardHeader>
          <CardTitle>Last Action Response</CardTitle>
          <CardDescription>Most recent API payload for admin action execution.</CardDescription>
        </CardHeader>
        <CardContent>
          {lastActionResult ? (
            <div className="space-y-2">
              <p className={lastActionResult.ok ? "text-sm text-[#0f9b58]" : "text-sm text-[#8a1f2a]"}>
                {lastActionResult.message}
              </p>
              <pre className="max-h-[320px] overflow-auto rounded-xl border border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.03)] p-3 text-xs text-[#1c1c1d]">
                {stringifyBody(lastActionResult.body)}
              </pre>
            </div>
          ) : (
            <p className="text-sm text-[rgba(28,28,29,0.68)]">Select and run an action to inspect response data.</p>
          )}
        </CardContent>
      </Card>

      {actionConfirmation ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-[rgba(18,18,19,0.44)] p-4">
          <div className="w-full max-w-md rounded-2xl border border-[rgba(28,28,29,0.12)] bg-white p-5 shadow-[0_20px_40px_rgba(0,0,0,0.16)]">
            <h4 className="text-[22px] leading-[1.2] font-medium text-[#1c1c1d]">
              {actionConfirmation.options.confirmationTitle}
            </h4>
            <p className="mt-2 text-[15px] leading-[1.45] text-[rgba(28,28,29,0.72)]">
              {actionConfirmation.options.confirmationDescription}
            </p>
            <div className="mt-5 flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setActionConfirmation(null)}
                disabled={isPending}
              >
                Not now
              </Button>
              <Button
                type="button"
                onClick={() => {
                  const pendingConfirmation = actionConfirmation;
                  if (!pendingConfirmation) {
                    return;
                  }
                  setActionConfirmation(null);
                  executeAction(pendingConfirmation.input, pendingConfirmation.options);
                }}
                disabled={isPending}
              >
                {actionConfirmation.options.confirmButtonLabel}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {isPending ? (
        <div className="fixed right-4 bottom-4 z-30 inline-flex items-center gap-2 rounded-lg border border-[rgba(28,28,29,0.12)] bg-white px-3 py-2 text-sm shadow-lg">
          <Loader2 className="h-4 w-4 animate-spin" />
          Running action...
        </div>
      ) : null}

    </div>
  );
}
