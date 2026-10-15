import { CheckCircle2Icon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

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
      disabled={action.disabled || action.loading || action.succeeded}
    >
      {action.succeeded ? action.doneLabel : action.loading ? action.busyLabel : action.idleLabel}
    </Button>
  );
}
