import {
  LateRenderersWatch,
  useLateRenderers,
} from "@/components/channels/late-renderers";
import "@/styles.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";

function createRuntime() {
  const listeners = new Set<() => void>();
  const core = {
    renderActivityMessages: [] as unknown[],
    subscribe(subscriber: { onRuntimeConnectionStatusChanged?: () => void }) {
      const listener = subscriber.onRuntimeConnectionStatusChanged;
      if (listener) listeners.add(listener);
      return {
        unsubscribe: () => {
          if (listener) listeners.delete(listener);
        },
      };
    },
    connect() {
      for (const listener of listeners) listener();
    },
    installRenderer() {
      core.renderActivityMessages = [{ activityType: "a2ui" }];
    },
    listeners,
  };
  return core;
}

type Runtime = ReturnType<typeof createRuntime>;

function Observer({
  core,
  waiting,
  settled,
}: {
  core: Runtime;
  waiting: boolean;
  settled: boolean;
}) {
  const version = useLateRenderers(core, waiting, settled);
  return <output aria-label="Renderer version">{version}</output>;
}

function Fixture() {
  const mode = new URLSearchParams(location.search).get("mode");
  const [core] = useState(createRuntime);
  const [settled, setSettled] = useState(false);
  const [connected, setConnected] = useState(false);
  const [updates, setUpdates] = useState<number[]>([]);
  const [listeners, setListeners] = useState<number | null>(null);
  const [recordUpdate] = useState(() => (version: number) => {
    setUpdates((list) => [...list, version]);
  });
  function connect() {
    core.connect();
    setConnected(true);
  }

  return (
    <main>
      {mode === "transcript" ? (
        <>
          <LateRenderersWatch
            core={core}
            settled={settled}
            onVersion={recordUpdate}
          />
          <output aria-label="Renderer notifications">
            {JSON.stringify(updates)}
          </output>
        </>
      ) : (
        <Observer
          core={core}
          settled={settled}
          waiting={mode !== "already-ready"}
        />
      )}
      <output aria-label="Runtime connection">
        {connected ? "Connected" : "Waiting"}
      </output>
      <output aria-label="Runtime subscribers">{listeners ?? ""}</output>
      <button
        type="button"
        onClick={() => {
          core.installRenderer();
          connect();
        }}
      >
        Connect runtime
      </button>
      <button
        type="button"
        onClick={() => {
          core.installRenderer();
          setSettled(true);
        }}
      >
        Finish loading capabilities
      </button>
      <button
        type="button"
        onClick={() => {
          connect();
          requestAnimationFrame(() =>
            requestAnimationFrame(() => core.installRenderer()),
          );
        }}
      >
        Connect before installing renderer
      </button>
      <button type="button" onClick={() => setListeners(core.listeners.size)}>
        Read subscriber count
      </button>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("The renderer fixture needs a root");
createRoot(root).render(<Fixture />);
