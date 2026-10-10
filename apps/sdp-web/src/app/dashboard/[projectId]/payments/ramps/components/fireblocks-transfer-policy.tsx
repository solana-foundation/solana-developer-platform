"use client";
import type {
  FireblocksPolicyCheck,
  FireblocksPolicyForm,
  FireblocksPolicyProposalResult,
  FireblocksPolicySelection,
  FireblocksPolicySetup,
} from "@sdp/types";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useTranslations } from "@/i18n/provider";
import { dashboardFetch } from "@/lib/dashboard-fetch";
import { useProjectId } from "@/lib/use-dashboard-project";
import { FireblocksPolicyFields, fireblocksPolicyFormReady } from "./fireblocks-policy-fields";

type Reply<T> = { data: T };
function PolicyDialog({
  selection,
  onClose,
}: {
  selection: FireblocksPolicySelection;
  onClose: () => void;
}) {
  const t = useTranslations();
  const [setup, setSetup] = useState<FireblocksPolicySetup | null>(null);
  const [form, setForm] = useState<FireblocksPolicyForm | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [proposal, setProposal] = useState<FireblocksPolicyProposalResult | null>(null);
  const busyRef = useRef(false);
  const request = useRef<{ id: string; body: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void dashboardFetch<Reply<FireblocksPolicySetup>>(
      `/api/dashboard/fireblocks/policy/setup?${new URLSearchParams({ ...selection })}`,
      { signal: controller.signal }
    ).then((reply) => {
      if (!active) return;
      if (!reply.ok) {
        setError(reply.error);
        return;
      }
      setSetup(reply.data.data);
      setForm(reply.data.data.defaults);
      setProposal(reply.data.data.proposal ?? null);
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [selection]);
  const submit = async () => {
    if (busyRef.current || !setup || !form) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    if (proposal?.state === "draft") {
      const reply = await dashboardFetch<Reply<FireblocksPolicyProposalResult>>(
        "/api/dashboard/fireblocks/policy/publish",
        { method: "POST", body: { selection, proposalId: proposal.proposalId } }
      );
      if (reply.ok) setProposal(reply.data.data);
      else setError(reply.error);
    } else {
      const body = { selection, form, revision: setup.revision };
      const serialized = JSON.stringify(body);
      if (!request.current || request.current.body !== serialized)
        request.current = { id: crypto.randomUUID(), body: serialized };
      const reply = await dashboardFetch<Reply<FireblocksPolicyProposalResult>>(
        "/api/dashboard/fireblocks/policy/draft",
        { method: "POST", body: { ...body, requestId: request.current.id } }
      );
      if (reply.ok) setProposal(reply.data.data);
      else setError(reply.error);
    }
    busyRef.current = false;
    setBusy(false);
  };
  return (
    <Modal
      isOpen
      ariaLabel={t("DashboardPayments.fireblocksPolicy.title")}
      onClose={onClose}
      closeDisabled={busy}
      size="xl"
      contentClassName="max-h-[90vh] overflow-y-auto p-6"
    >
      <div className="space-y-5">
        <div className="pr-8">
          <h2 className="text-xl">{t("DashboardPayments.fireblocksPolicy.title")}</h2>
          <p className="mt-2 text-sm text-secondary">
            {t("DashboardPayments.fireblocksPolicy.intro")}
          </p>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-error">
            {error}
          </p>
        ) : null}
        {!setup && !error ? (
          <p className="text-sm text-secondary">
            {t("DashboardPayments.fireblocksPolicy.loading")}
          </p>
        ) : null}
        {setup && form ? (
          <FireblocksPolicyFields
            setup={setup}
            form={form}
            onChange={setForm}
            disabled={busy || !!proposal}
          />
        ) : null}
        {proposal ? (
          <p role="status" className="text-sm text-secondary">
            {t(
              proposal.state === "draft"
                ? "DashboardPayments.fireblocksPolicy.draftSaved"
                : proposal.state === "submitted"
                  ? "DashboardPayments.fireblocksPolicy.submitted"
                  : "DashboardPayments.fireblocksPolicy.unconfirmed"
            )}
          </p>
        ) : null}
        <div className="flex justify-end gap-3 border-t border-border-default pt-4">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t("DashboardPayments.fireblocksPolicy.close")}
          </Button>
          {(!proposal || proposal.state === "draft") && setup && form ? (
            <Button
              onClick={() => void submit()}
              disabled={busy || !fireblocksPolicyFormReady(form, setup)}
            >
              {t(
                busy
                  ? "DashboardPayments.fireblocksPolicy.saving"
                  : proposal
                    ? "DashboardPayments.fireblocksPolicy.publish"
                    : "DashboardPayments.fireblocksPolicy.saveDraft"
              )}
            </Button>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
export function FireblocksTransferPolicy({
  enabled,
  selection,
}: {
  enabled: boolean;
  selection: FireblocksPolicySelection;
}) {
  const t = useTranslations();
  const projectId = useProjectId();
  const [check, setCheck] = useState<FireblocksPolicyCheck | null>(null);
  const [open, setOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const key = JSON.stringify([projectId, selection, refresh]);
  const [resultKey, setResultKey] = useState("");
  const stableSelection = useRef(selection);
  if (JSON.stringify(stableSelection.current) !== JSON.stringify(selection))
    stableSelection.current = selection;
  useEffect(() => {
    setOpen(false);
    if (
      !enabled ||
      !selection.walletId ||
      !selection.accountId ||
      !selection.address ||
      !selection.token ||
      !/^\d+(\.\d+)?$/.test(selection.amount) ||
      !projectId
    )
      return;
    const controller = new AbortController();
    let active = true;
    const timer = setTimeout(() => {
      void dashboardFetch<Reply<FireblocksPolicyCheck>>(
        `/api/dashboard/fireblocks/policy?${new URLSearchParams({ ...stableSelection.current })}`,
        { signal: controller.signal }
      ).then((reply) => {
        if (!active) return;
        setCheck(reply.ok ? reply.data.data : { state: "unknown", canConfigure: false });
        setResultKey(key);
      });
    }, 500);
    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [
    enabled,
    key,
    projectId,
    selection.walletId,
    selection.accountId,
    selection.address,
    selection.token,
    selection.amount,
  ]);
  if (!enabled || !check || resultKey !== key) return null;
  const message = {
    covered: "DashboardPayments.fireblocksPolicy.covered",
    missing: "DashboardPayments.fireblocksPolicy.missing",
    blocked: "DashboardPayments.fireblocksPolicy.blocked",
    unknown: "DashboardPayments.fireblocksPolicy.unknown",
    permission_required: "DashboardPayments.fireblocksPolicy.permissions",
  } as const;
  return (
    <div className="space-y-3 border-t border-border-default pt-4">
      <p className="text-sm text-secondary" role="status">
        {t(message[check.state])}
        {check.ruleName ? ` ${check.ruleName}` : ""}
      </p>
      {check.state !== "covered" ? (
        <div className="flex flex-wrap items-center gap-3">
          {check.canConfigure ? (
            <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
              {t("DashboardPayments.fireblocksPolicy.configure")}
            </Button>
          ) : null}
          <Button type="button" variant="ghost" onClick={() => setRefresh((value) => value + 1)}>
            {t("DashboardPayments.fireblocksPolicy.recheck")}
          </Button>
          <a
            href="https://console.fireblocks.io"
            target="_blank"
            rel="noreferrer"
            className="text-sm underline underline-offset-4"
          >
            {t("DashboardPayments.fireblocksPolicy.openFireblocks")}
          </a>
        </div>
      ) : null}
      {open ? (
        <PolicyDialog
          selection={stableSelection.current}
          onClose={() => {
            setOpen(false);
            setRefresh((value) => value + 1);
          }}
        />
      ) : null}
    </div>
  );
}
