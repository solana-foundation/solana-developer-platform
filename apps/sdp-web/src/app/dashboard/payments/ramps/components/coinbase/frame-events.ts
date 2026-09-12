import type { CoinbaseRampEvent } from "@sdp/types";
import { toast } from "sonner";
import { z } from "zod";
import { postCoinbaseRampEvent } from "@/app/dashboard/payments/payments-workspace.data";
import type { MessageKey, TranslationValues } from "@/i18n/messages";

const coinbaseFrameEventSchema = z.discriminatedUnion("eventName", [
  z.object({
    eventName: z.enum([
      "onramp_api.load_pending",
      "onramp_api.load_success",
      "onramp_api.apple_pay_button_pressed",
      "onramp_api.pending_payment_auth",
      "onramp_api.payment_authorized",
      "onramp_api.commit_success",
      "onramp_api.cancel",
      "onramp_api.polling_start",
      "onramp_api.polling_success",
      // Embedded-mode progress events: Coinbase verifies the buyer's phone and email and
      // runs its limits-upgrade form inside the frame before the payment step.
      "onramp_api.verification_success",
      "onramp_api.upgrade_submit_success",
      "onramp_api.upgrade_approved",
    ]),
  }),
  z.object({
    eventName: z.enum([
      "onramp_api.load_error",
      "onramp_api.commit_error",
      "onramp_api.polling_error",
      // Embedded-mode terminal error: verification, limits, or order preparation failed
      // and the hosted flow cannot continue.
      "onramp_api.session_error",
    ]),
    data: z.object({
      errorCode: z.string(),
      errorMessage: z.string(),
    }),
  }),
]);

export type CoinbaseFrameEvent = z.infer<typeof coinbaseFrameEventSchema>;
type CoinbaseFrameError = Extract<CoinbaseFrameEvent, { data: unknown }>["data"];
type Translate = (key: MessageKey, values?: TranslationValues) => string;

/**
 * The reason recorded and shown for a Coinbase error event. Coinbase's localized message
 * when it has one; the error code otherwise, so the ramp-events endpoint (which requires a
 * non-empty reason) never rejects the report and the operator never sees a blank notice.
 */
export function coinbaseErrorReason(data: CoinbaseFrameError): string {
  const message = data.errorMessage.trim();
  return message.length > 0 ? message : data.errorCode;
}
/** Posts a Coinbase ramp event to the SDP ramp-events endpoint. */
export type PostCoinbaseRampEvent = typeof postCoinbaseRampEvent;

export interface CoinbaseFrameEventOptions {
  /** Event poster; defaults to the workspace's ramp-events client. Tests inject a spy here. */
  postEvent?: PostCoinbaseRampEvent;
}

/**
 * Parses a raw postMessage payload from the Coinbase payment-link iframe.
 *
 * The web component posts events as stringified JSON (`'{"eventName":"onramp_api.*"}'`),
 * never objects, so anything non-string is foreign noise. Payloads that fail to parse or
 * carry an unrecognized event name return null — Coinbase may add event names, and
 * unknown ones must not break the frame.
 */
function parseCoinbaseFrameEvent(raw: unknown): CoinbaseFrameEvent | null {
  if (typeof raw !== "string") {
    return null;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = coinbaseFrameEventSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

function reportRampEvent(
  event: CoinbaseRampEvent,
  t: Translate,
  postEvent: PostCoinbaseRampEvent
): void {
  postEvent(event, t).catch((error) => {
    toast.error(t("DashboardPayments.ramps.coinbaseEventFailed"), {
      description:
        error instanceof Error ? error.message : t("DashboardPayments.ramps.eventRequestFailed"),
      position: "bottom-right",
    });
  });
}

/**
 * Handles a raw postMessage payload from the Coinbase payment-link iframe, forwarding
 * provisional transfer transitions to the SDP ramp-events endpoint keyed by the
 * create-order id: commit_success marks the transfer settling, commit_error and the
 * embedded flow's session_error record the failure with Coinbase's localized error message.
 *
 * polling_success / polling_error are deliberately NOT reported: the iframe's polling is
 * a client-side convenience whose errors can be transient (network) while the charge
 * succeeded, and its success carries no settled amount. The server-side
 * `onramp.transaction.*` webhook is the settlement authority — it completes or fails the
 * transfer with the actual delivered crypto amount, which a client-set terminal status
 * would permanently block.
 *
 * Load-phase and progress events (load_*, apple_pay_button_pressed, pending_payment_auth,
 * payment_authorized, cancel, polling_start, and the embedded verification_success,
 * upgrade_submit_success, upgrade_approved) don't change the transfer's state and are
 * intentionally not reported. In particular load_error can be transient: an
 * ERROR_CODE_GUEST_APPLE_PAY_NOT_SUPPORTED is followed by a successful QR-code fallback
 * render on web.
 *
 * Returns the parsed event (null for foreign messages) so the frame can react to
 * UI-phase transitions like `apple_pay_button_pressed`, `cancel` and `session_error`.
 *
 * @see https://docs.cdp.coinbase.com/onramp/headless-onramp/overview#post-message-events
 */
export function handleCoinbaseFrameEvent(
  orderId: string,
  raw: unknown,
  t: Translate,
  { postEvent = postCoinbaseRampEvent }: CoinbaseFrameEventOptions = {}
): CoinbaseFrameEvent | null {
  const event = parseCoinbaseFrameEvent(raw);
  if (!event) {
    return null;
  }
  switch (event.eventName) {
    case "onramp_api.commit_success":
      reportRampEvent({ kind: "committed", orderId }, t, postEvent);
      break;
    case "onramp_api.commit_error":
    case "onramp_api.session_error":
      reportRampEvent(
        { kind: "errored", orderId, reason: coinbaseErrorReason(event.data) },
        t,
        postEvent
      );
      break;
    case "onramp_api.load_pending":
    case "onramp_api.load_success":
    case "onramp_api.load_error":
    case "onramp_api.apple_pay_button_pressed":
    case "onramp_api.pending_payment_auth":
    case "onramp_api.payment_authorized":
    case "onramp_api.cancel":
    case "onramp_api.polling_start":
    case "onramp_api.polling_success":
    case "onramp_api.polling_error":
    case "onramp_api.verification_success":
    case "onramp_api.upgrade_submit_success":
    case "onramp_api.upgrade_approved":
      break;
    default: {
      const exhaustive: never = event;
      throw new Error(`Unhandled Coinbase frame event: ${JSON.stringify(exhaustive)}`);
    }
  }
  return event;
}
