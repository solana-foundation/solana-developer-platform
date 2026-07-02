"use client";

import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useState,
} from "react";
import {
  createInitialDraft,
  type DetailsStage,
  type DraftState,
  furthestReachableStep,
  stepIndex,
  WIZARD_STEPS,
  type WizardStep,
} from "./issuance-draft-wizard.types";

const STORAGE_KEY = "sdp:issuance:create-draft:v1";
const STORAGE_VERSION = 1;

interface WizardState {
  draft: DraftState;
  currentStep: WizardStep;
  detailsStage: DetailsStage;
  maxStepReached: WizardStep;
  updatedAt: string | null;
}

type Action =
  | { type: "updateDraft"; patch: Partial<DraftState> }
  | { type: "goToStep"; step: WizardStep }
  | { type: "advance" }
  | { type: "goBack" }
  | { type: "reset" }
  | { type: "hydrate"; state: WizardState };

function createInitialState(): WizardState {
  return {
    draft: createInitialDraft(),
    currentStep: "classification",
    detailsStage: "select",
    maxStepReached: "classification",
    updatedAt: null,
  };
}

function furthestOf(a: WizardStep, b: WizardStep): WizardStep {
  return stepIndex(a) >= stepIndex(b) ? a : b;
}

function reducer(state: WizardState, action: Action): WizardState {
  switch (action.type) {
    case "updateDraft": {
      const draft = { ...state.draft, ...action.patch };
      return { ...state, draft, updatedAt: new Date().toISOString() };
    }
    case "goToStep": {
      // Only allow navigating to a step already reached. Jumping into
      // asset-details (e.g. an "Edit" from Review) lands on the form view.
      const target =
        stepIndex(action.step) <= stepIndex(state.maxStepReached)
          ? action.step
          : state.maxStepReached;
      const detailsStage = target === "asset-details" ? "form" : state.detailsStage;
      return { ...state, currentStep: target, detailsStage };
    }
    case "advance": {
      // Sub-step advance inside asset-details: selector -> form.
      if (state.currentStep === "asset-details" && state.detailsStage === "select") {
        return { ...state, detailsStage: "form" };
      }
      const nextIndex = Math.min(stepIndex(state.currentStep) + 1, WIZARD_STEPS.length - 1);
      const nextStep = WIZARD_STEPS[nextIndex];
      const detailsStage = nextStep === "asset-details" ? "select" : state.detailsStage;
      return {
        ...state,
        currentStep: nextStep,
        detailsStage,
        maxStepReached: furthestOf(state.maxStepReached, nextStep),
      };
    }
    case "goBack": {
      // Sub-step back inside asset-details: form -> selector.
      if (state.currentStep === "asset-details" && state.detailsStage === "form") {
        return { ...state, detailsStage: "select" };
      }
      const prevIndex = Math.max(stepIndex(state.currentStep) - 1, 0);
      const prevStep = WIZARD_STEPS[prevIndex];
      const detailsStage = prevStep === "asset-details" ? "form" : state.detailsStage;
      return { ...state, currentStep: prevStep, detailsStage };
    }
    case "reset":
      return createInitialState();
    case "hydrate":
      return action.state;
    default:
      return state;
  }
}

function isWizardStep(value: unknown): value is WizardStep {
  return typeof value === "string" && (WIZARD_STEPS as readonly string[]).includes(value);
}

function isDetailsStage(value: unknown): value is DetailsStage {
  return value === "select" || value === "form";
}

// Parse + validate a persisted payload, clamping the restored step to what the
// restored draft actually supports so a stale entry can't land the user on a
// step whose prerequisites are unmet.
function readStoredState(): WizardState | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as {
      version?: number;
      draft?: Partial<DraftState>;
      currentStep?: unknown;
      detailsStage?: unknown;
      maxStepReached?: unknown;
      updatedAt?: unknown;
    };
    if (parsed.version !== STORAGE_VERSION || typeof parsed.draft !== "object" || !parsed.draft) {
      return null;
    }

    const draft: DraftState = { ...createInitialDraft(), ...parsed.draft };
    const ceiling = furthestReachableStep(draft);
    const storedCurrent = isWizardStep(parsed.currentStep) ? parsed.currentStep : "classification";
    const storedMax = isWizardStep(parsed.maxStepReached) ? parsed.maxStepReached : storedCurrent;

    const clamp = (step: WizardStep): WizardStep =>
      stepIndex(step) <= stepIndex(ceiling) ? step : ceiling;

    return {
      draft,
      currentStep: clamp(storedCurrent),
      detailsStage: isDetailsStage(parsed.detailsStage) ? parsed.detailsStage : "select",
      maxStepReached: clamp(furthestOf(storedMax, storedCurrent)),
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
    };
  } catch {
    return null;
  }
}

function writeStoredState(state: WizardState): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: STORAGE_VERSION, ...state })
    );
  } catch {
    // Storage full / unavailable (private mode) — persistence is best-effort.
  }
}

function clearStoredState(): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

export interface IssuanceDraftContextValue {
  draft: DraftState;
  currentStep: WizardStep;
  detailsStage: DetailsStage;
  maxStepReached: WizardStep;
  updatedAt: string | null;
  updateDraft: (patch: Partial<DraftState>) => void;
  goToStep: (step: WizardStep) => void;
  advance: () => void;
  goBack: () => void;
  reset: () => void;
}

const IssuanceDraftContext = createContext<IssuanceDraftContextValue | null>(null);

export function IssuanceDraftProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, createInitialState);
  // `hydrated` is state (not a ref) so the persist effect below reads `false`
  // on the first commit and skips writing defaults over a stored draft.
  const [hydrated, setHydrated] = useState(false);

  // Hydrate once, after mount (SSR-safe — the first client render matches the
  // server's default output, then we restore from localStorage).
  useEffect(() => {
    const stored = readStoredState();
    if (stored) {
      dispatch({ type: "hydrate", state: stored });
    }
    setHydrated(true);
  }, []);

  // Persist every change once hydration has run.
  useEffect(() => {
    if (!hydrated) {
      return;
    }
    writeStoredState(state);
  }, [state, hydrated]);

  const value = useMemo<IssuanceDraftContextValue>(
    () => ({
      draft: state.draft,
      currentStep: state.currentStep,
      detailsStage: state.detailsStage,
      maxStepReached: state.maxStepReached,
      updatedAt: state.updatedAt,
      updateDraft: (patch) => dispatch({ type: "updateDraft", patch }),
      goToStep: (step) => dispatch({ type: "goToStep", step }),
      advance: () => dispatch({ type: "advance" }),
      goBack: () => dispatch({ type: "goBack" }),
      reset: () => {
        clearStoredState();
        dispatch({ type: "reset" });
      },
    }),
    [state]
  );

  return createElement(IssuanceDraftContext.Provider, { value }, children);
}

export function useIssuanceDraft(): IssuanceDraftContextValue {
  const value = useContext(IssuanceDraftContext);
  if (!value) {
    throw new Error("useIssuanceDraft must be used within an IssuanceDraftProvider");
  }
  return value;
}
