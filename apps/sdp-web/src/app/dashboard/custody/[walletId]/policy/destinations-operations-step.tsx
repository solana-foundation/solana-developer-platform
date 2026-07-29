"use client";

import { DestinationEditor } from "./destination-editor";
import { OperationEditor } from "./operation-editor";
import type { PolicyAuthoringState, validatePolicyState } from "./wallet-policy-authoring";
import { EmptyStepState } from "./wallet-policy-flow.shared";

export function DestinationsAndOperationsStep({
  state,
  setPolicyState,
  errors,
  complianceScreeningEnabled,
}: {
  state: PolicyAuthoringState;
  setPolicyState: (update: (current: PolicyAuthoringState) => PolicyAuthoringState) => void;
  errors: ReturnType<typeof validatePolicyState>;
  complianceScreeningEnabled: boolean;
}) {
  const showDestinations = state.categories.includes("destinations");
  const showOperations = state.categories.includes("operations");

  if (!showDestinations && !showOperations) return <EmptyStepState />;

  return (
    <div className="space-y-6">
      {showDestinations ? (
        <DestinationEditor
          state={state}
          setPolicyState={setPolicyState}
          complianceScreeningEnabled={complianceScreeningEnabled}
        />
      ) : null}
      {showOperations ? (
        <OperationEditor state={state} error={errors.operations} setPolicyState={setPolicyState} />
      ) : null}
    </div>
  );
}
