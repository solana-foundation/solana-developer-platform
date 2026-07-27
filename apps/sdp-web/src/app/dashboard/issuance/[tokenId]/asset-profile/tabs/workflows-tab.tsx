"use client";

import { Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectItem } from "@/components/ui/select";
import {
  type CatalogActionView,
  createWorkflow,
  type ExecutionStatus,
  type ExecutionTier,
  type ExecutionView,
  enrollHolder,
  fetchExecutions,
  fetchWorkflowCatalog,
  fetchWorkflows,
  humanizeType,
  retryExecution,
  setWorkflowEnabled,
  type WorkflowCatalog,
  type WorkflowRuleView,
} from "../workflows.data";

const TIER_BADGE: Record<
  ExecutionTier,
  { variant: "success" | "warning" | "danger"; label: string }
> = {
  automated: { variant: "success", label: "Automated" },
  sensitive: { variant: "warning", label: "Sensitive" },
  requires_approval: { variant: "danger", label: "Requires approval" },
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
  const [catalog, setCatalog] = useState<WorkflowCatalog | null>(null);
  const [rules, setRules] = useState<WorkflowRuleView[]>([]);
  const [executions, setExecutions] = useState<ExecutionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [triggerType, setTriggerType] = useState<string | null>(null);
  const [actionType, setActionType] = useState<string | null>(null);
  const [reviewMode, setReviewMode] = useState<"auto" | "manual">("auto");
  const [busy, setBusy] = useState(false);
  const [walletAddress, setWalletAddress] = useState("");

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [cat, ruleRows, execRows] = await Promise.all([
        fetchWorkflowCatalog(tokenId),
        fetchWorkflows(tokenId),
        fetchExecutions(tokenId),
      ]);
      setCatalog(cat);
      setRules(ruleRows);
      setExecutions(execRows);
      setTriggerType((prev) => prev ?? cat.triggers[0]?.type ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load workflows");
    } finally {
      setLoading(false);
    }
  }, [tokenId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selectedAction = catalog?.actions.find((a) => a.type === actionType) ?? null;
  const canCreate = canManage && Boolean(triggerType && selectedAction?.support.ok) && !busy;

  const handleCreate = async () => {
    if (!triggerType || !actionType) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await createWorkflow(tokenId, { triggerType, actionType, reviewMode });
      setActionType(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create workflow");
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
      setError(err instanceof Error ? err.message : "Failed to update workflow");
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
      setError(err instanceof Error ? err.message : "Failed to retry execution");
    } finally {
      setBusy(false);
    }
  };

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
      setError(err instanceof Error ? err.message : "Failed to enroll holder");
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-10 text-sm text-secondary">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading workflows…
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
            <CardTitle>Build workflow rule</CardTitle>
            <CardDescription>
              When a trigger fires, run an action — gated by this asset's capabilities.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1.5 text-sm">
                <span className="font-medium text-secondary">When</span>
                <Select value={triggerType} onValueChange={setTriggerType} placeholder="Trigger">
                  {(catalog?.triggers ?? []).map((t) => (
                    <SelectItem key={t.type} value={t.type}>
                      {humanizeType(t.type)}
                    </SelectItem>
                  ))}
                </Select>
              </div>

              <div className="space-y-1.5 text-sm">
                <span className="font-medium text-secondary">Then</span>
                <Select value={actionType} onValueChange={setActionType} placeholder="Action">
                  {(catalog?.actions ?? []).map((a) => (
                    <SelectItem key={a.type} value={a.type}>
                      {`${humanizeType(a.type)}${a.support.ok ? "" : " — unavailable"}`}
                    </SelectItem>
                  ))}
                </Select>
              </div>

              <div className="space-y-1.5 text-sm">
                <span className="font-medium text-secondary">Review</span>
                <Select
                  value={reviewMode}
                  onValueChange={(v) => setReviewMode(v === "manual" ? "manual" : "auto")}
                >
                  <SelectItem value="auto">Auto apply</SelectItem>
                  <SelectItem value="manual">Manual review</SelectItem>
                </Select>
              </div>
            </div>

            {selectedAction ? (
              <div className="flex items-center gap-2 text-sm">
                <Badge variant={TIER_BADGE[tierOf(selectedAction)].variant}>
                  {TIER_BADGE[tierOf(selectedAction)].label}
                </Badge>
                {!selectedAction.support.ok ? (
                  <span className="text-secondary">
                    Not supported by this asset ({selectedAction.support.reason}).
                  </span>
                ) : null}
              </div>
            ) : null}

            <div className="flex justify-end">
              <Button type="button" size="sm" onClick={handleCreate} disabled={!canCreate}>
                Create workflow
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* Rules */}
      <Card>
        <CardHeader>
          <CardTitle>Rules</CardTitle>
          <CardDescription>Automations configured for this asset.</CardDescription>
        </CardHeader>
        <CardContent>
          {rules.length === 0 ? (
            <p className="text-sm text-secondary">No workflows yet.</p>
          ) : (
            <ul className="divide-y divide-border-default">
              {rules.map((rule) => (
                <li key={rule.id} className="flex items-center justify-between gap-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-primary">
                      {humanizeType(rule.trigger_type)} → {humanizeType(rule.action_type)}
                    </p>
                    <p className="text-xs text-secondary">
                      {rule.review_mode === "manual" ? "Manual review" : "Auto apply"}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge variant={rule.enabled ? "success" : "default"}>
                      {rule.enabled ? "Enabled" : "Disabled"}
                    </Badge>
                    {canManage ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        onClick={() => handleToggle(rule)}
                        disabled={busy}
                      >
                        {rule.enabled ? "Disable" : "Enable"}
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
            <CardTitle>Verified holders</CardTitle>
            <CardDescription>
              Enroll a wallet for this asset. When its KYC is approved, matching workflows run.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                value={walletAddress}
                onChange={(e) => setWalletAddress(e.target.value)}
                placeholder="Wallet address"
                className="min-w-0 flex-1 rounded-xl border border-border-default bg-white px-3 py-2 text-sm"
              />
              <Button
                type="button"
                size="sm"
                onClick={handleEnroll}
                disabled={busy || !walletAddress.trim()}
              >
                Enroll wallet
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* Execution log */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle>Execution log</CardTitle>
            <CardDescription>Recent workflow runs and their outcomes.</CardDescription>
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
            <p className="text-sm text-secondary">No executions yet.</p>
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
                        {humanizeType(execution.action_type)}{" "}
                        <span className="font-normal text-secondary">
                          · {execution.status.replace(/_/g, " ")}
                        </span>
                      </p>
                      <p className="truncate text-xs text-secondary">
                        {humanizeType(execution.trigger_type)} · attempt {execution.attempt_count}/
                        {execution.max_attempts}
                        {execution.error ? ` · ${execution.error}` : ""}
                      </p>
                    </div>
                  </div>
                  {canManage &&
                  (execution.status === "failed" || execution.status === "awaiting_review") ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      onClick={() => handleRetry(execution)}
                      disabled={busy}
                    >
                      {execution.status === "awaiting_review" ? "Approve" : "Retry"}
                    </Button>
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
