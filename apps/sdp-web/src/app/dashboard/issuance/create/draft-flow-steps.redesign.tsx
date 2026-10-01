"use client";

import type { PaymentsDashboardWallet } from "@sdp/types";
import { BoxIcon, InfoIcon, LandmarkIcon, type LucideIcon, TriangleAlertIcon } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useState } from "react";
import { RecordLine } from "@/components/refresh-record";
import { Button } from "@/components/ui/button";
import { InfoHint } from "@/components/ui/info-hint";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectItem } from "@/components/ui/select";
import { StatusText } from "@/components/ui/status-text";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import { IssuanceCheckRow } from "../issuance-checkbox.redesign";
import { type AuthorityKey, type DraftState, isDraftAuthorityInUse } from "./draft-model";
import type { DraftAccess } from "./local-drafts.redesign";

export type { DraftAccess };

/** The flow's draft: the saved draft's fields, and the access list as the design picks it. */
export interface FlowDraft {
  draft: DraftState;
  access: DraftAccess;
}

export type UpdateDraft = (changes: Partial<DraftState>) => void;

const CLASSES: {
  key: DraftState["assetClass"];
  icon: LucideIcon;
  name: MessageKey;
  why: MessageKey;
}[] = [
  {
    key: "stablecoin",
    icon: LandmarkIcon,
    name: "DashboardIssuance.newDesign.classification.stablecoin",
    why: "DashboardIssuance.newDesign.classification.stablecoinWhy",
  },
  {
    key: "digital-asset",
    icon: BoxIcon,
    name: "DashboardIssuance.newDesign.classification.digitalToken",
    why: "DashboardIssuance.newDesign.classification.digitalTokenWhy",
  },
];

export const CLASS_LABEL: Record<DraftState["assetClass"], MessageKey> = {
  stablecoin: "DashboardIssuance.newDesign.classification.stablecoin",
  "digital-asset": "DashboardIssuance.newDesign.classification.digitalToken",
};

const CURRENCIES = ["USD", "EUR", "GBP"] as const;
const NO_CURRENCY = "none";
const NUMERIC = "numeric";
const ACCESS_ALLOWLIST: DraftAccess = "allowlist";

const AUTHORITIES: { key: AuthorityKey; name: MessageKey; why: MessageKey }[] = [
  {
    key: "mint-authority",
    name: "DashboardIssuance.newDesign.permissions.mint",
    why: "DashboardIssuance.newDesign.draft.mintAuthorityWhy",
  },
  {
    key: "freeze-authority",
    name: "DashboardIssuance.newDesign.permissions.freeze",
    why: "DashboardIssuance.newDesign.draft.freezeAuthorityWhy",
  },
  {
    key: "metadata-authority",
    name: "DashboardIssuance.newDesign.permissions.metadata",
    why: "DashboardIssuance.newDesign.draft.metadataAuthorityWhy",
  },
  {
    key: "permanent-delegate",
    name: "DashboardIssuance.newDesign.permissions.delegate",
    why: "DashboardIssuance.newDesign.draft.delegateAuthorityWhy",
  },
];

/** A labelled field as the flow draws one: 13px label, the control, an optional hint. */
function Field({
  id,
  label,
  help,
  hint,
  children,
}: {
  id?: string;
  label: string;
  help?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="flex items-center gap-1">
        <Label htmlFor={id} className="text-meta font-normal text-secondary">
          {label}
        </Label>
        {help ? <InfoHint text={help} /> : null}
      </span>
      {children}
      {hint ? <p className="text-body text-secondary">{hint}</p> : null}
    </div>
  );
}

/** Step 1: the token's name and what it is. */
export function ClassifyStep({ draft, update }: { draft: DraftState; update: UpdateDraft }) {
  const t = useTranslations();
  const [explain, setExplain] = useState(false);
  return (
    <div className="flex flex-col gap-6">
      <Field id="draft-name" label={t("DashboardIssuance.newDesign.details.name")}>
        <Input
          id="draft-name"
          size="xl"
          autoComplete="off"
          maxLength={100}
          placeholder={t("DashboardIssuance.newDesign.draft.namePlaceholder")}
          value={draft.name}
          onChange={(event) => update({ name: event.currentTarget.value })}
        />
      </Field>
      <div className="flex flex-col gap-4 pt-10">
        <div className="flex flex-wrap items-baseline justify-between gap-4">
          <h3 className="text-subheading font-medium text-primary">
            {t("DashboardIssuance.newDesign.draft.chooseClassification")}
          </h3>
          <Button
            variant="outline"
            size="sm"
            aria-expanded={explain}
            onClick={() => setExplain((open) => !open)}
          >
            {explain
              ? t("DashboardIssuance.newDesign.draft.hideExplanation")
              : t("DashboardIssuance.newDesign.draft.notSure")}
          </Button>
        </div>
        {explain ? (
          <div className="flex flex-col gap-2 rounded-card border border-border-subtle p-4 text-body text-primary">
            <p>
              <span className="font-medium">
                {t("DashboardIssuance.newDesign.draft.explainStablecoinLead")}
              </span>{" "}
              {t("DashboardIssuance.newDesign.draft.explainStablecoin")}
            </p>
            <p>
              <span className="font-medium">
                {t("DashboardIssuance.newDesign.draft.explainDigitalLead")}
              </span>{" "}
              {t("DashboardIssuance.newDesign.draft.explainDigital")}
            </p>
          </div>
        ) : null}
        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">
            {t("DashboardIssuance.newDesign.draft.chooseClassification")}
          </legend>
          {CLASSES.map((entry) => {
            const Icon = entry.icon;
            const selected = draft.assetClass === entry.key;
            return (
              <label
                key={entry.key}
                data-draft-class={entry.key}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-card border p-3 hover:bg-fill-subtle has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-primary",
                  selected ? "border-primary" : "border-border-default"
                )}
              >
                <input
                  type="radio"
                  name="draft-classification"
                  className="sr-only"
                  checked={selected}
                  onChange={() =>
                    update({
                      assetClass: entry.key,
                      // A stablecoin is six decimals; any other token starts at nine.
                      decimals: entry.key === "stablecoin" ? "6" : "9",
                    })
                  }
                />
                <Icon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-tertiary" />
                <span className="flex min-w-0 flex-col">
                  <span className="text-body font-medium text-primary">{t(entry.name)}</span>
                  <span className="text-meta text-secondary">{t(entry.why)}</span>
                </span>
              </label>
            );
          })}
        </fieldset>
      </div>
    </div>
  );
}

/** Step 2: the terms locked with the mint, then the issuer. */
export function DetailsStep({ draft, update }: { draft: DraftState; update: UpdateDraft }) {
  const t = useTranslations();
  const stablecoin = draft.assetClass === "stablecoin";
  const locked = t("DashboardIssuance.newDesign.draft.lockedAtDeploy");
  return (
    <div className="flex flex-col gap-6">
      <h3 className="text-subheading font-medium text-primary">
        {t("DashboardIssuance.newDesign.details.about")}
      </h3>
      <div className="grid gap-6 @xl:grid-cols-2">
        <Field
          id="draft-symbol"
          label={t("DashboardIssuance.newDesign.details.symbol")}
          hint={locked}
        >
          <Input
            id="draft-symbol"
            size="xl"
            autoComplete="off"
            maxLength={10}
            placeholder={t("DashboardIssuance.newDesign.draft.symbolPlaceholder")}
            value={draft.symbol}
            onChange={(event) => update({ symbol: event.currentTarget.value })}
          />
        </Field>
        <Field
          id="draft-decimals"
          label={t("DashboardIssuance.newDesign.details.decimals")}
          hint={stablecoin ? t("DashboardIssuance.newDesign.draft.stablecoinDecimals") : locked}
        >
          <Input
            id="draft-decimals"
            size="xl"
            autoComplete="off"
            inputMode={NUMERIC}
            disabled={stablecoin}
            value={draft.decimals}
            onChange={(event) => update({ decimals: event.currentTarget.value })}
          />
        </Field>
      </div>
      <Field id="draft-description" label={t("DashboardIssuance.newDesign.details.description")}>
        <Input
          id="draft-description"
          size="xl"
          autoComplete="off"
          maxLength={500}
          placeholder={t("DashboardIssuance.newDesign.draft.descriptionPlaceholder")}
          value={draft.description}
          onChange={(event) => update({ description: event.currentTarget.value })}
        />
      </Field>
      <Field
        id="draft-cap"
        label={t("DashboardIssuance.newDesign.details.maximumSupply")}
        help={t("DashboardIssuance.newDesign.draft.capHelp")}
      >
        <Input
          id="draft-cap"
          size="xl"
          autoComplete="off"
          inputMode={NUMERIC}
          placeholder={t("DashboardIssuance.newDesign.overview.noCap")}
          value={draft.maxSupply}
          onChange={(event) =>
            update({ maxSupply: event.currentTarget.value.replace(/[\s,]/g, "") })
          }
        />
      </Field>
      <h3 className="mt-10 text-subheading font-medium text-primary">
        {t("DashboardIssuance.newDesign.details.financial")}
      </h3>
      <div className="grid gap-6 @xl:grid-cols-2">
        <Field
          id="draft-issuer"
          label={t("DashboardIssuance.newDesign.details.issuerName")}
          help={t("DashboardIssuance.newDesign.draft.issuerHelp")}
        >
          <Input
            id="draft-issuer"
            size="xl"
            autoComplete="organization"
            maxLength={200}
            placeholder={t("DashboardIssuance.newDesign.draft.issuerPlaceholder")}
            value={draft.issuerName ?? ""}
            onChange={(event) => update({ issuerName: event.currentTarget.value })}
          />
        </Field>
        <Field label={t("DashboardIssuance.newDesign.details.currency")}>
          <Select
            ariaLabel={t("DashboardIssuance.newDesign.details.currency")}
            placeholder={t("DashboardIssuance.newDesign.draft.selectCurrency")}
            value={draft.pegCurrency ?? ""}
            onValueChange={(value) =>
              update({
                pegCurrency: CURRENCIES.find((currency) => currency === value) ?? undefined,
              })
            }
          >
            {CURRENCIES.map((currency) => (
              <SelectItem key={currency} value={currency}>
                {t(`DashboardIssuance.newDesign.draft.currency${currency}`)}
              </SelectItem>
            ))}
            <SelectItem value={NO_CURRENCY}>
              {t("DashboardIssuance.newDesign.details.noCurrency")}
            </SelectItem>
          </Select>
        </Field>
      </div>
    </div>
  );
}

/** Step 3: what the token can do. A stablecoin's controls come fixed with its template. */
export function ControlsStep({
  draft,
  access,
  update,
  onAccess,
}: {
  draft: DraftState;
  access: DraftAccess;
  update: UpdateDraft;
  onAccess: (access: DraftAccess) => void;
}) {
  const t = useTranslations();
  const stablecoin = draft.assetClass === "stablecoin";
  const alwaysOn = (
    <StatusText tone="neutral" className="text-body">
      {t("DashboardIssuance.newDesign.draft.alwaysOn")}
    </StatusText>
  );
  const controls: {
    key: string;
    name: MessageKey;
    why: MessageKey;
    on: boolean;
    locked: boolean;
    set?: (on: boolean) => void;
  }[] = [
    {
      key: "freeze",
      name: "DashboardIssuance.newDesign.permissions.freezable",
      why: "DashboardIssuance.newDesign.draft.freezableWhy",
      on: stablecoin || draft.freezeAccounts === true,
      locked: stablecoin,
      set: (on) => update({ freezeAccounts: on }),
    },
    {
      key: "pause",
      name: "DashboardIssuance.newDesign.permissions.pausable",
      why: "DashboardIssuance.newDesign.draft.pausableWhy",
      on: stablecoin || draft.pauseTransfers,
      locked: stablecoin,
      set: (on) => update({ pauseTransfers: on }),
    },
    {
      key: "delegate",
      name: "DashboardIssuance.newDesign.permissions.delegate",
      why: "DashboardIssuance.newDesign.draft.delegateWhy",
      on: stablecoin || draft.permanentDelegate === true,
      locked: stablecoin,
      set: (on) => update({ permanentDelegate: on }),
    },
    {
      key: "access",
      name: "DashboardIssuance.newDesign.draft.accessList",
      why: stablecoin
        ? "DashboardIssuance.newDesign.draft.accessWhyStablecoin"
        : "DashboardIssuance.newDesign.draft.accessWhyToken",
      on: access !== "off",
      // A stablecoin always keeps a list: blocklist or allowlist, never none.
      locked: stablecoin,
      set: (on) => onAccess(on ? ACCESS_ALLOWLIST : "off"),
    },
    {
      key: "mintable",
      name: "DashboardIssuance.newDesign.permissions.mintable",
      why: "DashboardIssuance.newDesign.draft.mintableWhy",
      on: true,
      locked: true,
    },
  ];
  const accessOptions: { value: DraftAccess; label: MessageKey }[] = stablecoin
    ? [
        { value: "blocklist", label: "DashboardIssuance.newDesign.draft.accessBlocklist" },
        { value: "allowlist", label: "DashboardIssuance.newDesign.draft.accessAllowlist" },
      ]
    : [
        { value: "allowlist", label: "DashboardIssuance.newDesign.draft.accessAllowlist" },
        { value: "off", label: "DashboardIssuance.newDesign.draft.accessOff" },
      ];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col">
        {controls.map((control) => (
          <IssuanceCheckRow
            key={control.key}
            checked={control.on}
            disabled={control.locked}
            onChange={control.set}
            aside={control.locked ? alwaysOn : undefined}
          >
            <span className="text-body font-medium text-primary">{t(control.name)}</span>
            <span className="text-meta text-secondary">{t(control.why)}</span>
          </IssuanceCheckRow>
        ))}
      </div>
      {stablecoin ? (
        <p className="flex max-w-[40em] items-start gap-2 text-meta text-secondary">
          <InfoIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          {t("DashboardIssuance.newDesign.draft.stablecoinControls")}
        </p>
      ) : null}
      <Field label={t("DashboardIssuance.newDesign.draft.accessList")}>
        <Select
          ariaLabel={t("DashboardIssuance.newDesign.draft.accessList")}
          value={access}
          onValueChange={(value) => {
            const next = accessOptions.find((option) => option.value === value)?.value;
            if (next) onAccess(next);
          }}
        >
          {accessOptions.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {t(option.label)}
            </SelectItem>
          ))}
        </Select>
      </Field>
    </div>
  );
}

/** Step 4: the project's wallet that holds each of the token's keys. */
export function PermissionsStep({
  draft,
  wallets,
  walletsError,
  update,
}: {
  draft: DraftState;
  wallets: readonly PaymentsDashboardWallet[];
  walletsError: string | null;
  update: UpdateDraft;
}) {
  const t = useTranslations();
  if (walletsError || wallets.length === 0) {
    return (
      <div className="flex flex-col items-start gap-4">
        <p className="max-w-[40em] text-body text-secondary">
          {walletsError ?? t("DashboardIssuance.newDesign.draft.noWallets")}
        </p>
        {walletsError ? null : (
          <Button asChild variant="outline" size="sm">
            <Link href="/dashboard/wallets/setup">
              {t("DashboardIssuance.newDesign.draft.createWallet")}
            </Link>
          </Button>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-6 @xl:grid-cols-2">
        {AUTHORITIES.filter((authority) => isDraftAuthorityInUse(draft, authority.key)).map(
          (authority) => (
            <Field key={authority.key} label={t(authority.name)} help={t(authority.why)}>
              <Select
                ariaLabel={t(authority.name)}
                placeholder={t("DashboardIssuance.signer.select")}
                value={draft.authorities[authority.key]}
                onValueChange={(value) => {
                  if (value)
                    update({ authorities: { ...draft.authorities, [authority.key]: value } });
                }}
              >
                {wallets.map((wallet) => (
                  <SelectItem key={wallet.id} value={wallet.id}>
                    {wallet.label?.trim() ||
                      `${wallet.publicKey.slice(0, 5)}…${wallet.publicKey.slice(-4)}`}
                  </SelectItem>
                ))}
              </Select>
            </Field>
          )
        )}
      </div>
      <p className="flex max-w-[40em] items-start gap-2 text-meta text-secondary">
        <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
        {t("DashboardIssuance.newDesign.draft.keysNote")}
      </p>
    </div>
  );
}

/** Step 5: the draft read back, then what creating it does and does not do. */
export function ReviewStep({
  draft,
  access,
  wallets,
  environment,
}: {
  draft: DraftState;
  access: DraftAccess;
  wallets: readonly PaymentsDashboardWallet[];
  environment: "sandbox" | "production";
}) {
  const t = useTranslations();
  const stablecoin = draft.assetClass === "stablecoin";
  const notSet = t("DashboardIssuance.newDesign.notSet");
  const mintWallet = wallets.find((wallet) => wallet.id === draft.authorities["mint-authority"]);
  const controls = [
    (stablecoin || draft.freezeAccounts) && t("DashboardIssuance.newDesign.permissions.freezable"),
    (stablecoin || draft.pauseTransfers) && t("DashboardIssuance.newDesign.permissions.pausable"),
    (stablecoin || draft.permanentDelegate) &&
      t("DashboardIssuance.newDesign.permissions.delegate"),
    access !== "off" && t("DashboardIssuance.newDesign.draft.accessList"),
    t("DashboardIssuance.newDesign.permissions.mintable"),
  ].filter(Boolean);
  const rows: [MessageKey, string][] = [
    ["DashboardIssuance.newDesign.details.name", draft.name.trim() || notSet],
    ["DashboardIssuance.newDesign.draft.classification", t(CLASS_LABEL[draft.assetClass])],
    ["DashboardIssuance.newDesign.details.symbol", draft.symbol.trim() || notSet],
    ["DashboardIssuance.newDesign.details.decimals", draft.decimals || notSet],
    [
      "DashboardIssuance.newDesign.details.maximumSupply",
      draft.maxSupply
        ? Number(draft.maxSupply).toLocaleString()
        : t("DashboardIssuance.newDesign.overview.noCap"),
    ],
    ["DashboardIssuance.newDesign.details.issuerName", draft.issuerName?.trim() || notSet],
    [
      "DashboardIssuance.newDesign.details.currency",
      draft.pegCurrency ?? t("DashboardIssuance.newDesign.details.noCurrency"),
    ],
    ["DashboardIssuance.newDesign.draft.controls", controls.join(", ")],
    [
      "DashboardIssuance.newDesign.draft.accessList",
      t(
        access === "blocklist"
          ? "DashboardIssuance.newDesign.access.blocklist"
          : access === "allowlist"
            ? "DashboardIssuance.newDesign.access.allowlist"
            : "DashboardIssuance.newDesign.access.off"
      ),
    ],
    [
      "DashboardIssuance.newDesign.permissions.mint",
      mintWallet?.label?.trim() || (mintWallet ? `${mintWallet.publicKey.slice(0, 5)}…` : notSet),
    ],
  ];
  const next: [MessageKey, MessageKey][] = [
    [
      "DashboardIssuance.newDesign.draft.environment",
      environment === "production"
        ? "DashboardIssuance.newDesign.draft.environmentProduction"
        : "DashboardIssuance.newDesign.draft.environmentSandbox",
    ],
    [
      "DashboardIssuance.newDesign.draft.networkCost",
      "DashboardIssuance.newDesign.draft.networkCostValue",
    ],
    [
      "DashboardIssuance.newDesign.draft.notYetSet",
      "DashboardIssuance.newDesign.draft.notYetSetValue",
    ],
    [
      "DashboardIssuance.newDesign.overview.reversible",
      "DashboardIssuance.newDesign.draft.reversibleValue",
    ],
    ["DashboardIssuance.newDesign.draft.then", "DashboardIssuance.newDesign.draft.thenValue"],
  ];
  return (
    <div className="flex flex-col gap-10">
      <section className="flex flex-col">
        <h3 className="pb-1.5 text-body font-medium text-primary">
          {t("DashboardIssuance.newDesign.draft.thisDraft")}
        </h3>
        <dl>
          {rows.map(([label, value]) => (
            <RecordLine key={label} label={t(label)}>
              {value}
            </RecordLine>
          ))}
        </dl>
      </section>
      <section className="flex flex-col">
        <h3 className="pb-1.5 text-body font-medium text-primary">
          {t("DashboardIssuance.newDesign.draft.whatHappensNext")}
        </h3>
        <dl>
          {next.map(([label, value]) => (
            <RecordLine key={label} label={t(label)}>
              {t(value)}
            </RecordLine>
          ))}
        </dl>
      </section>
    </div>
  );
}
