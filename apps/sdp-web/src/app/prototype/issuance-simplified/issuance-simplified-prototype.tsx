"use client";

import {
  ArrowLeft,
  ArrowRight,
  Ban,
  Building2,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDollarSign,
  Code2,
  Copy,
  ExternalLink,
  Eye,
  FileCheck2,
  Flame,
  Gauge,
  MoreHorizontal,
  Pause,
  Plus,
  Settings2,
  Shield,
  ShieldCheck,
  Snowflake,
  Sparkles,
  Users,
  Wallet,
  X,
} from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { WizardStepProgress } from "@/components/ui/wizard-step-progress";
import { saveIssuancePrototypeDraft } from "./actions";
import styles from "./issuance-simplified-prototype.module.css";

// PROTOTYPE — One focused simplified issuance flow on
// /prototype/issuance-simplified. Delete or absorb after review.

const STEPS = ["Classification", "Token details", "Controls", "Permissions", "Review"];

type AssetClass = "stablecoin" | "digital-asset";
type AuthorityKey = "mint" | "burn" | "freeze" | "pause";
type Surface = "create" | "workspace";

interface DraftState {
  assetClass: AssetClass;
  name: string;
  symbol: string;
  description: string;
  website: string;
  maxSupply: string;
  decimals: string;
  allowlist: boolean;
  pauseTransfers: boolean;
  interestBearing: boolean;
  interestRate: string;
  transferFee: boolean;
  transferFeeBasisPoints: string;
  transferFeeMax: string;
  authorities: Record<AuthorityKey, string>;
}

const INITIAL_DRAFT: DraftState = {
  assetClass: "stablecoin",
  name: "Veritas USD",
  symbol: "vUSD",
  description: "A fully-reserved US dollar stablecoin for fast, programmable settlement.",
  website: "https://veritas.finance",
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
    mint: "Treasury Wallet",
    burn: "Treasury Wallet",
    freeze: "Compliance Ops",
    pause: "Operations Safe",
  },
};

const authorityCopy: Record<AuthorityKey, { title: string; description: string }> = {
  mint: {
    title: "Who can create new token supply?",
    description: "This wallet approves every mint operation.",
  },
  burn: {
    title: "Who can permanently remove supply?",
    description: "This wallet approves every burn operation.",
  },
  freeze: {
    title: "Who can freeze token balances?",
    description: "Use a compliance-controlled wallet for account restrictions.",
  },
  pause: {
    title: "Who can pause all transfers?",
    description: "Use a high-trust operations wallet for emergencies.",
  },
};

function cx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export function IssuanceSimplifiedPrototype({ embedded = false }: { embedded?: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const initialStep = Math.min(4, Math.max(0, Number(searchParams.get("step") ?? 0) || 0));
  const initialSurface: Surface =
    searchParams.get("surface") === "workspace" ? "workspace" : "create";

  const [surface, setSurface] = useState<Surface>(initialSurface);
  const [step, setStepState] = useState(initialStep);
  const [draft, setDraft] = useState<DraftState>(INITIAL_DRAFT);
  const [wallets, setWallets] = useState(["Treasury Wallet", "Compliance Ops", "Operations Safe"]);
  const [walletModalOpen, setWalletModalOpen] = useState(false);
  const [walletName, setWalletName] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [activeWorkspaceTab, setActiveWorkspaceTab] = useState("Overview");
  const [publicInfo, setPublicInfo] = useState(true);
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

  const showSurface = (next: Surface) => {
    setSurface(next);
    replaceParams({ surface: next === "workspace" ? "workspace" : null });
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

  const addWallet = () => {
    const normalized = walletName.trim();
    if (!normalized) return;
    setWallets((current) => [...current, normalized]);
    setWalletName("");
    setWalletModalOpen(false);
  };

  const saveDraft = async () => {
    setSavingDraft(true);
    try {
      const result = await saveIssuancePrototypeDraft(draft);
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
    <div className={cx(styles.prototypePage, embedded && styles.embeddedPrototypePage)}>
      <main className={styles.mainShell}>
        {surface === "create" ? (
          <CreateSurface
            step={step}
            setStep={setStep}
            draft={draft}
            updateDraft={updateDraft}
            setAssetClass={setAssetClass}
            wallets={wallets}
            openWalletModal={() => setWalletModalOpen(true)}
            advancedOpen={advancedOpen}
            setAdvancedOpen={setAdvancedOpen}
            draftSaved={draftSaved}
            savingDraft={savingDraft}
            saveDraft={saveDraft}
          />
        ) : (
          <TokenWorkspace
            draft={draft}
            publicInfo={publicInfo}
            setPublicInfo={setPublicInfo}
            activeTab={activeWorkspaceTab}
            setActiveTab={setActiveWorkspaceTab}
            editDraft={() => showSurface("create")}
          />
        )}
      </main>

      {walletModalOpen && (
        <WalletModal
          value={walletName}
          onChange={setWalletName}
          onClose={() => setWalletModalOpen(false)}
          onCreate={addWallet}
        />
      )}
    </div>
  );
}

interface CreateSurfaceProps {
  step: number;
  setStep: (step: number) => void;
  draft: DraftState;
  updateDraft: <K extends keyof DraftState>(key: K, value: DraftState[K]) => void;
  setAssetClass: (value: AssetClass) => void;
  wallets: string[];
  openWalletModal: () => void;
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
                disabled={draftSaved || savingDraft}
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

function templateName(draft: DraftState) {
  return draft.assetClass === "stablecoin" ? "Stablecoin" : "Custom";
}

function permissionKeys(draft: DraftState): AuthorityKey[] {
  if (draft.assetClass === "stablecoin") return ["mint", "burn", "freeze", "pause"];
  return draft.pauseTransfers ? ["mint", "burn", "pause"] : ["mint", "burn"];
}

interface StepContentProps extends CreateSurfaceProps {}

function StepContent({
  step,
  draft,
  updateDraft,
  setAssetClass,
  wallets,
  openWalletModal,
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
          openWalletModal={openWalletModal}
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
      description: "A digital token for uses like rewards, access, or in-app value, rather than an investment security.",
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
              ? "Fixed by the Mosaic Stablecoin template."
              : "Mosaic Custom defaults to 9."
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
    <div className={styles.field}>
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </div>
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
            ? "Included by the Mosaic Stablecoin template."
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
            description="Included by the Mosaic Stablecoin template."
            checked
            onChange={() => undefined}
            Icon={Snowflake}
            disabled
          />
          <ControlRow
            title="Recovery authority"
            description="Included by the Mosaic Stablecoin template."
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
  openWalletModal,
}: {
  draft: DraftState;
  updateDraft: <K extends keyof DraftState>(key: K, value: DraftState[K]) => void;
  wallets: string[];
  openWalletModal: () => void;
}) {
  const updateAuthority = (key: AuthorityKey, value: string) => {
    updateDraft("authorities", { ...draft.authorities, [key]: value });
  };

  return (
    <div className={styles.permissionsStack}>
      {permissionKeys(draft).map((key) => {
        const copy = authorityCopy[key];
        const Icon =
          key === "mint"
            ? CircleDollarSign
            : key === "burn"
              ? Flame
              : key === "freeze"
                ? Snowflake
                : Pause;
        return (
          <div className={styles.permissionRow} key={key}>
            <span className={styles.permissionIcon}>
              <Icon size={17} />
            </span>
            <div className={styles.permissionCopy}>
              <strong>{copy.title}</strong>
              <span>{copy.description}</span>
            </div>
            <select
              value={draft.authorities[key]}
              onChange={(event) => updateAuthority(key, event.target.value)}
            >
              {wallets.map((wallet) => (
                <option key={wallet}>{wallet}</option>
              ))}
            </select>
          </div>
        );
      })}
      <button type="button" className={styles.createWalletInline} onClick={openWalletModal}>
        <Plus size={14} /> Create another wallet
      </button>
    </div>
  );
}

function ReviewStep({ draft }: { draft: DraftState }) {
  return (
    <div className={styles.reviewStack}>
      <section className={styles.reviewList} aria-label="Asset review">
        <ReviewRow label="Token" value={`${draft.name} (${draft.symbol})`} />
        <ReviewRow label="Mosaic template" value={templateName(draft)} />
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
            <Code2 size={15} /> Prepared transaction preview
          </span>
          <button type="button">
            <Copy size={13} /> Copy
          </button>
        </div>
        <pre>
          <span>POST</span> /v1/issuance/tokens/prepare{"\n"}
          {"\n"}
          <b>classification</b> {draft.assetClass === "stablecoin" ? "stablecoin" : "digital_asset"}
          {"\n"}
          <b>template</b> {draft.assetClass === "stablecoin" ? "stablecoin" : "custom"}
          {"\n"}
          <b>name</b> {draft.name}
          {"\n"}
          <b>symbol</b> {draft.symbol}
          {"\n"}
          <b>decimals</b> {draft.decimals}
          {"\n"}
          <b>controls</b> {enabledControls(draft).join(", ") || "none"}
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

interface TokenWorkspaceProps {
  draft: DraftState;
  publicInfo: boolean;
  setPublicInfo: (value: boolean) => void;
  activeTab: string;
  setActiveTab: (value: string) => void;
  editDraft: () => void;
}

function TokenWorkspace({
  draft,
  publicInfo,
  setPublicInfo,
  activeTab,
  setActiveTab,
  editDraft,
}: TokenWorkspaceProps) {
  const tabs = ["Overview", "Compliance", "Operations", "Activity"];
  return (
    <section className={cx(styles.contentCard, styles.tokenWorkspace)}>
      <header className={styles.tokenHeader}>
        <div className={styles.tokenIdentityRow}>
          <div className={styles.tokenIdentity}>
            <span className={styles.largeTokenMark}>{draft.symbol.slice(0, 1) || "V"}</span>
            <div>
              <div className={styles.tokenTitleLine}>
                <h1>{draft.name}</h1>
                <span className={styles.symbolBadge}>{draft.symbol}</span>
                <span className={styles.activeBadge}>Active</span>
              </div>
              <div className={styles.tokenMeta}>
                <span>
                  {draft.assetClass === "stablecoin" ? "Stablecoin" : "Non-Security Digital Asset"}
                </span>
                <span>·</span>
                <span>Devnet</span>
                <span>·</span>
                <span>
                  Mint B3A2P…nNsv <Copy size={12} />
                </span>
              </div>
            </div>
          </div>
          <div className={styles.tokenActions}>
            <button type="button" className={styles.secondaryButton}>
              <Code2 size={14} /> API Playground
            </button>
            <button type="button" className={styles.secondaryButton}>
              Explorer <ExternalLink size={13} />
            </button>
            <button type="button" className={styles.iconButton}>
              <MoreHorizontal size={16} />
            </button>
          </div>
        </div>

        <div className={styles.headerBand}>
          <div className={styles.authorityBand}>
            <span className={styles.bandLabel}>
              <Shield size={14} /> Wallet controls
            </span>
            <AuthorityChip label="Creates supply" wallet={draft.authorities.mint} />
            <AuthorityChip label="Removes supply" wallet={draft.authorities.burn} />
            <AuthorityChip label="Freezes balances" wallet={draft.authorities.freeze} />
            <AuthorityChip label="Pauses transfers" wallet={draft.authorities.pause} />
          </div>
          <div className={styles.headerSignals}>
            <button type="button" onClick={() => setActiveTab("Compliance")}>
              <Users size={14} /> Allowlist <strong>148</strong>
            </button>
            <button type="button" onClick={() => setActiveTab("Compliance")}>
              <Ban size={14} /> Blocklist <strong>3</strong>
            </button>
            <label className={styles.publicToggle}>
              <span>
                <Eye size={14} /> Public info
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={publicInfo}
                className={cx(styles.toggle, publicInfo && styles.toggleOn)}
                onClick={() => setPublicInfo(!publicInfo)}
              >
                <span />
              </button>
            </label>
          </div>
        </div>

        <nav className={styles.workspaceTabs}>
          {tabs.map((tab) => (
            <button
              type="button"
              key={tab}
              className={tab === activeTab ? styles.workspaceTabActive : undefined}
              onClick={() => setActiveTab(tab)}
            >
              {tab}
            </button>
          ))}
        </nav>
      </header>

      <div className={styles.workspaceBody}>
        {activeTab === "Overview" && <WorkspaceOverview draft={draft} publicInfo={publicInfo} />}
        {activeTab === "Compliance" && <WorkspaceCompliance draft={draft} />}
        {activeTab === "Operations" && <WorkspaceOperations />}
        {activeTab === "Activity" && <WorkspaceActivity />}
      </div>

      <button type="button" className={styles.editPrototypeButton} onClick={editDraft}>
        <ArrowLeft size={14} /> Back to creation flow
      </button>
    </section>
  );
}

function AuthorityChip({ label, wallet }: { label: string; wallet: string }) {
  return (
    <button type="button" className={styles.authorityChip}>
      <span>{label}</span>
      <strong>{wallet}</strong>
      <ChevronRight size={12} />
    </button>
  );
}

function WorkspaceOverview({ draft, publicInfo }: { draft: DraftState; publicInfo: boolean }) {
  return (
    <div className={styles.overviewGrid}>
      <div className={styles.overviewMain}>
        <div className={styles.statGrid}>
          <StatCard label="Current supply" value="1,250,000" detail={draft.symbol} />
          <StatCard
            label="Supply cap"
            value={Number(draft.maxSupply).toLocaleString()}
            detail={draft.symbol}
          />
          <StatCard label="Holders" value="214" detail="+18 this month" />
        </div>
        <section className={styles.workspaceSection}>
          <div className={styles.sectionHeading}>
            <div>
              <h2>Public information</h2>
              <p>Visible in token metadata and explorer integrations.</p>
            </div>
            <span className={publicInfo ? styles.publishedBadge : styles.hiddenBadge}>
              {publicInfo ? "Published" : "Hidden"}
            </span>
          </div>
          <div className={styles.infoRows}>
            <InfoRow label="Name" value={draft.name} state="Always public" />
            <InfoRow label="Symbol" value={draft.symbol} state="Always public" />
            <InfoRow
              label="Description"
              value={draft.description}
              state={publicInfo ? "Public" : "Hidden"}
            />
            <InfoRow
              label="Website"
              value={draft.website}
              state={publicInfo ? "Public" : "Hidden"}
            />
          </div>
        </section>
      </div>
      <aside className={styles.overviewSide}>
        <section className={styles.workspaceSection}>
          <div className={styles.sectionHeading}>
            <div>
              <h2>Controls</h2>
              <p>Active token behavior.</p>
            </div>
          </div>
          <div className={styles.capabilityRows}>
            {enabledControls(draft).map((control) => (
              <div key={control}>
                <span>{control}</span>
                <strong>On</strong>
              </div>
            ))}
            <div>
              <span>Supply</span>
              <strong>Mint on demand</strong>
            </div>
          </div>
        </section>
        <section className={styles.workspaceSection}>
          <div className={styles.sectionHeading}>
            <div>
              <h2>Access lists</h2>
              <p>Transfer eligibility at a glance.</p>
            </div>
          </div>
          <div className={styles.listSummary}>
            <div>
              <span className={styles.greenDot} /> <span>Approved addresses</span>
              <strong>148</strong>
            </div>
            <div>
              <span className={styles.redDot} /> <span>Blocked addresses</span>
              <strong>3</strong>
            </div>
          </div>
        </section>
      </aside>
    </div>
  );
}

function StatCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className={styles.statCard}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function InfoRow({ label, value, state }: { label: string; value: string; state: string }) {
  return (
    <div className={styles.infoRow}>
      <span>{label}</span>
      <strong>{value}</strong>
      <em>{state}</em>
    </div>
  );
}

function WorkspaceCompliance({ draft }: { draft: DraftState }) {
  return (
    <div className={styles.singleColumnWorkspace}>
      <section className={styles.workspaceSection}>
        <div className={styles.sectionHeading}>
          <div>
            <h2>Controls</h2>
            <p>Manage access lists and the wallets responsible for restrictions.</p>
          </div>
          <button type="button" className={styles.primaryButton}>
            <Plus size={14} /> Add address
          </button>
        </div>
        <div className={styles.complianceStats}>
          <div>
            <ShieldCheck size={18} />
            <span>
              <strong>148 approved</strong>
              <small>Can receive this token</small>
            </span>
          </div>
          <div>
            <Ban size={18} />
            <span>
              <strong>3 blocked</strong>
              <small>Cannot receive this token</small>
            </span>
          </div>
          <div>
            <Snowflake size={18} />
            <span>
              <strong>{draft.authorities.freeze}</strong>
              <small>Can freeze balances</small>
            </span>
          </div>
        </div>
      </section>
      <section className={styles.workspaceSection}>
        <div className={styles.sectionHeading}>
          <div>
            <h2>Who controls what</h2>
            <p>Plain-language permissions for operators.</p>
          </div>
        </div>
        <div className={styles.infoRows}>
          {(Object.keys(authorityCopy) as AuthorityKey[]).map((key) => (
            <InfoRow
              key={key}
              label={authorityCopy[key].title}
              value={draft.authorities[key]}
              state="Assigned"
            />
          ))}
        </div>
      </section>
    </div>
  );
}

function WorkspaceOperations() {
  return (
    <div className={styles.operationsWorkspace}>
      <div className={styles.transactionAssist}>
        <Code2 size={17} />
        <div>
          <strong>SDP prepares, your wallet approves</strong>
          <span>
            Review an unsigned transaction, fee quote, and expiry before asking the assigned wallet
            to sign.
          </span>
        </div>
        <span className={styles.devnetBadge}>Devnet quote</span>
      </div>
      <div className={styles.operationGrid}>
        {[
          [CircleDollarSign, "Create supply", "Mint tokens into a selected wallet"],
          [Flame, "Remove supply", "Permanently burn tokens"],
          [Snowflake, "Freeze balances", "Restrict a specific wallet"],
          [Pause, "Pause transfers", "Stop all token movement temporarily"],
        ].map(([Icon, title, detail]) => {
          const OperationIcon = Icon as typeof CircleDollarSign;
          return (
            <button type="button" className={styles.operationCard} key={title as string}>
              <OperationIcon size={19} />
              <span>
                <strong>{title as string}</strong>
                <small>{detail as string}</small>
              </span>
              <em>Prepare</em>
              <ChevronRight size={15} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

function WorkspaceActivity() {
  return (
    <section className={styles.workspaceSection}>
      <div className={styles.sectionHeading}>
        <div>
          <h2>Activity</h2>
          <p>Recent issuance and control changes.</p>
        </div>
      </div>
      <div className={styles.activityRows}>
        <ActivityRow
          icon={<CircleDollarSign size={16} />}
          title="Created 250,000 vUSD"
          actor="Treasury Wallet"
          time="Today, 10:42"
        />
        <ActivityRow
          icon={<ShieldCheck size={16} />}
          title="Added 12 approved addresses"
          actor="Compliance Ops"
          time="Yesterday, 16:18"
        />
        <ActivityRow
          icon={<FileCheck2 size={16} />}
          title="Updated public information"
          actor="Gui"
          time="Aug 31, 09:14"
        />
      </div>
    </section>
  );
}

function ActivityRow({
  icon,
  title,
  actor,
  time,
}: {
  icon: ReactNode;
  title: string;
  actor: string;
  time: string;
}) {
  return (
    <div className={styles.activityRow}>
      <span className={styles.activityIcon}>{icon}</span>
      <span className={styles.activityCopy}>
        <strong>{title}</strong>
        <small>{actor}</small>
      </span>
      <time>{time}</time>
    </div>
  );
}

function WalletModal({
  value,
  onChange,
  onClose,
  onCreate,
}: {
  value: string;
  onChange: (value: string) => void;
  onClose: () => void;
  onCreate: () => void;
}) {
  return (
    <div className={styles.modalOverlay}>
      <button
        type="button"
        className={styles.modalBackdrop}
        aria-label="Close wallet dialog"
        onClick={onClose}
      />
      <div
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="wallet-modal-title"
      >
        <div className={styles.modalHeader}>
          <div className={styles.modalIcon}>
            <Wallet size={19} />
          </div>
          <div>
            <h2 id="wallet-modal-title">Create a wallet</h2>
            <p>Available immediately in every permission picker.</p>
          </div>
          <button type="button" className={styles.iconButton} onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <Field label="Wallet name" hint="Use a name that describes the wallet's responsibility.">
          <input
            value={value}
            placeholder="e.g. Issuance Safe"
            onChange={(event) => onChange(event.target.value)}
          />
        </Field>
        <div className={styles.walletProviderCard}>
          <Building2 size={18} />
          <span>
            <strong>SDP-managed wallet</strong>
            <small>Ready for this Devnet prototype</small>
          </span>
          <CheckCircle2 size={17} />
        </div>
        <div className={styles.modalFooter}>
          <button type="button" className={styles.secondaryButton} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={styles.primaryButton}
            onClick={onCreate}
            disabled={!value.trim()}
          >
            Create wallet
          </button>
        </div>
      </div>
    </div>
  );
}
