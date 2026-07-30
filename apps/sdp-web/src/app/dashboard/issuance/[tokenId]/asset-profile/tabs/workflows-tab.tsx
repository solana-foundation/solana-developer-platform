"use client";

import { Loader2, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { formatRelativeTime } from "@/app/dashboard/activity-format-utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { HoldToConfirmButton } from "@/components/ui/hold-to-confirm-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Modal } from "@/components/ui/modal";
import { Select, SelectItem } from "@/components/ui/select";
import { SkeletonBlock } from "@/components/ui/skeleton-block";
import type { MessageKey } from "@/i18n/messages";
import { useLocale, useTranslations } from "@/i18n/provider";
import { usePersistedDashboardSWR } from "@/lib/dashboard-swr";
import {
  approveExecution,
  type CatalogActionView,
  createWorkflow,
  deleteWorkflow,
  type ExecutionStatus,
  type ExecutionTier,
  type ExecutionView,
  enrollHolder,
  fetchExecutions,
  fetchHolders,
  fetchNotificationConfig,
  fetchWorkflowCatalog,
  fetchWorkflows,
  type GuardClause,
  type GuardDraft,
  type HolderView,
  humanizeType,
  rejectExecution,
  retryExecution,
  setWorkflowEnabled,
  updateWorkflow,
  type WorkflowCatalog,
  type WorkflowRuleView,
} from "../workflows.data";
import { GuardEditor } from "./guard-editor";
import { WorkflowFlowPreview } from "./workflow-flow-preview";

// ── Static catalog metadata ─────────────────────────────────────────────────────────

// Per-action inputs the builder collects beyond the trigger payload. Wallet/source
// default to the trigger's subject wallet when left blank, so they're optional there.
// labelKey/helpKey/options[].labelKey are i18n key suffixes under workflows.*
interface ParamField {
  key: string;
  labelKey: string;
  required?: boolean;
  helpKey?: string;
  secret?: boolean;
  options?: Array<{ value: string; labelKey: string }>;
}

const WALLET_HELP = "paramWalletHelp";

const ACTION_PARAM_FIELDS: Record<string, ParamField[]> = {
  mint: [
    { key: "amount", labelKey: "paramAmount", required: true },
    { key: "wallet", labelKey: "paramDestination", helpKey: WALLET_HELP },
  ],
  burn: [{ key: "amount", labelKey: "paramAmount", required: true }],
  force_burn: [
    { key: "amount", labelKey: "paramAmount", required: true },
    { key: "source", labelKey: "paramSource", helpKey: WALLET_HELP },
  ],
  seize: [
    { key: "amount", labelKey: "paramAmount", required: true },
    { key: "destination", labelKey: "paramDestination", required: true },
    { key: "source", labelKey: "paramSource", helpKey: WALLET_HELP },
  ],
  send_webhook: [
    { key: "url", labelKey: "paramWebhookUrl", required: true },
    { key: "secret", labelKey: "paramSecret", secret: true },
  ],
  notify: [
    {
      key: "audience",
      labelKey: "paramNotify",
      options: [
        { value: "admins", labelKey: "audienceAdmins" },
        { value: "members", labelKey: "audienceMembers" },
      ],
    },
    { key: "email", labelKey: "paramEmail", helpKey: "paramEmailHelp" },
  ],
  freeze: [{ key: "wallet", labelKey: "paramWallet", helpKey: WALLET_HELP }],
  unfreeze: [{ key: "wallet", labelKey: "paramWallet", helpKey: WALLET_HELP }],
  allowlist_add: [{ key: "wallet", labelKey: "paramWallet", helpKey: WALLET_HELP }],
  allowlist_remove: [{ key: "wallet", labelKey: "paramWallet", helpKey: WALLET_HELP }],
};

const TIER_VARIANT: Record<ExecutionTier, "success" | "warning" | "danger"> = {
  automated: "success",
  sensitive: "warning",
  requires_approval: "danger",
};

// Status dots stay within the semantic four: green (done), red (failed), amber
// (needs a human), gray (in flight / neutral).
const STATUS_DOT: Record<ExecutionStatus, string> = {
  succeeded: "bg-success",
  failed: "bg-error",
  awaiting_review: "bg-warning",
  processing: "bg-fill-strong",
  pending: "bg-fill-strong",
  cancelled: "bg-fill-strong",
};

// Triggers whose payload identifies a subject wallet. Any other trigger driving a
// wallet-targeting action needs the wallet supplied as an action param.
const TRIGGERS_WITH_WALLET = new Set(["kyc_approved", "kyc_rejected"]);
// The param that can fill that gap, per wallet-targeting action.
const ACTION_WALLET_PARAM: Record<string, string> = {
  mint: "wallet",
  freeze: "wallet",
  unfreeze: "wallet",
  allowlist_add: "wallet",
  allowlist_remove: "wallet",
  seize: "source",
  force_burn: "source",
};

const AMOUNT_RE = /^\d+(\.\d+)?$/;

// ── i18n helpers ────────────────────────────────────────────────────────────────────

type TFunc = ReturnType<typeof useTranslations>;

// Localized workflow string with a readable fallback — a missing key must degrade,
// never crash the tab.
function makeWf(t: TFunc) {
  return (k: string, values?: Record<string, string | number>): string => {
    try {
      return t(`DashboardIssuance.workflows.${k}` as MessageKey, values);
    } catch {
      return humanizeType(k);
    }
  };
}

// Localized label for a dynamic catalog key (trigger/action/status/conditionField),
// falling back to humanizeType for any key without a translation.
function makeLabel(t: TFunc) {
  return (kind: "trigger" | "action" | "status" | "conditionField", type: string): string => {
    try {
      return t(`DashboardIssuance.workflows.${kind}Labels.${type}` as MessageKey);
    } catch {
      return humanizeType(type);
    }
  };
}

// One-line explanation of what a trigger fires on / what an action does, rendered as
// help text under the builder's selects. The catalog's `descriptionKey` pointed at a
// namespace that never existed, which is why the builder explained nothing.
function makeDescription(t: TFunc) {
  return (kind: "trigger" | "action", type: string | null | undefined): string | null => {
    if (!type) {
      return null;
    }
    try {
      return t(`DashboardIssuance.workflows.${kind}Descriptions.${type}` as MessageKey);
    } catch {
      return null;
    }
  };
}

// Human-readable failure reason for the machine codes the engine writes into
// `execution.error` (CAPABILITY_REVOKED:…, HTTP_502, MISSING_PARAM:wallet, …).
// Unknown codes fall back to the raw string (it may be a chain error message).
const ERROR_CODE_KEYS: Record<string, string> = {
  RULE_NOT_FOUND: "errorCodes.ruleNotFound",
  RULE_DISABLED: "errorCodes.ruleDisabled",
  ASSET_CONTEXT_UNAVAILABLE: "errorCodes.assetUnavailable",
  CAPABILITY_REVOKED: "errorCodes.capabilityRevoked",
  TOKEN_NOT_FOUND: "errorCodes.tokenNotFound",
  TOKEN_NOT_DEPLOYED: "errorCodes.tokenNotDeployed",
  TOKEN_DECIMALS_UNKNOWN: "errorCodes.tokenNotDeployed",
  EMAIL_NOT_CONFIGURED: "errorCodes.emailNotConfigured",
  NO_RECIPIENTS_RESOLVED: "errorCodes.noRecipients",
  STALE_RECOVERED_NEEDS_REVIEW: "errorCodes.staleRecovered",
  MISSING_PARAM: "errorCodes.missingParam",
  MISSING_OR_INVALID_PARAM: "errorCodes.missingParam",
  MISSING_WALLET_IN_PAYLOAD: "errorCodes.missingParam",
  INVALID_ADDRESS: "errorCodes.invalidAddress",
  INVALID_PARAM: "errorCodes.invalidParam",
  ACTION_NOT_IMPLEMENTED: "errorCodes.unknown",
};

export function failureLabel(error: string, wf: ReturnType<typeof makeWf>): string {
  const [code, detail] = error.split(":", 2);
  if (code?.startsWith("HTTP_")) {
    return wf("errorCodes.http", { status: code.slice(5) });
  }
  const key = code ? ERROR_CODE_KEYS[code] : undefined;
  if (!key) {
    return error;
  }
  return detail ? `${wf(key)} (${detail})` : wf(key);
}

// ── Builder validation ──────────────────────────────────────────────────────────────

interface BuilderValidation {
  fieldErrors: Record<string, string>;
  guardsIncomplete: boolean;
  walletGap: boolean;
  ok: boolean;
}

export function validateBuilder(input: {
  triggerType: string | null;
  action: CatalogActionView | null;
  params: Record<string, string>;
  guards: GuardDraft[];
  wf: ReturnType<typeof makeWf>;
}): BuilderValidation {
  const { triggerType, action, params, guards, wf } = input;
  const fieldErrors: Record<string, string> = {};
  const fields = action ? (ACTION_PARAM_FIELDS[action.type] ?? []) : [];

  for (const field of fields) {
    const value = (params[field.key] ?? "").trim();
    if (field.required && !value) {
      fieldErrors[field.key] = wf("validationRequired");
      continue;
    }
    if (!value) {
      continue;
    }
    if (field.key === "amount" && (!AMOUNT_RE.test(value) || Number(value) <= 0)) {
      fieldErrors[field.key] = wf("validationAmount");
    }
    if (field.key === "url" && !/^https?:\/\/\S+$/i.test(value)) {
      fieldErrors[field.key] = wf("validationUrl");
    }
  }

  const guardsIncomplete = guards.some((guard) => !guard.field || !guard.value.trim());

  const walletParam = action ? ACTION_WALLET_PARAM[action.type] : undefined;
  const walletGap = Boolean(
    action &&
      walletParam &&
      triggerType &&
      !TRIGGERS_WITH_WALLET.has(triggerType) &&
      !(params[walletParam] ?? "").trim()
  );

  return {
    fieldErrors,
    guardsIncomplete,
    walletGap,
    ok: Object.keys(fieldErrors).length === 0 && !guardsIncomplete && !walletGap,
  };
}

// Collect filled guard rows into a WorkflowCondition; `in` splits on commas.
// (Validation guarantees no incomplete rows reach this point.)
export function guardsToCondition(guards: GuardDraft[]): { all: GuardClause[] } | undefined {
  const clauses: GuardClause[] = [];
  for (const guard of guards) {
    const value = guard.value.trim();
    if (!guard.field || !value) {
      continue;
    }
    if (guard.op === "in") {
      const list = value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
      if (list.length > 0) {
        clauses.push({ field: guard.field, op: "in", value: list });
      }
    } else {
      clauses.push({ field: guard.field, op: guard.op, value });
    }
  }
  return clauses.length > 0 ? { all: clauses } : undefined;
}

function conditionToGuards(rule: WorkflowRuleView): GuardDraft[] {
  const clauses = rule.definition?.condition?.all ?? [];
  return clauses.map((clause) => ({
    id: crypto.randomUUID(),
    field: clause.field,
    op: clause.op,
    value: Array.isArray(clause.value) ? clause.value.join(", ") : String(clause.value),
  }));
}

// ── Confirmation modal (reject / delete) ────────────────────────────────────────────

interface ConfirmState {
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
}

function ConfirmDialog({
  confirm,
  pending,
  cancelLabel,
  closeLabel,
  onCancel,
}: {
  confirm: ConfirmState | null;
  pending: boolean;
  cancelLabel: string;
  closeLabel: string;
  onCancel: () => void;
}) {
  if (!confirm) {
    return null;
  }
  return (
    <Modal
      isOpen
      onClose={onCancel}
      closeDisabled={pending}
      ariaLabel={confirm.title}
      closeLabel={closeLabel}
      contentClassName="border-border-default p-5"
      size="sm"
    >
      <h4 className="pr-12 text-lg font-medium text-primary">{confirm.title}</h4>
      <p className="mt-2 text-sm text-secondary">{confirm.description}</p>
      <div className="mt-5 flex items-center justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={pending}>
          {cancelLabel}
        </Button>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          onClick={confirm.onConfirm}
          disabled={pending}
        >
          {confirm.confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}

// Card-shaped loading placeholder so the layout doesn't collapse to a bare spinner.
function CardSkeleton({ lines }: { lines: number }) {
  return (
    <Card>
      <CardContent className="space-y-3 py-6">
        {Array.from({ length: lines }, (_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton rows
          <SkeletonBlock key={index} className="h-5 w-full" />
        ))}
      </CardContent>
    </Card>
  );
}

// ── Tab ─────────────────────────────────────────────────────────────────────────────

const EXECUTIONS_PAGE_SIZE = 50;
const EXECUTIONS_MAX_PAGE_SIZE = 200;

// Data — SWR with persisted snapshots: cached across tab switches, revalidated on
// focus, and immune to locale-change refetch loops.
function useWorkflowsData(tokenId: string, executionsPageSize: number) {
  const catalogSwr = usePersistedDashboardSWR(
    ["workflow-catalog", tokenId] as const,
    ([, id]) => fetchWorkflowCatalog(id),
    { revalidateOnFocus: true, revalidateIfStale: true },
    { key: `token.${tokenId}.workflow-catalog`, ttlMs: 60_000 }
  );
  const rulesSwr = usePersistedDashboardSWR(
    ["workflow-rules", tokenId] as const,
    ([, id]) => fetchWorkflows(id),
    { revalidateOnFocus: true, revalidateIfStale: true },
    { key: `token.${tokenId}.workflow-rules`, ttlMs: 15_000 }
  );
  const executionsSwr = usePersistedDashboardSWR(
    ["workflow-executions", tokenId, executionsPageSize] as const,
    ([, id, pageSize]) => fetchExecutions(id, Number(pageSize)),
    { revalidateOnFocus: true, revalidateIfStale: true, keepPreviousData: true },
    { key: `token.${tokenId}.workflow-executions.${executionsPageSize}`, ttlMs: 10_000 }
  );
  const holdersSwr = usePersistedDashboardSWR(
    ["workflow-holders", tokenId] as const,
    ([, id]) => fetchHolders(id),
    { revalidateOnFocus: true, revalidateIfStale: true },
    { key: `token.${tokenId}.workflow-holders`, ttlMs: 30_000 }
  );
  const configSwr = usePersistedDashboardSWR(
    ["notification-config"] as const,
    () => fetchNotificationConfig(),
    { revalidateOnFocus: false },
    { key: "notification-config", ttlMs: 300_000 }
  );

  const catalog = catalogSwr.data ?? null;
  const rules = rulesSwr.data ?? [];
  return {
    catalogSwr,
    rulesSwr,
    executionsSwr,
    holdersSwr,
    catalog,
    rules,
    executions: executionsSwr.data?.executions ?? [],
    executionsTotal: executionsSwr.data?.total ?? 0,
    holders: holdersSwr.data?.holders ?? [],
    // null = config unreachable → don't claim email is unavailable.
    emailEnabled: configSwr.data === null ? null : (configSwr.data?.emailEnabled ?? null),
    initialLoading:
      (catalogSwr.isLoading && !catalog) || (rulesSwr.isLoading && rules.length === 0),
    loadFailed: Boolean((catalogSwr.error && !catalog) || (rulesSwr.error && !rulesSwr.data)),
  };
}

export function WorkflowsTab({
  tokenId,
  canManage,
  canManagePrivileged,
}: {
  tokenId: string;
  // tokens:write — enough for `automated` rules.
  canManage: boolean;
  // tokens:admin — required for `sensitive` and `requires_approval` rules, mirroring the
  // API's tier gate. Enforced there; here it just keeps the builder honest.
  canManagePrivileged: boolean;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const wf = useMemo(() => makeWf(t), [t]);
  const label = useMemo(() => makeLabel(t), [t]);
  const describe = useMemo(() => makeDescription(t), [t]);

  const [executionsPageSize, setExecutionsPageSize] = useState(EXECUTIONS_PAGE_SIZE);
  const {
    catalogSwr,
    rulesSwr,
    executionsSwr,
    holdersSwr,
    catalog,
    rules,
    executions,
    executionsTotal,
    holders,
    emailEnabled,
    initialLoading,
    loadFailed,
  } = useWorkflowsData(tokenId, executionsPageSize);

  // ── Builder state ──
  const [triggerType, setTriggerType] = useState<string | null>(null);
  const [actionType, setActionType] = useState<string | null>(null);
  const [reviewMode, setReviewMode] = useState<"auto" | "manual">("auto");
  const [params, setParams] = useState<Record<string, string>>({});
  const [guards, setGuards] = useState<GuardDraft[]>([]);
  const [showValidation, setShowValidation] = useState(false);
  // Rule being edited (trigger/action locked); null = creating a new rule.
  const [editingRule, setEditingRule] = useState<WorkflowRuleView | null>(null);
  // Id of the row (rule/execution/"create"/"enroll") with an in-flight mutation.
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [walletAddress, setWalletAddress] = useState("");

  const effectiveTrigger = editingRule?.trigger_type ?? triggerType ?? catalog?.triggers[0]?.type;
  const selectedTrigger = catalog?.triggers.find((tr) => tr.type === effectiveTrigger) ?? null;
  const conditionFields = selectedTrigger?.trigger.conditionFields ?? [];
  const effectiveAction = editingRule?.action_type ?? actionType;
  const selectedAction = catalog?.actions.find((a) => a.type === effectiveAction) ?? null;
  const paramFields = effectiveAction ? (ACTION_PARAM_FIELDS[effectiveAction] ?? []) : [];

  const validation = validateBuilder({
    triggerType: effectiveTrigger ?? null,
    action: selectedAction,
    params,
    guards,
    wf,
  });
  // Tier of an action from the catalog. Fails CLOSED: an unknown tier (catalog failed
  // to load, or an action the client doesn't know) counts as requires_approval so a
  // destructive action can never degrade into a one-click, member-authored rule.
  const tierForAction = (type: string): ExecutionTier =>
    catalog?.actions.find((a) => a.type === type)?.action.execution ?? "requires_approval";

  // Mirrors the API's tier gate (workflow-authz.ts): `automated` needs tokens:write,
  // everything else tokens:admin.
  const canUseAction = (type: string): boolean =>
    tierForAction(type) === "automated" ? canManage : canManagePrivileged;

  const actionAllowed = effectiveAction ? canUseAction(effectiveAction) : true;
  const canSubmit =
    canManage &&
    actionAllowed &&
    Boolean(effectiveTrigger && selectedAction?.support.ok) &&
    busyId === null;

  // One-line "field: value · …" summary of the collected action params, for the
  // preview. Secrets are masked, option values localized.
  const paramSummary = paramFields
    .map((field) => {
      const value = (params[field.key] ?? "").trim();
      if (!value) {
        return null;
      }
      if (field.secret) {
        return `${wf(field.labelKey)}: ••••`;
      }
      const option = field.options?.find((opt) => opt.value === value);
      return `${wf(field.labelKey)}: ${option ? wf(option.labelKey) : value}`;
    })
    .filter((entry): entry is string => entry !== null)
    .join(" · ");

  const resetBuilder = useCallback(() => {
    setEditingRule(null);
    setActionType(null);
    setParams({});
    setGuards([]);
    setReviewMode("auto");
    setShowValidation(false);
  }, []);

  // Switching trigger changes which condition fields exist, so any authored guards no
  // longer apply — clear them (params keep only option defaults via action change).
  const onTriggerChange = (value: string | null) => {
    setTriggerType(value);
    setGuards([]);
    setShowValidation(false);
  };

  // Switching action resets the collected params and seeds sensible defaults.
  const onActionChange = (value: string | null) => {
    setActionType(value);
    const defaults: Record<string, string> = {};
    for (const field of (value ? ACTION_PARAM_FIELDS[value] : undefined) ?? []) {
      if (field.options?.[0]) {
        defaults[field.key] = field.options[0].value;
      }
    }
    setParams(defaults);
    setShowValidation(false);
  };

  // Load an existing rule into the builder for editing (trigger/action immutable).
  const startEditing = (rule: WorkflowRuleView) => {
    setEditingRule(rule);
    setTriggerType(rule.trigger_type);
    setActionType(rule.action_type);
    setReviewMode(rule.review_mode);
    const ruleParams = rule.definition?.action?.params ?? {};
    setParams(
      Object.fromEntries(Object.entries(ruleParams).map(([key, value]) => [key, String(value)]))
    );
    setGuards(conditionToGuards(rule));
    setShowValidation(false);
  };

  // GUARD editor row operations (stable ids — index keys would jump the caret on remove).
  const addGuard = () => {
    const first = conditionFields[0];
    if (!first) {
      return;
    }
    setGuards((prev) => [...prev, { id: crypto.randomUUID(), field: first, op: "eq", value: "" }]);
  };
  const updateGuard = (id: string, patch: Partial<GuardDraft>) => {
    setGuards((prev) => prev.map((guard) => (guard.id === id ? { ...guard, ...patch } : guard)));
  };
  const removeGuard = (id: string) => {
    setGuards((prev) => prev.filter((guard) => guard.id !== id));
  };

  // Wraps a mutation with per-row busy state, toasts, and the right refetches.
  const runMutation = async (
    id: string,
    mutate: () => Promise<void>,
    successMessage: string,
    errorMessage: string
  ) => {
    setBusyId(id);
    try {
      await mutate();
      toast.success(successMessage);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : errorMessage);
    } finally {
      setBusyId(null);
    }
  };

  const handleSubmit = async () => {
    if (!effectiveTrigger || !effectiveAction) {
      return;
    }
    if (!validation.ok) {
      setShowValidation(true);
      return;
    }
    // Only send non-empty params; blanks fall back to trigger-payload defaults server-side.
    const actionParams: Record<string, string> = {};
    for (const field of paramFields) {
      const value = (params[field.key] ?? "").trim();
      if (value) {
        actionParams[field.key] = value;
      }
    }
    const condition = guardsToCondition(guards);
    if (editingRule) {
      await runMutation(
        "create",
        async () => {
          await updateWorkflow(tokenId, editingRule.id, {
            actionParams,
            condition: condition ?? null,
            reviewMode,
          });
          resetBuilder();
          await rulesSwr.mutate();
        },
        wf("toastRuleUpdated"),
        wf("errorUpdate")
      );
      return;
    }
    await runMutation(
      "create",
      async () => {
        await createWorkflow(tokenId, {
          triggerType: effectiveTrigger,
          actionType: effectiveAction,
          reviewMode,
          actionParams: Object.keys(actionParams).length > 0 ? actionParams : undefined,
          condition,
        });
        resetBuilder();
        await rulesSwr.mutate();
      },
      wf("toastRuleCreated"),
      wf("errorCreate")
    );
  };

  const handleToggle = (rule: WorkflowRuleView) =>
    runMutation(
      rule.id,
      async () => {
        await setWorkflowEnabled(tokenId, rule.id, !rule.enabled);
        await rulesSwr.mutate();
      },
      rule.enabled ? wf("toastRuleDisabled") : wf("toastRuleEnabled"),
      wf("errorUpdate")
    );

  const handleDelete = (rule: WorkflowRuleView) =>
    setConfirm({
      title: wf("deleteConfirmTitle"),
      description: wf("deleteConfirmDescription"),
      confirmLabel: wf("confirmDelete"),
      onConfirm: () => {
        void runMutation(
          rule.id,
          async () => {
            await deleteWorkflow(tokenId, rule.id);
            setConfirm(null);
            if (editingRule?.id === rule.id) {
              resetBuilder();
            }
            await rulesSwr.mutate();
          },
          wf("toastRuleDeleted"),
          wf("errorUpdate")
        );
      },
    });

  // Approving a held execution and retrying a failed one hit different endpoints: the
  // first authorizes an action that has never run, and is audited as an authorization.
  const handleRetry = (execution: ExecutionView) => {
    const approving = execution.status === "awaiting_review";
    return runMutation(
      execution.id,
      async () => {
        await (approving ? approveExecution : retryExecution)(tokenId, execution.id);
        await executionsSwr.mutate();
      },
      approving ? wf("toastApproved") : wf("toastRetried"),
      wf("errorRetry")
    );
  };

  const handleReject = (execution: ExecutionView) =>
    setConfirm({
      title: wf("rejectConfirmTitle"),
      description: wf("rejectConfirmDescription"),
      confirmLabel: wf("confirmReject"),
      onConfirm: () => {
        void runMutation(
          execution.id,
          async () => {
            await rejectExecution(tokenId, execution.id);
            setConfirm(null);
            await executionsSwr.mutate();
          },
          wf("toastRejected"),
          wf("errorReject")
        );
      },
    });

  const handleEnroll = () =>
    runMutation(
      "enroll",
      async () => {
        await enrollHolder(tokenId, { walletAddress: walletAddress.trim() });
        setWalletAddress("");
        await Promise.all([holdersSwr.mutate(), executionsSwr.mutate()]);
      },
      wf("toastEnrolled"),
      wf("errorEnroll")
    );

  if (initialLoading) {
    return (
      <div className="space-y-4">
        <CardSkeleton lines={4} />
        <CardSkeleton lines={3} />
        <CardSkeleton lines={3} />
      </div>
    );
  }

  // A real load failure gets an explicit error state with a retry — not an empty tab
  // with hollow dropdowns.
  if (loadFailed) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
          <p className="text-sm text-secondary">{wf("errorLoad")}</p>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => {
              void catalogSwr.mutate();
              void rulesSwr.mutate();
              void executionsSwr.mutate();
              void holdersSwr.mutate();
            }}
          >
            {wf("reload")}
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Builder */}
      {canManage ? (
        <Card>
          <CardHeader>
            <CardTitle>{editingRule ? wf("editTitle") : wf("builderTitle")}</CardTitle>
            <CardDescription>
              {editingRule
                ? wf("editDescription", {
                    rule: `${label("trigger", editingRule.trigger_type)} → ${label("action", editingRule.action_type)}`,
                  })
                : wf("builderDescription")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {/* lg cramps the controls next to the workspace sidebar (same call the
                compliance tab made) — split only on genuinely wide viewports. */}
            <div className="grid gap-6 min-[1440px]:grid-cols-2">
              <BuilderControls
                t={t}
                wf={wf}
                label={label}
                describe={describe}
                catalog={catalog}
                editing={Boolean(editingRule)}
                triggerType={effectiveTrigger ?? null}
                actionType={effectiveAction ?? null}
                reviewMode={reviewMode}
                params={params}
                paramFields={paramFields}
                selectedAction={selectedAction}
                conditionFields={conditionFields}
                guards={guards}
                emailEnabled={emailEnabled}
                validation={validation}
                showValidation={showValidation}
                busy={busyId === "create"}
                canSubmit={canSubmit}
                canUseAction={canUseAction}
                onTriggerChange={onTriggerChange}
                onActionChange={onActionChange}
                onReviewModeChange={setReviewMode}
                onParamChange={(key, value) => setParams((prev) => ({ ...prev, [key]: value }))}
                onGuardAdd={addGuard}
                onGuardUpdate={updateGuard}
                onGuardRemove={removeGuard}
                onSubmit={() => void handleSubmit()}
                onCancelEdit={resetBuilder}
              />

              {/* Execution preview — exactly what will happen when this rule runs. */}
              <WorkflowFlowPreview
                trigger={selectedTrigger}
                action={selectedAction}
                guards={guards}
                reviewMode={reviewMode}
                paramSummary={paramSummary}
                walletGap={validation.walletGap}
              />
            </div>
          </CardContent>
        </Card>
      ) : null}

      <RulesCard
        rules={rules}
        wf={wf}
        label={label}
        locale={locale}
        canManage={canManage}
        canUseAction={canUseAction}
        busyId={busyId}
        editingRuleId={editingRule?.id ?? null}
        onToggle={(rule) => void handleToggle(rule)}
        onEdit={startEditing}
        onDelete={handleDelete}
      />

      {canManage ? (
        <HoldersCard
          holders={holders}
          wf={wf}
          label={label}
          locale={locale}
          walletAddress={walletAddress}
          busyId={busyId}
          onWalletAddressChange={setWalletAddress}
          onEnroll={() => void handleEnroll()}
        />
      ) : null}

      <ExecutionLogCard
        executions={executions}
        executionsTotal={executionsTotal}
        executionsPageSize={executionsPageSize}
        isValidating={executionsSwr.isValidating}
        wf={wf}
        label={label}
        locale={locale}
        canManage={canManage}
        canUseAction={canUseAction}
        busyId={busyId}
        tierForAction={tierForAction}
        onRefresh={() => void executionsSwr.mutate()}
        onShowMore={() =>
          setExecutionsPageSize((prev) =>
            Math.min(prev + EXECUTIONS_PAGE_SIZE, EXECUTIONS_MAX_PAGE_SIZE)
          )
        }
        onApprove={(execution) => void handleRetry(execution)}
        onReject={handleReject}
      />

      <ConfirmDialog
        confirm={confirm}
        pending={busyId !== null}
        cancelLabel={t("DashboardIssuance.confirmation.notNow")}
        closeLabel={t("DashboardIssuance.modal.closeConfirmation")}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}

// ── Builder controls (left column) ──────────────────────────────────────────────────

function BuilderControls(props: {
  t: TFunc;
  wf: ReturnType<typeof makeWf>;
  label: ReturnType<typeof makeLabel>;
  describe: ReturnType<typeof makeDescription>;
  catalog: WorkflowCatalog | null;
  editing: boolean;
  triggerType: string | null;
  actionType: string | null;
  reviewMode: "auto" | "manual";
  params: Record<string, string>;
  paramFields: ParamField[];
  selectedAction: CatalogActionView | null;
  conditionFields: string[];
  guards: GuardDraft[];
  emailEnabled: boolean | null;
  validation: BuilderValidation;
  showValidation: boolean;
  busy: boolean;
  canSubmit: boolean;
  canUseAction: (type: string) => boolean;
  onTriggerChange: (value: string | null) => void;
  onActionChange: (value: string | null) => void;
  onReviewModeChange: (value: "auto" | "manual") => void;
  onParamChange: (key: string, value: string) => void;
  onGuardAdd: () => void;
  onGuardUpdate: (id: string, patch: Partial<GuardDraft>) => void;
  onGuardRemove: (id: string) => void;
  onSubmit: () => void;
  onCancelEdit: () => void;
}) {
  const {
    t,
    wf,
    label,
    describe,
    catalog,
    editing,
    triggerType,
    actionType,
    reviewMode,
    params,
    paramFields,
    selectedAction,
    conditionFields,
    guards,
    emailEnabled,
    validation,
    showValidation,
    busy,
    canSubmit,
    canUseAction,
  } = props;

  // `requires_approval` always holds for a human — the server forces it regardless of
  // what's stored — so offering "auto apply" here would contradict the preview beside it.
  const reviewLocked = selectedAction?.action.execution === "requires_approval";

  return (
    <div className="space-y-4">
      <div className="space-y-4">
        <div className="space-y-1.5 text-sm">
          <span className="font-medium text-secondary">{wf("when")}</span>
          <Select
            ariaLabel={wf("when")}
            value={triggerType}
            disabled={editing}
            onValueChange={props.onTriggerChange}
            placeholder={wf("triggerPlaceholder")}
          >
            {(catalog?.triggers ?? []).map((trigger) => (
              <SelectItem key={trigger.type} value={trigger.type}>
                {label("trigger", trigger.type)}
              </SelectItem>
            ))}
          </Select>
          {describe("trigger", triggerType) ? (
            <p className="text-secondary text-xs">{describe("trigger", triggerType)}</p>
          ) : null}
        </div>

        <div className="space-y-1.5 text-sm">
          <span className="font-medium text-secondary">{wf("then")}</span>
          <Select
            ariaLabel={wf("then")}
            value={actionType}
            disabled={editing}
            onValueChange={props.onActionChange}
            placeholder={wf("actionPlaceholder")}
          >
            {(catalog?.actions ?? []).map((a) => {
              const permitted = canUseAction(a.type);
              const suffix = !a.support.ok
                ? wf("unavailableSuffix")
                : permitted
                  ? ""
                  : wf("adminOnlySuffix");
              return (
                <SelectItem key={a.type} value={a.type} disabled={!a.support.ok || !permitted}>
                  {`${label("action", a.type)}${suffix}`}
                </SelectItem>
              );
            })}
          </Select>
          {describe("action", actionType) ? (
            <p className="text-secondary text-xs">{describe("action", actionType)}</p>
          ) : null}
        </div>

        <div className="space-y-1.5 text-sm">
          <span className="font-medium text-secondary">{wf("review")}</span>
          <Select
            ariaLabel={wf("review")}
            value={reviewLocked ? "manual" : reviewMode}
            disabled={reviewLocked}
            onValueChange={(v) => props.onReviewModeChange(v === "manual" ? "manual" : "auto")}
          >
            <SelectItem value="auto" disabled={reviewLocked}>
              {wf("autoApply")}
            </SelectItem>
            <SelectItem value="manual">{wf("manualReview")}</SelectItem>
          </Select>
          {reviewLocked ? <p className="text-secondary text-xs">{wf("reviewLockedNote")}</p> : null}
        </div>
      </div>

      {selectedAction ? (
        <div className="flex items-center gap-2 text-sm">
          <Badge variant={TIER_VARIANT[selectedAction.action.execution]}>
            {wf(`tierLabels.${selectedAction.action.execution}`)}
          </Badge>
          {!selectedAction.support.ok ? (
            <span className="text-secondary">
              {t("DashboardIssuance.workflows.notSupported", {
                reason: selectedAction.support.reason,
              })}
            </span>
          ) : null}
        </div>
      ) : null}

      {/* Per-action parameters (amount, destination, webhook URL, notify audience…). */}
      {paramFields.length > 0 ? (
        <div className="grid gap-3 rounded-xl border border-border-subtle bg-fill-subtle/40 p-3 sm:grid-cols-2">
          {paramFields.map((field) => (
            <ParamFieldControl
              key={field.key}
              field={field}
              wf={wf}
              value={params[field.key] ?? ""}
              error={showValidation ? validation.fieldErrors[field.key] : undefined}
              onChange={(value) => props.onParamChange(field.key, value)}
            />
          ))}
        </div>
      ) : null}

      {/* GUARD ("only if…") — optional filters over the trigger payload. */}
      {triggerType ? (
        <GuardEditor
          conditionFields={conditionFields}
          guards={guards}
          onAdd={props.onGuardAdd}
          onUpdate={props.onGuardUpdate}
          onRemove={props.onGuardRemove}
        />
      ) : null}

      {/* Generic, detail-free notice when the email channel isn't configured. Only an
          explicit `false` warns — an unreachable config endpoint stays silent. A
          specific-email rule can't fall back to in-app, so its warning is stronger. */}
      {actionType === "notify" && emailEnabled === false ? (
        <div className="rounded-lg border border-warning-border bg-warning-bg px-3 py-2 text-xs text-warning">
          {(params.email ?? "").trim() ? wf("emailUnavailableSpecific") : wf("emailUnavailable")}
        </div>
      ) : null}

      {showValidation && !validation.ok ? (
        <p role="alert" className="text-xs text-error">
          {validation.walletGap
            ? wf("validationWalletGap")
            : validation.guardsIncomplete
              ? wf("validationGuards")
              : wf("validationFields")}
        </p>
      ) : null}

      <div className="flex justify-end gap-2">
        {editing ? (
          <Button type="button" size="sm" variant="ghost" onClick={props.onCancelEdit}>
            {wf("cancelEdit")}
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          onClick={props.onSubmit}
          disabled={!canSubmit}
          iconLeft={busy ? <Loader2 className="size-3.5 animate-spin" /> : undefined}
        >
          {editing ? wf("saveChanges") : wf("create")}
        </Button>
      </div>
    </div>
  );
}

function ParamFieldControl({
  field,
  wf,
  value,
  error,
  onChange,
}: {
  field: ParamField;
  wf: ReturnType<typeof makeWf>;
  value: string;
  error?: string;
  onChange: (value: string) => void;
}) {
  const inputId = `wf-param-${field.key}`;
  if (field.options) {
    return (
      <div className="space-y-1.5 text-sm">
        <Label htmlFor={inputId} className="text-secondary">
          {wf(field.labelKey)}
        </Label>
        <Select
          ariaLabel={wf(field.labelKey)}
          value={value || (field.options[0]?.value ?? "")}
          onValueChange={(v) => onChange(v ?? "")}
        >
          {field.options.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {wf(opt.labelKey)}
            </SelectItem>
          ))}
        </Select>
      </div>
    );
  }
  return (
    <div className="space-y-1.5 text-sm">
      <Label htmlFor={inputId} className="text-secondary">
        {wf(field.labelKey)}
        {field.required ? <span className="text-error"> *</span> : null}
      </Label>
      <Input
        id={inputId}
        type={field.secret ? "password" : "text"}
        autoComplete={field.secret ? "off" : undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.helpKey ? wf(field.helpKey) : undefined}
      />
      {error ? (
        <span className="text-xs text-error">{error}</span>
      ) : field.helpKey ? (
        <span className="text-xs text-tertiary">{wf(field.helpKey)}</span>
      ) : null}
    </div>
  );
}

// ── Rules card ──────────────────────────────────────────────────────────────────────

function RulesCard({
  rules,
  wf,
  label,
  locale,
  canManage,
  canUseAction,
  busyId,
  editingRuleId,
  onToggle,
  onEdit,
  onDelete,
}: {
  rules: WorkflowRuleView[];
  wf: ReturnType<typeof makeWf>;
  label: ReturnType<typeof makeLabel>;
  locale: string;
  canManage: boolean;
  canUseAction: (type: string) => boolean;
  busyId: string | null;
  editingRuleId: string | null;
  onToggle: (rule: WorkflowRuleView) => void;
  onEdit: (rule: WorkflowRuleView) => void;
  onDelete: (rule: WorkflowRuleView) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{wf("rulesTitle")}</CardTitle>
        <CardDescription>{wf("rulesDescription")}</CardDescription>
      </CardHeader>
      <CardContent>
        {rules.length === 0 ? (
          <p className="text-sm text-secondary">{wf("rulesEmpty")}</p>
        ) : (
          <ul className="divide-y divide-border-default">
            {rules.map((rule) => (
              <RuleRow
                key={rule.id}
                rule={rule}
                wf={wf}
                label={label}
                locale={locale}
                // Editing or deleting a seize rule is as privileged as authoring one.
                canManage={canManage && canUseAction(rule.action_type)}
                busy={busyId !== null}
                rowBusy={busyId === rule.id}
                editing={editingRuleId === rule.id}
                onToggle={() => onToggle(rule)}
                onEdit={() => onEdit(rule)}
                onDelete={() => onDelete(rule)}
              />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// ── Holders card ────────────────────────────────────────────────────────────────────

function HoldersCard({
  holders,
  wf,
  label,
  locale,
  walletAddress,
  busyId,
  onWalletAddressChange,
  onEnroll,
}: {
  holders: HolderView[];
  wf: ReturnType<typeof makeWf>;
  label: ReturnType<typeof makeLabel>;
  locale: string;
  walletAddress: string;
  busyId: string | null;
  onWalletAddressChange: (value: string) => void;
  onEnroll: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{wf("holdersTitle")}</CardTitle>
        <CardDescription>{wf("holdersDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="min-w-0 flex-1">
            <Input
              aria-label={wf("walletPlaceholder")}
              value={walletAddress}
              onChange={(e) => onWalletAddressChange(e.target.value)}
              placeholder={wf("walletPlaceholder")}
            />
          </div>
          <Button
            type="button"
            size="sm"
            onClick={onEnroll}
            disabled={busyId !== null || !walletAddress.trim()}
            iconLeft={
              busyId === "enroll" ? <Loader2 className="size-3.5 animate-spin" /> : undefined
            }
          >
            {wf("enrollWallet")}
          </Button>
        </div>
        <HoldersList holders={holders} wf={wf} label={label} locale={locale} />
      </CardContent>
    </Card>
  );
}

// ── Execution log card ──────────────────────────────────────────────────────────────

function ExecutionLogCard({
  executions,
  executionsTotal,
  executionsPageSize,
  isValidating,
  wf,
  label,
  locale,
  canManage,
  canUseAction,
  busyId,
  tierForAction,
  onRefresh,
  onShowMore,
  onApprove,
  onReject,
}: {
  executions: ExecutionView[];
  executionsTotal: number;
  executionsPageSize: number;
  isValidating: boolean;
  wf: ReturnType<typeof makeWf>;
  label: ReturnType<typeof makeLabel>;
  locale: string;
  canManage: boolean;
  canUseAction: (type: string) => boolean;
  busyId: string | null;
  tierForAction: (type: string) => ExecutionTier;
  onRefresh: () => void;
  onShowMore: () => void;
  onApprove: (execution: ExecutionView) => void;
  onReject: (execution: ExecutionView) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{wf("logTitle")}</CardTitle>
        <CardDescription>{wf("logDescription")}</CardDescription>
        <CardAction>
          <Button
            type="button"
            size="icon-sm"
            variant="secondary"
            aria-label={wf("refresh")}
            title={wf("refresh")}
            onClick={onRefresh}
            disabled={busyId !== null}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isValidating ? "animate-spin" : ""}`} />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {executions.length === 0 ? (
          <p className="text-sm text-secondary">{wf("logEmpty")}</p>
        ) : (
          <>
            <ul className="divide-y divide-border-default">
              {executions.map((execution) => (
                <ExecutionRow
                  key={execution.id}
                  execution={execution}
                  wf={wf}
                  label={label}
                  locale={locale}
                  // Approving a held mint IS a mint: the decision needs the same
                  // permission the rule's tier required to author it.
                  canManage={canManage && canUseAction(execution.action_type)}
                  busy={busyId !== null}
                  rowBusy={busyId === execution.id}
                  tier={tierForAction(execution.action_type)}
                  onApprove={() => onApprove(execution)}
                  onReject={() => onReject(execution)}
                />
              ))}
            </ul>
            {executions.length < executionsTotal &&
            executionsPageSize < EXECUTIONS_MAX_PAGE_SIZE ? (
              <div className="mt-3 flex justify-center">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={isValidating}
                  onClick={onShowMore}
                >
                  {wf("logShowMore", { shown: executions.length, total: executionsTotal })}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ── Rules list row ──────────────────────────────────────────────────────────────────

function RuleRow({
  rule,
  wf,
  label,
  locale,
  canManage,
  busy,
  rowBusy,
  editing,
  onToggle,
  onEdit,
  onDelete,
}: {
  rule: WorkflowRuleView;
  wf: ReturnType<typeof makeWf>;
  label: ReturnType<typeof makeLabel>;
  locale: string;
  canManage: boolean;
  busy: boolean;
  rowBusy: boolean;
  editing: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <li className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-primary">
          {label("trigger", rule.trigger_type)} → {label("action", rule.action_type)}
        </p>
        <p className="text-xs text-secondary">
          {rule.review_mode === "manual" ? wf("manualReview") : wf("autoApply")}
          {" · "}
          {formatRelativeTime(rule.created_at, locale)}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {rowBusy ? <Loader2 className="size-3.5 animate-spin text-secondary" /> : null}
        <Badge variant={rule.enabled ? "success" : "default"}>
          {rule.enabled ? wf("enabled") : wf("disabled")}
        </Badge>
        {canManage ? (
          <>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={wf("editRule")}
              title={wf("editRule")}
              onClick={onEdit}
              disabled={busy || editing}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={wf("deleteRule")}
              title={wf("deleteRule")}
              onClick={onDelete}
              disabled={busy}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={onToggle} disabled={busy}>
              {rule.enabled ? wf("disable") : wf("enable")}
            </Button>
          </>
        ) : null}
      </div>
    </li>
  );
}

// ── Holders roster ──────────────────────────────────────────────────────────────────

function HoldersList({
  holders,
  wf,
  label,
  locale,
}: {
  holders: HolderView[];
  wf: ReturnType<typeof makeWf>;
  label: ReturnType<typeof makeLabel>;
  locale: string;
}) {
  if (holders.length === 0) {
    return <p className="text-sm text-secondary">{wf("holdersEmpty")}</p>;
  }
  return (
    <ul className="divide-y divide-border-default">
      {holders.map((holder) => (
        <li key={holder.id} className="flex items-center justify-between gap-4 py-2.5">
          <div className="min-w-0">
            <p className="truncate font-mono text-sm text-primary">{holder.wallet_address}</p>
            <p className="text-xs text-secondary">
              {formatRelativeTime(holder.created_at, locale)}
            </p>
          </div>
          <Badge variant={holder.kyc_status === "verified" ? "success" : "default"}>
            {label("status", holder.kyc_status)}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

// ── Execution log row ───────────────────────────────────────────────────────────────

// One line naming what an execution acts on: "1000 → <wallet>" for a mint, "<source> →
// <destination>" for a seize, the subject wallet otherwise. Empty when the payload
// carries nothing worth showing (a notify or webhook).
export function executionTarget(execution: ExecutionView): string {
  const payload = execution.trigger_payload ?? {};
  const amount = payload.amount == null ? null : String(payload.amount);
  const source = payload.source == null ? null : String(payload.source);
  const destination =
    payload.destination == null
      ? payload.wallet == null
        ? null
        : String(payload.wallet)
      : String(payload.destination);

  const route = [source, destination].filter(Boolean).join(" → ");
  return [amount, route].filter(Boolean).join(" · ");
}

function ExecutionRow({
  execution,
  wf,
  label,
  locale,
  canManage,
  busy,
  rowBusy,
  tier,
  onApprove,
  onReject,
}: {
  execution: ExecutionView;
  wf: ReturnType<typeof makeWf>;
  label: ReturnType<typeof makeLabel>;
  locale: string;
  canManage: boolean;
  busy: boolean;
  rowBusy: boolean;
  tier: ExecutionTier;
  onApprove: () => void;
  onReject: () => void;
}) {
  const destructive = tier === "requires_approval";
  const target = executionTarget(execution);
  return (
    <li className="flex items-center justify-between gap-4 py-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[execution.status]}`}
          aria-hidden
        />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-primary">
            {label("action", execution.action_type)}{" "}
            <span className="font-normal text-secondary">
              · {label("status", execution.status)}
            </span>
          </p>
          {/* What this execution will actually do. Shown before the approve control so a
              held mint or seize is never authorized sight-unseen. */}
          {target ? (
            <p className="truncate font-mono text-xs text-primary" title={target}>
              {target}
            </p>
          ) : null}
          <p className="truncate text-xs text-secondary" title={execution.error ?? undefined}>
            {label("trigger", execution.trigger_type)} ·{" "}
            {formatRelativeTime(execution.created_at, locale)} · {wf("attempt")}{" "}
            {execution.attempt_count}/{execution.max_attempts}
            {execution.error ? ` · ${failureLabel(execution.error, wf)}` : ""}
          </p>
        </div>
      </div>
      {rowBusy ? <Loader2 className="size-3.5 shrink-0 animate-spin text-secondary" /> : null}
      {canManage && execution.status === "awaiting_review" ? (
        <div className="flex shrink-0 items-center gap-2">
          {destructive ? (
            // Destructive/irreversible → require a deliberate 5s hold.
            <HoldToConfirmButton
              label={wf("holdApprove")}
              holdingLabel={wf("keepHolding")}
              disabled={busy}
              onConfirm={onApprove}
            />
          ) : (
            <Button type="button" size="sm" variant="secondary" onClick={onApprove} disabled={busy}>
              {wf("approve")}
            </Button>
          )}
          <Button type="button" size="sm" variant="ghost" onClick={onReject} disabled={busy}>
            {wf("reject")}
          </Button>
        </div>
      ) : canManage && execution.status === "failed" ? (
        // Retrying re-authorizes the run, so destructive actions keep the hold gate.
        destructive ? (
          <HoldToConfirmButton
            label={wf("holdRetry")}
            holdingLabel={wf("keepHolding")}
            disabled={busy}
            onConfirm={onApprove}
          />
        ) : (
          <Button type="button" size="sm" variant="secondary" onClick={onApprove} disabled={busy}>
            {wf("retry")}
          </Button>
        )
      ) : null}
    </li>
  );
}
