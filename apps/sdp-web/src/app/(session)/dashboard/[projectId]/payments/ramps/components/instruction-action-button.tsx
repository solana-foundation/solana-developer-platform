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
  doneLabel: string;
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
  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      iconLeft={action.succeeded ? <CheckCircle2Icon /> : action.icon}
      onClick={action.onClick}
      disabled={action.disabled || action.succeeded}
      loading={action.loading}
    >
      {action.succeeded ? action.doneLabel : action.idleLabel}
    </Button>
  );
}
