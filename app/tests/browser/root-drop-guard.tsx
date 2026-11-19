import { useState } from "react";
import { createRoot } from "react-dom/client";
import { useUnclaimedDropGuard } from "@/routes/__root";

function Guard() {
  useUnclaimedDropGuard();
  return null;
}

function DropTarget() {
  const [guarded, setGuarded] = useState(true);
  const [file, setFile] = useState("");
  return (
    <main>
      {guarded ? <Guard /> : null}
      <button
        type="button"
        onClick={() => setGuarded(false)}
        disabled={!guarded}
      >
        Remove drop guard
      </button>
      <section aria-label="Page margin">
        <p>Drop outside the editor</p>
      </section>
      <section
        aria-label="File drop target"
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDrop={(event) => {
          event.preventDefault();
          setFile(event.dataTransfer.files[0]?.name ?? "");
        }}
      >
        <p>Drop a file here</p>
        <output>{file}</output>
      </section>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing browser test root");
createRoot(root).render(<DropTarget />);
