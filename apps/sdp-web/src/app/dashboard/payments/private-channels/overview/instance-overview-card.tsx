import type { PrivateChannelInstance, PrivateChannelInstanceOverview } from "@sdp/types";
import { getTranslations } from "@/i18n/server";
import { cn } from "@/lib/utils";

type Tone = "ok" | "warn" | "bad";

const DOT: Record<Tone, string> = {
  ok: "bg-status-success-text",
  warn: "bg-status-warning-text",
  bad: "bg-status-error-text",
};

function StatusInline({ tone, label }: { tone: Tone; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className={cn("inline-block size-2 rounded-full", DOT[tone])} />
      <span>{label}</span>
    </span>
  );
}

function Row({
  label,
  primary,
  detail,
  mono = false,
}: {
  label: string;
  primary: React.ReactNode;
  detail?: React.ReactNode;
  /** Opt in for on-chain identifiers only — not status text or version numbers. */
  mono?: boolean;
}) {
  return (
    <div className="grid grid-cols-[max-content_1fr] items-baseline gap-x-4 py-3">
      <dt className="text-sm text-secondary">{label}</dt>
      <dd className="min-w-0 space-y-1 text-right">
        <div
          className={cn(
            "break-all text-sm text-primary",
            mono && "font-mono text-secondary text-xs"
          )}
        >
          {primary}
        </div>
        {detail ? <div className="text-secondary text-xs">{detail}</div> : null}
      </dd>
    </div>
  );
}

function gatewayStatus(
  t: Awaited<ReturnType<typeof getTranslations>>,
  health: PrivateChannelInstanceOverview["gateway"]["health"]
) {
  if (health.status === "ready") {
    return { tone: "ok" as const, label: t("DashboardPrivateChannels.overview.ready") };
  }
  if (health.status === "degraded") {
    return {
      tone: "warn" as const,
      label: t("DashboardPrivateChannels.overview.degraded", { reason: health.reason }),
    };
  }
  return {
    tone: "bad" as const,
    label: t("DashboardPrivateChannels.overview.unreachable", { error: health.error }),
  };
}

function formatSol(lamports: number): string {
  return `${(lamports / 1e9).toFixed(4)} SOL`;
}

interface Props {
  instance: PrivateChannelInstance;
  overview: PrivateChannelInstanceOverview;
}

export async function InstanceOverviewCard({ instance, overview }: Props) {
  const t = await getTranslations();
  const { gateway, chainRpc, escrowInstance, escrowProgram, auth } = overview;
  const gw = gatewayStatus(t, gateway.health);

  return (
    <div className="space-y-6">
      <dl className="divide-y divide-border-subtle">
        <Row
          label={t("DashboardPrivateChannels.overview.gateway")}
          primary={<StatusInline tone={gw.tone} label={gw.label} />}
        />

        <Row
          label={t("DashboardPrivateChannels.overview.solanaVersion")}
          primary={
            chainRpc.ok ? (
              chainRpc.solanaVersion ? (
                `v${chainRpc.solanaVersion}`
              ) : (
                "—"
              )
            ) : (
              <StatusInline tone="bad" label={chainRpc.error} />
            )
          }
        />

        <Row
          label={t("DashboardPrivateChannels.overview.slot")}
          primary={gateway.channelSlot !== null ? gateway.channelSlot.toLocaleString() : "—"}
        />

        <Row
          label={t("DashboardPrivateChannels.overview.latestBlockhash")}
          primary={gateway.latestBlockhash ?? "—"}
          mono
        />

        <Row
          label={t("DashboardPrivateChannels.overview.escrowInstance")}
          primary={instance.escrowInstanceAddr}
          mono
          detail={
            escrowInstance.present ? (
              <span>
                {formatSol(escrowInstance.lamports)}
                {escrowInstance.ownerMatchesProgram
                  ? null
                  : ` · ${t("DashboardPrivateChannels.overview.ownerMismatch")}`}
              </span>
            ) : (
              <StatusInline tone="bad" label={escrowInstance.error} />
            )
          }
        />

        <Row
          label={t("DashboardPrivateChannels.overview.escrowProgram")}
          primary={instance.escrowProgramId}
          mono
          detail={
            escrowProgram.present ? (
              <StatusInline
                tone={escrowProgram.executable ? "ok" : "warn"}
                label={
                  escrowProgram.executable
                    ? t("DashboardPrivateChannels.overview.onChain")
                    : t("DashboardPrivateChannels.overview.notExecutable")
                }
              />
            ) : (
              <StatusInline tone="bad" label={escrowProgram.error} />
            )
          }
        />

        {auth ? (
          <Row
            label={t("DashboardPrivateChannels.overview.authService")}
            primary={
              <StatusInline
                tone={auth.reachable ? "ok" : "bad"}
                label={
                  auth.reachable
                    ? t("DashboardPrivateChannels.overview.reachable")
                    : (auth.error ?? t("DashboardPrivateChannels.overview.notReachable"))
                }
              />
            }
          />
        ) : null}
      </dl>
    </div>
  );
}
