import type { z } from "zod";
import type {
  SafeProxyCaller,
  SafeProxyCatalog,
  SafeProxyOperation,
  SafeProxySection,
} from "./catalog";
import type { SafeProxyDeclaredFields } from "./envelope";

export type SafeProxyHandlerRequest<Operation extends SafeProxyOperation> = {
  requestId: string;
  caller: SafeProxyCaller;
  /** Aborts when the call's budget runs out. A handler passes it to its one outbound call. */
  signal: AbortSignal;
  input: z.output<Operation["request"]>;
} & SafeProxyDeclaredFields<Operation>;

/** Answers with the operation's response, or throws a `SafeProxyError` naming the code and outcome. */
export type SafeProxyHandler<Operation extends SafeProxyOperation> = (
  request: SafeProxyHandlerRequest<Operation>
) => Promise<z.input<Operation["response"]>>;

/** What sdp-safe-proxy must supply: one handler per catalog operation, or it does not compile. */
export type SafeProxyHandlers = {
  readonly [Section in SafeProxySection]: {
    readonly [Name in keyof SafeProxyCatalog[Section]]: SafeProxyCatalog[Section][Name] extends SafeProxyOperation
      ? SafeProxyHandler<SafeProxyCatalog[Section][Name]>
      : never;
  };
};
