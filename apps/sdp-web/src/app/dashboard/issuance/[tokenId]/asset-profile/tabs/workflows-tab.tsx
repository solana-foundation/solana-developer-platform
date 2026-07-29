"use client";

import { Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { HoldToConfirmButton } from "@/components/ui/hold-to-confirm-button";
import { Select, SelectItem } from "@/components/ui/select";
import { useTranslations } from "@/i18n/provider";
import {
  type CatalogActionView,
  createWorkflow,
  type ExecutionStatus,
  type ExecutionTier,
  type ExecutionView,
  enrollHolder,
  fetchExecutions,
  fetchNotificationConfig,
  fetchWorkflowCatalog,
  fetchWorkflows,
  type GuardClause,
  type GuardDraft,
  humanizeType,
  rejectExecution,
  retryExecution,
  setWorkflowEnabled,
  type WorkflowCatalog,
  type WorkflowRuleView,
} from "../workflows.data";
import { GuardEditor } from "./guard-editor";
import { WorkflowFlowPreview } from "./workflow-flow-preview";

// Per-action inputs the builder collects beyond the trigger payload. Wallet/source
// default to the trigger's subject wallet when left blank, so they're optional there.
// labelKey/helpKey/options[].labelKey are i18n key suffixes under workflows.*
interface ParamField {
  key: string;
  labelKey: string;
  required?: boolean;
  helpKey?: string;
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
    { key: "secret", labelKey: "paramSecret" },
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
    { key: "email", labelKey: "paramEmail" },
  ],
  freeze: [{ key: "wallet", labelKey: "paramWallet", helpKey: WALLET_HELP }],
  unfreeze: [{ key: "wallet", labelKey: "paramWallet", helpKey: WALLET_HELP }],
};

const TIER_VARIANT: Record<ExecutionTier, "success" | "warning" | "danger"> = {
  automated: "success",
  sensitive: "warning",
  requires_approval: "danger",
};

const STATUS_DOT: Record<ExecutionStatus, string> = {
  succeeded: "bg-success",
  failed: "bg-error",
  awaiting_review: "bg-warning",
  processing: "bg-info",
  pending: "bg-info",
  cancelled: "bg-fill",
};

function tierOf(action: CatalogActionView): ExecutionTier {
  return action.action.execution;
}

export function WorkflowsTab({ tokenId, canManage }: { tokenId: string; canManage: boolean }) {
  const t = useTranslations();
  // Localized label for a dynamic catalog key (trigger/action/status), falling back to
  // humanizeType for any key without a translation (e.g. a future catalog addition).
  const label = (
    kind: "trigger" | "action" | "status" | "conditionField",
    type: string
  ): string => {
    try {
      return t(`DashboardIssuance.workflows.${kind}Labels.${type}` as Parameters<typeof t>[0]);
    } catch {
      return humanizeType(type);
    }
  };
  const wf = useCallback(
    (k: string) => t(`DashboardIssuance.workflows.${k}` as Parameters<typeof t>[0]),
    [t]
  );
  const [catalog, setCatalog] = useState<WorkflowCatalog | null>(null);
  const [rules, setRules] = useState<WorkflowRuleView[]>([]);
  const [executions, setExecutions] = useState<ExecutionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [triggerType, setTriggerType] = useState<string | null>(null);
  const [actionType, setActionType] = useState<string | null>(null);
  const [reviewMode, setReviewMode] = useState<"auto" | "manual">("auto");
  const [params, setParams] = useState<Record<string, string>>({});
  const [guards, setGuards] = useState<GuardDraft[]>([]);
  const [emailEnabled, setEmailEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [walletAddress, setWalletAddress] = useState("");

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [cat, ruleRows, execRows, cfg] = await Promise.all([
        fetchWorkflowCatalog(tokenId),
        fetchWorkflows(tokenId),
        fetchExecutions(tokenId),
        fetchNotificationConfig(),
      ]);
      setCatalog(cat);
      setRules(ruleRows);
      setExecutions(execRows);
      setEmailEnabled(cfg.emailEnabled);
      setTriggerType((prev) => prev ?? cat.triggers[0]?.type ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : wf("errorLoad"));
    } finally {
      setLoading(false);
    }
  }, [tokenId, wf]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selectedTrigger = catalog?.triggers.find((tr) => tr.type === triggerType) ?? null;
  const conditionFields = selectedTrigger?.trigger.conditionFields ?? [];
  const selectedAction = catalog?.actions.find((a) => a.type === actionType) ?? null;
  const paramFields = actionType ? (ACTION_PARAM_FIELDS[actionType] ?? []) : [];
  const requiredParamsFilled = paramFields
    .filter((field) => field.required)
    .every((field) => (params[field.key] ?? "").trim().length > 0);
  const canCreate =
    canManage &&
    Boolean(triggerType && selectedAction?.support.ok) &&
    requiredParamsFilled &&
    !busy;

  // One-line "field: value · …" summary of the collected action params, for the preview.
  const paramSummary = paramFields
    .map((field) => {
      const value = (params[field.key] ?? "").trim();
      return value ? `${wf(field.labelKey)}: ${value}` : null;
    })
    .filter((entry): entry is string => entry !== null)
    .join(" · ");

  // Switching trigger changes which condition fields exist, so any authored guards no
  // longer apply — clear them.
  const onTriggerChange = (value: string | null) => {
    setTriggerType(value);
    setGuards([]);
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
  };

  // GUARD editor row operations.
  const addGuard = () => {
    const first = conditionFields[0];
    if (!first) {
      return;
    }
    setGuards((prev) => [...prev, { field: first, op: "eq", value: "" }]);
  };
  const updateGuard = (index: number, patch: Partial<GuardDraft>) => {
    setGuards((prev) => prev.map((guard, i) => (i === index ? { ...guard, ...patch } : guard)));
  };
  const removeGuard = (index: number) => {
    setGuards((prev) => prev.filter((_, i) => i !== index));
  };

  const handleCreate = async () => {
    if (!triggerType || !actionType) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Only send non-empty params; blanks fall back to trigger-payload defaults server-side.
      const actionParams: Record<string, string> = {};
      for (const field of paramFields) {
        const value = (params[field.key] ?? "").trim();
        if (value) {
          actionParams[field.key] = value;
        }
      }
      // Collect filled guard rows into a WorkflowCondition; `in` splits on commas. Drop
      // incomplete rows and omit the condition entirely when nothing was authored.
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
      await createWorkflow(tokenId, {
        triggerType,
        actionType,
        reviewMode,
        actionParams: Object.keys(actionParams).length > 0 ? actionParams : undefined,
        condition: clauses.length > 0 ? { all: clauses } : undefined,
      });
      setActionType(null);
      setParams({});
      setGuards([]);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : wf("errorCreate"));
    } finally {
      setBusy(false);
    }
  };

  const handleToggle = async (rule: WorkflowRuleView) => {
    setBusy(true);
    try {
      await setWorkflowEnabled(tokenId, rule.id, !rule.enabled);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : wf("errorUpdate"));
    } finally {
      setBusy(false);
    }
  };

  const handleRetry = async (execution: ExecutionView) => {
    setBusy(true);
    try {
      await retryExecution(tokenId, execution.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : wf("errorRetry"));
    } finally {
      setBusy(false);
    }
  };

  const handleReject = async (execution: ExecutionView) => {
    setBusy(true);
    try {
      await rejectExecution(tokenId, execution.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : wf("errorReject"));
    } finally {
      setBusy(false);
    }
  };

  // Tier of an execution's action (from the catalog), to decide whether approving it
  // needs the deliberate hold-to-confirm gate. Fails CLOSED: an unknown tier (catalog
  // failed to load / unknown action) is treated as requires_approval so a destructive
  // action can never degrade to a one-click approve.
  const tierForAction = (actionType: string): ExecutionTier =>
    catalog?.actions.find((a) => a.type === actionType)?.action.execution ??
    "requires_approval";

  const handleEnroll = async () => {
    if (!walletAddress.trim()) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await enrollHolder(tokenId, { walletAddress: walletAddress.trim() });
      setWalletAddress("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : wf("errorEnroll"));
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-10 text-sm text-secondary">
        <Loader2 className="h-4 w-4 animate-spin" /> {wf("loading")}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error ? (
        <div className="rounded-xl border border-error-border bg-error-bg px-4 py-3 text-sm text-error">
          {error}
        </div>
      ) : null}

      {/* Builder */}
      {canManage ? (
        <Card>
          <CardHeader>
            <CardTitle>{wf("builderTitle")}</CardTitle>
            <CardDescription>{wf("builderDescription")}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-6 lg:grid-cols-2">
              {/* Controls — build the flow */}
              <div className="space-y-4">
                <div className="space-y-4">
                  <div className="space-y-1.5 text-sm">
                    <span className="font-medium text-secondary">{wf("when")}</span>
                    <Select
                      value={triggerType}
                      onValueChange={onTriggerChange}
                      placeholder={wf("triggerPlaceholder")}
                    >
                      {(catalog?.triggers ?? []).map((trigger) => (
                        <SelectItem key={trigger.type} value={trigger.type}>
                          {label("trigger", trigger.type)}
                        </SelectItem>
                      ))}
                    </Select>
                  </div>

                  <div className="space-y-1.5 text-sm">
                    <span className="font-medium text-secondary">{wf("then")}</span>
                    <Select
                      value={actionType}
                      onValueChange={onActionChange}
                      placeholder={wf("actionPlaceholder")}
                    >
                      {(catalog?.actions ?? []).map((a) => (
                        <SelectItem key={a.type} value={a.type}>
                          {`${label("action", a.type)}${a.support.ok ? "" : wf("unavailableSuffix")}`}
                        </SelectItem>
                      ))}
                    </Select>
                  </div>

                  <div className="space-y-1.5 text-sm">
                    <span className="font-medium text-secondary">{wf("review")}</span>
                    <Select
                      value={reviewMode}
                      onValueChange={(v) => setReviewMode(v === "manual" ? "manual" : "auto")}
                    >
                      <SelectItem value="auto">{wf("autoApply")}</SelectItem>
                      <SelectItem value="manual">{wf("manualReview")}</SelectItem>
                    </Select>
                  </div>
                </div>

                {selectedAction ? (
                  <div className="flex items-center gap-2 text-sm">
                    <Badge variant={TIER_VARIANT[tierOf(selectedAction)]}>
                      {wf(`tierLabels.${tierOf(selectedAction)}`)}
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
                    {paramFields.map((field) =>
                      field.options ? (
                        <div key={field.key} className="space-y-1.5 text-sm">
                          <span className="font-medium text-secondary">{wf(field.labelKey)}</span>
                          <Select
                            value={params[field.key] ?? field.options[0]?.value ?? ""}
                            onValueChange={(v) =>
                              setParams((prev) => ({ ...prev, [field.key]: v ?? "" }))
                            }
                          >
                            {field.options.map((opt) => (
                              <SelectItem key={opt.value} value={opt.value}>
                                {wf(opt.labelKey)}
                              </SelectItem>
                            ))}
                          </Select>
                        </div>
                      ) : (
                        <div key={field.key} className="space-y-1.5 text-sm">
                          <span className="font-medium text-secondary">
                            {wf(field.labelKey)}
                            {field.required ? <span className="text-error"> *</span> : null}
                          </span>
                          <input
                            value={params[field.key] ?? ""}
                            onChange={(e) =>
                              setParams((prev) => ({ ...prev, [field.key]: e.target.value }))
                            }
                            placeholder={field.helpKey ? wf(field.helpKey) : undefined}
                            className="w-full rounded-lg border border-border-default bg-white px-3 py-2 text-sm"
                          />
                          {field.helpKey ? (
                            <span className="text-xs text-tertiary">{wf(field.helpKey)}</span>
                          ) : null}
                        </div>
                      )
                    )}
                  </div>
                ) : null}

                {/* GUARD ("only if…") — optional filters over the trigger payload. */}
                {triggerType ? (
                  <GuardEditor
                    conditionFields={conditionFields}
                    guards={guards}
                    onAdd={addGuard}
                    onUpdate={updateGuard}
                    onRemove={removeGuard}
                  />
                ) : null}

                {/* Generic, detail-free notice when the email channel isn't configured. */}
                {actionType === "notify" && !emailEnabled ? (
                  <div className="rounded-lg border border-warning-border bg-warning-bg px-3 py-2 text-xs text-warning">
                    {wf("emailUnavailable")}
                  </div>
                ) : null}

                <div className="flex justify-end">
                  <Button type="button" size="sm" onClick={handleCreate} disabled={!canCreate}>
                    {wf("create")}
                  </Button>
                </div>
              </div>

              {/* Execution preview — exactly what will happen when this rule runs. */}
              <WorkflowFlowPreview
                trigger={selectedTrigger}
                action={selectedAction}
                guards={guards}
                reviewMode={reviewMode}
                paramSummary={paramSummary}
              />
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* Rules */}
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
                <li key={rule.id} className="flex items-center justify-between gap-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-primary">
                      {label("trigger", rule.trigger_type)} → {label("action", rule.action_type)}
                    </p>
                    <p className="text-xs text-secondary">
                      {rule.review_mode === "manual" ? wf("manualReview") : wf("autoApply")}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge variant={rule.enabled ? "success" : "default"}>
                      {rule.enabled ? wf("enabled") : wf("disabled")}
                    </Badge>
                    {canManage ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        onClick={() => handleToggle(rule)}
                        disabled={busy}
                      >
                        {rule.enabled ? wf("disable") : wf("enable")}
                      </Button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Holders enrollment */}
      {canManage ? (
        <Card>
          <CardHeader>
            <CardTitle>{wf("holdersTitle")}</CardTitle>
            <CardDescription>{wf("holdersDescription")}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                value={walletAddress}
                onChange={(e) => setWalletAddress(e.target.value)}
                placeholder={wf("walletPlaceholder")}
                className="min-w-0 flex-1 rounded-xl border border-border-default bg-white px-3 py-2 text-sm"
              />
              <Button
                type="button"
                size="sm"
                onClick={handleEnroll}
                disabled={busy || !walletAddress.trim()}
              >
                {wf("enrollWallet")}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* Execution log */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle>{wf("logTitle")}</CardTitle>
            <CardDescription>{wf("logDescription")}</CardDescription>
          </div>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => void refresh()}
            disabled={busy}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </CardHeader>
        <CardContent>
          {executions.length === 0 ? (
            <p className="text-sm text-secondary">{wf("logEmpty")}</p>
          ) : (
            <ul className="divide-y divide-border-default">
              {executions.map((execution) => (
                <li key={execution.id} className="flex items-center justify-between gap-4 py-3">
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
                      <p className="truncate text-xs text-secondary">
                        {label("trigger", execution.trigger_type)} · {wf("attempt")}{" "}
                        {execution.attempt_count}/{execution.max_attempts}
                        {execution.error ? ` · ${execution.error}` : ""}
                      </p>
                    </div>
                  </div>
                  {canManage && execution.status === "awaiting_review" ? (
                    <div className="flex shrink-0 items-center gap-2">
                      {tierForAction(execution.action_type) === "requires_approval" ? (
                        // Destructive/irreversible → require a deliberate 5s hold.
                        <HoldToConfirmButton
                          label={wf("holdApprove")}
                          holdingLabel={wf("keepHolding")}
                          disabled={busy}
                          onConfirm={() => handleRetry(execution)}
                        />
                      ) : (
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          onClick={() => handleRetry(execution)}
                          disabled={busy}
                        >
                          {wf("approve")}
                        </Button>
                      )}
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => handleReject(execution)}
                        disabled={busy}
                      >
                        {wf("reject")}
                      </Button>
                    </div>
                  ) : canManage && execution.status === "failed" ? (
                    // Retrying re-authorizes the run, so destructive actions keep the
                    // deliberate hold gate here too.
                    tierForAction(execution.action_type) === "requires_approval" ? (
                      <HoldToConfirmButton
                        label={wf("holdRetry")}
                        holdingLabel={wf("keepHolding")}
                        disabled={busy}
                        onConfirm={() => handleRetry(execution)}
                      />
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        onClick={() => handleRetry(execution)}
                        disabled={busy}
                      >
                        {wf("retry")}
                      </Button>
                    )
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
