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
 * opens on its own page with Deploy token.
 */
export function IssuanceDraftFlow({
  wallets,
  walletsError,
}: {
  wallets: PaymentsDashboardWallet[];
  walletsError: string | null;
}) {
  const t = useTranslations();
  const router = useRouter();
  const { sdpEnvironment } = useDashboardWorkspace();
  const [step, setStep] = useState(0);
  const [classified, setClassified] = useState(false);
  const [draft, setDraft] = useState<DraftState>(() => initialDraft(wallets));
  const [access, setAccess] = useState<DraftAccess>("blocklist");
  const [pending, startTransition] = useTransition();
  const update = (changes: Partial<DraftState>) =>
    setDraft((current) => ({ ...current, ...changes }));

  const blocker = stepBlocker(step, draft, classified);
  const savable = classified && draftSchema.safeParse(draft).success;
  const last = step === STEPS.length - 1;

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
      toast.success(
        destination === "token"
          ? t("DashboardIssuance.newDesign.draft.created")
          : t("DashboardIssuance.newDesign.draft.saved"),
        {
          description:
            destination === "token"
              ? t("DashboardIssuance.newDesign.draft.createdBody", { name: draft.name.trim() })
              : t("DashboardIssuance.newDesign.draft.savedBody"),
          position: "bottom-right",
        }
      );
      router.push(
        destination === "token" && result.tokenId ? `${LIST_PATH}/${result.tokenId}` : LIST_PATH
      );
    });

  const footer = (
    <div className="flex flex-wrap items-center gap-4">
      {step > 0 ? (
        <Button variant="outline" disabled={pending} onClick={() => setStep(step - 1)}>
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
          <Button variant="outline" disabled={pending || !savable} onClick={() => save("list")}>
            {t("DashboardIssuance.newDesign.draft.saveAndExit")}
          </Button>
        )}
        {last ? (
          <Button disabled={pending || !savable} onClick={() => save("token")}>
            {pending
              ? t("DashboardIssuance.newDesign.draft.creating")
              : t("DashboardIssuance.newDesign.draft.createDraft")}
          </Button>
        ) : (
          <Button
            variant={blocker ? "outline" : "default"}
            disabled={pending || Boolean(blocker)}
            onClick={() => setStep(step + 1)}
          >
            {t("DashboardIssuance.newDesign.draft.continue")}
          </Button>
        )}
      </div>
    </div>
  );

  return (
    <div className="h-full min-h-0" data-issuance-draft-flow>
      <WizardFrame
        steps={STEPS.map((entry) => ({ label: t(entry.label), title: t(entry.title) }))}
        currentStep={step}
        progressLabel={t("DashboardIssuance.newDesign.draft.stepOf", {
          current: step + 1,
          total: STEPS.length,
        })}
        footer={footer}
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
