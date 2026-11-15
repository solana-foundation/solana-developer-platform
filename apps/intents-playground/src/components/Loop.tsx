// The loop of `DESIGN.md`, 4.1, one call at a time: each call shows its curl, its answer, and what
// `next` asks the caller to do. A switch runs the loop alone. A request of one step reads as one
// sign: the calls stay folded, and nothing asks for `continue`.

import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import {
  type Answer,
  api,
  type ContinueBody,
  type Prover,
  type Recipe,
  type SignStep,
} from "@/api";
import { Code, Snippets } from "@/components/Code";
import { Instructions, StepRows, VerifiedResult } from "@/components/Plan";
import { describe } from "@/errors";
import { explorerUrl } from "@/known";
import { type Call, continueBody, type Done, loadCalls, saveCalls } from "@/loop";
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
  build:
    "The step spends private funds, so only the spender's keys can build it. Ask your own wallet or custody to build `spend`, then call continue with progress and what it built. The service never calls your wallet.",
  sign: "Verify each step against your own RPC, sign it, and send it yourself. When `then` is `continue`, call continue with progress and the signatures. The playground verifies each step in the browser and signs only a step that proves its message.",
  wait: "Nothing to sign. `until` is the condition that the step waits for. Watch it yourself, or call continue again at `checkAfter`.",
  done: "The flow is done. Drop progress.",
};

/// The signature of each step of the latest `sign`, by position, once the step is sent.
type Sent = Record<number, string>;

export function Loop(props: Props) {
  const loop = useLoop(props);
  const auto = useAutoRun(loop);
  const { calls, answer, busy, sent } = loop;

  const flow = answer !== null && (answer.steps.length > 1 || answer.next.kind !== "sign");

  return (
    <div className="loop">
      {flow && (
        <div>
          <div className="section-title">The loop</div>
          <div className="section-sub">
            Every call answers <code>progress</code> and <code>next</code>. Keep progress, and do
            what next says.
          </div>
        </div>
      )}
      {flow && <AutoSwitch auto={auto.on} onAuto={auto.set} />}
      {(calls[0]?.answer?.warnings ?? []).map((warning) => (
        <div key={warning} className="callout callout-amber">
          {warning}
        </div>
      ))}
      {answer !== null && answer.steps.length > 1 && <StepsBar steps={answer.steps} />}

      {calls.length === 0 && <StartPanel {...props} busy={busy} onStart={auto.start} />}
      {calls.length > 0 && (
        <details open={flow}>
          <summary>API calls ({calls.length})</summary>
          {calls.map((made, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a call's position in the loop is its identity.
            <CallCard key={index} number={index + 1} call={made} />
          ))}
        </details>
      )}

      {answer !== null && (
        <NextPanel
          answer={answer}
          recipe={props.recipe}
          busy={busy}
          sent={sent}
          verified={loop.verified}
          onVerify={(index) => loop.verifyAt(answer, index)}
          onSend={(index, acceptUnverified) =>
            loop.sendAt(answer, index, loop.verified[index], acceptUnverified)
          }
          built={loop.built}
          onBuild={() => loop.buildFor(answer)}
          prover={loop.prover}
          onProver={loop.setProver}
          failure={loop.failure}
          onContinue={(stop) =>
            loop
              .resume(answer, { signatures: Object.values(sent), built: loop.built, stop })
              .catch(() => undefined)
          }
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

// Each action's failure shows as `failure` in the next panel, or as a call of the loop, so a click
// drops the rejection.

/// One step of a `sign`, with its position.
interface StepAt {
  index: number;
  step: SignStep | undefined;
}

/// A step to sign, with its verification. `acceptUnverified` is the caller's consent to sign
/// instructions that no segment proves.
interface SendRequest extends StepAt {
  verified: Verified | undefined;
  acceptUnverified: boolean;
}

/// A call to the service: `start` with the plan request, or `continue` with the last progress.
interface CallRequest {
  route: Call["route"];
  body: unknown;
}

/// The calls of the loop, kept in storage for a refresh, and the actions on the latest answer. The
/// parent keys the loop by its request, so each request starts from its own calls.
function useLoop(props: Props) {
  const [calls, setCalls] = useState<Call[]>(() => loadCalls(props.requestKey));
  const [sent, setSent] = useState<Sent>({});
  const [verified, setVerified] = useState<Record<number, Verified>>({});
  const [built, setBuilt] = useState<Record<string, unknown> | null>(null);
  const [prover, setProver] = useState<Prover>("wallet");
  const answer = calls.at(-1)?.answer ?? null;

  useEffect(() => saveCalls(props.requestKey, calls), [props.requestKey, calls]);

  const record = (made: Call) => {
    setCalls((previous) => [...previous, made]);
    setSent({});
    setVerified({});
    setBuilt(null);
  };

  const call = useMutation({
    mutationFn: ({ route, body }: CallRequest) =>
      route === "start"
        ? api.start(body as object, props.tamper)
        : api.resume(body as ContinueBody),
    onSuccess: (answered, { route, body }) =>
      record({ route, body, answer: answered, error: null }),
    onError: (error, { route, body }) =>
      record({ route, body, answer: null, error: describe(error) }),
  });
  const build = useMutation({
    mutationFn: (spend: Record<string, unknown>) => api.build(spend, prover),
    onSuccess: setBuilt,
  });
  const verify = useMutation({
    mutationFn: ({ step }: StepAt) => verifyStep(step),
    onSuccess: (result, { index }) => setVerified((all) => ({ ...all, [index]: result })),
  });
  const send = useMutation({
    mutationFn: sendStep,
    onSuccess: (signature, { index }) => {
      setSent((all) => ({ ...all, [index]: signature }));
      props.onSent(signature);
    },
  });

  const stepAt = (from: Answer, index: number): StepAt => ({
    index,
    step: from.next.kind === "sign" ? from.next.steps[index] : undefined,
  });

  return {
    calls,
    answer,
    busy: call.isPending ? (call.variables?.route ?? null) : build.isPending ? "build" : null,
    failure: [build.error, verify.error, send.error].find((error) => error !== null) ?? null,
    sent,
    verified,
    built,
    prover,
    setProver,
    start: () => call.mutateAsync({ route: "start", body: props.request }),
    resume: (from: Answer, done: Done) =>
      call.mutateAsync({ route: "continue", body: continueBody(from, done) }),
    buildFor: (from: Answer) =>
      from.next.kind === "build"
        ? build.mutateAsync(from.next.spend)
        : Promise.reject(new Error("the answer asks for no build")),
    verifyAt: (from: Answer, index: number) => verify.mutateAsync(stepAt(from, index)),
    sendAt: (
      from: Answer,
      index: number,
      verified: Verified | undefined,
      acceptUnverified: boolean
    ) => send.mutateAsync({ ...stepAt(from, index), verified, acceptUnverified }),
    clear: () => setCalls([]),
  };
}

type LoopActions = ReturnType<typeof useLoop>;

/// In auto mode, the loop builds, signs and sends each step, waits until `checkAfter`, and
/// continues, until done or until the switch turns off. A failed call stops it.
function useAutoRun(loop: LoopActions) {
  const [on, setOn] = useState(false);
  const enabled = useRef(false);
  const running = useRef(false);

  const run = async (from: Answer | null) => {
    if (running.current) return;

    running.current = true;
    try {
      let answer = from;
      while (answer !== null && answer.next.kind !== "done" && enabled.current) {
        answer = await advance(answer, loop);
      }
    } catch {
      enabled.current = false;
      setOn(false);
    } finally {
      running.current = false;
    }
  };

  return {
    on,
    set: (next: boolean) => {
      enabled.current = next;
      setOn(next);
      if (next) void run(loop.answer);
    },
    // A failed call is recorded as a call of the loop, so the rejection needs no handling here.
    start: () => {
      loop
        .start()
        .then((answer) => (enabled.current ? run(answer) : undefined))
        .catch(() => undefined);
    },
  };
}

/// Does what `next` asks, then continues. Returns the next answer, or `null` when the request is
/// done once the signed steps land.
async function advance(answer: Answer, loop: LoopActions): Promise<Answer | null> {
  const { next } = answer;

  if (next.kind === "wait") {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, Date.parse(next.checkAfter) - Date.now()))
    );

    return loop.resume(answer, { signatures: [], built: null });
  }

  if (next.kind === "build") {
    return loop.resume(answer, { signatures: [], built: await loop.buildFor(answer) });
  }

  // Auto mode never consents to unverified instructions, so such a step stops the loop.
  const signatures: string[] = [];
  for (const index of next.kind === "sign" ? next.steps.keys() : []) {
    const verified = await loop.verifyAt(answer, index);
    signatures.push(await loop.sendAt(answer, index, verified, false));
  }

  return next.kind === "sign" && next.then === "done"
    ? null
    : loop.resume(answer, { signatures, built: null });
}

function verifyStep(step: SignStep | undefined): Promise<Verified> {
  if (step?.transaction === undefined)
    return Promise.reject(new Error("the step holds no transaction"));

  return verifyPlan(step, step.transaction);
}

/// Signs only a step whose verification proves its message. Instructions in no segment need the
/// caller's consent, and the wallet checks the same list again.
function sendStep({ step, verified, acceptUnverified }: SendRequest): Promise<string> {
  if (step?.transaction === undefined)
    return Promise.reject(new Error("the step holds no transaction"));

  if (verified === undefined)
    return Promise.reject(new Error("Verify the step before it is signed."));

  if (!verified.matches || verified.intents.length === 0)
    return Promise.reject(new Error("The transaction does not prove the step's message."));

  if (verified.unverified.length > 0 && !acceptUnverified)
    return Promise.reject(
      new Error(`Instructions ${verified.unverified.join(", ")} are in no segment.`)
    );

  return api.send(step.transaction, verified.unverified).then(({ signature }) => signature);
}

/// The request's steps as a wizard: done, current, and pending.
function StepsBar({ steps }: { steps: Answer["steps"] }) {
  return (
    <ol className="steps-bar">
      {steps.map((step, index) => (
        <li key={step.name} className={`steps-bar-step ${step.state}`}>
          <span className="steps-bar-number">{index + 1}</span>
          {step.name}
        </li>
      ))}
    </ol>
  );
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
        {props.busy === "start" ? "Starting…" : "POST /v1/intents"}
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
          {number}. POST /v1/intents{call.route === "start" ? "" : "/continue"}
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
  build: "badge-amber",
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
  onVerify: (index: number) => Promise<Verified>;
  onSend: (index: number, acceptUnverified: boolean) => Promise<string>;
  built: Record<string, unknown> | null;
  onBuild: () => Promise<Record<string, unknown>>;
  prover: Prover;
  onProver: (prover: Prover) => void;
  /// The last build, verification, or send that failed.
  failure: Error | null;
  /// `true` stops the flow, and the service plans the recovery of the last step that landed.
  onContinue: (stop: boolean) => void;
}

function NextPanel(props: NextProps) {
  const { next } = props.answer;
  const body = continueBody(props.answer, {
    signatures: Object.values(props.sent),
    built: props.built,
  });

  return (
    <div className="loop-next">
      <div className="section-title">next: {next.kind}</div>
      <div className="section-sub">{TODO[next.kind]}</div>
      {props.failure !== null && (
        <div className="callout callout-red error-text">{describe(props.failure)}</div>
      )}
      {next.kind === "sign" &&
        next.steps.map((step, index) => (
          <SignStepView key={step.name} {...props} step={step} index={index} />
        ))}
      {next.kind === "build" && <BuildView next={next} {...props} />}
      {next.kind === "wait" && <WaitView next={next} />}
      {next.kind === "done" && <div className="callout callout-green">{next.message}</div>}
      {next.kind === "sign" && next.then === "done" && (
        <div className="callout callout-gray">
          {Object.keys(props.sent).length === next.steps.length
            ? "Sent. The request is done once it lands, so it needs no continue call."
            : "The request is done once this lands, so it needs no continue call."}
        </div>
      )}
      {next.kind !== "done" && !(next.kind === "sign" && next.then === "done") && (
        <>
          <details>
            <summary>The next call</summary>
            <Code text={continueCurl(body)} />
          </details>
          <div className="side-actions row">
            <button
              type="button"
              className="btn btn-pri"
              disabled={props.busy !== null}
              onClick={() => props.onContinue(false)}
            >
              {props.busy === "continue" ? "Calling…" : "POST /v1/intents/continue"}
            </button>
            {props.answer.steps.length > 1 &&
              !props.answer.steps.some((step) => step.state === "stopped") && (
                <button
                  type="button"
                  className="btn btn-sec"
                  disabled={props.busy !== null}
                  onClick={() => props.onContinue(true)}
                >
                  Stop and recover
                </button>
              )}
          </div>
        </>
      )}
    </div>
  );
}

function BuildView(props: NextProps & { next: Extract<Answer["next"], { kind: "build" }> }) {
  const instructions = (props.built?.instructions as unknown[] | undefined)?.length ?? 0;

  return (
    <>
      <div className="section-sub">
        Step <code>{props.next.step}</code> needs this spend. The wallet checks it against the
        intent again when it signs.
      </div>
      <ProverChoice
        prover={props.prover}
        onProver={props.onProver}
        disabled={props.built !== null}
      />
      <Code
        text={`POST /wallet/shielded/build\n${JSON.stringify({ spend: props.next.spend, prover: props.prover }, null, 2)}`}
      />
      <button
        type="button"
        className="btn btn-sec"
        disabled={props.busy !== null || props.built !== null}
        onClick={() => props.onBuild().catch(() => undefined)}
      >
        {props.busy === "build" ? "Building and proving…" : "Build with the wallet"}
      </button>
      {props.built !== null && (
        <>
          <div className="callout callout-green">
            The wallet built the spend: {instructions} pool instruction, with its proof.
          </div>
          <details>
            <summary>What the wallet built</summary>
            <Code text={JSON.stringify(props.built, null, 2)} />
          </details>
        </>
      )}
    </>
  );
}

/// Where the wallet proves the spend. The service's prover sees the witness, so it learns the spend.
function ProverChoice(props: {
  prover: Prover;
  onProver: (prover: Prover) => void;
  disabled: boolean;
}) {
  const choices: { value: Prover; label: string; sub: string }[] = [
    { value: "wallet", label: "Prove in the wallet", sub: "Nobody else sees the spend." },
    {
      value: "service",
      label: "Prove on the service",
      sub: "The service's prover sees the notes, the amounts, and the recipient. It cannot spend: the wallet still signs.",
    },
  ];

  return (
    <div className="prover-choice" role="radiogroup" aria-label="Where to prove">
      {choices.map((choice) => (
        <label
          key={choice.value}
          className={`prover-option${props.prover === choice.value ? " selected" : ""}`}
        >
          <input
            type="radio"
            name="prover"
            value={choice.value}
            checked={props.prover === choice.value}
            disabled={props.disabled}
            onChange={() => props.onProver(choice.value)}
          />
          <span>
            <span className="prover-label">{choice.label}</span>
            <span className="prover-sub">{choice.sub}</span>
          </span>
        </label>
      ))}
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
  const proves = result?.matches === true && result.intents.length > 0;
  const unverified = result?.unverified.length ?? 0;

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
              onClick={() => props.onVerify(index).catch(() => undefined)}
            >
              Verify
            </button>
            <button
              type="button"
              className="btn btn-pri"
              disabled={props.busy !== null || signature !== undefined || !proves}
              onClick={() => props.onSend(index, unverified > 0).catch(() => undefined)}
            >
              {unverified > 0
                ? `Sign with ${unverified} unverified instruction${unverified === 1 ? "" : "s"}`
                : "Sign and send"}
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
