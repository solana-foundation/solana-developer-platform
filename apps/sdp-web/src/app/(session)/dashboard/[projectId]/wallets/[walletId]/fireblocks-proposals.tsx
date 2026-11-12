"use client";

import type { FireblocksProposalSummary } from "@sdp/types/fireblocks";
import { Button } from "@sdp/ui/button";
import { Modal } from "@sdp/ui/modal";
import { useState } from "react";
import useSWR from "swr";
import {
  cancelFireblocksProposal,
  listFireblocksProposals,
} from "@/app/(session)/dashboard/[projectId]/wallets/fireblocks-proposal-actions";
import { RecordBlock } from "@/components/refresh-record";
import { useTranslations } from "@/i18n/provider";

export function FireblocksProposals({ custodyWalletId }: { custodyWalletId: string }) {
  const t = useTranslations();
  const [kind, setKind] = useState<"signing" | "transfer">("signing");
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<{
    proposal: FireblocksProposalSummary;
    key: string;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const { data, error, isLoading, mutate } = useSWR(
    ["fireblocks-proposals", custodyWalletId, kind, offset],
    () => listFireblocksProposals(custodyWalletId, kind, offset),
    { refreshInterval: 15_000, revalidateOnFocus: true }
  );
  async function cancel() {
    if (!selected || pending) return;
    setPending(true);
    try {
      const result = await cancelFireblocksProposal(
        selected.proposal.kind,
        selected.proposal.id,
        selected.key
      );
      setNotice(
        t(
          result.proposal.status === "CANCELLED" || result.proposal.status === "CANCELED"
            ? "DashboardCustody.proposals.cancelled"
            : result.acknowledged
              ? "DashboardCustody.proposals.requested"
              : "DashboardCustody.proposals.unconfirmed"
        )
      );
      setSelected(null);
      await mutate().catch(() => undefined);
    } catch {
      setNotice(t("DashboardCustody.proposals.failed"));
    } finally {
      setPending(false);
    }
  }
  return (
    <RecordBlock title={t("DashboardCustody.proposals.title")}>
      <div className="flex flex-wrap gap-2">
        {(["signing", "transfer"] as const).map((value) => (
          <Button
            key={value}
            type="button"
            variant="secondary"
            aria-pressed={kind === value}
            onClick={() => {
              setKind(value);
              setOffset(0);
              setNotice(null);
            }}
          >
            {t(
              value === "signing"
                ? "DashboardCustody.proposals.signing"
                : "DashboardCustody.proposals.transfers"
            )}
          </Button>
        ))}
      </div>
      {notice ? (
        <p role="status" className="mt-3 text-body text-secondary">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-3 text-body text-critical">
          {t("DashboardCustody.proposals.loadFailed")}
        </p>
      ) : null}
      {isLoading ? (
        <div
          className="mt-4 h-16 animate-pulse rounded-control bg-fill-subtle"
          role="status"
          aria-label={t("DashboardCustody.proposals.loading")}
        />
      ) : null}
      {data?.proposals.length === 0 ? (
        <p className="mt-4 text-body text-tertiary">{t("DashboardCustody.proposals.empty")}</p>
      ) : null}
      <ul className="mt-4 divide-y divide-border-subtle">
        {data?.proposals.map((proposal) => (
          <li key={proposal.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div className="min-w-0 flex-1 space-y-1">
              <p className="break-all text-body text-primary">
                {proposal.transactionId ?? proposal.id}
              </p>
              <p className="text-caption text-tertiary">{proposal.status.replaceAll("_", " ")}</p>
              {proposal.cancellationRequestedAt && proposal.canCancel ? (
                <p className="text-caption text-secondary">
                  {t("DashboardCustody.proposals.requested")}
                </p>
              ) : null}
            </div>
            {proposal.canCancel ? (
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setSelected({ proposal, key: crypto.randomUUID() });
                  setNotice(null);
                }}
              >
                {t("DashboardCustody.proposals.cancel")}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {offset > 0 || data?.hasMore ? (
        <div className="mt-3 flex gap-2">
          <Button
            type="button"
            variant="secondary"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - 20))}
          >
            {t("DashboardCustody.proposals.previous")}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={!data?.hasMore}
            onClick={() => setOffset(offset + 20)}
          >
            {t("DashboardCustody.proposals.next")}
          </Button>
        </div>
      ) : null}
      <Modal
        isOpen={selected !== null}
        onClose={() => {
          if (!pending) setSelected(null);
        }}
        ariaLabel={t("DashboardCustody.proposals.confirmTitle")}
        size="sm"
      >
        <div className="space-y-5 p-6">
          <p className="text-title font-medium text-primary">
            {t("DashboardCustody.proposals.confirmTitle")}
          </p>
          <p className="text-body text-secondary">{t("DashboardCustody.proposals.confirmBody")}</p>
          {notice ? (
            <p role="alert" className="text-body text-critical">
              {notice}
            </p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-3">
            <Button
              type="button"
              variant="secondary"
              disabled={pending}
              onClick={() => setSelected(null)}
            >
              {t("DashboardCustody.proposals.keep")}
            </Button>
            <Button type="button" variant="destructive" loading={pending} onClick={cancel}>
              {t("DashboardCustody.proposals.cancel")}
            </Button>
          </div>
        </div>
      </Modal>
    </RecordBlock>
  );
}
