import { Button } from "@sdp/ui/button";
import { CheckCircle2Icon } from "lucide-react";
import type { ReactNode } from "react";

export interface InstructionAction {
  loading: boolean;
  succeeded: boolean;
  disabled?: boolean;
  onClick: () => void;
  icon: ReactNode;
  idleLabel: string;
  busyLabel: string;
  doneLabel: string;
}

type InstructionActionState = "idle" | "busy" | "done";

function instructionActionState(action: InstructionAction): InstructionActionState {
  if (action.succeeded) return "done";
  if (action.loading) return "busy";
  return "idle";
}

export function InstructionActionButton({
  action,
  variant = "secondary",
  size = "xs",
}: {
  action: InstructionAction;
  variant?: "default" | "secondary";
  size?: "default" | "xs";
}) {
  const state = instructionActionState(action);
  let label: string;
  switch (state) {
    case "idle":
      label = action.idleLabel;
      break;
    case "busy":
      label = action.busyLabel;
      break;
    case "done":
      label = action.doneLabel;
      break;
    default: {
      const exhaustive: never = state;
      throw new Error(`Unknown instruction action state: ${exhaustive}`);
    }
  }

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      iconLeft={action.succeeded ? <CheckCircle2Icon /> : action.icon}
      onClick={action.onClick}
      disabled={action.disabled || action.loading || action.succeeded}
    >
      {label}
    </Button>
  );
}
