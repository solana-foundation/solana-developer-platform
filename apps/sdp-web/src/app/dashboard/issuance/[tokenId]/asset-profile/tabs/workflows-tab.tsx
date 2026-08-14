"use client";

import {
  ArrowRight,
  BadgeCheck,
  Check,
  Circle,
  CircleCheck,
  CircleSlash,
  Clock,
  Filter,
  GitBranch,
  Inbox,
  Loader2,
  type LucideIcon,
  Pencil,
  Play,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  Trash2,
  TriangleAlert,
  UserCheck,
  Wallet,
  X,
  Zap,
} from "lucide-react";
import { Fragment, type ReactNode, useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { formatRelativeTime } from "@/app/dashboard/activity-format-utils";
import { isValidSolanaAddress } from "@/app/dashboard/custody/[walletId]/policy/wallet-policy-authoring";
import { fetchWebhookEndpoints } from "@/app/dashboard/issuance/webhooks/webhook-endpoints.client";
import type { WebhookEndpointsPage } from "@/app/dashboard/issuance/webhooks/webhook-endpoints.data";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { MessageKey } from "@/i18n/messages";
import { useLocale, useTranslations } from "@/i18n/provider";
import { usePersistedDashboardSWR } from "@/lib/dashboard-swr";
import { cn } from "@/lib/utils";
import {
  approveExecution,
  type CatalogActionView,
  type CatalogTriggerView,
  createWorkflow,
  deleteWorkflow,
  type ExecutionStatus,
  type ExecutionTier,
  type ExecutionView,
  enrollHolder,
  fetchExecutions,
  fetchHolders,
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
import { SendWebhookParams } from "./send-webhook-params";
import {
  ACTION_ICONS,
  CardSelect,
  type CardSelectOption,
  ConnectorBadge,
  ToneMarker,
  TRIGGER_ICONS,
  WORKFLOW_PILL_CLASS,
} from "./workflow-builder-cards";
import { OP_LABEL_KEY, WorkflowFlowGraph } from "./workflow-flow-preview";

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
  // Registry endpoint XOR inline url (+secret) — enforced in validateBuilder and by
  // the SendWebhookParams mode toggle, so neither field is `required` here.
  send_webhook: [
    { key: "endpointId", labelKey: "paramWebhookEndpoint" },
    { key: "url", labelKey: "paramWebhookUrl" },
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

// Execution status → glyph + tone. Colour stays within the semantic four: green (done),
// red (failed), amber (needs a human), gray (in flight / neutral).
const STATUS_GLYPH: Record<ExecutionStatus, LucideIcon> = {
  succeeded: CircleCheck,
  failed: TriangleAlert,
  awaiting_review: Clock,
  processing: Loader2,
  pending: Circle,
  cancelled: CircleSlash,
};
const STATUS_BADGE_VARIANT: Record<ExecutionStatus, BadgeVariant> = {
  succeeded: "success",
  failed: "danger",
  awaiting_review: "warning",
  processing: "info",
  pending: "default",
  cancelled: "default",
};

// Holder KYC status → pill variant + glyph.
const KYC_STATUS_META: Record<string, { variant: BadgeVariant; icon: LucideIcon }> = {
  verified: { variant: "success", icon: BadgeCheck },
  pending: { variant: "warning", icon: Clock },
  rejected: { variant: "danger", icon: X },
  unverified: { variant: "default", icon: Circle },
};
const KYC_STATUS_FALLBACK: { variant: BadgeVariant; icon: LucideIcon } = {
  variant: "default",
  icon: Circle,
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
// Params the engine hands to the chain as addresses — validated like the server does.
const WALLET_PARAM_KEYS = new Set(["wallet", "destination", "source"]);
// Input caps mirroring the save-time schemas (2,000 is the server's blanket per-param
// cap; the rest are that field's own tighter bound).
const PARAM_MAX_LENGTH: Record<string, number> = {
  secret: 200,
  email: 254,
  label: 120,
};

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

// Guard values are scalars, except the `in` operator's list — rendered as a tidy
// comma-separated run, same as the builder preview.
function formatGuardValue(value: string | number | Array<string | number>): string {
  return Array.isArray(value) ? value.map(String).join(", ") : String(value);
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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Format rules for a filled-in param, mirroring the save-time schemas: a bad address /
// short secret / malformed email is a guaranteed 400, so it surfaces on the field
// instead of as a failed save. The loose url regex is deliberate — legacy http rules
// must stay editable in custom mode.
function paramFormatError(
  key: string,
  value: string,
  wf: ReturnType<typeof makeWf>
): string | null {
  if (key === "amount" && (!AMOUNT_RE.test(value) || Number(value) <= 0)) {
    return wf("validationAmount");
  }
  if (key === "url" && !/^https?:\/\/\S+$/i.test(value)) {
    return wf("validationUrl");
  }
  if (WALLET_PARAM_KEYS.has(key) && !isValidSolanaAddress(value)) {
    return wf("validationAddress");
  }
  if (key === "secret" && (value.length < 8 || value.length > 200)) {
    return wf("validationSecret");
  }
  if (key === "email" && !EMAIL_RE.test(value)) {
    return wf("validationEmail");
  }
  return null;
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
    const formatError = paramFormatError(field.key, value, wf);
    if (formatError) {
      fieldErrors[field.key] = formatError;
    }
  }

  // send_webhook targets exactly one of: a registry endpoint or an inline URL. (The
  // loose url regex above stays so legacy http rules remain editable in custom mode.)
  if (action?.type === "send_webhook") {
    const endpointId = (params.endpointId ?? "").trim();
    const url = (params.url ?? "").trim();
    if ((!endpointId && !url) || (endpointId && url)) {
      fieldErrors.endpointId = wf("validationEndpoint");
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
    initialLoading:
      (catalogSwr.isLoading && !catalog) || (rulesSwr.isLoading && rules.length === 0),
    loadFailed: Boolean((catalogSwr.error && !catalog) || (rulesSwr.error && !rulesSwr.data)),
  };
}

export function WorkflowsTab({
  tokenId,
  canManage,
  canManagePrivileged,
  verifiedHolders,
}: {
  tokenId: string;
  // tokens:write — enough for `automated` rules.
  canManage: boolean;
  // tokens:admin — required for `sensitive` and `requires_approval` rules, mirroring the
  // API's tier gate. Enforced there; here it just keeps the builder honest.
  canManagePrivileged: boolean;
  // The asset gates on verified holders (KYC access mode). Enrollment is only meaningful
  // when it does, so the holders roster is shown only then — see the render site below.
  verifiedHolders: boolean;
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
    initialLoading,
    loadFailed,
  } = useWorkflowsData(tokenId, executionsPageSize);

  // First page only (the picker is a dropdown, not a browser); `total` rides along so
  // the params block can say when the registry holds more than one page.
  const webhookEndpointsSwr = usePersistedDashboardSWR<WebhookEndpointsPage>(
    ["webhook-endpoints"],
    () => fetchWebhookEndpoints(1, 100),
    { revalidateOnFocus: false },
    { key: "webhook-endpoints", ttlMs: 15_000 }
  );
  const webhookEndpoints = webhookEndpointsSwr.data;

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
  const summaryParts = paramFields
    .map((field): { key: string; node: ReactNode } | null => {
      const value = (params[field.key] ?? "").trim();
      if (!value) {
        return null;
      }
      if (field.secret) {
        return { key: field.key, node: `${wf(field.labelKey)}: ••••` };
      }
      // A raw endpoint id says nothing in a preview — show the endpoint's label, as a
      // pill so the referenced registry entity reads as an object, not free text.
      if (field.key === "endpointId") {
        const endpoint = webhookEndpoints?.endpoints.find((e) => e.id === value);
        return {
          key: field.key,
          node: (
            <span className="inline-flex items-center gap-1.5">
              {wf(field.labelKey)}
              <Badge className={WORKFLOW_PILL_CLASS} variant="default">
                {endpoint?.label ?? value}
              </Badge>
            </span>
          ),
        };
      }
      const option = field.options?.find((opt) => opt.value === value);
      return {
        key: field.key,
        node: `${wf(field.labelKey)}: ${option ? wf(option.labelKey) : value}`,
      };
    })
    .filter((entry): entry is { key: string; node: ReactNode } => entry !== null);
  // Empty string (not an empty element) so the preview's `paramSummary || undefined`
  // still reads "no params collected" as falsy.
  const paramSummary: ReactNode =
    summaryParts.length === 0
      ? ""
      : summaryParts.map((part, index) => (
          <Fragment key={part.key}>
            {index > 0 ? " · " : null}
            {part.node}
          </Fragment>
        ));

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
    // What the review selector SHOWS for a `requires_approval` action, which is locked to
    // manual. The selector only overrides its displayed value, so the state behind it is
    // still whatever was picked before the action was chosen — "auto" by default. Sending
    // that raw is rejected by the API (the tier always requires manual review), which
    // would make the destructive rules the lock exists for impossible to save.
    const submittedReviewMode =
      tierForAction(effectiveAction) === "requires_approval" ? "manual" : reviewMode;
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
            reviewMode: submittedReviewMode,
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
          reviewMode: submittedReviewMode,
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
            <WorkflowBuilder
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
              selectedTrigger={selectedTrigger}
              selectedAction={selectedAction}
              conditionFields={conditionFields}
              guards={guards}
              webhookEndpoints={webhookEndpoints}
              editingRuleId={editingRule?.id ?? null}
              validation={validation}
              showValidation={showValidation}
              paramSummary={paramSummary}
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
        tierForAction={tierForAction}
        busyId={busyId}
        editingRuleId={editingRule?.id ?? null}
        onToggle={(rule) => void handleToggle(rule)}
        onEdit={startEditing}
        onDelete={handleDelete}
      />

      {canManage && verifiedHolders ? (
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

// ── Builder: shared field blocks ────────────────────────────────────────────────────

// Pre-rendered pieces handed to the layout, so the wiring lives in one place.
interface LayoutArgs {
  wf: ReturnType<typeof makeWf>;
  triggerType: string | null;
  triggerSelect: ReactNode;
  actionSelect: ReactNode;
  triggerIcon: LucideIcon;
  actionIcon: LucideIcon;
  flowPanel: ReactNode;
  guardEditor: ReactNode;
  tierNotice: ReactNode;
  reviewField: ReactNode;
  paramsBlock: ReactNode;
  validationMessage: ReactNode;
  submitRow: ReactNode;
}

// `heading`, not `title`: a `title` JSX prop is read as user-facing copy by the i18n
// audit, which would then flag the i18n keys passed through it.
// Surfaces only the unsupported reason (the cards already carry the tier badge).
function TierNotice({ t, selectedAction }: { t: TFunc; selectedAction: CatalogActionView | null }) {
  const support = selectedAction?.support;
  if (!support || support.ok) {
    return null;
  }
  return (
    <p className="rounded-lg border border-error-border bg-error-bg px-3 py-2 text-xs text-error">
      {t("DashboardIssuance.workflows.notSupported", { reason: support.reason })}
    </p>
  );
}

function ReviewField({
  // Bound as `t` so the ui-copy audit recognizes the key literals as translated.
  wf: t,
  reviewMode,
  reviewLocked,
  onChange,
}: {
  wf: ReturnType<typeof makeWf>;
  reviewMode: "auto" | "manual";
  reviewLocked: boolean;
  onChange: (value: "auto" | "manual") => void;
}) {
  const value = reviewLocked ? "manual" : reviewMode;
  // Two choices: big always-visible card-buttons side by side (the WHEN/THEN card
  // grammar), stretched to the bottom of the settings panel — a dropdown hides one of
  // two options for no win.
  const options = [
    {
      value: "auto" as const,
      icon: Zap,
      label: t("autoApply"),
      description: t("autoApplyDescription"),
      disabled: reviewLocked,
    },
    {
      value: "manual" as const,
      icon: UserCheck,
      label: t("manualReview"),
      description: t("manualReviewDescription"),
      disabled: false,
    },
  ];
  return (
    // Content height, not flex-1: when both this and the parameters block grew, the slack
    // split between them and the leftover under these cards read as an oversized margin
    // above the block below. The parameters block absorbs it all instead.
    <div className="flex flex-col gap-1.5 text-sm">
      <span className="text-xs font-medium text-secondary">{t("review")}</span>
      {/* items-stretch is the default, but stated: both cards must be the row's height so
          their bottom edges line up whatever their descriptions wrap to. */}
      <div className="grid flex-1 content-start items-stretch gap-3 sm:grid-cols-2">
        {options.map((option) => {
          const Icon = option.icon;
          const selected = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={selected}
              disabled={option.disabled}
              onClick={() => onChange(option.value)}
              className={cn(
                // Grows with the column (the preview panel next door sets the height) but
                // never *forces* it: the icon sits beside the label rather than above it,
                // so the card's natural height stays under a short preview's and the
                // settings panel can't end up taller than the preview it explains.
                // Content is top-aligned, not centred: the two descriptions wrap to
                // different line counts, and centring each card's content independently
                // put their icon rows and labels at different heights.
                "relative flex h-full max-h-40 cursor-pointer flex-col items-start justify-start gap-2 rounded-xl border p-4 pr-11 text-left transition-colors",
                // Inset focus ring. The browser default is drawn outside the border box, so
                // on a pair of cards it made whichever one was last clicked look taller and
                // misaligned rather than focused.
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--input-focus-ring)]",
                selected
                  ? "border-primary bg-fill-subtle/50"
                  : "border-border-default bg-fill-subtle/20 hover:bg-fill-subtle",
                "disabled:pointer-events-none disabled:opacity-40"
              )}
            >
              <span
                className={cn(
                  "absolute top-3 right-3 flex size-5 items-center justify-center rounded-full border transition-colors",
                  selected
                    ? "border-primary bg-primary text-on-primary"
                    : "border-border-default text-transparent"
                )}
                aria-hidden
              >
                <Check className="size-3" strokeWidth={3} />
              </span>
              <span className="flex min-w-0 items-center gap-2.5">
                <span
                  className={cn(
                    "flex size-10 shrink-0 items-center justify-center rounded-xl bg-fill-subtle",
                    selected ? "text-primary" : "text-tertiary"
                  )}
                >
                  <Icon className="size-[22px]" />
                </span>
                <span className="truncate text-[15px] font-medium text-primary">
                  {option.label}
                </span>
              </span>
              <span className="block text-sm leading-5 text-tertiary">{option.description}</span>
            </button>
          );
        })}
      </div>
      {reviewLocked ? <p className="text-secondary text-xs">{t("reviewLockedNote")}</p> : null}
    </div>
  );
}

function ParamsBlock({
  paramFields,
  params,
  wf,
  showValidation,
  validation,
  onParamChange,
}: {
  paramFields: ParamField[];
  params: Record<string, string>;
  wf: ReturnType<typeof makeWf>;
  showValidation: boolean;
  validation: BuilderValidation;
  onParamChange: (key: string, value: string) => void;
}) {
  if (paramFields.length === 0) {
    return null;
  }
  return (
    <div
      className={cn(
        "grid gap-3 rounded-xl border border-border-subtle bg-fill-subtle/40 p-3",
        // A lone field (e.g. allowlist's wallet) takes the full row; pairs split.
        paramFields.length > 1 && "sm:grid-cols-2"
      )}
    >
      {paramFields.map((field) => (
        <ParamFieldControl
          key={field.key}
          field={field}
          wf={wf}
          value={params[field.key] ?? ""}
          error={showValidation ? validation.fieldErrors[field.key] : undefined}
          onChange={(value) => onParamChange(field.key, value)}
        />
      ))}
    </div>
  );
}

function ValidationMessage({
  showValidation,
  validation,
  wf,
}: {
  showValidation: boolean;
  validation: BuilderValidation;
  wf: ReturnType<typeof makeWf>;
}) {
  if (!showValidation || validation.ok) {
    return null;
  }
  return (
    <p role="alert" className="text-xs text-error">
      {validation.walletGap
        ? wf("validationWalletGap")
        : validation.guardsIncomplete
          ? wf("validationGuards")
          : wf("validationFields")}
    </p>
  );
}

function SubmitRow({
  editing,
  busy,
  canSubmit,
  wf,
  onSubmit,
  onCancelEdit,
}: {
  editing: boolean;
  busy: boolean;
  canSubmit: boolean;
  wf: ReturnType<typeof makeWf>;
  onSubmit: () => void;
  onCancelEdit: () => void;
}) {
  return (
    <div className="flex justify-end gap-2">
      {editing ? (
        <Button type="button" size="sm" variant="ghost" onClick={onCancelEdit}>
          {wf("cancelEdit")}
        </Button>
      ) : null}
      <Button
        type="button"
        size="sm"
        onClick={onSubmit}
        disabled={!canSubmit}
        iconLeft={
          busy ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : editing ? (
            <Check className="size-3.5" />
          ) : (
            <Plus className="size-3.5" />
          )
        }
      >
        {editing ? wf("saveChanges") : wf("create")}
      </Button>
    </div>
  );
}

// ── Builder: dropdown selectors (used by the sketch-style layouts) ──────────────────

const TIER_BADGE_VARIANT: Record<ExecutionTier, "success" | "warning" | "danger"> = {
  automated: "success",
  sensitive: "warning",
  requires_approval: "danger",
};

// "  — unavailable" → "unavailable": the catalog suffix carries a separator for inline
// use; as a card note it stands alone.
function stripSuffix(value: string): string {
  return value.replace(/^[\s—·-]+/, "").trim();
}

// The WHEN/THEN pickers. Compact select triggers whose options are the rich cards
// (icon + description + tier badge) — the card grids' content, in a dropdown. i18n keys
// match the ones already tracked in the copy baseline.
function TriggerSelect({
  catalog,
  value,
  editing,
  onChange,
  wf,
  label,
  describe,
}: {
  catalog: WorkflowCatalog | null;
  value: string | null;
  editing: boolean;
  onChange: (value: string | null) => void;
  wf: ReturnType<typeof makeWf>;
  label: ReturnType<typeof makeLabel>;
  describe: ReturnType<typeof makeDescription>;
}) {
  const options: CardSelectOption[] = (catalog?.triggers ?? []).map((trigger) => ({
    value: trigger.type,
    icon: TRIGGER_ICONS[trigger.type] ?? Zap,
    label: label("trigger", trigger.type),
    description: describe("trigger", trigger.type),
  }));
  return (
    <CardSelect
      ariaLabel={wf("when")}
      value={value}
      disabled={editing}
      onValueChange={onChange}
      placeholder={wf("triggerPlaceholder")}
      options={options}
    />
  );
}

function ActionSelect({
  catalog,
  value,
  editing,
  canUseAction,
  onChange,
  wf,
  label,
  describe,
}: {
  catalog: WorkflowCatalog | null;
  value: string | null;
  editing: boolean;
  canUseAction: (type: string) => boolean;
  onChange: (value: string | null) => void;
  wf: ReturnType<typeof makeWf>;
  label: ReturnType<typeof makeLabel>;
  describe: ReturnType<typeof makeDescription>;
}) {
  const options: CardSelectOption[] = (catalog?.actions ?? []).map((a) => {
    const permitted = canUseAction(a.type);
    const unsupported = !a.support.ok;
    const tier = a.action.execution;
    const tierLabel = wf(`tierLabels.${tier}`);
    return {
      value: a.type,
      icon: ACTION_ICONS[a.type] ?? Play,
      label: label("action", a.type),
      description: describe("action", a.type),
      badgeText: tierLabel,
      badgeTone: TIER_BADGE_VARIANT[tier],
      note: unsupported
        ? stripSuffix(wf("unavailableSuffix"))
        : permitted
          ? undefined
          : stripSuffix(wf("adminOnlySuffix")),
      disabled: editing || unsupported || !permitted,
      group: tierLabel,
    };
  });
  return (
    <CardSelect
      ariaLabel={wf("then")}
      value={value}
      disabled={editing}
      onValueChange={onChange}
      placeholder={wf("actionPlaceholder")}
      options={options}
    />
  );
}

// ── Builder: small presentational helpers ───────────────────────────────────────────

// A single node/panel box: kicker (WHEN/THEN/GUARD), icon, optional step number, control.
function BuilderNode({
  icon: Icon,
  kicker,
  index,
  active,
  children,
}: {
  icon: LucideIcon;
  kicker: string;
  index?: number;
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        // min-w-0 so the flex row splits into equal columns regardless of the selected
        // option's length — the trigger truncates instead of widening its column.
        "min-w-0 flex-1 space-y-3 rounded-xl border bg-surface-raised p-3 transition-colors",
        active ? "border-primary" : "border-border-default"
      )}
    >
      <div className="flex items-center gap-2">
        {index ? (
          <span className="flex size-5 items-center justify-center rounded-full border border-border-default text-[11px] font-semibold text-secondary">
            {index}
          </span>
        ) : null}
        <span className="flex size-9 items-center justify-center rounded-lg bg-fill-subtle text-secondary">
          <Icon className="size-[18px]" aria-hidden />
        </span>
        <span className="text-[11px] font-semibold uppercase tracking-wide text-tertiary">
          {kicker}
        </span>
      </div>
      {children}
    </div>
  );
}

// Labeled field wrapper (stepper layout). `term` (not `label`) is a resolved string —
// a `label=` JSX attribute would be read as copy by the i18n audit.
// Decorative left-to-right connector, hidden when the row wraps to a column.
function RowArrow() {
  return (
    <div className="hidden items-center self-center xl:flex" aria-hidden>
      <ConnectorBadge icon={ArrowRight} />
    </div>
  );
}

// ── Builder: layout ─────────────────────────────────────────────────────────────────
//
// WHEN → THEN → GUARD across the top, then rule settings + the live execution preview.
// The GUARD slot is the user's "only if…" filter (never "capability enabled" — capability
// is automatic and shows only in the preview). A rule is always exactly one trigger → one
// action → optional filter.

function GuardSlot(args: LayoutArgs) {
  return (
    args.guardEditor ?? <p className="text-xs text-tertiary">{args.wf("triggerPlaceholder")}</p>
  );
}

// TL — "Wizard row": WHEN → THEN → GUARD as a horizontal card row, settings + live
// execution preview below (real engine steps, not invented narration).
function WizardRowLayout(args: LayoutArgs) {
  // Bound as `t` so the ui-copy audit recognizes the key literals as translated.
  const t = args.wf;
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 xl:flex-row xl:items-stretch">
        <BuilderNode icon={args.triggerIcon} kicker={t("when")}>
          {args.triggerSelect}
        </BuilderNode>
        <RowArrow />
        <BuilderNode icon={args.actionIcon} kicker={t("then")}>
          {args.actionSelect}
        </BuilderNode>
        <RowArrow />
        <BuilderNode icon={Filter} kicker={t("guard")}>
          <GuardSlot {...args} />
        </BuilderNode>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="flex flex-col rounded-xl border border-border-default bg-fill-subtle/30 p-4">
          {/* Same heading grammar as the Execution preview panel next door: h4 title,
              caption beneath, no accent bar. */}
          <h4 className="text-sm font-semibold text-primary">{t("settingsTitle")}</h4>
          <p className="mt-0.5 text-xs text-secondary">{t("settingsIntro")}</p>
          {/* gap-4 between the two sections: the parameters heading has to read as a new
              section, not as another line of the review block above it. */}
          <div className="mt-4 flex flex-1 flex-col gap-4">
            {args.reviewField}
            {args.paramsBlock}
          </div>
        </div>
        {/* The panel itself is the grid item — no wrapper div, which would be the thing
            that stretches while the bordered panel inside it stayed content-height. */}
        {args.flowPanel}
      </div>
      {args.tierNotice}
      {args.validationMessage}
      {args.submitRow}
    </div>
  );
}

// ── Builder (assembles the shared pieces and renders the layout) ────────────────────

function WorkflowBuilder(props: {
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
  selectedTrigger: CatalogTriggerView | null;
  selectedAction: CatalogActionView | null;
  conditionFields: string[];
  guards: GuardDraft[];
  webhookEndpoints: WebhookEndpointsPage | undefined;
  editingRuleId: string | null;
  validation: BuilderValidation;
  showValidation: boolean;
  paramSummary: ReactNode;
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
  const { wf, label } = props;
  // `requires_approval` always holds for a human — the server forces it regardless of
  // what's stored — so offering "auto apply" here would contradict the preview.
  const reviewLocked = props.selectedAction?.action.execution === "requires_approval";

  // Icons for the WHEN/THEN nodes; fall back to a neutral glyph.
  const triggerIcon = (props.triggerType && TRIGGER_ICONS[props.triggerType]) || Zap;
  const actionIcon = (props.actionType && ACTION_ICONS[props.actionType]) || Play;
  // The parameters block names its action rather than saying "Parameters" generically.
  const actionLabel = props.actionType ? label("action", props.actionType) : "";

  const args: LayoutArgs = {
    wf,
    triggerType: props.triggerType,
    triggerSelect: (
      <TriggerSelect
        catalog={props.catalog}
        value={props.triggerType}
        editing={props.editing}
        onChange={props.onTriggerChange}
        wf={wf}
        label={label}
        describe={props.describe}
      />
    ),
    actionSelect: (
      <ActionSelect
        catalog={props.catalog}
        value={props.actionType}
        editing={props.editing}
        canUseAction={props.canUseAction}
        onChange={props.onActionChange}
        wf={wf}
        label={label}
        describe={props.describe}
      />
    ),
    triggerIcon,
    actionIcon,
    flowPanel: (
      <WorkflowFlowGraph
        trigger={props.selectedTrigger}
        action={props.selectedAction}
        guards={props.guards}
        reviewMode={props.reviewMode}
        paramSummary={props.paramSummary}
        walletGap={props.validation.walletGap}
        orientation="vertical"
        showChrome={true}
      />
    ),
    guardEditor: props.triggerType ? (
      <GuardEditor
        conditionFields={props.conditionFields}
        guards={props.guards}
        onAdd={props.onGuardAdd}
        onUpdate={props.onGuardUpdate}
        onRemove={props.onGuardRemove}
      />
    ) : null,
    tierNotice: <TierNotice t={props.t} selectedAction={props.selectedAction} />,
    reviewField: (
      <ReviewField
        wf={wf}
        reviewMode={props.reviewMode}
        reviewLocked={reviewLocked}
        onChange={props.onReviewModeChange}
      />
    ),
    paramsBlock: (
      <BuilderParamsBlock
        actionType={props.actionType}
        actionIcon={actionIcon}
        actionLabel={actionLabel}
        editingRuleId={props.editingRuleId}
        paramFields={props.paramFields}
        params={props.params}
        webhookEndpoints={props.webhookEndpoints}
        wf={wf}
        showValidation={props.showValidation}
        validation={props.validation}
        onParamChange={props.onParamChange}
      />
    ),
    validationMessage: (
      <ValidationMessage
        showValidation={props.showValidation}
        validation={props.validation}
        wf={wf}
      />
    ),
    submitRow: (
      <SubmitRow
        editing={props.editing}
        busy={props.busy}
        canSubmit={props.canSubmit}
        wf={wf}
        onSubmit={props.onSubmit}
        onCancelEdit={props.onCancelEdit}
      />
    ),
  };

  return <WizardRowLayout {...args} />;
}

// Per-action copy for the parameters block. `makeWf` returns a humanized key rather than
// throwing on a miss, so which actions have bespoke copy is stated here instead of being
// discovered at render: an action the catalog grows before this file does falls back to a
// generic line rather than printing a mangled key.
const ACTIONS_WITH_PARAM_COPY = new Set([
  "mint",
  "burn",
  "force_burn",
  "seize",
  "send_webhook",
  "notify",
  "freeze",
  "unfreeze",
  "allowlist_add",
  "allowlist_remove",
]);
const ACTIONS_WITH_BANNER_COPY = new Set(["pause", "unpause", "record"]);

// pause / unpause / record take no parameters at all, which left the settings panel with a
// bare void under the review cards. Rather than announcing the absence, the banner says
// what the action actually does — the void is where that explanation was missing anyway.
function NoParamsBanner({
  // Bound as `t` so the ui-copy audit recognizes the key literals as translated.
  wf: t,
  icon: Icon,
  action,
  actionType,
}: {
  wf: ReturnType<typeof makeWf>;
  icon: LucideIcon;
  action: string;
  actionType: string;
}) {
  const bespoke = ACTIONS_WITH_BANNER_COPY.has(actionType);
  return (
    <div className="flex flex-1 items-center gap-3 rounded-xl border border-dashed border-border-default bg-fill-subtle/20 p-4">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-fill-subtle text-tertiary">
        <Icon className="size-[22px]" aria-hidden />
      </span>
      <div className="min-w-0">
        <p className="text-sm font-medium text-primary">
          {bespoke ? t(`noParamsTitles.${actionType}`) : t("noParamsTitle", { action })}
        </p>
        <p className="mt-0.5 text-xs leading-5 text-secondary">
          {bespoke ? t(`noParamsBodies.${actionType}`) : t("noParamsBody", { action })}
        </p>
      </div>
    </div>
  );
}

// The per-action parameter inputs. send_webhook gets its bespoke registry/custom
// picker; every other action renders its ACTION_PARAM_FIELDS as plain controls.
function BuilderParamsBlock({
  actionType,
  editingRuleId,
  paramFields,
  params,
  webhookEndpoints,
  wf: t,
  showValidation,
  validation,
  actionIcon,
  actionLabel,
  onParamChange,
}: {
  actionType: string | null;
  editingRuleId: string | null;
  paramFields: ParamField[];
  params: Record<string, string>;
  webhookEndpoints: WebhookEndpointsPage | undefined;
  wf: ReturnType<typeof makeWf>;
  showValidation: boolean;
  validation: BuilderValidation;
  actionIcon: LucideIcon;
  actionLabel: string;
  onParamChange: (key: string, value: string) => void;
}) {
  // No action picked yet: the panel's own intro already covers that state.
  if (!actionType) {
    return null;
  }
  if (paramFields.length === 0) {
    return <NoParamsBanner action={actionLabel} actionType={actionType} icon={actionIcon} wf={t} />;
  }
  const bespoke = ACTIONS_WITH_PARAM_COPY.has(actionType);
  const heading = bespoke
    ? t(`paramsTitles.${actionType}`)
    : t("paramsTitle", { action: actionLabel });
  const caption = bespoke
    ? t(`paramsIntros.${actionType}`)
    : t("paramsIntro", { action: actionLabel });
  return (
    // gap-1.5 between a heading and its controls, matching the Review label above it.
    <div className="flex flex-col gap-1.5">
      <div>
        {/* Set like the "Review" label above it — the line beneath carries the detail. */}
        <h5 className="text-xs font-medium text-secondary">{heading}</h5>
        <p className="mt-0.5 text-xs text-tertiary">{caption}</p>
      </div>
      {actionType === "send_webhook" ? (
        <SendWebhookParams
          key={editingRuleId ?? "new"}
          wf={t}
          params={params}
          endpoints={webhookEndpoints}
          errors={showValidation ? validation.fieldErrors : {}}
          onParamChange={onParamChange}
        />
      ) : (
        <ParamsBlock
          paramFields={paramFields}
          params={params}
          wf={t}
          showValidation={showValidation}
          validation={validation}
          onParamChange={onParamChange}
        />
      )}
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
        // The design-system TextInput is inline-flex (intrinsic width); stretch the root
        // AND the inner field span so the control fills its grid cell.
        className="w-full [&>span:first-child]:w-full"
        id={inputId}
        type={field.secret ? "password" : "text"}
        autoComplete={field.secret ? "off" : undefined}
        inputMode={field.key === "amount" ? "decimal" : undefined}
        maxLength={PARAM_MAX_LENGTH[field.key] ?? 2_000}
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

function guardClauseTexts(
  rule: WorkflowRuleView,
  wf: ReturnType<typeof makeWf>,
  label: ReturnType<typeof makeLabel>
): string[] {
  return (rule.definition?.condition?.all ?? []).map(
    (clause) =>
      `${label("conditionField", clause.field)} ${wf(
        OP_LABEL_KEY[clause.op]
      ).toLocaleLowerCase()} ${formatGuardValue(clause.value)}`
  );
}

// A saved rule's guard: one filled pill carrying the whole condition as a sentence,
// trailing the action. A guarded rule must never read as unconditional, so the clause is
// always shown rather than reduced to a mark.
function GuardDisplay({
  rule,
  // Bound as `t` so the ui-copy audit recognizes the key literal as translated.
  wf: t,
  label,
  className,
}: {
  rule: WorkflowRuleView;
  wf: ReturnType<typeof makeWf>;
  label: ReturnType<typeof makeLabel>;
  className?: string;
}) {
  const texts = guardClauseTexts(rule, t, label);
  if (texts.length === 0) {
    return null;
  }
  return (
    <Badge className={cn(className, WORKFLOW_PILL_CLASS)} variant="default">
      <span className="inline-flex items-center gap-1">
        <GitBranch aria-hidden className="size-3" />
        <span>{t("flowOnlyIf", { clauses: texts.join(", ") })}</span>
      </span>
    </Badge>
  );
}

// The little circled connector between a rule row's trigger and action.
function RuleArrow() {
  return (
    <span
      className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border-default text-tertiary"
      aria-hidden
    >
      <ArrowRight className="size-3" />
    </span>
  );
}

// One half of a rule row: icon tile + label, the tile optionally carrying the tier marker.
function RuleStepChip({
  icon: Icon,
  text,
  marker,
}: {
  icon: LucideIcon;
  text: string;
  marker?: ReactNode;
}) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="relative flex size-8 shrink-0 items-center justify-center rounded-lg bg-fill-subtle text-secondary">
        <Icon className="size-4" />
        {marker}
      </span>
      <span className="truncate text-sm font-medium text-primary">{text}</span>
    </span>
  );
}

// Review mode as a glyph with a tooltip — the row is deliberately terse, and the two
// modes are a binary that a lightning/approver icon carries without spending a word.
function ReviewIndicator({
  rule,
  wf: t,
}: {
  rule: WorkflowRuleView;
  wf: ReturnType<typeof makeWf>;
}) {
  const manual = rule.review_mode === "manual";
  const Icon = manual ? UserCheck : Zap;
  const text = manual ? t("manualReview") : t("autoApply");
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span aria-label={text} className="inline-flex text-secondary" role="img">
          <Icon aria-hidden className="size-4" />
        </span>
      </TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  );
}

// A saved rule as one line: trigger → action, with the guard clause trailing the action
// and the tier stated as a marker on the action's icon tile (the way the builder states
// it) rather than a pill, which was the row's widest element.
function RuleFlowLine({
  rule,
  // Bound as `t` so the ui-copy audit recognizes the key literal as translated.
  wf: t,
  label,
  tier,
}: {
  rule: WorkflowRuleView;
  wf: ReturnType<typeof makeWf>;
  label: ReturnType<typeof makeLabel>;
  tier: ExecutionTier;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
      <RuleStepChip
        icon={TRIGGER_ICONS[rule.trigger_type] ?? Zap}
        text={label("trigger", rule.trigger_type)}
      />
      <RuleArrow />
      <RuleStepChip
        icon={ACTION_ICONS[rule.action_type] ?? Play}
        marker={<ToneMarker label={t(`tierLabels.${tier}`)} tone={TIER_BADGE_VARIANT[tier]} />}
        text={label("action", rule.action_type)}
      />
      <GuardDisplay label={label} rule={rule} wf={t} />
    </div>
  );
}

function RulesCard({
  rules,
  wf,
  label,
  locale,
  canManage,
  canUseAction,
  tierForAction,
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
  tierForAction: (type: string) => ExecutionTier;
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
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <span className="flex size-10 items-center justify-center rounded-full bg-fill-subtle text-tertiary">
              <Zap className="size-5" aria-hidden />
            </span>
            <p className="text-sm text-secondary">{wf("rulesEmpty")}</p>
          </div>
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
                tier={tierForAction(rule.action_type)}
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
        <div className="space-y-2">
          <Input
            className="w-full [&>span:first-child]:w-full"
            aria-label={wf("walletPlaceholder")}
            value={walletAddress}
            onChange={(e) => onWalletAddressChange(e.target.value)}
            placeholder={wf("walletPlaceholder")}
          />
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              onClick={onEnroll}
              disabled={busyId !== null || !walletAddress.trim()}
              iconLeft={
                busyId === "enroll" ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Wallet className="size-3.5" />
                )
              }
            >
              {wf("enrollWallet")}
            </Button>
          </div>
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
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <span className="flex size-10 items-center justify-center rounded-full bg-fill-subtle text-tertiary">
              <Inbox className="size-5" aria-hidden />
            </span>
            <p className="text-sm text-secondary">{wf("logEmpty")}</p>
          </div>
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
  tier,
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
  tier: ExecutionTier;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <li className="flex items-center justify-between gap-4 py-3">
      <RuleFlowLine label={label} rule={rule} tier={tier} wf={wf} />
      <div className="flex shrink-0 items-center gap-2">
        <ReviewIndicator rule={rule} wf={wf} />
        <span className="whitespace-nowrap text-xs text-tertiary">
          {formatRelativeTime(rule.created_at, locale)}
        </span>
        {rowBusy ? <Loader2 className="size-3.5 animate-spin text-secondary" /> : null}
        <Badge className={WORKFLOW_PILL_CLASS} variant={rule.enabled ? "success" : "default"}>
          {rule.enabled ? wf("enabled") : wf("disabled")}
        </Badge>
        <RuleRowActions
          busy={busy}
          canManage={canManage}
          editing={editing}
          enabled={rule.enabled}
          onDelete={onDelete}
          onEdit={onEdit}
          onToggle={onToggle}
          wf={wf}
        />
      </div>
    </li>
  );
}

// Edit / delete / enable-disable for one rule row.
function RuleRowActions({
  wf,
  canManage,
  busy,
  editing,
  enabled,
  onToggle,
  onEdit,
  onDelete,
}: {
  wf: ReturnType<typeof makeWf>;
  canManage: boolean;
  busy: boolean;
  editing: boolean;
  enabled: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  if (!canManage) {
    return null;
  }
  return (
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
      <Button
        type="button"
        size="sm"
        variant="secondary"
        onClick={onToggle}
        disabled={busy}
        iconLeft={enabled ? <PowerOff className="size-3.5" /> : <Power className="size-3.5" />}
      >
        {enabled ? wf("disable") : wf("enable")}
      </Button>
    </>
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
    return (
      <div className="flex flex-col items-center gap-2 py-6 text-center">
        <span className="flex size-10 items-center justify-center rounded-full bg-fill-subtle text-tertiary">
          <Wallet className="size-5" aria-hidden />
        </span>
        <p className="text-sm text-secondary">{wf("holdersEmpty")}</p>
      </div>
    );
  }
  return (
    <ul className="divide-y divide-border-default">
      {holders.map((holder) => {
        const status = KYC_STATUS_META[holder.kyc_status] ?? KYC_STATUS_FALLBACK;
        const StatusIcon = status.icon;
        return (
          <li key={holder.id} className="flex items-center justify-between gap-4 py-3">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-fill-subtle text-secondary">
                <Wallet className="size-[18px]" aria-hidden />
              </span>
              <div className="min-w-0">
                <p className="truncate font-mono text-sm text-primary">{holder.wallet_address}</p>
                <p className="text-xs text-secondary">
                  {formatRelativeTime(holder.created_at, locale)}
                </p>
              </div>
            </div>
            <Badge className={WORKFLOW_PILL_CLASS} variant={status.variant}>
              <span className="inline-flex items-center gap-1 leading-none">
                <StatusIcon className="size-3 shrink-0" aria-hidden />
                {label("status", holder.kyc_status)}
              </span>
            </Badge>
          </li>
        );
      })}
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
  const ActionIcon = ACTION_ICONS[execution.action_type] ?? Play;
  const StatusGlyph = STATUS_GLYPH[execution.status];
  return (
    <li className="flex items-center justify-between gap-4 py-3.5">
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-fill-subtle text-secondary">
          <ActionIcon className="size-[18px]" aria-hidden />
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="text-sm font-medium text-primary">
              {label("action", execution.action_type)}
            </span>
            <Badge className={WORKFLOW_PILL_CLASS} variant={STATUS_BADGE_VARIANT[execution.status]}>
              <span className="inline-flex items-center gap-1 leading-none">
                <StatusGlyph
                  className={cn(
                    "size-3 shrink-0",
                    execution.status === "processing" && "animate-spin"
                  )}
                  aria-hidden
                />
                {label("status", execution.status)}
              </span>
            </Badge>
          </div>
          {/* What this execution will actually do. Shown before the approve control so a
              held mint or seize is never authorized sight-unseen. */}
          {target ? (
            <p className="mt-0.5 truncate font-mono text-xs text-primary" title={target}>
              {target}
            </p>
          ) : null}
          <p
            className="mt-0.5 truncate text-xs text-secondary"
            title={execution.error ?? undefined}
          >
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
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={onApprove}
              disabled={busy}
              iconLeft={<Check className="size-3.5" />}
            >
              {wf("approve")}
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={onReject}
            disabled={busy}
            iconLeft={<X className="size-3.5" />}
          >
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
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={onApprove}
            disabled={busy}
            iconLeft={<RefreshCw className="size-3.5" />}
          >
            {wf("retry")}
          </Button>
        )
      ) : null}
    </li>
  );
}
