"use client";

import { useCallback, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectItem } from "@/components/ui/select";
import { useTranslations } from "@/i18n/provider";
import {
  prepareRingsOperation,
  RINGS_ALLOWLISTED_ASSETS,
  type RingsOperationDetail,
  type RingsOpType,
  type RingsWallet,
  type RingsZone,
} from "./helius-rings.data";
import { useRingsZones } from "./use-rings-zones";

type Translate = ReturnType<typeof useTranslations>;

const OP_TYPES: RingsOpType[] = [
  "shield",
  "transfer_registered",
  "transfer_anonymous",
  "withdraw",
  "merge",
  "timelock_create",
];

const NEEDS_ASSET: ReadonlySet<RingsOpType> = new Set([
  "shield",
  "transfer_registered",
  "transfer_anonymous",
  "withdraw",
]);
const NEEDS_RECIPIENT: ReadonlySet<RingsOpType> = new Set([
  "transfer_registered",
  "transfer_anonymous",
  "withdraw",
]);

/**
 * Where the wizard is, and the only data valid at that point. A union rather
 * than parallel `step`/`result`/`error` values so "showing a result with no
 * operation" is not representable.
 */
type Phase =
  | { name: "compose" }
  | { name: "review"; error: string | null }
  | { name: "result"; operation: RingsOperationDetail };

/** Everything the compose form has collected. */
interface ComposerDraft {
  walletId: string | null;
  opType: RingsOpType;
  assetMint: string;
  amountRaw: string;
  recipient: string;
  zoneId: string | null;
  unlockAt: string;
  beneficiary: string;
}

const EMPTY_DRAFT: ComposerDraft = {
  walletId: null,
  opType: "shield",
  assetMint: RINGS_ALLOWLISTED_ASSETS[0].mint,
  amountRaw: "",
  recipient: "",
  zoneId: null,
  unlockAt: "",
  beneficiary: "",
};

function transferModeFor(opType: RingsOpType): "registered" | "anonymous" | undefined {
  if (opType === "transfer_registered") return "registered";
  if (opType === "transfer_anonymous") return "anonymous";
  return undefined;
}

function isDraftComplete(draft: ComposerDraft): boolean {
  if (draft.walletId === null) return false;
  if (NEEDS_ASSET.has(draft.opType) && !/^\d+$/.test(draft.amountRaw)) return false;
  if (NEEDS_RECIPIENT.has(draft.opType) && draft.recipient.trim().length === 0) return false;
  if (
    draft.opType === "timelock_create" &&
    (draft.unlockAt.length === 0 || draft.beneficiary.trim().length === 0)
  ) {
    return false;
  }
  return true;
}

function buildSummaryRows(
  t: Translate,
  draft: ComposerDraft,
  wallets: RingsWallet[],
  zones: RingsZone[]
): Array<[string, string]> {
  const asset = RINGS_ALLOWLISTED_ASSETS.find((entry) => entry.mint === draft.assetMint);
  const rows: Array<[string, string]> = [
    [
      t("DashboardHeliusRings.composer.summaryWallet"),
      wallets.find((wallet) => wallet.id === draft.walletId)?.name ?? "—",
    ],
    [
      t("DashboardHeliusRings.composer.summaryOperation"),
      t(`DashboardHeliusRings.activity.opType_${draft.opType}`),
    ],
  ];
  if (NEEDS_ASSET.has(draft.opType)) {
    rows.push([
      t("DashboardHeliusRings.composer.summaryAmount"),
      `${draft.amountRaw} (${asset?.symbol ?? "?"} ${t("DashboardHeliusRings.composer.baseUnits")})`,
    ]);
  }
  if (NEEDS_RECIPIENT.has(draft.opType)) {
    rows.push([t("DashboardHeliusRings.composer.summaryRecipient"), draft.recipient]);
  }
  if (draft.opType === "merge" && draft.zoneId) {
    rows.push([
      t("DashboardHeliusRings.composer.summaryZone"),
      zones.find((zone) => zone.id === draft.zoneId)?.name ?? draft.zoneId,
    ]);
  }
  if (draft.opType === "timelock_create") {
    rows.push([t("DashboardHeliusRings.composer.summaryUnlockAt"), draft.unlockAt]);
    rows.push([t("DashboardHeliusRings.composer.summaryBeneficiary"), draft.beneficiary]);
  }
  return rows;
}

/**
 * One composer for every shielded operation kind. A `review` step sits between
 * the form and the POST; anonymous transfers additionally require an explicit
 * acknowledgement on that step before Confirm unlocks.
 */
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
  const [anonymousAcknowledged, setAnonymousAcknowledged] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const { zones } = useRingsZones(draft.walletId, t("DashboardHeliusRings.errors.loadFailed"));

  const patchDraft = useCallback((patch: Partial<ComposerDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
  }, []);

  const reset = useCallback(() => {
    setPhase({ name: "compose" });
    setDraft((current) => ({ ...EMPTY_DRAFT, walletId: current.walletId }));
    setAnonymousAcknowledged(false);
  }, []);

  const handleConfirm = useCallback(async () => {
    if (!draft.walletId) return;
    setSubmitting(true);
    setPhase({ name: "review", error: null });
    const asset = RINGS_ALLOWLISTED_ASSETS.find((entry) => entry.mint === draft.assetMint);
    let prepared: Awaited<ReturnType<typeof prepareRingsOperation>>;
    try {
      prepared = await prepareRingsOperation({
        walletId: draft.walletId,
        opType: draft.opType,
        asset:
          NEEDS_ASSET.has(draft.opType) && asset
            ? { mint: asset.mint, amountRaw: draft.amountRaw }
            : undefined,
        to: NEEDS_RECIPIENT.has(draft.opType) ? draft.recipient.trim() : undefined,
        zoneId: draft.opType === "merge" && draft.zoneId ? draft.zoneId : undefined,
        transferMode: transferModeFor(draft.opType),
        timelock:
          draft.opType === "timelock_create"
            ? {
                unlockAt: new Date(draft.unlockAt).toISOString(),
                beneficiary: draft.beneficiary.trim(),
              }
            : undefined,
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
    setPhase({ name: "result", operation: prepared.operation });
    await onPrepared();
  }, [draft, onPrepared, t]);

  const summaryRows = useMemo(
    () => buildSummaryRows(t, draft, wallets, zones),
    [t, draft, wallets, zones]
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("DashboardHeliusRings.composer.title")}</CardTitle>
        <CardDescription>{t("DashboardHeliusRings.composer.description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {phase.name === "compose" ? (
          <ComposeStep
            draft={draft}
            wallets={wallets}
            zones={zones}
            onPatch={patchDraft}
            onReview={() => setPhase({ name: "review", error: null })}
          />
        ) : null}
        {phase.name === "review" ? (
          <ReviewStep
            rows={summaryRows}
            isAnonymous={draft.opType === "transfer_anonymous"}
            acknowledged={anonymousAcknowledged}
            onAcknowledge={setAnonymousAcknowledged}
            gatewayRed={gatewayRed}
            error={phase.error}
            submitting={submitting}
            onBack={() => setPhase({ name: "compose" })}
            onConfirm={() => void handleConfirm()}
          />
        ) : null}
        {phase.name === "result" ? <ResultStep result={phase.operation} onReset={reset} /> : null}
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
  zones,
  onPatch,
  onReview,
}: {
  draft: ComposerDraft;
  wallets: RingsWallet[];
  zones: RingsZone[];
  onPatch: (patch: Partial<ComposerDraft>) => void;
  onReview: () => void;
}) {
  const t = useTranslations();
  const needsAsset = NEEDS_ASSET.has(draft.opType);
  const needsRecipient = NEEDS_RECIPIENT.has(draft.opType);

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
            {wallets.map((wallet) => (
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

      {needsAsset ? (
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
              inputMode="numeric"
              value={draft.amountRaw}
              placeholder="1000000"
              onChange={(event) => onPatch({ amountRaw: event.target.value.replace(/\D/g, "") })}
            />
          </Field>
        </div>
      ) : null}

      {needsRecipient ? (
        <Field
          label={
            draft.opType === "transfer_anonymous"
              ? t("DashboardHeliusRings.composer.recipientAnonymous")
              : t("DashboardHeliusRings.composer.recipient")
          }
        >
          <Input
            value={draft.recipient}
            placeholder={t("DashboardHeliusRings.composer.recipientPlaceholder")}
            onChange={(event) => onPatch({ recipient: event.target.value })}
          />
        </Field>
      ) : null}

      {draft.opType === "merge" && zones.length > 0 ? (
        <Field label={t("DashboardHeliusRings.composer.zone")}>
          <Select
            ariaLabel={t("DashboardHeliusRings.composer.zone")}
            value={draft.zoneId}
            onValueChange={(zoneId) => onPatch({ zoneId })}
            placeholder={t("DashboardHeliusRings.composer.zonePlaceholder")}
          >
            {zones.map((zone) => (
              <SelectItem key={zone.id} value={zone.id}>
                {zone.name}
              </SelectItem>
            ))}
          </Select>
        </Field>
      ) : null}

      {draft.opType === "timelock_create" ? (
        <div className="flex flex-wrap gap-3">
          <Field label={t("DashboardHeliusRings.composer.unlockAt")}>
            <Input
              type="datetime-local"
              value={draft.unlockAt}
              onChange={(event) => onPatch({ unlockAt: event.target.value })}
            />
          </Field>
          <Field label={t("DashboardHeliusRings.composer.beneficiary")}>
            <Input
              value={draft.beneficiary}
              placeholder={t("DashboardHeliusRings.composer.recipientPlaceholder")}
              onChange={(event) => onPatch({ beneficiary: event.target.value })}
            />
          </Field>
        </div>
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
  isAnonymous,
  acknowledged,
  onAcknowledge,
  gatewayRed,
  error,
  submitting,
  onBack,
  onConfirm,
}: {
  rows: Array<[string, string]>;
  isAnonymous: boolean;
  acknowledged: boolean;
  onAcknowledge: (acknowledged: boolean) => void;
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

      {isAnonymous ? (
        <Callout variant="warning">
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={acknowledged}
              onChange={(event) => onAcknowledge(event.target.checked)}
            />
            <span>{t("DashboardHeliusRings.composer.anonymousWarning")}</span>
          </label>
        </Callout>
      ) : null}

      {error ? <Callout variant="danger">{error}</Callout> : null}

      <div className="flex gap-2">
        <Button variant="secondary" onClick={onBack}>
          {t("DashboardHeliusRings.composer.back")}
        </Button>
        <Button disabled={submitting || (isAnonymous && !acknowledged)} onClick={onConfirm}>
          {submitting
            ? t("DashboardHeliusRings.composer.preparing")
            : t("DashboardHeliusRings.composer.confirm")}
        </Button>
      </div>
    </>
  );
}

function ResultStep({ result, onReset }: { result: RingsOperationDetail; onReset: () => void }) {
  const t = useTranslations();
  return (
    <>
      <div className="flex items-center gap-2">
        <Badge variant={result.state === "failed" ? "danger" : "default"}>
          {t(`DashboardHeliusRings.activity.state_${result.state}`)}
        </Badge>
        {result.failure ? (
          <span className="text-sm text-secondary">
            {result.failure.code === "gateway_unavailable"
              ? t("DashboardHeliusRings.errors.gatewayUnavailable")
              : result.failure.message}
          </span>
        ) : null}
      </div>
      <div>
        <Button variant="secondary" onClick={onReset}>
          {t("DashboardHeliusRings.composer.newOperation")}
        </Button>
      </div>
    </>
  );
}
