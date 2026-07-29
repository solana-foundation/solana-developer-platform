"use client";

import { Badge } from "@/components/ui/badge";
import { useTranslations } from "@/i18n/provider";
import {
  type CatalogActionView,
  type CatalogTriggerView,
  type ExecutionTier,
  type GuardDraft,
  humanizeType,
} from "../workflows.data";

// Read-only "exactly what happens" panel for the rule currently being built. Computed
// live from the same catalog the controls use — no backend call. It surfaces the
// otherwise-invisible AUTOMATIC capability gate as a real pipeline step, alongside the
// user-authored WHEN → (only if…) → review → THEN legs. Mirrors the wizard's
// "automations you'll unlock" preview, but for one specific in-progress rule.

type StepTone = "ok" | "warn" | "blocked" | "pending";

interface FlowStep {
  tone: StepTone;
  title: string;
  detail?: string;
  badge?: ExecutionTier;
}

const DOT: Record<StepTone, string> = {
  ok: "bg-success",
  warn: "bg-warning",
  blocked: "bg-error",
  pending: "bg-fill-strong",
};

const TIER_VARIANT: Record<ExecutionTier, "success" | "warning" | "danger"> = {
  automated: "success",
  sensitive: "warning",
  requires_approval: "danger",
};

const OP_LABEL_KEY: Record<GuardDraft["op"], string> = {
  eq: "guardIs",
  neq: "guardIsNot",
  in: "guardIsOneOf",
};

const SUPPORT_REASON_KEY: Record<string, string> = {
  no_allowlist: "flowReasonNoAllowlist",
  capability_disabled: "flowReasonCapabilityDisabled",
  unknown_action: "flowReasonUnknownAction",
};

export function WorkflowFlowPreview({
  trigger,
  action,
  guards,
  reviewMode,
  paramSummary,
  // True when the action targets a wallet that neither the trigger payload nor the
  // collected params identify — the rule would enqueue and then permanently fail.
  walletGap,
}: {
  trigger: CatalogTriggerView | null;
  action: CatalogActionView | null;
  guards: GuardDraft[];
  reviewMode: "auto" | "manual";
  paramSummary: string;
  walletGap: boolean;
}) {
  const t = useTranslations();
  // All lookups go through a catching wrapper: one missing/renamed key must degrade to
  // a readable fallback, not crash the whole tab.
  const wf = (k: string) => {
    try {
      return t(`DashboardIssuance.workflows.${k}` as Parameters<typeof t>[0]);
    } catch {
      return humanizeType(k);
    }
  };
  const dyn = (kind: "trigger" | "action" | "conditionField", type: string): string => {
    try {
      return t(`DashboardIssuance.workflows.${kind}Labels.${type}` as Parameters<typeof t>[0]);
    } catch {
      return humanizeType(type);
    }
  };
  const interp = (k: string, values: Record<string, string>): string => {
    try {
      return t(`DashboardIssuance.workflows.${k}` as Parameters<typeof t>[0], values);
    } catch {
      return Object.values(values).join(" ");
    }
  };

  const steps: FlowStep[] = [];

  if (trigger) {
    steps.push({
      tone: "ok",
      title: interp("flowWhen", { trigger: dyn("trigger", trigger.type) }),
    });
  }

  // GUARD leg — only the rows the user actually filled in.
  const activeGuards = guards.filter((g) => g.field && g.value.trim().length > 0);
  if (activeGuards.length > 0) {
    const clauses = activeGuards
      .map((g) => {
        // `in` values are comma-separated while editing — render them as a tidy list.
        const value =
          g.op === "in"
            ? g.value
                .split(",")
                .map((entry) => entry.trim())
                .filter(Boolean)
                .join(", ")
            : g.value.trim();
        return `${dyn("conditionField", g.field)} ${wf(OP_LABEL_KEY[g.op]).toLocaleLowerCase()} ${value}`;
      })
      .join(" · ");
    steps.push({ tone: "ok", title: interp("flowOnlyIf", { clauses }) });
  }

  if (action) {
    // Capability gate (AUTOMATIC) — the rail that's invisible in the raw controls.
    const req = action.action.requires;
    const supported = action.support.ok;
    let capTitle: string;
    if (req.kind === "allowlist") {
      capTitle = wf("flowCapabilityAllowlist");
    } else if (req.kind === "token_transaction") {
      capTitle = interp("flowCapabilityToken", { capability: humanizeType(req.action) });
    } else if (req.kind === "base") {
      // Mint/burn ride the asset's base authorities — say so instead of the misleading
      // "no capability required".
      capTitle = interp("flowCapabilityBase", { capability: humanizeType(req.action) });
    } else {
      capTitle = wf("flowCapabilityNone");
    }
    steps.push(
      supported
        ? { tone: "ok", title: capTitle }
        : {
            tone: "blocked",
            title: capTitle,
            detail: wf(SUPPORT_REASON_KEY[action.support.reason] ?? "flowReasonUnknownAction"),
          }
    );

    // Target-wallet gate — a trigger that never identifies a wallet cannot drive a
    // wallet-targeting action unless a param fills the gap. Without this step the
    // preview green-lights a rule that would permanently fail at run time.
    if (walletGap) {
      steps.push({
        tone: "blocked",
        title: wf("flowWalletGap"),
        detail: wf("flowWalletGapDetail"),
      });
    }

    // Review gate — destructive tiers are always held; others honor the chosen review mode.
    const tier = action.action.execution;
    const destructive = tier === "requires_approval";
    const held = destructive || reviewMode === "manual";
    steps.push(
      held
        ? {
            tone: "warn",
            title: wf("flowHeldForReview"),
            detail: destructive ? wf("flowHoldNote") : undefined,
          }
        : { tone: "ok", title: wf("flowAutoApplies") }
    );

    // Action leg.
    steps.push({
      tone: supported && !walletGap ? "ok" : "blocked",
      title: interp("flowRuns", { action: dyn("action", action.type) }),
      detail: paramSummary || undefined,
      badge: tier,
    });
  } else if (trigger) {
    steps.push({ tone: "pending", title: wf("flowPickAction") });
  }

  return (
    <div className="rounded-xl border border-border-default bg-fill-subtle/30 p-4">
      <h4 className="text-sm font-semibold text-primary">{wf("flowTitle")}</h4>
      <p className="mt-0.5 text-xs text-secondary">{wf("flowIntro")}</p>

      {steps.length === 0 ? (
        <p className="mt-4 text-sm text-secondary">{wf("flowEmpty")}</p>
      ) : (
        <ol className="mt-4">
          {steps.map((step, index) => {
            const last = index === steps.length - 1;
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: steps are positional and recomputed each render
              <li key={`${step.title}-${index}`} className="flex gap-3">
                <div className="flex flex-col items-center">
                  <span
                    className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${DOT[step.tone]}`}
                    aria-hidden
                  />
                  {last ? null : (
                    <span className="my-1 w-px flex-1 bg-border-default" aria-hidden />
                  )}
                </div>
                <div className={`min-w-0 ${last ? "" : "pb-4"}`}>
                  <p className="text-sm font-medium text-primary">
                    {step.title}
                    {step.badge ? (
                      <Badge className="ml-2 align-middle" variant={TIER_VARIANT[step.badge]}>
                        {wf(`tierLabels.${step.badge}`)}
                      </Badge>
                    ) : null}
                  </p>
                  {step.detail ? (
                    <p className="mt-0.5 truncate text-xs text-secondary">{step.detail}</p>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
