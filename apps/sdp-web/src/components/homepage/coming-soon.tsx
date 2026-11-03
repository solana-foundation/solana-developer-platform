import { cn } from "@sdp/ui/cn";
import shared from "./homepage.module.css";

/**
 * The pill beside a module the deployment's release channel does not run yet. It holds no logic,
 * so server sections and the client drawings render the same pill from a label they already have.
 *
 * @param props.label - The translated "Coming soon".
 * @param props.className - Placement from the section that sets it.
 * @returns The pill.
 */
export function ComingSoon({ label, className }: { label: string; className?: string }) {
  return <span className={cn(shared.soon, className)}>{label}</span>;
}
