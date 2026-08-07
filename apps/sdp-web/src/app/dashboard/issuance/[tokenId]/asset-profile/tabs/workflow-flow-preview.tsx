"use client";

import {
  ArrowDown,
  ArrowRight,
  Circle,
  CircleCheck,
  Clock,
  Filter,
  type LucideIcon,
  Play,
  ShieldAlert,
  ShieldCheck,
  TriangleAlert,
  Zap,
} from "lucide-react";
import { Fragment } from "react";
import { Badge } from "@/components/ui/badge";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import {
  type CatalogActionView,
  type CatalogTriggerView,
  type ExecutionTier,
  type GuardDraft,
  humanizeType,
} from "../workflows.data";
import { ACTION_ICONS, ConnectorBadge } from "./workflow-builder-cards";

// Read-only "exactly what happens" panel for the rule currently being built. Computed
// live from the same catalog the controls use — no backend call. It surfaces the
// otherwise-invisible AUTOMATIC capability gate as a real pipeline node, alongside the
// user-authored WHEN → (only if…) → review → THEN legs. Rendered as a connected node
// graph: an icon chip per step (tinted by status), joined by arrows.

type StepTone = "ok" | "warn" | "blocked" | "pending";
type StepKind = "when" | "guard" | "capability" | "walletgap" | "review" | "action";

interface FlowStep {
  tone: StepTone;
  kind: StepKind;
  title: string;
  detail?: string;
  badge?: ExecutionTier;
  actionType?: string;
}

// Status lives in a trailing glyph (green check / amber clock / red alert), so the left
// icon tile stays neutral — status colour in exactly one place per node, per the sketches.
const STATUS_ICON: Record<StepTone, LucideIcon> = {
  ok: CircleCheck,
  warn: Clock,
  blocked: TriangleAlert,
  pending: Circle,
};
const STATUS_TONE: Record<StepTone, string> = {
  ok: "text-success",
  warn: "text-warning",
  blocked: "text-error",
  pending: "text-tertiary",
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

function stepIcon(step: FlowStep): LucideIcon {
  switch (step.kind) {
    case "when":
      return Zap;
    case "guard":
      return Filter;
    case "capability":
      return step.tone === "blocked" ? ShieldAlert : ShieldCheck;
    case "walletgap":
      return TriangleAlert;
    case "review":
      return step.tone === "warn" ? Clock : CircleCheck;
    case "action":
      return (step.actionType ? ACTION_ICONS[step.actionType] : undefined) ?? Play;
  }
}

export function WorkflowFlowGraph({
  trigger,
  action,
  guards,
  reviewMode,
  paramSummary,
  // True when the action targets a wallet that neither the trigger payload nor the
  // collected params identify — the rule would enqueue and then permanently fail.
  walletGap,
  orientation = "vertical",
  // When false, drops the titled card chrome so the graph can embed inside another
  // surface (e.g. the pipeline layout's outcome strip).
  showChrome = true,
}: {
  trigger: CatalogTriggerView | null;
  action: CatalogActionView | null;
  guards: GuardDraft[];
  reviewMode: "auto" | "manual";
  paramSummary: string;
  walletGap: boolean;
  orientation?: "vertical" | "horizontal";
  showChrome?: boolean;
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
      kind: "when",
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
    steps.push({ tone: "ok", kind: "guard", title: interp("flowOnlyIf", { clauses }) });
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
        ? { tone: "ok", kind: "capability", title: capTitle }
        : {
            tone: "blocked",
            kind: "capability",
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
        kind: "walletgap",
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
            kind: "review",
            title: wf("flowHeldForReview"),
            detail: destructive ? wf("flowHoldNote") : undefined,
          }
        : { tone: "ok", kind: "review", title: wf("flowAutoApplies") }
    );

    // Action leg.
    steps.push({
      tone: supported && !walletGap ? "ok" : "blocked",
      kind: "action",
      title: interp("flowRuns", { action: dyn("action", action.type) }),
      detail: paramSummary || undefined,
      badge: tier,
      actionType: action.type,
    });
  } else if (trigger) {
    steps.push({ tone: "pending", kind: "action", title: wf("flowPickAction") });
  }

  const graph =
    steps.length === 0 ? (
      <p className="text-sm text-secondary">{wf("flowEmpty")}</p>
    ) : (
      <div
        className={cn(
          orientation === "horizontal"
            ? "flex flex-wrap items-stretch gap-x-1 gap-y-2"
            : "flex flex-col"
        )}
      >
        {steps.map((step, index) => {
          const Icon = stepIcon(step);
          const last = index === steps.length - 1;
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: steps are positional and recomputed each render
            <Fragment key={`${step.kind}-${index}`}>
              <FlowNode
                icon={Icon}
                tone={step.tone}
                title={step.title}
                detail={step.detail}
                badge={step.badge ? wf(`tierLabels.${step.badge}`) : undefined}
                badgeVariant={step.badge ? TIER_VARIANT[step.badge] : undefined}
                orientation={orientation}
              />
              {last ? null : <FlowArrow orientation={orientation} />}
            </Fragment>
          );
        })}
      </div>
    );

  if (!showChrome) {
    return graph;
  }

  return (
    <div className="rounded-xl border border-border-default bg-fill-subtle/30 p-4">
      <h4 className="text-sm font-semibold text-primary">{wf("flowTitle")}</h4>
      <p className="mt-0.5 text-xs text-secondary">{wf("flowIntro")}</p>
      <div className="mt-4">{graph}</div>
    </div>
  );
}

function FlowNode({
  icon: Icon,
  tone,
  title,
  detail,
  badge,
  badgeVariant,
  orientation,
}: {
  icon: LucideIcon;
  tone: StepTone;
  title: string;
  detail?: string;
  badge?: string;
  badgeVariant?: "success" | "warning" | "danger";
  orientation: "vertical" | "horizontal";
}) {
  const StatusIcon = STATUS_ICON[tone];
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-xl border border-border-subtle bg-surface-raised px-3 py-2.5",
        orientation === "horizontal" && "min-w-[11rem] flex-1 basis-[11rem]"
      )}
    >
      <span
        className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-fill-subtle text-secondary"
        aria-hidden
      >
        <Icon className="size-[18px]" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-sm font-medium text-primary">{title}</span>
          {badge ? (
            <Badge variant={badgeVariant} className="align-middle">
              {badge}
            </Badge>
          ) : null}
        </div>
        {detail ? <p className="mt-0.5 truncate text-xs text-secondary">{detail}</p> : null}
      </div>
      <StatusIcon className={cn("size-4 shrink-0 self-center", STATUS_TONE[tone])} aria-hidden />
    </div>
  );
}

function FlowArrow({ orientation }: { orientation: "vertical" | "horizontal" }) {
  if (orientation === "horizontal") {
    return (
      <div className="flex items-center self-center" aria-hidden>
        <ConnectorBadge icon={ArrowRight} />
      </div>
    );
  }
  // Centred across the node width — the connectors form a spine down the middle.
  return (
    <div className="flex justify-center py-1.5" aria-hidden>
      <ConnectorBadge icon={ArrowDown} />
    </div>
  );
}
