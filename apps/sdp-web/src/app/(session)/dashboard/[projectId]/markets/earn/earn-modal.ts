import type { Modal } from "@sdp/ui/modal";
import type { ComponentProps } from "react";

/**
 * The frame every Earn transaction dialog shares (deposit, withdrawal, the exit chooser, queued
 * and par requests, custodial withdrawal), and the placeholder shown while one loads: one
 * width, so moving between them or from the placeholder to the dialog never resizes it, and a
 * top edge that stays put while a step's height changes.
 */
export const EARN_TRANSACTION_MODAL_FRAME = {
  placement: "top",
  size: "md",
} as const satisfies Pick<ComponentProps<typeof Modal>, "placement" | "size">;
