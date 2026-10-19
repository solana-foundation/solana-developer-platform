import type { SdpEnvironment } from "@sdp/types/api-keys";
import type { PaymentRampQuote, RampDirection } from "@sdp/types/payments";
import type {
  RampEstimateOfframpInput,
  RampEstimateOnrampInput,
  RampOfframpQuoteInput,
  RampOnrampQuoteInput,
} from "./types";

// biome-ignore lint/security/noSecrets: the public wallet every kit quotes to, not a credential.
export const CONTRACT_WALLET = "8mSiNWTeu59yy1pxsoNCyy7KNMnKvfgGu8Ej975LsufM";

/** A recorded request field: one exact value, or every value in order. */
export type RecordedValue = string | readonly string[];

/** One recorded provider exchange: the request it answers and the provider's reply. */
export interface RecordedExchange {
  method: "GET" | "POST";
  /** Matches the whole request URL, scheme and host included. */
  url: RegExp;
  /** Query parameters the request must carry. */
  query?: Readonly<Record<string, RecordedValue>>;
  /** Form-encoded body fields the request must carry. */
  form?: Readonly<Record<string, RecordedValue>>;
  status: number;
  body: Record<string, unknown>;
}

/** A request an adapter made while a kit was replaying. */
export interface ReplayedRequest {
  method: RecordedExchange["method"];
  url: string;
  headers: Headers;
}

/** One estimate or quote case: its input and the exchanges it makes, in order. */
export interface RampKitCase<TInput> {
  input: TInput;
  exchanges: readonly RecordedExchange[];
}

/**
 * What the ramp contract suite replays for one provider. Each direction the
 * provider runs has an estimate case and a quote case.
 */
export interface RampProviderTestKit {
  /** The managed credentials, for every mode in `managedModes`. */
  env: Record<string, string>;
  /** The modes SDP holds credentials for. Every other mode must fail closed before any request. */
  managedModes: readonly SdpEnvironment[];
  onramp?: {
    estimate: RampKitCase<RampEstimateOnrampInput>;
    quote: RampKitCase<RampOnrampQuoteInput>;
  };
  offramp?: {
    estimate: RampKitCase<RampEstimateOfframpInput>;
    quote: RampKitCase<RampOfframpQuoteInput>;
  };
  /** Whether a request carries the credential the adapter must use for `mode`. */
  usesModeCredential: (request: ReplayedRequest, mode: SdpEnvironment) => boolean;
  /**
   * Whether a quote carries the credential the adapter must use for `mode`.
   * Required when the provider builds quotes without a request.
   */
  quoteUsesModeCredential?: (quote: PaymentRampQuote, mode: SdpEnvironment) => boolean;
  /** An estimate reply with one field the adapter reads given the wrong type. */
  malformedEstimate: { direction: RampDirection; exchange: RecordedExchange };
}

/** The live state of one replay. */
export interface Replay {
  /** Requests the kit answered, in order. */
  requests: ReplayedRequest[];
  /** Requests no recorded exchange matched, with the reason. */
  unrecorded: string[];
  /** Whether every recorded exchange was used. */
  exhausted: () => boolean;
}

/** A request as the replay compares it with a recorded exchange. */
interface CapturedRequest {
  method: string;
  url: string;
  body: string;
}

function fieldMismatch(
  where: "query" | "form",
  recorded: Readonly<Record<string, RecordedValue>> | undefined,
  actual: URLSearchParams
): string | undefined {
  for (const [name, value] of Object.entries(recorded ?? {})) {
    const expected = typeof value === "string" ? [value] : value;
    const sent = actual.getAll(name);
    if (sent.length !== expected.length || sent.some((item, index) => item !== expected[index])) {
      return `${where} ${name} is ${JSON.stringify(sent)}, recorded ${JSON.stringify(expected)}`;
    }
  }
  return undefined;
}

function requestMismatch(exchange: RecordedExchange, request: CapturedRequest): string | undefined {
  if (exchange.method !== request.method) {
    return `recorded a ${exchange.method}`;
  }
  if (!exchange.url.test(request.url)) {
    return `recorded a URL matching ${exchange.url}`;
  }
  return (
    fieldMismatch("query", exchange.query, new URL(request.url).searchParams) ??
    fieldMismatch("form", exchange.form, new URLSearchParams(request.body))
  );
}

/**
 * Replaces `fetch` with a replay of `exchanges`, in order. A request that does
 * not match the next exchange's method, URL, query and form fields is recorded
 * as unrecorded and answered 599, so the adapter fails and the suite can name
 * the request.
 *
 * @param exchanges - The recorded exchanges to answer with.
 * @returns The replay's live state.
 */
export function replayExchanges(exchanges: readonly RecordedExchange[]): Replay {
  const replay: Replay = {
    requests: [],
    unrecorded: [],
    exhausted: () => replay.requests.length === exchanges.length,
  };
  globalThis.fetch = async (input, init) => {
    const request: CapturedRequest = {
      method: init?.method === undefined ? "GET" : init.method,
      url: input instanceof Request ? input.url : String(input),
      body:
        init?.body === undefined || init.body === null ? "" : await new Response(init.body).text(),
    };
    const exchange = exchanges[replay.requests.length];
    const mismatch =
      exchange === undefined ? "no recorded exchange is left" : requestMismatch(exchange, request);
    if (exchange === undefined || mismatch !== undefined) {
      replay.unrecorded.push(`${request.method} ${request.url}: ${mismatch}`);
      return new Response("unrecorded request", { status: 599 });
    }
    replay.requests.push({
      method: exchange.method,
      url: request.url,
      headers: new Headers(init?.headers),
    });
    return new Response(JSON.stringify(exchange.body), {
      status: exchange.status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return replay;
}
