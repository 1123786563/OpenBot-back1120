import { Collapse } from "@/components/channels/composer/collapse";
import "@/styles.css";
import { Suspense, startTransition, use, useState } from "react";
import { createRoot } from "react-dom/client";

const pending = new Promise<void>(() => {});

function Blocker() {
  performance.mark("collapse-transition-suspended");
  use(pending);
  return null;
}

function CollapseFixture() {
  const [open, setOpen] = useState(false);
  const [height, setHeight] = useState(64);
  const [suspending, setSuspending] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setHeight(64);
          setOpen(true);
        }}
      >
        Open at 64 pixels
      </button>
      <button
        type="button"
        onClick={() => {
          setHeight(96);
          setOpen(true);
        }}
      >
        Open at 96 pixels
      </button>
      <button type="button" onClick={() => setOpen(false)}>
        Close
      </button>
      <button
        type="button"
        onClick={() =>
          startTransition(() => {
            setOpen(false);
            setSuspending(true);
          })
        }
      >
        Start suspended close
      </button>
      <Suspense fallback={<p>Waiting to close</p>}>
        <section aria-label="Collapsible panel">
          <Collapse open={open} className="collapse-fixture-content">
            {open && (
              <div data-testid="collapse-fixture-body" style={{ height }}>
                Panel content
              </div>
            )}
          </Collapse>
        </section>
        {suspending && <Blocker />}
      </Suspense>
    </>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("The browser fixture needs a root");
createRoot(root).render(<CollapseFixture />);
