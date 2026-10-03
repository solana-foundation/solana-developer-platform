"use client";

import type { PaymentsDashboardWallet } from "@sdp/types";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { WizardFrame } from "@/components/wizard-frame";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { usePaymentsDemo } from "@/lib/payments-demo/payments-demo-context";
import { saveIssuanceDraft } from "./actions";
import {
  ClassifyStep,
  ControlsStep,
  DetailsStep,
  type DraftAccess,
  PermissionsStep,
  ReviewStep,
} from "./draft-flow-steps.redesign";
import { type DraftState, draftSchema } from "./draft-model";
import {
  type LocalDraft,
  removeLocalDraft,
  restoreDraft,
  saveLocalDraft,
  useLocalDrafts,
} from "./local-drafts.redesign";

const STEPS: { label: MessageKey; title: MessageKey }[] = [
  {
    label: "DashboardIssuance.newDesign.draft.stepClassify",
    title: "DashboardIssuance.newDesign.draft.titleClassify",
  },
  {
    label: "DashboardIssuance.newDesign.draft.stepDetails",
    title: "DashboardIssuance.newDesign.draft.titleDetails",
  },
  {
    label: "DashboardIssuance.newDesign.draft.stepControls",
    title: "DashboardIssuance.newDesign.draft.titleControls",
  },
  {
    label: "DashboardIssuance.newDesign.draft.stepPermissions",
    title: "DashboardIssuance.newDesign.draft.titlePermissions",
  },
  {
    label: "DashboardIssuance.newDesign.draft.stepReview",
    title: "DashboardIssuance.newDesign.draft.titleReview",
  },
];

const LIST_PATH = "/dashboard/issuance";

function initialDraft(wallets: readonly PaymentsDashboardWallet[]): DraftState {
  const first = wallets[0]?.id ?? "";
  return {
    assetClass: "stablecoin",
    name: "",
    symbol: "",
    description: "",
    website: "",
    maxSupply: "",
    decimals: "6",
    allowlist: false,
    pauseTransfers: true,
    interestBearing: false,
    interestRate: "500",
    transferFee: false,
    transferFeeBasisPoints: "50",
    transferFeeMax: "100",
    issuerName: "",
    freezeAccounts: true,
    permanentDelegate: false,
    authorities: {
      "mint-authority": first,
      "metadata-authority": first,
      "freeze-authority": first,
      "permanent-delegate": first,
    },
  };
}

/**
 * The draft demo mode opens with, every step already filled in (a stablecoin, its details,
 * the sample wallets on its keys), so the flow can be walked to Create draft on Continue alone.
 */
function demoDraft(wallets: readonly PaymentsDashboardWallet[]): DraftState {
  return {
    ...initialDraft(wallets),
    name: "Harbor Dollar",
    symbol: "HRBR",
    description:
      "A dollar stablecoin for paying suppliers, backed one to one by cash at a regulated bank.",
    maxSupply: "10000000",
    issuerName: "Hoodies Inc",
    pegCurrency: "USD",
  };
}

/** What a step still needs before Continue, as the footer says it; null when it has it all. */
function stepBlocker(step: number, draft: DraftState, classified: boolean): MessageKey | null {
  if (step === 0 && !(classified && draft.name.trim())) {
    return "DashboardIssuance.newDesign.draft.needClassify";
  }
  if (step === 1) {
    const valid = draftSchema.safeParse(draft);
    const detailErrors = valid.success
      ? []
      : valid.error.issues.filter((issue) =>
          ["symbol", "decimals", "maxSupply", "description"].includes(String(issue.path[0]))
        );
    if (!(draft.symbol.trim() && draft.decimals.trim() && draft.issuerName?.trim())) {
      return "DashboardIssuance.newDesign.draft.needDetails";
    }
    if (detailErrors.length > 0) return "DashboardIssuance.newDesign.draft.fixDetails";
  }
  if (step === 3 && !draftSchema.safeParse(draft).success) {
    return "DashboardIssuance.newDesign.draft.needKeys";
  }
  return null;
}

/**
 * A new draft, as the design takes it: what the token is, its details, what it can do, who
 * holds its keys, then a review. Nothing reaches the chain; the draft is stored in SDP and
 * opens on its own page with Deploy token. The API takes only a complete draft, so one left
 * unfinished is kept in this browser, and opens again from Issuance (`resumeId`).
 */
export function IssuanceDraftFlow({
  wallets,
  walletsError,
  resumeId,
}: {
  wallets: PaymentsDashboardWallet[];
  walletsError: string | null;
  resumeId: string | null;
}) {
  // Browser storage is read after hydration, so the kept draft arrives a render late: hold on
  // to the first one found and remount the flow on it. Later writes (Save and exit again, or
  // the copy dropped once SDP stores it) leave the open flow alone.
  const { drafts } = useLocalDrafts();
  const stored = resumeId ? (drafts.find((entry) => entry.id === resumeId) ?? null) : null;
  const [resumeFrom, setResumeFrom] = useState<LocalDraft | null>(null);
  if (stored && resumeFrom === null) setResumeFrom(stored);

  return (
    <DraftFlow
      key={resumeFrom?.id ?? "fresh"}
      wallets={wallets}
      walletsError={walletsError}
      localId={resumeFrom?.id ?? resumeId}
      resumeFrom={resumeFrom}
    />
  );
}

function DraftFlow({
  wallets,
  walletsError,
  localId: keptId,
  resumeFrom,
}: {
  wallets: PaymentsDashboardWallet[];
  walletsError: string | null;
  localId: string | null;
  resumeFrom: LocalDraft | null;
}) {
  const t = useTranslations();
  const { sdpEnvironment } = useDashboardWorkspace();
  const {
    step,
    setStep,
    classified,
    setClassified,
    draft,
    setDraft,
    access,
    setAccess,
    storageKey,
    localId,
  } = useDraftFlowState(wallets, keptId, resumeFrom);
  const { pending, save, keepLocally } = useDraftSave({
    draft,
    access,
    step,
    storageKey,
    localId,
  });
  const update = (changes: Partial<DraftState>) =>
    setDraft((current) => ({ ...current, ...changes }));

  const savable = classified && draftSchema.safeParse(draft).success;

  // The draft flow sits at the top of the page, with no title over it: the design draws its
  // progress 48px from the top, 10px over its bar, and the step's heading 26px over the fields,
  // where the shared frame (under a Payments title) has 36, 8 and 24.
  return (
    <div
      className="h-full min-h-0 md:[&_[data-wizard-scroll-region]]:pt-12 [&_[data-wizard-stepper]>div:first-child]:gap-y-2.5 [&_[data-wizard-heading]]:mb-6.5"
      data-issuance-draft-flow
    >
      <WizardFrame
        steps={STEPS.map((entry) => ({ label: t(entry.label), title: t(entry.title) }))}
        currentStep={step}
        progressLabel={t("DashboardIssuance.newDesign.draft.stepOf", {
          current: step + 1,
          total: STEPS.length,
        })}
        footer={
          <DraftFlowFooter
            step={step}
            blocker={stepBlocker(step, draft, classified)}
            pending={pending}
            savable={savable}
            canKeepLocally={Boolean(storageKey)}
            onStep={setStep}
            onSave={save}
            onKeepLocally={keepLocally}
          />
        }
      >
        {step === 0 ? (
          <ClassifyStep
            draft={classified ? draft : { ...draft, assetClass: "" as DraftState["assetClass"] }}
            update={(changes) => {
              if (changes.assetClass) {
                setClassified(true);
                setAccess(changes.assetClass === "stablecoin" ? "blocklist" : "off");
              }
              update(changes);
            }}
          />
        ) : null}
        {step === 1 ? <DetailsStep draft={draft} update={update} /> : null}
        {step === 2 ? (
          <ControlsStep draft={draft} access={access} update={update} onAccess={setAccess} />
        ) : null}
        {step === 3 ? (
          <PermissionsStep
            draft={draft}
            wallets={wallets}
            walletsError={walletsError}
            update={update}
          />
        ) : null}
        {step === 4 ? (
          <ReviewStep
            draft={draft}
            access={access}
            wallets={wallets}
            environment={sdpEnvironment}
          />
        ) : null}
      </WizardFrame>
    </div>
  );
}

/**
 * Back, what the step still needs, then Exit (step one) or Save and exit, and Continue or,
 * on the last step, Create draft. Save and exit stores a complete draft in SDP and keeps an
 * unfinished one in this browser.
 */
function DraftFlowFooter({
  step,
  blocker,
  pending,
  savable,
  canKeepLocally,
  onStep,
  onSave,
  onKeepLocally,
}: {
  step: number;
  blocker: MessageKey | null;
  pending: boolean;
  savable: boolean;
  canKeepLocally: boolean;
  onStep: (step: number) => void;
  onSave: (destination: "list" | "token") => void;
  onKeepLocally: () => void;
}) {
  const t = useTranslations();
  const router = useRouter();
  const last = step === STEPS.length - 1;

  // The design's flow buttons keep the 40px height with 16px sides, 2px less than the shared
  // large button.
  return (
    <div className="flex flex-wrap items-center gap-4 [&_button]:[--button-padding-x-lg:1rem]">
      {step > 0 ? (
        <Button variant="outline" disabled={pending} onClick={() => onStep(step - 1)}>
          {t("DashboardIssuance.newDesign.draft.back")}
        </Button>
      ) : null}
      <p className="order-first w-full min-w-0 text-meta text-secondary md:order-none md:w-auto md:flex-1">
        {blocker ? t(blocker) : null}
      </p>
      <div className="ml-auto flex items-center gap-4">
        {step === 0 ? (
          <Button variant="outline" disabled={pending} onClick={() => router.push(LIST_PATH)}>
            {t("DashboardIssuance.newDesign.draft.exit")}
          </Button>
        ) : (
          <Button
            variant="outline"
            disabled={pending || !(savable || canKeepLocally)}
            onClick={() => (savable ? onSave("list") : onKeepLocally())}
          >
            {t("DashboardIssuance.newDesign.draft.saveAndExit")}
          </Button>
        )}
        {last ? (
          <Button disabled={pending || !savable} onClick={() => onSave("token")}>
            {pending
              ? t("DashboardIssuance.newDesign.draft.creating")
              : t("DashboardIssuance.newDesign.draft.createDraft")}
          </Button>
        ) : (
          <Button
            variant={blocker ? "outline" : "default"}
            disabled={pending || Boolean(blocker)}
            onClick={() => onStep(step + 1)}
          >
            {t("DashboardIssuance.newDesign.draft.continue")}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Where a draft goes when it leaves the flow: into SDP once it is complete (to its own page,
 * or back to Issuance), or into this browser while it is not. Storing it in SDP drops the
 * browser's copy.
 */
function useDraftSave({
  draft,
  access,
  step,
  storageKey,
  localId,
}: {
  draft: DraftState;
  access: DraftAccess;
  step: number;
  storageKey: string | null;
  localId: string;
}) {
  const t = useTranslations();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const keepLocally = () => {
    if (!storageKey) return;
    saveLocalDraft(storageKey, {
      id: localId,
      savedAt: new Date().toISOString(),
      step,
      access,
      draft,
    });
    toast.success(t("DashboardIssuance.newDesign.draft.savedLocally"), {
      description: t("DashboardIssuance.newDesign.draft.savedLocallyBody"),
      position: "bottom-right",
    });
    router.push(LIST_PATH);
  };

  const save = (destination: "list" | "token") =>
    startTransition(async () => {
      const result = await saveIssuanceDraft({ ...draft, allowlist: access === "allowlist" });
      if (result.state !== "success") {
        toast.error(t("DashboardIssuance.newDesign.draft.saveFailed"), {
          description: result.message,
          position: "bottom-right",
        });
        return;
      }
      if (storageKey) removeLocalDraft(storageKey, localId);
      const toToken = destination === "token";
      toast.success(
        toToken
          ? t("DashboardIssuance.newDesign.draft.created")
          : t("DashboardIssuance.newDesign.draft.saved"),
        {
          description: toToken
            ? t("DashboardIssuance.newDesign.draft.createdBody", { name: draft.name.trim() })
            : t("DashboardIssuance.newDesign.draft.savedBody"),
          position: "bottom-right",
        }
      );
      router.push(toToken && result.tokenId ? `${LIST_PATH}/${result.tokenId}` : LIST_PATH);
    });

  return { pending, save, keepLocally };
}

/**
 * The flow's state: the step, whether a classification was picked, the draft and its access
 * list, starting from the kept draft `resumeFrom` when there is one, and the id the browser
 * keeps it under.
 */
function useDraftFlowState(
  wallets: readonly PaymentsDashboardWallet[],
  keptId: string | null,
  resumeFrom: LocalDraft | null
) {
  // Demo mode starts a new draft filled in; a kept draft opens as it was left.
  const demo = usePaymentsDemo();
  const [step, setStep] = useState(() =>
    resumeFrom ? Math.min(Math.max(resumeFrom.step, 0), STEPS.length - 1) : 0
  );
  const [classified, setClassified] = useState(resumeFrom !== null || demo);
  const [draft, setDraft] = useState<DraftState>(() =>
    resumeFrom
      ? restoreDraft(
          initialDraft(wallets),
          resumeFrom.draft,
          new Set(wallets.map((wallet) => wallet.id))
        )
      : demo
        ? demoDraft(wallets)
        : initialDraft(wallets)
  );
  const [access, setAccess] = useState<DraftAccess>(resumeFrom?.access ?? "blocklist");
  const { storageKey } = useLocalDrafts();
  const [localId] = useState(() => keptId ?? crypto.randomUUID());

  return {
    step,
    setStep,
    classified,
    setClassified,
    draft,
    setDraft,
    access,
    setAccess,
    storageKey,
    localId,
  };
}
