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

type Step = "compose" | "review" | "result";

/**
 * One composer for every shielded operation kind. A `review` step sits between
 * the form and the POST; anonymous transfers additionally require an explicit
 * acknowledgement on that step before Confirm unlocks.
 */
export function OperationComposer({
  wallets,
  zones,
  onPrepared,
}: {
  wallets: RingsWallet[];
  zones: RingsZone[];
  onPrepared: () => Promise<void>;
}) {
  const t = useTranslations();

  const [step, setStep] = useState<Step>("compose");
  const [walletId, setWalletId] = useState<string | null>(null);
  const [opType, setOpType] = useState<RingsOpType>("shield");
  const [assetMint, setAssetMint] = useState<string>(RINGS_ALLOWLISTED_ASSETS[0].mint);
  const [amountRaw, setAmountRaw] = useState("");
  const [recipient, setRecipient] = useState("");
  const [zoneId, setZoneId] = useState<string | null>(null);
  const [unlockAt, setUnlockAt] = useState("");
  const [beneficiary, setBeneficiary] = useState("");
  const [anonymousAcknowledged, setAnonymousAcknowledged] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<RingsOperationDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const needsAsset = NEEDS_ASSET.has(opType);
  const needsRecipient = NEEDS_RECIPIENT.has(opType);
  const isTimelock = opType === "timelock_create";
  const isAnonymous = opType === "transfer_anonymous";
  const isMerge = opType === "merge";

  const asset = useMemo(
    () => RINGS_ALLOWLISTED_ASSETS.find((entry) => entry.mint === assetMint),
    [assetMint]
  );

  const composeComplete =
    walletId !== null &&
    (!needsAsset || /^\d+$/.test(amountRaw)) &&
    (!needsRecipient || recipient.trim().length > 0) &&
    (!isTimelock || (unlockAt.length > 0 && beneficiary.trim().length > 0));

  const reset = useCallback(() => {
    setStep("compose");
    setAmountRaw("");
    setRecipient("");
    setUnlockAt("");
    setBeneficiary("");
    setZoneId(null);
    setAnonymousAcknowledged(false);
    setResult(null);
    setError(null);
  }, []);

  const handleConfirm = useCallback(async () => {
    if (!walletId) return;
    setSubmitting(true);
    setError(null);
    const prepared = await prepareRingsOperation({
      walletId,
      opType,
      asset: needsAsset && asset ? { mint: asset.mint, amountRaw } : undefined,
      to: needsRecipient ? recipient.trim() : undefined,
      zoneId: isMerge && zoneId ? zoneId : undefined,
      transferMode: isAnonymous
        ? "anonymous"
        : opType === "transfer_registered"
          ? "registered"
          : undefined,
      timelock: isTimelock
        ? { unlockAt: new Date(unlockAt).toISOString(), beneficiary: beneficiary.trim() }
        : undefined,
    });
    setSubmitting(false);
    if (prepared.error || !prepared.operation) {
      setError(prepared.error ?? t("DashboardHeliusRings.composer.prepareFailed"));
      return;
    }
    setResult(prepared.operation);
    setStep("result");
    await onPrepared();
  }, [
    walletId,
    opType,
    needsAsset,
    asset,
    amountRaw,
    needsRecipient,
    recipient,
    isMerge,
    zoneId,
    isAnonymous,
    isTimelock,
    unlockAt,
    beneficiary,
    onPrepared,
    t,
  ]);

  const summaryRows: Array<[string, string]> = [
    [
      t("DashboardHeliusRings.composer.summaryWallet"),
      wallets.find((wallet) => wallet.id === walletId)?.name ?? "—",
    ],
    [
      t("DashboardHeliusRings.composer.summaryOperation"),
      t(`DashboardHeliusRings.activity.opType_${opType}`),
    ],
    ...(needsAsset
      ? ([
          [
            t("DashboardHeliusRings.composer.summaryAmount"),
            `${amountRaw} (${asset?.symbol ?? "?"} ${t("DashboardHeliusRings.composer.baseUnits")})`,
          ],
        ] as Array<[string, string]>)
      : []),
    ...(needsRecipient
      ? ([[t("DashboardHeliusRings.composer.summaryRecipient"), recipient]] as Array<
          [string, string]
        >)
      : []),
    ...(isMerge && zoneId
      ? ([
          [
            t("DashboardHeliusRings.composer.summaryZone"),
            zones.find((zone) => zone.id === zoneId)?.name ?? zoneId,
          ],
        ] as Array<[string, string]>)
      : []),
    ...(isTimelock
      ? ([
          [t("DashboardHeliusRings.composer.summaryUnlockAt"), unlockAt],
          [t("DashboardHeliusRings.composer.summaryBeneficiary"), beneficiary],
        ] as Array<[string, string]>)
      : []),
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("DashboardHeliusRings.composer.title")}</CardTitle>
        <CardDescription>{t("DashboardHeliusRings.composer.description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {step === "compose" ? (
          <>
            <div className="flex flex-wrap gap-3">
              <div className="flex min-w-52 flex-col gap-1.5">
                <span className="text-sm font-medium text-primary">
                  {t("DashboardHeliusRings.composer.wallet")}
                </span>
                <Select
                  ariaLabel={t("DashboardHeliusRings.composer.wallet")}
                  value={walletId}
                  onValueChange={setWalletId}
                  placeholder={t("DashboardHeliusRings.composer.walletPlaceholder")}
                >
                  {wallets.map((wallet) => (
                    <SelectItem key={wallet.id} value={wallet.id}>
                      {wallet.name}
                    </SelectItem>
                  ))}
                </Select>
              </div>
              <div className="flex min-w-52 flex-col gap-1.5">
                <span className="text-sm font-medium text-primary">
                  {t("DashboardHeliusRings.composer.operation")}
                </span>
                <Select
                  ariaLabel={t("DashboardHeliusRings.composer.operation")}
                  value={opType}
                  onValueChange={(value) => {
                    if (value) setOpType(value as RingsOpType);
                  }}
                >
                  {OP_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {t(`DashboardHeliusRings.activity.opType_${type}`)}
                    </SelectItem>
                  ))}
                </Select>
              </div>
            </div>

            {needsAsset ? (
              <div className="flex flex-wrap gap-3">
                <div className="flex min-w-40 flex-col gap-1.5">
                  <span className="text-sm font-medium text-primary">
                    {t("DashboardHeliusRings.composer.asset")}
                  </span>
                  <Select
                    ariaLabel={t("DashboardHeliusRings.composer.asset")}
                    value={assetMint}
                    onValueChange={(value) => {
                      if (value) setAssetMint(value);
                    }}
                  >
                    {RINGS_ALLOWLISTED_ASSETS.map((entry) => (
                      <SelectItem key={entry.mint} value={entry.mint}>
                        {entry.symbol}
                      </SelectItem>
                    ))}
                  </Select>
                </div>
                <div className="flex min-w-48 flex-col gap-1.5">
                  <span className="text-sm font-medium text-primary">
                    {t("DashboardHeliusRings.composer.amount")}
                  </span>
                  <Input
                    inputMode="numeric"
                    value={amountRaw}
                    placeholder="1000000"
                    onChange={(event) => setAmountRaw(event.target.value.replace(/\D/g, ""))}
                  />
                </div>
              </div>
            ) : null}

            {needsRecipient ? (
              <div className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-primary">
                  {isAnonymous
                    ? t("DashboardHeliusRings.composer.recipientAnonymous")
                    : t("DashboardHeliusRings.composer.recipient")}
                </span>
                <Input
                  value={recipient}
                  placeholder={t("DashboardHeliusRings.composer.recipientPlaceholder")}
                  onChange={(event) => setRecipient(event.target.value)}
                />
              </div>
            ) : null}

            {isMerge && zones.length > 0 ? (
              <div className="flex min-w-52 flex-col gap-1.5">
                <span className="text-sm font-medium text-primary">
                  {t("DashboardHeliusRings.composer.zone")}
                </span>
                <Select
                  ariaLabel={t("DashboardHeliusRings.composer.zone")}
                  value={zoneId}
                  onValueChange={setZoneId}
                  placeholder={t("DashboardHeliusRings.composer.zonePlaceholder")}
                >
                  {zones.map((zone) => (
                    <SelectItem key={zone.id} value={zone.id}>
                      {zone.name}
                    </SelectItem>
                  ))}
                </Select>
              </div>
            ) : null}

            {isTimelock ? (
              <div className="flex flex-wrap gap-3">
                <div className="flex min-w-52 flex-col gap-1.5">
                  <span className="text-sm font-medium text-primary">
                    {t("DashboardHeliusRings.composer.unlockAt")}
                  </span>
                  <Input
                    type="datetime-local"
                    value={unlockAt}
                    onChange={(event) => setUnlockAt(event.target.value)}
                  />
                </div>
                <div className="flex min-w-52 flex-col gap-1.5">
                  <span className="text-sm font-medium text-primary">
                    {t("DashboardHeliusRings.composer.beneficiary")}
                  </span>
                  <Input
                    value={beneficiary}
                    placeholder={t("DashboardHeliusRings.composer.recipientPlaceholder")}
                    onChange={(event) => setBeneficiary(event.target.value)}
                  />
                </div>
              </div>
            ) : null}

            <div>
              <Button disabled={!composeComplete} onClick={() => setStep("review")}>
                {t("DashboardHeliusRings.composer.review")}
              </Button>
            </div>
          </>
        ) : null}

        {step === "review" ? (
          <>
            <dl className="flex flex-col gap-2">
              {summaryRows.map(([label, value]) => (
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
                    checked={anonymousAcknowledged}
                    onChange={(event) => setAnonymousAcknowledged(event.target.checked)}
                  />
                  <span>{t("DashboardHeliusRings.composer.anonymousWarning")}</span>
                </label>
              </Callout>
            ) : null}

            {error ? <Callout variant="danger">{error}</Callout> : null}

            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setStep("compose")}>
                {t("DashboardHeliusRings.composer.back")}
              </Button>
              <Button
                disabled={submitting || (isAnonymous && !anonymousAcknowledged)}
                onClick={() => void handleConfirm()}
              >
                {submitting
                  ? t("DashboardHeliusRings.composer.preparing")
                  : t("DashboardHeliusRings.composer.confirm")}
              </Button>
            </div>
          </>
        ) : null}

        {step === "result" && result ? (
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
              <Button variant="secondary" onClick={reset}>
                {t("DashboardHeliusRings.composer.newOperation")}
              </Button>
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
