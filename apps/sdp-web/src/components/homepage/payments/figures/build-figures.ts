/*
 * Draws every payment kind's figure as SVG markup. Loaded with a dynamic import only when the
 * bench nears the screen, so the kit stays out of the initial bundle.
 */
import type { PaymentKind } from "@/components/homepage/payments/kinds";
import type { SceneInput } from "./scene-input";
import { batchScene } from "./scenes/batch";
import { depositScene } from "./scenes/deposit";
import { microScene } from "./scenes/micro";
import { payScene } from "./scenes/pay";
import { recurringScene } from "./scenes/recurring";
import { requestScene } from "./scenes/request";

const SCENES = {
  pay: payScene,
  request: requestScene,
  recurring: recurringScene,
  batch: batchScene,
  micro: microScene,
  deposit: depositScene,
} as const satisfies Record<PaymentKind, (input: SceneInput) => string>;

/** One kind's figure; a drawing error escapes to the caller. */
export function buildFigure(kind: PaymentKind, input: SceneInput): string {
  return SCENES[kind](input);
}
