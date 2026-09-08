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
  Shield,
  ShieldCheck,
  Snowflake,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { WizardStepProgress } from "@/components/ui/wizard-step-progress";
import { shortenAddress } from "../wallet-identity";
import { saveIssuanceDraft } from "./actions";
import { type AuthorityKey, buildDraftPayload, type DraftState } from "./draft-model";
import styles from "./issuance-draft-form.module.css";

// The five-step draft flow. Saving persists a draft; it never deploys a token.

const STEPS = ["Classification", "Token details", "Controls", "Permissions", "Review"];

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

const authorityCopy: Record<AuthorityKey, string> = {
  "mint-authority": "Who can mint tokens?",
  "freeze-authority": "Who can freeze balances?",
  "metadata-authority": "Who can update token information?",
  "permanent-delegate": "Who can recover or destroy balances?",
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
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const initialStep = Math.min(4, Math.max(0, Number(searchParams.get("step") ?? 0) || 0));
  const [step, setStepState] = useState(initialStep);
  const [draft, setDraft] = useState<DraftState>(() => ({
    ...INITIAL_DRAFT,
    authorities: Object.fromEntries(
      Object.keys(authorityCopy).map((key) => [key, wallets[0]?.walletId ?? ""])
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
      toast.error(error instanceof Error ? error.message : "Unable to save draft.", {
        position: "bottom-right",
      });
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
  const router = useRouter();
  const { step, setStep, draftSaved, savingDraft, saveDraft } = props;
  const body = <StepContent {...props} />;

  return (
    <section className={styles.contentCard}>
      <div className={styles.focusVariant}>
        <div className={styles.progressHeader} data-wizard-stepper>
          <WizardStepProgress
            currentStep={step}
            progressLabel={`Step ${step + 1} of ${STEPS.length}`}
            steps={STEPS}
          />
        </div>
        <div className={styles.wizardScrollRegion}>
          <div className={styles.focusGrid}>
            <div className={styles.stepStage}>{body}</div>
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
              <ArrowLeft size={14} /> Back
            </button>
            {step < 4 ? (
              <button
                type="button"
                className={styles.primaryButton}
                onClick={() => setStep(step + 1)}
              >
                Continue <ArrowRight size={14} />
              </button>
            ) : (
              <button
                type="button"
                className={styles.primaryButton}
                disabled={draftSaved || savingDraft || !props.wallets.length}
                onClick={saveDraft}
              >
                {savingDraft ? (
                  "Saving…"
                ) : draftSaved ? (
                  <>
                    <Check size={14} /> Draft saved
                  </>
                ) : (
                  <>
                    Save draft <ArrowRight size={14} />
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

function enabledControls(draft: DraftState) {
  return [
    draft.allowlist && "Approved recipients",
    draft.pauseTransfers && "Emergency pause",
    draft.assetClass === "stablecoin" && "Freeze balances",
    draft.assetClass === "stablecoin" && "Recovery authority",
    draft.interestBearing && "Interest-bearing balances",
    draft.transferFee && "Transfer fee",
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
  const options: Array<{
    key: AssetClass;
    title: string;
    description: string;
    Icon: typeof CircleDollarSign;
  }> = [
    {
      key: "stablecoin",
      title: "Stablecoin",
      description: "A token designed to track a stable value, such as the US dollar or euro.",
      Icon: CircleDollarSign,
    },
    {
      key: "digital-asset",
      title: "Non-Security Digital Asset",
      description:
        "A digital token for uses like rewards, access, or in-app value, rather than an investment security.",
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
  return (
    <div className={styles.formStack}>
      <div className={styles.formGrid}>
        <Field label="Token name">
          <input value={draft.name} onChange={(event) => updateDraft("name", event.target.value)} />
        </Field>
        <Field label="Symbol">
          <input
            value={draft.symbol}
            maxLength={10}
            onChange={(event) => updateDraft("symbol", event.target.value.toUpperCase())}
          />
        </Field>
      </div>
      <Field label="Description" hint="Used in the token metadata.">
        <textarea
          rows={4}
          value={draft.description}
          onChange={(event) => updateDraft("description", event.target.value)}
        />
      </Field>
      <div className={styles.formGrid}>
        <Field
          label={draft.assetClass === "stablecoin" ? "Maximum supply" : "Maximum supply (optional)"}
          hint={
            draft.assetClass === "stablecoin"
              ? "Use the number stepper or type a value."
              : "Leave empty for uncapped supply."
          }
        >
          <input
            type="number"
            min="1"
            step="1000"
            value={draft.maxSupply}
            onChange={(event) => updateDraft("maxSupply", event.target.value)}
          />
        </Field>
        <Field
          label="Decimals"
          hint={
            draft.assetClass === "stablecoin"
              ? "Stablecoins use 6 decimal places."
              : "Digital assets default to 9 decimal places."
          }
        >
          <select
            value={draft.decimals}
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
      <Field label="Website" hint="Optional token metadata link.">
        <input
          value={draft.website}
          onChange={(event) => updateDraft("website", event.target.value)}
        />
      </Field>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: Every caller supplies one native input, select, or textarea as children.
    <label className={styles.field}>
      <span>{label}</span>
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
  return (
    <div className={styles.controlStack}>
      <ControlRow
        title="Approved recipients"
        description="Only approved addresses can receive this token."
        checked={draft.allowlist}
        onChange={(value) => updateDraft("allowlist", value)}
        Icon={ShieldCheck}
      />
      <ControlRow
        title="Emergency pause capability"
        description={
          draft.assetClass === "stablecoin"
            ? "Included with stablecoins."
            : "Allow the assigned wallet to pause transfers during an emergency."
        }
        checked={draft.pauseTransfers}
        onChange={(value) => updateDraft("pauseTransfers", value)}
        Icon={Pause}
        disabled={draft.assetClass === "stablecoin"}
      />
      {draft.assetClass === "stablecoin" && (
        <>
          <ControlRow
            title="Freeze balances"
            description="Included with stablecoins."
            checked
            onChange={() => undefined}
            Icon={Snowflake}
            disabled
          />
          <ControlRow
            title="Recovery authority"
            description="Included with stablecoins."
            checked
            onChange={() => undefined}
            Icon={Shield}
            disabled
          />
        </>
      )}
      <a
        href="https://sdp-docs-solana-foundation.vercel.app/docs/tokens/allowlists"
        target="_blank"
        rel="noreferrer"
        className={styles.docsLink}
      >
        How approved recipients work <ExternalLink size={13} />
      </a>
      {draft.assetClass === "digital-asset" && (
        <div className={styles.advancedSection}>
          <button type="button" onClick={() => setAdvancedOpen(!advancedOpen)}>
            <span>
              <Settings2 size={15} /> Advanced controls
            </span>
            <ChevronDown size={15} className={advancedOpen ? styles.chevronOpen : undefined} />
          </button>
          {advancedOpen && (
            <div className={styles.advancedBody}>
              <ControlRow
                title="Interest-bearing balances"
                description="Display balances with a configured interest rate."
                checked={draft.interestBearing}
                onChange={(value) => updateDraft("interestBearing", value)}
                Icon={Eye}
              />
              <ControlRow
                title="Transfer fee"
                description="Collect a configurable fee on each transfer."
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
  checked,
  onChange,
  Icon,
  disabled = false,
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  Icon: typeof Shield;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={styles.controlRow}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className={styles.controlIcon}>
        <Icon size={18} />
      </span>
      <span className={styles.controlCopy}>
        <strong>{title}</strong>
        <span>{description}</span>
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
  return (
    <div className={styles.permissionsStack}>
      {walletsError ? <p role="alert">{walletsError}</p> : null}
      {!wallets.length && !walletsError ? (
        <p>
          No wallets available. <Link href="/dashboard/wallets/setup">Create a wallet</Link> before
          saving this draft.
        </p>
      ) : null}
      {permissionKeys(draft).map((key) => (
        <Field key={key} label={authorityCopy[key]}>
          <select
            aria-label={authorityCopy[key]}
            value={draft.authorities[key]}
            disabled={!wallets.length}
            onChange={(event) =>
              updateDraft("authorities", { ...draft.authorities, [key]: event.target.value })
            }
          >
            <option value="" disabled>
              Select a wallet
            </option>
            {wallets.map((wallet) => (
              <option key={wallet.walletId} value={wallet.walletId}>
                {wallet.label || "Wallet"} · {shortenAddress(wallet.publicKey)}
              </option>
            ))}
          </select>
        </Field>
      ))}
    </div>
  );
}

function ReviewStep({ draft }: { draft: DraftState }) {
  return (
    <div className={styles.reviewStack}>
      <section className={styles.reviewList} aria-label="Asset review">
        <ReviewRow label="Token" value={`${draft.name} (${draft.symbol})`} />
        <ReviewRow
          label="Classification"
          value={draft.assetClass === "stablecoin" ? "Stablecoin" : "Non-Security Digital Asset"}
        />
        <ReviewRow label="Description" value={draft.description} />
        <ReviewRow label="Website" value={draft.website || "Not included"} />
        <ReviewRow
          label="Supply cap"
          value={draft.maxSupply ? Number(draft.maxSupply).toLocaleString() : "Unlimited"}
        />
        <ReviewRow
          label="Controls"
          value={enabledControls(draft).join(", ") || "No optional controls"}
        />
        <ReviewRow
          label="Permissions"
          value={`${permissionKeys(draft).length} permissions assigned`}
        />
        <ReviewRow label="Network" value="Devnet" />
      </section>
      <section className={styles.apiPreview}>
        <div className={styles.apiPreviewHeader}>
          <span>
            <Code2 size={15} /> Draft API preview
          </span>
          <button
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(
                  JSON.stringify(buildDraftPayload(draft), null, 2)
                );
                toast.success("Draft request copied.");
              } catch {
                toast.error("Unable to copy. Try again.");
              }
            }}
          >
            <Copy size={13} /> Copy
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
