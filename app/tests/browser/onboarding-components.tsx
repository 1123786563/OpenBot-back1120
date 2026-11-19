import { DemoStage } from "@/components/onboarding/demo-stage";
import { ComputerDemo } from "@/components/onboarding/demos/computer-demo";
import { SelfHostDemo } from "@/components/onboarding/demos/self-host-demo";
import { TeamDemo } from "@/components/onboarding/demos/team-demo";
import { WelcomeDemo } from "@/components/onboarding/demos/welcome-demo";
import { StepIntro } from "@/components/onboarding/onboarding-frame";
import {
  type OnboardingStep,
  OnboardingWizard,
} from "@/components/onboarding/onboarding-wizard";
import { agentKeys } from "@/lib/agents/queries";
import "@/styles.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { createRoot } from "react-dom/client";

const params = new URLSearchParams(location.search);
const mode = params.get("mode");
const plain = (id: string, title: string): OnboardingStep => ({
  id,
  title,
  intro: () => <StepIntro title={title}>About {title}.</StepIntro>,
  demo: () => <p>Picture of {title}</p>,
});
const steps = [
  plain("one", "One"),
  plain("two", "Two"),
  plain("three", "Three"),
];

function WizardFixture() {
  const [inserted, setInserted] = useState(false);
  const [submitted, setSubmitted] = useState("");
  const [held, setHeld] = useState<(() => void) | null>(null);
  const [done, setDone] = useState(false);
  const [step, setStep] = useState(params.get("step") ?? "two");
  const [moves, setMoves] = useState<string[]>([]);
  const optional =
    mode === "optional" || mode === "deferred" || mode === "pending";
  const second: OnboardingStep = {
    ...plain("two", optional ? "Connect your apps" : "Two"),
    demoFirst: params.has("picture-first"),
    ...(optional && {
      footnote: "You can connect more apps later.",
      optional: true,
      secondary: done ? undefined : { label: "Not now" },
    }),
    ...(mode === "deferred" && {
      primaryLabel: "Turn on notifications",
      onPrimary: (next) => setHeld(() => next),
    }),
    ...(mode === "pending" && {
      primaryLabel: done ? "Notifications on" : "Turn on notifications",
      primaryPending: !done,
      primaryDone: done,
    }),
  };
  const third =
    mode === "form"
      ? {
          ...steps[2],
          primaryForm: "last-step-form",
          primaryLabel: "Get started",
          intro: () => (
            <StepIntro
              title="Three"
              after={
                <form
                  id="last-step-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const data = new FormData(event.currentTarget);
                    setSubmitted(String(data.get("name")));
                  }}
                >
                  <label>
                    Workspace name
                    <input name="name" required />
                  </label>
                </form>
              }
            />
          ),
        }
      : steps[2];
  const list =
    mode === "single"
      ? [plain("one", "Only")]
      : [
          steps[0],
          second,
          ...(inserted ? [plain("local", "Local")] : []),
          third,
        ];

  return (
    <>
      <OnboardingWizard
        initialStepId={step}
        steps={list}
        {...(mode === "controlled" && {
          stepId: step,
          onMove: (to: string, way: string) =>
            setMoves((previous) => [...previous, `${to} ${way}`]),
        })}
      />
      {mode === "insert" && (
        <button type="button" onClick={() => setInserted(true)}>
          Reveal local step
        </button>
      )}
      {mode === "deferred" && held && (
        <button type="button" onClick={() => held()}>
          Finish notification request
        </button>
      )}
      {mode === "pending" && (
        <button
          className="fixed right-0 top-0 z-20"
          type="button"
          onClick={() => setDone(true)}
        >
          Resolve notification request
        </button>
      )}
      {mode === "form" && (
        <output aria-label="Submitted workspace">{submitted}</output>
      )}
      {mode === "controlled" && (
        <>
          <output aria-label="Requested moves">{moves.join(", ")}</output>
          <button type="button" onClick={() => setStep("one")}>
            Apply first step
          </button>
        </>
      )}
    </>
  );
}

function DemoFixture() {
  return (
    <>
      <button type="button">Before illustration</button>
      <DemoStage beatMs={80} beats={3} kind="test" label="A test picture">
        {({ beat, playing }) => (
          <>
            <button type="button">Illustration action</button>
            <p>
              Beat {beat} {playing ? "playing" : "still"}
            </p>
          </>
        )}
      </DemoStage>
      <button type="button">After illustration</button>
      <div style={{ height: "200vh" }} />
    </>
  );
}

function PicturesFixture() {
  const [client] = useState(() => {
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity } },
    });
    client.setQueryData(agentKeys.list(false), []);
    return client;
  });
  return (
    <QueryClientProvider client={client}>
      <div className="grid grid-cols-2 gap-4 p-4">
        <WelcomeDemo />
        <ComputerDemo />
        <TeamDemo />
        <SelfHostDemo />
      </div>
    </QueryClientProvider>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("The onboarding fixture needs a root");
const Fixture =
  mode === "demo"
    ? DemoFixture
    : mode === "pictures"
      ? PicturesFixture
      : WizardFixture;
createRoot(root).render(<Fixture />);
