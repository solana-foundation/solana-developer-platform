// The loop of `DESIGN.md`, 4.1, one call at a time: each call shows its curl, its answer, and what
// `next` asks the caller to do. A switch runs the loop alone.

import { useCallback, useEffect, useState } from "react";

import { type Answer, api, type Recipe, ServiceError, type SignStep } from "@/api";
import { Code, Snippets } from "@/components/Code";
import { Instructions, StepRows, VerifiedResult } from "@/components/Plan";
import { explorerUrl } from "@/known";
import { type Call, continueBody, loadCalls, saveCalls } from "@/loop";
import { compileSnippets, continueCurl, sendSnippets, startCurl } from "@/snippets";
import { type Verified, verifyPlan } from "@/verifier";

interface Props {
  request: object;
  requestKey: string;
  recipe: Recipe | null;
  tamper: boolean;
  ready: boolean;
  onSent: (signature: string) => void;
}

/// What each kind of `next` asks the caller to do.
const TODO: Record<Answer["next"]["kind"], string> = {
  sign: "Verify each step against your own RPC, sign it, and send it yourself. Then call continue with progress and the signatures. The playground signs with its local wallets and sends through /v1/send.",
  wait: "Nothing to sign. `until` is the condition that the step waits for. Watch it yourself, or call continue again at `checkAfter`.",
  done: "The flow is done. Drop progress.",
};

/// The signature of each step of the latest `sign`, by position, once the step is sent.
type Sent = Record<number, string>;

export function Loop(props: Props) {
  const loop = useLoop(props);
  const [auto, setAuto] = useState(false);
  const { calls, answer, busy, sent } = loop;

  useAutoLoop({ ...loop, auto });

  return (
    <div className="loop">
      <div>
        <div className="section-title">The loop</div>
        <div className="section-sub">
          Every call answers <code>progress</code> and <code>next</code>. Keep progress, and do what
          next says.
        </div>
      </div>
      <AutoSwitch auto={auto} onAuto={setAuto} />

      {calls.length === 0 && <StartPanel {...props} busy={busy} onStart={loop.start} />}
      {calls.map((made, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a call's position in the loop is its identity.
        <CallCard key={index} number={index + 1} call={made} />
      ))}

      {answer !== null && (
        <NextPanel
          answer={answer}
          recipe={props.recipe}
          busy={busy}
          sent={sent}
          verified={loop.verified}
          onVerify={loop.verify}
          onSend={loop.send}
          onContinue={() => loop.resume(Object.values(sent))}
        />
      )}
      {calls.length > 0 && (
        <button type="button" className="btn btn-sec-sm" onClick={loop.clear}>
          Start over
        </button>
      )}
    </div>
  );
}

/// The calls of the loop, kept in storage for a refresh, and the actions on the latest answer.
function useLoop(props: Props) {
  const [calls, setCalls] = useState<Call[]>(() => loadCalls(props.requestKey));
  const [busy, setBusy] = useState<string | null>(null);
  const [sent, setSent] = useState<Sent>({});
  const [verified, setVerified] = useState<Record<number, Verified>>({});
  const answer = calls.at(-1)?.answer ?? null;
  const steps = answer?.next.kind === "sign" ? answer.next.steps : [];

  useEffect(() => setCalls(loadCalls(props.requestKey)), [props.requestKey]);
  useEffect(() => saveCalls(props.requestKey, calls), [props.requestKey, calls]);

  const call = useCallback((route: Call["route"], body: unknown, request: Promise<Answer>) => {
    const push = (made: Call) => {
      setCalls((previous) => [...previous, made]);
      setSent({});
      setVerified({});
    };

    setBusy(route);
    return request
      .then((answered) => push({ route, body, answer: answered, error: null }))
      .catch((error: unknown) => push({ route, body, answer: null, error: describe(error) }))
      .finally(() => setBusy(null));
  }, []);

  const resume = useCallback(
    (signatures: string[]) => {
      if (answer === null) return Promise.resolve();
      const body = continueBody(answer, signatures);

      return call("continue", body, api.resume(body));
    },
    [answer, call]
  );

  const verify = (index: number) =>
    verifyStep(steps[index]).then((result) => setVerified((all) => ({ ...all, [index]: result })));
  const send = (index: number) =>
    sendStep(steps[index]).then((signature) => {
      setSent((all) => ({ ...all, [index]: signature }));
      props.onSent(signature);
      return signature;
    });

  return {
    calls,
    answer,
    steps,
    busy,
    sent,
    verified,
    setBusy,
    resume,
    verify,
    send,
    start: () => call("start", props.request, api.start(props.request, props.tamper)),
    clear: () => setCalls([]),
  };
}

/// In auto mode, signs and sends each step, waits until `checkAfter`, and continues, until done.
function useAutoLoop(loop: {
  auto: boolean;
  busy: string | null;
  answer: Answer | null;
  steps: SignStep[];
  resume: (signatures: string[]) => Promise<void>;
  setBusy: (busy: string | null) => void;
  send: (index: number) => Promise<string>;
  verify: (index: number) => Promise<void>;
}) {
  const { auto, busy, answer, steps, resume, setBusy, send, verify } = loop;

  useEffect(() => {
    if (!auto || busy !== null || answer === null) return;

    if (answer.next.kind === "wait") {
      const delay = Math.max(0, Date.parse(answer.next.checkAfter) - Date.now());
      const timer = setTimeout(() => resume([]), delay);

      return () => clearTimeout(timer);
    }

    if (answer.next.kind === "sign") {
      // `resume` marks the loop busy until its answer arrives, so the effect does not sign twice.
      setBusy("auto");
      signAll(steps.length, verify, send)
        .then((signatures) => resume(signatures))
        .catch(() => setBusy(null));
    }
  }, [auto, busy, answer, steps.length, resume, setBusy, send, verify]);
}

async function signAll(
  count: number,
  verify: (index: number) => Promise<void>,
  send: (index: number) => Promise<string>
): Promise<string[]> {
  const signatures: string[] = [];

  for (let index = 0; index < count; index += 1) {
    await verify(index);
    signatures.push(await send(index));
  }

  return signatures;
}

function verifyStep(step: SignStep | undefined): Promise<Verified> {
  if (step?.transaction === undefined)
    return Promise.reject(new Error("the step holds no transaction"));

  return verifyPlan(step, step.transaction);
}

function sendStep(step: SignStep | undefined): Promise<string> {
  if (step?.transaction === undefined)
    return Promise.reject(new Error("the step holds no transaction"));

  return api.send(step.transaction).then(({ signature }) => signature);
}

function AutoSwitch({ auto, onAuto }: { auto: boolean; onAuto: (auto: boolean) => void }) {
  return (
    <label className="switch-row">
      <span>
        <span className="switch-label">Run the loop for me</span>
        <span className="section-sub">
          Sign, send, wait, and continue until done, without a click for each call.
        </span>
      </span>
      <span className="toggle">
        <input type="checkbox" checked={auto} onChange={(event) => onAuto(event.target.checked)} />
        <span className="toggle-track" />
        <span className="toggle-thumb" />
      </span>
    </label>
  );
}

function StartPanel(props: Props & { busy: string | null; onStart: () => void }) {
  return (
    <div className="loop-call">
      <div className="section-sub">The first call starts the flow with the plan request.</div>
      <Code text={startCurl(props.request)} />
      <button
        type="button"
        className="btn btn-pri"
        disabled={!props.ready || props.busy !== null}
        onClick={props.onStart}
      >
        {props.busy === "start" ? "Starting…" : "POST /v1/intents/start"}
      </button>
    </div>
  );
}

function CallCard({ number, call }: { number: number; call: Call }) {
  const curl =
    call.route === "start" ? startCurl(call.body as object) : continueCurl(call.body as object);
  const kind = call.answer?.next.kind;

  return (
    <div className="loop-call">
      <div className="loop-call-top">
        <span className="section-title">
          {number}. POST /v1/intents/{call.route}
        </span>
        {kind !== undefined && <span className={`badge ${KIND_BADGES[kind]}`}>{kind}</span>}
        {call.error !== null && <span className="badge badge-red">error</span>}
      </div>
      <details>
        <summary>Request</summary>
        <Code text={curl} />
      </details>
      {call.answer !== null && (
        <details>
          <summary>Answer</summary>
          <Code text={JSON.stringify(call.answer, null, 2)} />
        </details>
      )}
      {call.error !== null && <div className="callout callout-red error-text">{call.error}</div>}
    </div>
  );
}

const KIND_BADGES: Record<Answer["next"]["kind"], string> = {
  sign: "badge-amber",
  wait: "badge-gray",
  done: "badge-green",
};

interface NextProps {
  answer: Answer;
  recipe: Recipe | null;
  busy: string | null;
  sent: Sent;
  verified: Record<number, Verified>;
  onVerify: (index: number) => Promise<void>;
  onSend: (index: number) => Promise<string>;
  onContinue: () => void;
}

function NextPanel(props: NextProps) {
  const { next } = props.answer;
  const signatures = Object.values(props.sent);
  const body = continueBody(props.answer, signatures);

  return (
    <div className="loop-next">
      <div className="section-title">next: {next.kind}</div>
      <div className="section-sub">{TODO[next.kind]}</div>
      {next.kind === "sign" &&
        next.steps.map((step, index) => (
          <SignStepView key={step.name} {...props} step={step} index={index} />
        ))}
      {next.kind === "wait" && <WaitView next={next} />}
      {next.kind === "done" && <div className="callout callout-green">{next.message}</div>}
      {next.kind !== "done" && (
        <>
          <details>
            <summary>The next call</summary>
            <Code text={continueCurl(body)} />
          </details>
          <button
            type="button"
            className="btn btn-pri"
            disabled={props.busy !== null}
            onClick={props.onContinue}
          >
            {props.busy === "continue" ? "Calling…" : "POST /v1/intents/continue"}
          </button>
        </>
      )}
    </div>
  );
}

function WaitView({ next }: { next: Extract<Answer["next"], { kind: "wait" }> }) {
  return (
    <>
      <div className="callout callout-gray">
        Step <code>{next.step}</code> waits: {next.message}. Ask again at{" "}
        {new Date(next.checkAfter).toLocaleTimeString()}.
      </div>
      <Code text={JSON.stringify({ until: next.until }, null, 2)} />
    </>
  );
}

function SignStepView(props: NextProps & { step: SignStep; index: number }) {
  const { step, index } = props;
  const signature = props.sent[index];
  const result = props.verified[index];

  return (
    <div className="loop-step">
      <div className="section-sub">
        Step <code>{step.name}</code> · signs the {step.signs}
      </div>
      <div className="callout callout-gray message">{step.message}</div>
      <StepRows step={step} recipe={props.recipe} />
      {step.instructions !== undefined && <Instructions step={step} />}
      {result !== undefined && <VerifiedResult verified={result} />}
      {signature !== undefined && (
        <div className="callout callout-green">
          Sent:{" "}
          <a href={explorerUrl("tx", signature)} target="_blank" rel="noreferrer">
            {signature}
          </a>
        </div>
      )}
      {step.transaction === undefined ? (
        <Snippets snippets={compileSnippets()} />
      ) : (
        <>
          <div className="side-actions row">
            <button
              type="button"
              className="btn btn-sec"
              disabled={props.busy !== null}
              onClick={() => props.onVerify(index)}
            >
              Verify
            </button>
            <button
              type="button"
              className="btn btn-pri"
              disabled={props.busy !== null || signature !== undefined}
              onClick={() => props.onSend(index)}
            >
              Sign and send
            </button>
          </div>
          <details>
            <summary>Verify, sign, and send it yourself</summary>
            <Snippets snippets={sendSnippets(step.transaction.messageBytes)} />
          </details>
        </>
      )}
    </div>
  );
}

/// A service error with its findings or its program logs.
export function describe(error: unknown): string {
  if (!(error instanceof ServiceError)) {
    return error instanceof Error ? error.message : String(error);
  }

  const details = error.details as { rendered?: string; logs?: string[] } | null;
  const extra = details?.rendered ?? details?.logs?.slice(-8).join("\n");

  return extra === undefined ? error.message : `${error.message}\n\n${extra}`;
}
