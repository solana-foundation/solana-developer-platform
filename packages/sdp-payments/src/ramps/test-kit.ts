import type { SdpEnvironment } from "@sdp/types";
import type { RampDirection } from "@sdp/types/ramp-requirements";
import type {
  RampEstimateOfframpInput,
  RampEstimateOnrampInput,
  RampOfframpQuoteInput,
  RampOnrampQuoteInput,
} from "./types";

/** One recorded provider exchange: the request it answers and the provider's reply. */
export interface RecordedExchange {
  method: "GET" | "POST";
  url: RegExp;
  status: number;
  body: unknown;
}

/** A request an adapter made while a kit was replaying. */
export interface ReplayedRequest {
  method: string;
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
  /** Credentials for both modes. */
  env: Record<string, string>;
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
  /** An estimate reply with one field the adapter reads given the wrong type. */
  malformedEstimate: { direction: RampDirection; exchange: RecordedExchange };
}

/** The live state of one replay. */
export interface Replay {
  /** Requests the kit answered, in order. */
  requests: ReplayedRequest[];
  /** Requests no recorded exchange matched, as `METHOD url`. */
  unrecorded: string[];
  /** Whether every recorded exchange was used. */
  exhausted: () => boolean;
}

/**
 * Replaces `fetch` with a replay of `exchanges`, in order. A request that does
 * not match the next exchange is recorded as unrecorded and answered 599, so
 * the adapter fails and the suite can name the request.
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
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method === undefined ? "GET" : init.method;
    const exchange = exchanges[replay.requests.length];
    if (exchange === undefined || exchange.method !== method || !exchange.url.test(url)) {
      replay.unrecorded.push(`${method} ${url}`);
      return new Response("unrecorded request", { status: 599 });
    }
    replay.requests.push({ method, url, headers: new Headers(init?.headers) });
    return new Response(JSON.stringify(exchange.body), {
      status: exchange.status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return replay;
}
