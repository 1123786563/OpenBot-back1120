import { useNameStep } from "@/components/onboarding/name-step";
import { OnboardingFrame } from "@/components/onboarding/onboarding-frame";
import { OnboardingWizard } from "@/components/onboarding/onboarding-wizard";
import "@/styles.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { createRoot } from "react-dom/client";

const params = new URLSearchParams(location.search);
if (params.has("overlay"))
  document.documentElement.dataset.desktopTitlebar = "overlay";

function NameStep({ finished }: { finished: boolean }) {
  const name = useNameStep({ finish: async () => {}, finished });
  return (
    <OnboardingWizard
      initialStepId="name"
      steps={[
        { id: "welcome", title: "Welcome to OpenBot", intro: () => null },
        { id: "selfhost", title: "Talk to us", intro: () => null },
        name,
      ]}
    />
  );
}

function ConnectFrame() {
  const [index, setIndex] = useState(1);
  const titles = ["Welcome", "Connect your apps", "Talk to us"];
  return (
    <OnboardingFrame
      key={index}
      demo={<p>The step's picture.</p>}
      index={index}
      intro={<h1>{titles[index]}</h1>}
      onBack={() => setIndex(index - 1)}
      onPick={setIndex}
      primary={
        index < 2
          ? { label: "Continue", onClick: () => setIndex(index + 1) }
          : undefined
      }
      reached={index}
      titles={titles}
    />
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("The onboarding fixture needs a root");
createRoot(root).render(
  <QueryClientProvider client={new QueryClient()}>
    {params.has("step") ? (
      <NameStep finished={params.get("step") === "done"} />
    ) : (
      <ConnectFrame />
    )}
  </QueryClientProvider>,
);
