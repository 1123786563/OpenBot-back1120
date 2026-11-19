import { createRoot } from "react-dom/client";
import { useElementVisible } from "@/components/computer/preview-visibility";

function PreviewVisibility() {
  const [observe, visible] = useElementVisible<HTMLElement>();
  return (
    <main>
      <figure data-preview-ref="observed" ref={observe}>
        <figcaption>Computer preview</figcaption>
      </figure>
      <output aria-label="Preview observation">
        {visible ? "Visible" : "Hidden"}
      </output>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing browser test root");
createRoot(root).render(<PreviewVisibility />);
