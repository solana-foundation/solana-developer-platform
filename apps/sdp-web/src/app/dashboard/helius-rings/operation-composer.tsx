"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectItem } from "@/components/ui/select";
import { useTranslations } from "@/i18n/provider";
import {
  prepareRingsOperation,
  RINGS_ALLOWLISTED_ASSETS,
  type RingsOpType,
  type RingsWallet,
} from "./helius-rings.data";
import { formatAssetAmount, parseDecimalToBaseUnits } from "./helius-rings.utils";

export interface CustodySummary {
  readonly name: string;
  readonly publicKey: string;
}

type Translate = ReturnType<typeof useTranslations>;

// UI tab labels map 1:1 to server op types; `transfer_registered` is what the
// API accepts for shielded → shielded transfers within this project.
const OP_TABS: readonly RingsOpType[] = ["shield", "withdraw", "transfer_registered"] as const;

type Phase = { name: "compose" } | { name: "review"; error: string | null };

interface ComposerDraft {
  walletId: string;
  opType: RingsOpType;
  assetMint: string;
  /** User-typed decimal amount, e.g. "1.01". Converted to base units at submit. */
  amountDecimal: string;
  recipient: string;
}

function newDraft(walletId: string, opType: RingsOpType = "shield"): ComposerDraft {
  return {
    walletId,
    opType,
    assetMint: RINGS_ALLOWLISTED_ASSETS[0].mint,
    amountDecimal: "",
    recipient: "",
  };
}

function assetOf(mint: string) {
  return RINGS_ALLOWLISTED_ASSETS.find((entry) => entry.mint === mint);
}

function draftAmountRaw(draft: ComposerDraft): string | null {
  const asset = assetOf(draft.assetMint);
  return asset ? parseDecimalToBaseUnits(draft.amountDecimal, asset.decimals) : null;
}

function isDraftComplete(draft: ComposerDraft): boolean {
  if (draftAmountRaw(draft) === null) return false;
  // Withdraw's recipient is derived from the wallet's own custody address; only
  // private transfers still need an explicit recipient choice.
  if (draft.opType === "transfer_registered") {
    return draft.recipient.trim().length > 0;
  }
  return true;
}

function buildSummaryRows(
  t: Translate,
  draft: ComposerDraft,
  custody: CustodySummary | null,
  recipientOptions: readonly RingsWallet[]
): Array<[string, string]> {
  const amountRaw = draftAmountRaw(draft);
  const rows: Array<[string, string]> = [
    [
      t("DashboardHeliusRings.composer.summaryOperation"),
      t(`DashboardHeliusRings.activity.opType_${draft.opType}`),
    ],
    [
      t("DashboardHeliusRings.composer.summaryAmount"),
      formatAssetAmount(amountRaw, draft.assetMint),
    ],
  ];
  if (draft.opType === "transfer_registered") {
    const recipientWallet = recipientOptions.find((w) => w.shieldedAddress === draft.recipient);
    rows.push([
      t("DashboardHeliusRings.composer.summaryRecipient"),
      recipientWallet?.name ?? draft.recipient,
    ]);
  }
  return rows;
}

/** Compose then review; confirming hands the operation to Activity. */
export function OperationComposer({
  wallets,
  recipientOptions,
  custody,
  gatewayRed,
  onPrepared,
}: {
  wallets: RingsWallet[];
  /** Other private wallets in the same project the sender can transfer to. */
  recipientOptions: RingsWallet[];
  /** Custody wallet backing the selected private wallet — name + Solana pubkey. */
  custody: CustodySummary | null;
  gatewayRed: boolean;
  onPrepared: () => Promise<void>;
}) {
  const t = useTranslations();

  // Workspace selection guarantees exactly one wallet by the time we mount, but
  // guard anyway so a stale prop doesn't submit against a missing id.
  const wallet = wallets[0] ?? null;
  const walletId = wallet?.id ?? null;

  const [phase, setPhase] = useState<Phase>({ name: "compose" });
  const [draft, setDraft] = useState<ComposerDraft>(() => newDraft(walletId ?? ""));
  const [submitting, setSubmitting] = useState(false);
  const [started, setStarted] = useState(false);

  // Switching wallet is a fresh session: clear draft (including tab), any
  // in-flight review, and the leftover started-callout. Otherwise the tab and
  // form data from wallet A follow the operator into wallet B.
  useEffect(() => {
    if (walletId === null) return;
    setDraft((current) => (current.walletId === walletId ? current : newDraft(walletId)));
    setPhase({ name: "compose" });
    setStarted(false);
  }, [walletId]);

  const patchDraft = useCallback((patch: Partial<ComposerDraft>) => {
    setStarted(false);
    setDraft((current) => ({ ...current, ...patch }));
  }, []);

  const handleConfirm = useCallback(async () => {
    const amountRaw = draftAmountRaw(draft);
    if (amountRaw === null) return;
    setSubmitting(true);
    setPhase({ name: "review", error: null });
    let prepared: Awaited<ReturnType<typeof prepareRingsOperation>>;
    try {
      // Withdraw always lands in the wallet's own custody address — no free
      // input. Transfer uses the recipient private wallet's shielded address.
      const to =
        draft.opType === "withdraw"
          ? (custody?.publicKey ?? undefined)
          : draft.opType === "transfer_registered"
            ? draft.recipient.trim()
            : undefined;
      if ((draft.opType === "withdraw" || draft.opType === "transfer_registered") && !to) {
        setPhase({
          name: "review",
          error: t("DashboardHeliusRings.composer.prepareFailed"),
        });
        return;
      }
      prepared = await prepareRingsOperation({
        walletId: draft.walletId,
        opType: draft.opType,
        asset: { mint: draft.assetMint, amountRaw },
        to,
      });
    } finally {
      setSubmitting(false);
    }
    if (prepared.error || !prepared.operation) {
      setPhase({
        name: "review",
        error: prepared.error ?? t("DashboardHeliusRings.composer.prepareFailed"),
      });
      return;
    }
    setStarted(true);
    setPhase({ name: "compose" });
    setDraft(newDraft(draft.walletId, draft.opType));
    await onPrepared();
  }, [draft, onPrepared, t]);

  const summaryRows = useMemo(
    () => (wallet ? buildSummaryRows(t, draft, custody, recipientOptions) : []),
    [t, draft, wallet, custody, recipientOptions]
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("DashboardHeliusRings.composer.title")}</CardTitle>
        <CardDescription>
          {t(`DashboardHeliusRings.composer.description_${draft.opType}`)}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {started && phase.name === "compose" ? (
          <Callout live variant="success">
            {t("DashboardHeliusRings.composer.started")}
          </Callout>
        ) : null}

        {phase.name === "compose" ? (
          <>
            <OpTabs
              value={draft.opType}
              onSelect={(opType) => {
                setPhase({ name: "compose" });
                patchDraft({ opType });
              }}
            />
            <ComposeStep
              draft={draft}
              custody={custody}
              recipientOptions={recipientOptions}
              onPatch={patchDraft}
              onReview={() => setPhase({ name: "review", error: null })}
            />
          </>
        ) : null}

        {phase.name === "review" ? (
          <ReviewStep
            rows={summaryRows}
            gatewayRed={gatewayRed}
            error={phase.error}
            submitting={submitting}
            onBack={() => setPhase({ name: "compose" })}
            onConfirm={() => void handleConfirm()}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

// Segmented control: three buttons that read as one connected group.
function OpTabs({
  value,
  onSelect,
}: {
  value: RingsOpType;
  onSelect: (op: RingsOpType) => void;
}) {
  const t = useTranslations();
  return (
    <div
      role="tablist"
      aria-label={t("DashboardHeliusRings.composer.operation")}
      className="inline-flex w-fit rounded-md border border-border-default bg-surface p-0.5"
    >
      {OP_TABS.map((op) => {
        const active = op === value;
        return (
          <button
            key={op}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(op)}
            className={
              active
                ? "rounded-sm bg-primary px-3 py-1.5 text-sm font-medium text-on-primary"
                : "rounded-sm px-3 py-1.5 text-sm font-medium text-secondary hover:text-primary"
            }
          >
            {t(`DashboardHeliusRings.composer.opTab_${op}`)}
          </button>
        );
      })}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-48 flex-col gap-1.5">
      <span className="text-sm font-medium text-primary">{label}</span>
      {children}
    </div>
  );
}

function ComposeStep({
  draft,
  custody,
  recipientOptions,
  onPatch,
  onReview,
}: {
  draft: ComposerDraft;
  custody: CustodySummary | null;
  recipientOptions: readonly RingsWallet[];
  onPatch: (patch: Partial<ComposerDraft>) => void;
  onReview: () => void;
}) {
  const t = useTranslations();

  if (draft.opType === "transfer_registered" && recipientOptions.length === 0) {
    return (
      <Callout variant="info">
        {t("DashboardHeliusRings.composer.privateTransferNoRecipients")}
      </Callout>
    );
  }

  return (
    <>
      <div className="flex flex-wrap gap-3">
        <Field label={t("DashboardHeliusRings.composer.asset")}>
          <Select
            ariaLabel={t("DashboardHeliusRings.composer.asset")}
            value={draft.assetMint}
            onValueChange={(value) => {
              if (value) onPatch({ assetMint: value });
            }}
          >
            {RINGS_ALLOWLISTED_ASSETS.map((entry) => (
              <SelectItem key={entry.mint} value={entry.mint}>
                {entry.symbol}
              </SelectItem>
            ))}
          </Select>
        </Field>
        <Field label={t("DashboardHeliusRings.composer.amount")}>
          <Input
            inputMode="decimal"
            value={draft.amountDecimal}
            placeholder="1.01"
            onChange={(event) =>
              onPatch({
                amountDecimal: event.target.value.replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1"),
              })
            }
          />
        </Field>
      </div>

      {draft.opType === "transfer_registered" ? (
        <Field label={t("DashboardHeliusRings.composer.recipientPrivateWallet")}>
          <Select
            ariaLabel={t("DashboardHeliusRings.composer.recipientPrivateWallet")}
            value={draft.recipient || null}
            onValueChange={(value) => {
              if (value) onPatch({ recipient: value });
            }}
            placeholder={t("DashboardHeliusRings.composer.recipientPrivateWalletPlaceholder")}
          >
            {recipientOptions.map((option) =>
              option.shieldedAddress === null ? null : (
                <SelectItem key={option.id} value={option.shieldedAddress}>
                  {option.name}
                </SelectItem>
              )
            )}
          </Select>
        </Field>
      ) : null}

      <div>
        <Button disabled={!isDraftComplete(draft)} onClick={onReview}>
          {t("DashboardHeliusRings.composer.review")}
        </Button>
      </div>
    </>
  );
}


function ReviewStep({
  rows,
  gatewayRed,
  error,
  submitting,
  onBack,
  onConfirm,
}: {
  rows: Array<[string, string]>;
  gatewayRed: boolean;
  error: string | null;
  submitting: boolean;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const t = useTranslations();
  return (
    <>
      {gatewayRed ? (
        <Callout variant="info">{t("DashboardHeliusRings.composer.gatewayRedNotice")}</Callout>
      ) : null}
      <dl className="flex flex-col gap-2">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-4">
            <dt className="text-sm text-secondary">{label}</dt>
            <dd className="text-sm text-primary">{value}</dd>
          </div>
        ))}
      </dl>

      {error ? <Callout variant="danger">{error}</Callout> : null}

      <div className="flex gap-2">
        <Button variant="secondary" onClick={onBack}>
          {t("DashboardHeliusRings.composer.back")}
        </Button>
        <Button disabled={submitting} onClick={onConfirm}>
          {submitting
            ? t("DashboardHeliusRings.composer.preparing")
            : t("DashboardHeliusRings.composer.confirm")}
        </Button>
      </div>
    </>
  );
}
