"use client";

import { useCallback, useMemo, useState } from "react";
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

type Translate = ReturnType<typeof useTranslations>;

const OP_TYPES: RingsOpType[] = ["shield", "withdraw"];

/**
 * A union rather than parallel `step`/`error` values so an error can only exist
 * on the step that can show one. Progress belongs to Activity, which follows
 * the operation past this card's lifetime.
 */
type Phase = { name: "compose" } | { name: "review"; error: string | null };

interface ComposerDraft {
  walletId: string | null;
  opType: RingsOpType;
  assetMint: string;
  /** User-typed decimal amount, e.g. "1.01". Converted to base units at submit. */
  amountDecimal: string;
  recipient: string;
}

const EMPTY_DRAFT: ComposerDraft = {
  walletId: null,
  opType: "shield",
  assetMint: RINGS_ALLOWLISTED_ASSETS[0].mint,
  amountDecimal: "",
  recipient: "",
};

function assetOf(mint: string) {
  return RINGS_ALLOWLISTED_ASSETS.find((entry) => entry.mint === mint);
}

function draftAmountRaw(draft: ComposerDraft): string | null {
  const asset = assetOf(draft.assetMint);
  return asset ? parseDecimalToBaseUnits(draft.amountDecimal, asset.decimals) : null;
}

function isDraftComplete(draft: ComposerDraft): boolean {
  if (draft.walletId === null) return false;
  if (draftAmountRaw(draft) === null) return false;
  return draft.opType !== "withdraw" || draft.recipient.trim().length > 0;
}

function buildSummaryRows(
  t: Translate,
  draft: ComposerDraft,
  wallets: RingsWallet[]
): Array<[string, string]> {
  const amountRaw = draftAmountRaw(draft);
  const rows: Array<[string, string]> = [
    [
      t("DashboardHeliusRings.composer.summaryWallet"),
      wallets.find((wallet) => wallet.id === draft.walletId)?.name ?? "—",
    ],
    [
      t("DashboardHeliusRings.composer.summaryOperation"),
      t(`DashboardHeliusRings.activity.opType_${draft.opType}`),
    ],
    [
      t("DashboardHeliusRings.composer.summaryAmount"),
      formatAssetAmount(amountRaw, draft.assetMint),
    ],
  ];
  if (draft.opType === "withdraw") {
    rows.push([t("DashboardHeliusRings.composer.summaryRecipient"), draft.recipient]);
  }
  return rows;
}

/** Compose then review; confirming hands the operation to Activity. */
export function OperationComposer({
  wallets,
  gatewayRed,
  onPrepared,
}: {
  wallets: RingsWallet[];
  gatewayRed: boolean;
  onPrepared: () => Promise<void>;
}) {
  const t = useTranslations();

  const [phase, setPhase] = useState<Phase>({ name: "compose" });
  const [draft, setDraft] = useState<ComposerDraft>(EMPTY_DRAFT);
  const [submitting, setSubmitting] = useState(false);
  const [started, setStarted] = useState(false);

  const patchDraft = useCallback((patch: Partial<ComposerDraft>) => {
    setStarted(false);
    setDraft((current) => ({ ...current, ...patch }));
  }, []);

  const handleConfirm = useCallback(async () => {
    if (!draft.walletId) return;
    const amountRaw = draftAmountRaw(draft);
    if (amountRaw === null) return;
    setSubmitting(true);
    setPhase({ name: "review", error: null });
    let prepared: Awaited<ReturnType<typeof prepareRingsOperation>>;
    try {
      prepared = await prepareRingsOperation({
        walletId: draft.walletId,
        opType: draft.opType,
        asset: { mint: draft.assetMint, amountRaw },
        to: draft.opType === "withdraw" ? draft.recipient.trim() : undefined,
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
    // Back to an empty form with the wallet kept, because the operation is no
    // longer this card's to report on: Activity has it, and follows it past the
    // point the composer would have been reset anyway.
    setStarted(true);
    setPhase({ name: "compose" });
    setDraft((current) => ({ ...EMPTY_DRAFT, walletId: current.walletId }));
    await onPrepared();
  }, [draft, onPrepared, t]);

  const summaryRows = useMemo(() => buildSummaryRows(t, draft, wallets), [t, draft, wallets]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("DashboardHeliusRings.composer.title")}</CardTitle>
        <CardDescription>{t("DashboardHeliusRings.composer.description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* The only thing this card says about an operation it started: that it
            exists and where to watch it. */}
        {started && phase.name === "compose" ? (
          <Callout live variant="success">
            {t("DashboardHeliusRings.composer.started")}
          </Callout>
        ) : null}
        {phase.name === "compose" ? (
          <ComposeStep
            draft={draft}
            wallets={wallets}
            onPatch={patchDraft}
            onReview={() => setPhase({ name: "review", error: null })}
          />
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
  wallets,
  onPatch,
  onReview,
}: {
  draft: ComposerDraft;
  wallets: RingsWallet[];
  onPatch: (patch: Partial<ComposerDraft>) => void;
  onReview: () => void;
}) {
  const t = useTranslations();
  // Only a `ready` wallet has a shielded identity to deposit into; the rest are
  // omitted rather than shown disabled, since nothing here would provision one.
  const readyWallets = wallets.filter((wallet) => wallet.status === "ready");

  return (
    <>
      <div className="flex flex-wrap gap-3">
        <Field label={t("DashboardHeliusRings.composer.wallet")}>
          <Select
            ariaLabel={t("DashboardHeliusRings.composer.wallet")}
            value={draft.walletId}
            onValueChange={(walletId) => onPatch({ walletId })}
            placeholder={t("DashboardHeliusRings.composer.walletPlaceholder")}
          >
            {readyWallets.map((wallet) => (
              <SelectItem key={wallet.id} value={wallet.id}>
                {wallet.name}
              </SelectItem>
            ))}
          </Select>
        </Field>
        <Field label={t("DashboardHeliusRings.composer.operation")}>
          <Select
            ariaLabel={t("DashboardHeliusRings.composer.operation")}
            value={draft.opType}
            onValueChange={(value) => {
              if (value) onPatch({ opType: value as RingsOpType });
            }}
          >
            {OP_TYPES.map((type) => (
              <SelectItem key={type} value={type}>
                {t(`DashboardHeliusRings.activity.opType_${type}`)}
              </SelectItem>
            ))}
          </Select>
        </Field>
      </div>

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
            // Digits + at most one dot. Rejects letters and stray punctuation
            // client-side; parseDecimalToBaseUnits enforces per-mint precision.
            onChange={(event) =>
              onPatch({ amountDecimal: event.target.value.replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1") })
            }
          />
        </Field>
      </div>

      {draft.opType === "withdraw" ? (
        <Field label={t("DashboardHeliusRings.composer.recipient")}>
          <Input
            value={draft.recipient}
            placeholder={t("DashboardHeliusRings.composer.recipientPlaceholder")}
            onChange={(event) => onPatch({ recipient: event.target.value })}
          />
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
