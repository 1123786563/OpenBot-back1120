import { QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Composer } from "@/components/channels/composer/composer";
import { deploymentKeys } from "@/lib/deployment/queries";
import { type LivePlatform, liveDictationSource } from "@/lib/dictation/live";
import { queryClient } from "@/query-client";
import { installChrome } from "../browser-narration.fixture";
import {
  type DesktopShellOptions,
  installDesktopShell,
} from "../desktop-shell.fixture";
import "@/styles.css";

const params = new URLSearchParams(location.search);
const source = params.get("source");
const transcription = source === "provider";
queryClient.setQueryData(deploymentKeys.capabilities(), {
  generativeUi: true,
  transcription,
});

function setUserAgent(platform: LivePlatform | "linux") {
  const os =
    platform === "mac"
      ? "Macintosh; Intel Mac OS X 10_15_7"
      : platform === "windows"
        ? "Windows NT 10.0; Win64; x64"
        : "X11; Linux x86_64";
  Object.defineProperty(navigator, "userAgent", {
    value: `Mozilla/5.0 (${os}) AppleWebKit/537.36 Chrome/150.0.0.0`,
    configurable: true,
  });
}

let allowPermission = false;
if (source === "desktop" || transcription) {
  const platform = params.get("platform");
  setUserAgent(
    platform === "windows" || platform === "linux" ? platform : "mac",
  );
  const heard: DesktopShellOptions["heard"] = [
    { type: "result", index: 0, text: "book a", final: false },
    { type: "result", index: 0, text: "book a table", final: false },
    { type: "result", index: 1, text: "for two", final: false },
  ];
  const shell = installDesktopShell({
    heard,
    atStop: [
      { type: "result", index: 1, text: "for two tonight", final: true },
    ],
    ...(params.has("refused") ? { fails: "not-allowed" } : {}),
    ...(params.has("permission")
      ? { availability: () => (allowPermission ? "available" : "downloading") }
      : {}),
  });
  Object.defineProperty(window, "dictationDesktopCalls", {
    value: shell.calls,
  });
}
if (source === "web" || transcription) {
  Object.defineProperty(window, "dictationRecognitions", {
    value: installChrome(null),
  });
} else {
  Object.defineProperty(window, "SpeechRecognition", {
    value: undefined,
    configurable: true,
  });
  Object.defineProperty(window, "webkitSpeechRecognition", {
    value: undefined,
    configurable: true,
  });
}

function inputFixture() {
  const record = { devices: 0, starts: 0 };
  Object.defineProperty(window, "dictationRecording", { value: record });
  Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
    value: async () => {
      record.devices++;
      const context = new AudioContext();
      const destination = context.createMediaStreamDestination();
      return destination.stream;
    },
  });
  class AudioFixture {
    static isTypeSupported() {
      return true;
    }
    mimeType = "audio/webm;codecs=opus";
    state = "inactive";
    ondataavailable: ((event: BlobEvent) => void) | null = null;
    onstop: (() => void) | null = null;
    start() {
      this.state = "recording";
      record.starts++;
    }
    stop() {
      this.state = "inactive";
      queueMicrotask(() => {
        this.ondataavailable?.(
          new BlobEvent("dataavailable", {
            data: new Blob(["audio fixture"], { type: this.mimeType }),
          }),
        );
        this.onstop?.();
      });
    }
  }
  Object.defineProperty(window, "MediaRecorder", { value: AudioFixture });
}
if (transcription) inputFixture();

function DictationComposer() {
  const [sent, setSent] = useState<string[]>([]);
  return (
    <main className="mx-auto max-w-2xl px-4 pt-40">
      {params.has("permission") && (
        <button
          type="button"
          onClick={() => {
            allowPermission = true;
          }}
        >
          Allow microphone access
        </button>
      )}
      {params.has("platform") && (
        <output aria-label="Speech platform">
          {liveDictationSource()?.platform ?? "unsupported"}
        </output>
      )}
      <Composer
        agents={[{ id: "billing", name: "Billing Bot", avatarSeed: "billing" }]}
        compact={params.has("compact")}
        initialValue="Existing draft"
        onSubmit={(draft) => {
          setSent((previous) => [...previous, draft.text]);
          if (params.has("fail-send")) throw new Error("Agent unavailable");
        }}
      />
      <output aria-label="Sent drafts">{JSON.stringify(sent)}</output>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing browser test root");
createRoot(root).render(
  <QueryClientProvider client={queryClient}>
    <DictationComposer />
  </QueryClientProvider>,
);
