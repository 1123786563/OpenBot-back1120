import type { Browser } from "@e2e-dev/web";
import {
  DEFAULT_USER_PREFERENCES,
  type NarrationPreference,
} from "../../shared/user-preferences";

type RecognitionResultEvent = {
  resultIndex: number;
  results: { 0: { transcript: string }; length: number; isFinal: boolean }[];
};

type DesktopSpeechEvent =
  | { type: "start" }
  | { type: "result"; index: number; text: string; final: boolean }
  | { type: "error"; error: string };

type SpeechFixture =
  | "installed"
  | "downloadable"
  | "no-local-model"
  | "unsupported";

export async function simulateBrowserSpeech(
  browser: Browser,
  {
    speech = "installed",
    microphone = true,
    error = "",
    desktop = null,
    heard = [],
    atStop = [],
    phrase = null,
  }: {
    speech?: SpeechFixture;
    microphone?: boolean;
    error?: string;
    desktop?: "unavailable" | "available" | null;
    heard?: DesktopSpeechEvent[];
    atStop?: DesktopSpeechEvent[];
    phrase?: { interim: string; final: string } | null;
  } = {},
) {
  await browser.addInitScript(
    ({ speech, microphone, error, desktop, phrase, heard, atStop }) => {
      const recognitions: {
        language: string;
        local: boolean;
        error: string;
      }[] = [];
      const downloads: {
        language: string;
        userGesture: boolean;
        local: boolean;
      }[] = [];
      const desktopCalls: { command: string; language?: unknown }[] = [];
      let model = speech === "downloadable" ? "downloadable" : "available";
      let finishDownload: (() => void) | undefined;
      const devices = new EventTarget();
      const media = Object.assign(devices, {
        enumerateDevices: async () => [
          { kind: "audiooutput" },
          ...(microphone ? [{ kind: "audioinput" }] : []),
        ],
      });
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: media,
      });
      if (desktop) {
        const callbacks = new Map<number, (event: unknown) => void>();
        const sessions = new Map<number, { callback: number; index: number }>();
        let nextCallback = 1;
        let nextSession = 1;
        function deliver(
          id: number,
          events: DesktopSpeechEvent[],
          end = false,
        ) {
          const session = sessions.get(id);
          if (!session) throw new Error("Unknown Desktop speech session");
          const callback = callbacks.get(session.callback);
          queueMicrotask(() => {
            for (const message of events)
              callback?.({ message, index: session.index++ });
            if (end) {
              callback?.({ end: true, index: session.index++ });
              sessions.delete(id);
            }
          });
        }
        Object.defineProperty(window, "__TAURI_INTERNALS__", {
          configurable: true,
          value: {
            transformCallback(callback: (message: unknown) => void) {
              const id = nextCallback++;
              callbacks.set(id, callback);
              return id;
            },
            unregisterCallback(id: number) {
              callbacks.delete(id);
            },
            async invoke(command: string, args?: Record<string, unknown>) {
              if (!command.startsWith("plugin:openbot-desktop|speech_"))
                return null;
              desktopCalls.push({
                command,
                ...(args?.language ? { language: args.language } : {}),
              });
              switch (command) {
                case "plugin:openbot-desktop|speech_available":
                  if (desktop === "unavailable")
                    throw new Error("command not found");
                  return "available";
                case "plugin:openbot-desktop|speech_start": {
                  const id = nextSession++;
                  const callback = Number(
                    String(args?.onEvent).replace("__CHANNEL__:", ""),
                  );
                  if (!callbacks.has(callback))
                    throw new Error("Missing Desktop speech callback");
                  sessions.set(id, { callback, index: 0 });
                  if (error) deliver(id, [{ type: "error", error }], true);
                  else deliver(id, [{ type: "start" }, ...heard]);
                  return id;
                }
                case "plugin:openbot-desktop|speech_stop":
                  deliver(Number(args?.session), atStop, true);
                  return null;
                case "plugin:openbot-desktop|speech_abort":
                  deliver(Number(args?.session), [], true);
                  return null;
              }
            },
          },
        });
      }

      class Recognition {
        lang = "";
        onstart: (() => void) | null = null;
        onend: (() => void) | null = null;
        onerror: ((event: { error: string }) => void) | null = null;
        onresult: ((event: RecognitionResultEvent) => void) | null = null;
        continuous = false;
        interimResults = false;
        declare processLocally: boolean;
        report(text: string, isFinal: boolean) {
          this.onresult?.({
            resultIndex: 0,
            results: [{ 0: { transcript: text }, length: 1, isFinal }],
          });
        }
        start() {
          const failure = error;
          recognitions.push({
            language: this.lang,
            local: this.processLocally === true,
            error: failure,
          });
          queueMicrotask(() => {
            if (failure) {
              this.onerror?.({ error: failure });
              this.onend?.();
            } else {
              this.onstart?.();
              if (phrase && this.continuous && this.interimResults)
                this.report(phrase.interim, false);
            }
          });
        }
        stop() {
          queueMicrotask(() => {
            if (phrase) this.report(phrase.final, true);
            this.onend?.();
          });
        }
        abort() {
          queueMicrotask(() => this.onend?.());
        }
      }

      if (speech === "installed" || speech === "downloadable") {
        Object.defineProperty(Recognition.prototype, "processLocally", {
          writable: true,
          value: false,
        });
        Object.assign(Recognition, {
          async available({ processLocally }: { processLocally: boolean }) {
            return processLocally ? model : "available";
          },
          async install({
            langs,
            processLocally,
          }: {
            langs: string[];
            processLocally: boolean;
          }) {
            const userGesture = navigator.userActivation.isActive;
            for (const language of langs)
              downloads.push({ language, userGesture, local: processLocally });
            if (model === "available") return true;
            if (!userGesture && model === "downloadable")
              throw new DOMException("A click is required", "NotAllowedError");
            model = "downloading";
            return new Promise<boolean>((resolve) => {
              finishDownload = () => {
                model = "available";
                resolve(true);
              };
            });
          },
        });
      }
      for (const name of ["SpeechRecognition", "webkitSpeechRecognition"]) {
        Object.defineProperty(window, name, {
          configurable: true,
          value: speech === "unsupported" ? undefined : Recognition,
        });
      }
      Object.defineProperty(window, "teachSpeechFixture", {
        value: {
          recognitions,
          downloads,
          desktopCalls,
          finishDownload: () => finishDownload?.(),
          setMicrophone(present: boolean) {
            microphone = present;
            devices.dispatchEvent(new Event("devicechange"));
          },
          setError(next: string) {
            error = next;
          },
        },
      });
    },
    { speech, microphone, error, desktop, phrase, heard, atStop },
  );

  const read = (key: "recognitions" | "downloads" | "desktopCalls") =>
    browser.evaluate(
      (name) => JSON.stringify(Reflect.get(window, "teachSpeechFixture")[name]),
      key,
    );
  return {
    async recognitions(): Promise<unknown> {
      return JSON.parse(await read("recognitions"));
    },
    async downloads(): Promise<unknown> {
      return JSON.parse(await read("downloads"));
    },
    async desktopCalls(): Promise<unknown> {
      return JSON.parse(await read("desktopCalls"));
    },
    async finishDownload() {
      await browser.evaluate(() =>
        Reflect.get(window, "teachSpeechFixture").finishDownload(),
      );
    },
    async setMicrophone(present: boolean) {
      await browser.evaluate(
        (next) => Reflect.get(window, "teachSpeechFixture").setMicrophone(next),
        present,
      );
    },
    async setError(error: string) {
      await browser.evaluate(
        (next) => Reflect.get(window, "teachSpeechFixture").setError(next),
        error,
      );
    },
  };
}

export async function serveNarrationPreference(
  browser: Browser,
  narration: NarrationPreference | null,
  { hold, fail = false }: { hold?: Promise<void>; fail?: boolean } = {},
) {
  const changes: unknown[] = [];
  let reads = 0;
  await browser.route(/\/api\/settings\/preferences$/, async (route) => {
    if (route.request.method === "GET") {
      reads++;
      await hold;
      if (fail)
        return route.fulfill({ status: 500, json: { error: "Unavailable" } });
    } else if (route.request.method === "PATCH") {
      const update: unknown = JSON.parse(route.request.postData ?? "null");
      changes.push(update);
      if (
        !update ||
        typeof update !== "object" ||
        !("narration" in update) ||
        (update.narration !== "on" && update.narration !== "off")
      ) {
        return route.fulfill({
          status: 400,
          json: { error: "Invalid narration preference" },
        });
      }
      narration = update.narration;
    }
    return route.fulfill({
      json: { preferences: { ...DEFAULT_USER_PREFERENCES, narration } },
    });
  });
  return { changes, reads: () => reads };
}
