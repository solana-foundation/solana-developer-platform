"use client";

import type { PaymentsDashboardWallet } from "@sdp/types";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  CircleDollarSign,
  Code2,
  Copy,
  ExternalLink,
  Eye,
  Gauge,
  Pause,
  Settings2,
  type Shield,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { WizardStepProgress } from "@/components/ui/wizard-step-progress";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { shortenAddress } from "../wallet-identity";
import { saveIssuanceDraft } from "./actions";
import { type AuthorityKey, buildDraftPayload, type DraftState } from "./draft-model";
import styles from "./issuance-draft-form.module.css";
import { settlementBlockedMessageKey } from "./token-controls-model";

/**
 * The DvP settlement warning for a control this form offers, if the program
 * refuses it.
 *
 * The form drives its controls from booleans on the draft rather than from
 * capability entries, so the setting key is named here and the deny list stays
 * the one place that decides. Only the extensions this step actually offers are
 * looked up; the rest are unreachable from here.
 */
function settlementWarning(
  t: ReturnType<typeof useTranslations>,
  key: "interestBearing" | "transferFee"
): string | undefined {
  const messageKey = settlementBlockedMessageKey(key);
  return messageKey ? t(messageKey) : undefined;
}

// The five-step draft flow. Saving persists a draft; it never deploys a token.

const STEP_KEYS = ["classification", "tokenDetails", "controls", "permissions", "review"] as const;

type AssetClass = "stablecoin" | "digital-asset";
const INITIAL_DRAFT: DraftState = {
  assetClass: "stablecoin",
  name: "",
  symbol: "",
  description: "",
  website: "",
  maxSupply: "10000000",
  decimals: "6",
  allowlist: false,
  pauseTransfers: true,
  interestBearing: false,
  interestRate: "500",
  transferFee: false,
  transferFeeBasisPoints: "50",
  transferFeeMax: "100",
  authorities: {
    "mint-authority": "",
    "metadata-authority": "",
    "freeze-authority": "",
    "permanent-delegate": "",
  },
};

const authorityCopy: Record<AuthorityKey, MessageKey> = {
  "mint-authority": "DashboardIssuance.draftForm.mintPermission",
  "freeze-authority": "DashboardIssuance.draftForm.freezePermission",
  "metadata-authority": "DashboardIssuance.draftForm.metadataPermission",
  "permanent-delegate": "DashboardIssuance.draftForm.recoveryPermission",
};

function cx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export function IssuanceDraftForm({
  wallets,
  walletsError,
}: {
  wallets: PaymentsDashboardWallet[];
  walletsError: string | null;
}) {
  const t = useTranslations();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const initialStep = Math.min(4, Math.max(0, Number(searchParams.get("step") ?? 0) || 0));
  const [step, setStepState] = useState(initialStep);
  const [draft, setDraft] = useState<DraftState>(() => ({
    ...INITIAL_DRAFT,
    authorities: Object.fromEntries(
      Object.keys(authorityCopy).map((key) => [key, wallets[0]?.id ?? ""])
    ) as Record<AuthorityKey, string>,
  }));
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [draftSaved, setDraftSaved] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);

  const replaceParams = (changes: Record<string, string | null>) => {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) params.delete(key);
      else params.set(key, value);
    }
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const setStep = (next: number) => {
    const normalized = Math.min(4, Math.max(0, next));
    setStepState(normalized);
    replaceParams({ step: String(normalized), surface: null });
  };

  const updateDraft = <K extends keyof DraftState>(key: K, value: DraftState[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setDraftSaved(false);
  };

  const setAssetClass = (assetClass: AssetClass) => {
    setDraftSaved(false);
    setDraft((current) => ({
      ...current,
      assetClass,
      allowlist: false,
      pauseTransfers: assetClass === "stablecoin",
      interestBearing: false,
      transferFee: false,
      maxSupply: assetClass === "stablecoin" ? "10000000" : "",
      decimals: assetClass === "stablecoin" ? "6" : "9",
    }));
  };

  const saveDraft = async () => {
    setSavingDraft(true);
    try {
      const result = await saveIssuanceDraft(draft);
      if (result.state === "error") {
        toast.error(result.message, { position: "bottom-right" });
        return;
      }

      window.localStorage.removeItem("sdp-issuance-prototype-draft");
      setDraftSaved(true);
      toast.success(result.message, { position: "bottom-right" });
      router.push("/dashboard/issuance");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("DashboardIssuance.draftForm.saveError"),
        {
          position: "bottom-right",
        }
      );
    } finally {
      setSavingDraft(false);
    }
  };

  return (
    <div className={cx(styles.prototypePage, styles.embeddedPrototypePage)}>
      <main className={styles.mainShell}>
        <CreateSurface
          step={step}
          setStep={setStep}
          draft={draft}
          updateDraft={updateDraft}
          setAssetClass={setAssetClass}
          wallets={wallets}
          walletsError={walletsError}
          advancedOpen={advancedOpen}
          setAdvancedOpen={setAdvancedOpen}
          draftSaved={draftSaved}
          savingDraft={savingDraft}
          saveDraft={saveDraft}
        />
      </main>
    </div>
  );
}

interface CreateSurfaceProps {
  step: number;
  setStep: (step: number) => void;
  draft: DraftState;
  updateDraft: <K extends keyof DraftState>(key: K, value: DraftState[K]) => void;
  setAssetClass: (value: AssetClass) => void;
  wallets: PaymentsDashboardWallet[];
  walletsError: string | null;
  advancedOpen: boolean;
  setAdvancedOpen: (value: boolean) => void;
  draftSaved: boolean;
  savingDraft: boolean;
  saveDraft: () => Promise<void>;
}

function CreateSurface(props: CreateSurfaceProps) {
  const t = useTranslations();
  const router = useRouter();
  const { step, setStep, draftSaved, savingDraft, saveDraft } = props;
  const body = <StepContent {...props} />;

  return (
    <section className={styles.contentCard}>
      <div className={styles.focusVariant}>
        <div className={styles.progressHeader} data-wizard-stepper>
          <WizardStepProgress
            currentStep={step}
            progressLabel={t("DashboardIssuance.draftForm.progress", {
              step: step + 1,
              total: STEP_KEYS.length,
            })}
            steps={STEP_KEYS.map((key) => t(`DashboardIssuance.draftForm.${key}`))}
          />
        </div>
        <div className={styles.wizardScrollRegion}>
          <div className={styles.focusGrid}>
            <form
              id="issuance-draft-step"
              className={styles.stepStage}
              onSubmit={(event) => {
                event.preventDefault();
                if (step < 4) setStep(step + 1);
                else void saveDraft();
              }}
            >
              {body}
            </form>
          </div>
        </div>
        <footer className={styles.stepFooter}>
          <div className={styles.stepFooterInner}>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => {
                if (step > 0) setStep(step - 1);
                else if (window.history.length > 1) router.back();
                else router.push("/dashboard/issuance");
              }}
            >
              <ArrowLeft size={14} /> {t("DashboardIssuance.draftForm.back")}
            </button>
            {step < 4 ? (
              <button
                type="submit"
                form="issuance-draft-step"
                className={styles.primaryButton}
                disabled={
                  step === 3 &&
                  !permissionKeys(props.draft).every((key) =>
                    props.wallets.some((wallet) => wallet.id === props.draft.authorities[key])
                  )
                }
              >
                {t("DashboardIssuance.draftForm.continue")} <ArrowRight size={14} />
              </button>
            ) : (
              <button
                type="button"
                className={styles.primaryButton}
                disabled={draftSaved || savingDraft || !props.wallets.length}
                onClick={saveDraft}
              >
                {savingDraft ? (
                  t("DashboardIssuance.draftForm.saving")
                ) : draftSaved ? (
                  <>
                    <Check size={14} /> {t("DashboardIssuance.draftForm.saved")}
                  </>
                ) : (
                  <>
                    {t("DashboardIssuance.draftForm.save")} <ArrowRight size={14} />
                  </>
                )}
              </button>
            )}
          </div>
        </footer>
      </div>
    </section>
  );
}

function enabledControls(draft: DraftState, t: ReturnType<typeof useTranslations>) {
  return [
    draft.allowlist && t("DashboardIssuance.draftForm.approved"),
    draft.pauseTransfers && t("DashboardIssuance.draftForm.pause"),
    draft.assetClass === "stablecoin" && t("DashboardIssuance.draftForm.freeze"),
    draft.assetClass === "stablecoin" && t("DashboardIssuance.draftForm.recovery"),
    draft.interestBearing && t("DashboardIssuance.draftForm.interest"),
    draft.transferFee && t("DashboardIssuance.draftForm.fee"),
  ].filter(Boolean) as string[];
}

function permissionKeys(draft: DraftState): AuthorityKey[] {
  return draft.assetClass === "stablecoin"
    ? ["mint-authority", "freeze-authority", "metadata-authority", "permanent-delegate"]
    : ["mint-authority", "metadata-authority"];
}

interface StepContentProps extends CreateSurfaceProps {}

function StepContent({
  step,
  draft,
  updateDraft,
  setAssetClass,
  wallets,
  walletsError,
  advancedOpen,
  setAdvancedOpen,
}: StepContentProps) {
  return (
    <div className={styles.stepPanel}>
      {step === 0 && <ClassificationStep draft={draft} setAssetClass={setAssetClass} />}
      {step === 1 && <TokenDetailsStep draft={draft} updateDraft={updateDraft} />}
      {step === 2 && (
        <ControlsStep
          draft={draft}
          updateDraft={updateDraft}
          advancedOpen={advancedOpen}
          setAdvancedOpen={setAdvancedOpen}
        />
      )}
      {step === 3 && (
        <PermissionsStep
          draft={draft}
          updateDraft={updateDraft}
          wallets={wallets}
          walletsError={walletsError}
        />
      )}
      {step === 4 && <ReviewStep draft={draft} />}
    </div>
  );
}

function ClassificationStep({
  draft,
  setAssetClass,
}: {
  draft: DraftState;
  setAssetClass: (value: AssetClass) => void;
}) {
  const t = useTranslations();
  const options: Array<{
    key: AssetClass;
    title: string;
    description: string;
    Icon: typeof CircleDollarSign;
  }> = [
    {
      key: "stablecoin",
      title: t("DashboardIssuance.draftForm.stablecoin"),
      description: t("DashboardIssuance.draftForm.stablecoinDescription"),
      Icon: CircleDollarSign,
    },
    {
      key: "digital-asset",
      title: t("DashboardIssuance.draftForm.digitalAsset"),
      description: t("DashboardIssuance.draftForm.digitalAssetDescription"),
      Icon: Sparkles,
    },
  ];

  return (
    <div className={styles.classificationGrid}>
      {options.map(({ key, title, description, Icon }) => {
        const selected = draft.assetClass === key;
        return (
          <button
            type="button"
            key={key}
            className={cx(styles.classificationCard, selected && styles.classificationCardSelected)}
            onClick={() => setAssetClass(key)}
          >
            <span className={styles.classificationIcon}>
              <Icon size={21} />
            </span>
            <span className={styles.classificationCopy}>
              <strong>{title}</strong>
              <span>{description}</span>
            </span>
            <span className={cx(styles.radio, selected && styles.radioSelected)}>
              {selected && <Check size={12} />}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function TokenDetailsStep({
  draft,
  updateDraft,
}: {
  draft: DraftState;
  updateDraft: <K extends keyof DraftState>(key: K, value: DraftState[K]) => void;
}) {
  const t = useTranslations();
  return (
    <div className={styles.formStack}>
      <div className={styles.formGrid}>
        <Field label={t("DashboardIssuance.draftForm.tokenName")} required>
          <input
            required
            maxLength={100}
            pattern={".*\\S.*"}
            value={draft.name}
            onChange={(event) => updateDraft("name", event.target.value)}
          />
        </Field>
        <Field label={t("DashboardIssuance.draftForm.symbol")} required>
          <input
            value={draft.symbol}
            required
            pattern="[A-Za-z0-9]+(?:[.][A-Za-z0-9]+)*"
            maxLength={10}
            onChange={(event) => updateDraft("symbol", event.target.value.toUpperCase())}
          />
        </Field>
      </div>
      <Field label={t("DashboardIssuance.draftForm.description")}>
        <textarea
          rows={3}
          maxLength={500}
          value={draft.description}
          onChange={(event) => updateDraft("description", event.target.value)}
        />
      </Field>
      <div className={styles.formGrid}>
        <Field
          label={
            draft.assetClass === "stablecoin"
              ? t("DashboardIssuance.draftForm.maxSupply")
              : t("DashboardIssuance.draftForm.maxSupplyOptional")
          }
          hint={
            draft.assetClass === "stablecoin"
              ? undefined
              : t("DashboardIssuance.draftForm.uncappedHint")
          }
        >
          <input
            type="number"
            min="1"
            step="1"
            value={draft.maxSupply}
            onChange={(event) => updateDraft("maxSupply", event.target.value)}
          />
        </Field>
        <Field
          label={t("DashboardIssuance.draftForm.decimals")}
          required
          hint={
            draft.assetClass === "stablecoin"
              ? t("DashboardIssuance.draftForm.stableDecimals")
              : t("DashboardIssuance.draftForm.customDecimals")
          }
        >
          <select
            value={draft.decimals}
            required
            disabled={draft.assetClass === "stablecoin"}
            onChange={(event) => updateDraft("decimals", event.target.value)}
          >
            <option value="0">0</option>
            <option value="2">2</option>
            <option value="6">6</option>
            <option value="8">8</option>
            <option value="9">9</option>
            <option value="18">18</option>
          </select>
        </Field>
      </div>
      <Field label={t("DashboardIssuance.draftForm.website")}>
        <input
          type="url"
          pattern="https?://.*"
          value={draft.website}
          maxLength={2048}
          onChange={(event) => updateDraft("website", event.target.value)}
        />
      </Field>
    </div>
  );
}

function Field({
  label,
  hint,
  required = false,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
}) {
  const t = useTranslations();
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: Every caller supplies one native input, select, or textarea as children.
    <label className={styles.field}>
      <span>
        {label}
        {required ? (
          <>
            {" "}
            <span aria-hidden className="text-destructive">
              *
            </span>
            <span className="sr-only"> {t("DashboardIssuance.create.required")}</span>
          </>
        ) : null}
      </span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

function ControlsStep({
  draft,
  updateDraft,
  advancedOpen,
  setAdvancedOpen,
}: {
  draft: DraftState;
  updateDraft: <K extends keyof DraftState>(key: K, value: DraftState[K]) => void;
  advancedOpen: boolean;
  setAdvancedOpen: (value: boolean) => void;
}) {
  const t = useTranslations();
  return (
    <div className={styles.controlStack}>
      <ControlRow
        title={t("DashboardIssuance.draftForm.approved")}
        description={t("DashboardIssuance.draftForm.approvedDescription")}
        checked={draft.allowlist}
        onChange={(value) => updateDraft("allowlist", value)}
        Icon={ShieldCheck}
      />
      {draft.assetClass === "stablecoin" ? (
        <section className="mt-2">
          <h3 className="text-sm font-medium text-primary">
            {t("DashboardIssuance.draftForm.includedControls")}
          </h3>
          <dl className="mt-2 divide-y divide-border-subtle">
            {(["pause", "freeze", "recover"] as const).map((control) => (
              <div key={control} className="py-3">
                <dt className="text-sm font-medium text-primary">
                  {t(`DashboardIssuance.draftForm.includedControlsCopy.${control}.title`)}
                </dt>
                <dd className="mt-1 text-sm text-secondary">
                  {t(`DashboardIssuance.draftForm.includedControlsCopy.${control}.description`)}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ) : (
        <ControlRow
          title={t("DashboardIssuance.draftForm.pauseCapability")}
          description={t("DashboardIssuance.draftForm.pauseDescription")}
          checked={draft.pauseTransfers}
          onChange={(value) => updateDraft("pauseTransfers", value)}
          Icon={Pause}
        />
      )}
      <a
        href="https://sdp-docs-solana-foundation.vercel.app/docs/tokens/allowlists"
        target="_blank"
        rel="noreferrer"
        className={styles.docsLink}
      >
        {t("DashboardIssuance.draftForm.approvedDocs")} <ExternalLink size={13} />
      </a>
      {draft.assetClass === "digital-asset" && (
        <div className={styles.advancedSection}>
          <button type="button" onClick={() => setAdvancedOpen(!advancedOpen)}>
            <span>
              <Settings2 size={15} /> {t("DashboardIssuance.draftForm.advanced")}
            </span>
            <ChevronDown size={15} className={advancedOpen ? styles.chevronOpen : undefined} />
          </button>
          {advancedOpen && (
            <div className={styles.advancedBody}>
              <ControlRow
                title={t("DashboardIssuance.draftForm.interest")}
                description={t("DashboardIssuance.draftForm.interestDescription")}
                warning={settlementWarning(t, "interestBearing")}
                checked={draft.interestBearing}
                onChange={(value) => updateDraft("interestBearing", value)}
                Icon={Eye}
              />
              <ControlRow
                title={t("DashboardIssuance.draftForm.fee")}
                description={t("DashboardIssuance.draftForm.feeDescription")}
                warning={settlementWarning(t, "transferFee")}
                checked={draft.transferFee}
                onChange={(value) => updateDraft("transferFee", value)}
                Icon={Gauge}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ControlRow({
  title,
  description,
  warning,
  checked,
  onChange,
  Icon,
  disabled = false,
}: {
  title: string;
  description: string;
  /**
   * Shown under the description, whether or not the control is on. Extensions
   * are fixed at mint, so a warning that waited for the toggle would arrive
   * after the decision it exists to inform.
   */
  warning?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  Icon: typeof Shield;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={styles.controlRow}
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className={styles.controlIcon}>
        <Icon size={18} />
      </span>
      <span className={styles.controlCopy}>
        <strong>{title}</strong>
        <span>{description}</span>
        {warning ? <span className={styles.controlWarning}>{warning}</span> : null}
      </span>
      <span className={cx(styles.toggle, checked && styles.toggleOn)}>
        <span />
      </span>
    </button>
  );
}

function PermissionsStep({
  draft,
  updateDraft,
  wallets,
  walletsError,
}: {
  draft: DraftState;
  updateDraft: <K extends keyof DraftState>(key: K, value: DraftState[K]) => void;
  wallets: PaymentsDashboardWallet[];
  walletsError: string | null;
}) {
  const t = useTranslations();
  return (
    <div className={styles.permissionsStack}>
      {walletsError ? <p role="alert">{walletsError}</p> : null}
      {!wallets.length && !walletsError ? (
        <p>{t("DashboardIssuance.draftForm.noWallets")}</p>
      ) : null}
      {permissionKeys(draft).map((key) => (
        <Field key={key} label={t(authorityCopy[key])} required>
          <select
            required
            aria-label={t(authorityCopy[key])}
            value={draft.authorities[key]}
            disabled={!wallets.length}
            onChange={(event) =>
              updateDraft("authorities", { ...draft.authorities, [key]: event.target.value })
            }
          >
            <option value="" disabled>
              {t("DashboardIssuance.draftForm.selectWallet")}
            </option>
            {wallets.map((wallet) => (
              <option key={wallet.id} value={wallet.id}>
                {wallet.label || t("DashboardIssuance.draftForm.wallet")} ·{" "}
                {shortenAddress(wallet.publicKey)}
              </option>
            ))}
          </select>
        </Field>
      ))}
    </div>
  );
}

function ReviewStep({ draft }: { draft: DraftState }) {
  const t = useTranslations();
  const { sdpEnvironment } = useDashboardWorkspace();
  return (
    <div className={styles.reviewStack}>
      <section
        className={styles.reviewList}
        aria-label={t("DashboardIssuance.draftForm.assetReview")}
      >
        <ReviewRow
          label={t("DashboardIssuance.draftForm.token")}
          value={`${draft.name} (${draft.symbol})`}
        />
        <ReviewRow
          label={t("DashboardIssuance.draftForm.classification")}
          value={
            draft.assetClass === "stablecoin"
              ? t("DashboardIssuance.draftForm.stablecoin")
              : t("DashboardIssuance.draftForm.digitalAsset")
          }
        />
        <ReviewRow label={t("DashboardIssuance.draftForm.description")} value={draft.description} />
        <ReviewRow
          label={t("DashboardIssuance.draftForm.website")}
          value={draft.website || t("DashboardIssuance.draftForm.notIncluded")}
        />
        <ReviewRow
          label={t("DashboardIssuance.draftForm.supplyCap")}
          value={
            draft.maxSupply
              ? Number(draft.maxSupply).toLocaleString()
              : t("DashboardIssuance.draftForm.unlimited")
          }
        />
        <ReviewRow
          label={t("DashboardIssuance.draftForm.controls")}
          value={
            enabledControls(draft, t).join(", ") || t("DashboardIssuance.draftForm.noControls")
          }
        />
        <ReviewRow
          label={t("DashboardIssuance.draftForm.permissions")}
          value={t("DashboardIssuance.draftForm.permissionCount", {
            count: permissionKeys(draft).filter((key) => draft.authorities[key]).length,
          })}
        />
        <ReviewRow
          label={t("DashboardIssuance.draftForm.network")}
          value={sdpEnvironment === "production" ? "Mainnet" : "Devnet"}
        />
      </section>
      <section className={styles.apiPreview}>
        <div className={styles.apiPreviewHeader}>
          <span>
            <Code2 size={15} /> {t("DashboardIssuance.draftForm.apiPreview")}
          </span>
          <button
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(
                  JSON.stringify(buildDraftPayload(draft), null, 2)
                );
                toast.success(t("DashboardIssuance.draftForm.copySuccess"));
              } catch {
                toast.error(t("DashboardIssuance.draftForm.copyError"));
              }
            }}
          >
            <Copy size={13} /> {t("DashboardIssuance.draftForm.copy")}
          </button>
        </div>
        <pre>
          <span>POST</span> /v1/issuance/asset-profiles{"\n\n"}
          {JSON.stringify(buildDraftPayload(draft), null, 2)}
        </pre>
      </section>
    </div>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.reviewRow}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
