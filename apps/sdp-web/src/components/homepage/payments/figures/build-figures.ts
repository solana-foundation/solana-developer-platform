/*
 * Draws every payment kind's figure as SVG markup. Loaded with a dynamic import only when the
 * bench nears the screen, so the kit stays out of the initial bundle.
 */
import type { PaymentKind } from "../kinds";
import type { FigFonts } from "./make-fig";
import type { FigureCopy } from "./scene-input";
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
} satisfies Record<PaymentKind, unknown>;

/** One kind's figure, or null if its drawing fails (the stage then stays empty for that kind). */
export function buildFigure(
  kind: PaymentKind,
  input: { fonts: FigFonts; label: string; copy: FigureCopy }
): string | null {
  try {
    return SCENES[kind](input);
  } catch (error) {
    console.error("payments figure", kind, error);
    return null;
  }
}
