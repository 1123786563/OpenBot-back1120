import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import {
  AdminComponentPreview,
  ComponentPreview,
} from "@/components/component-preview";
import { queryClient } from "@/query-client";
import "@/styles.css";

const mode = new URLSearchParams(location.search).get("mode");
const container = document.getElementById("root");
if (!container) throw new Error("Missing component preview fixture root");
createRoot(container).render(
  <QueryClientProvider client={queryClient}>
    <main aria-label="Preview tile" className="h-52 w-80">
      {mode === "read-only" ? (
        <ComponentPreview kind="sandboxed" name="custom_preview_test" />
      ) : mode === "compiled" ? (
        <AdminComponentPreview kind="card" name="showTable" />
      ) : (
        <AdminComponentPreview kind="sandboxed" name="custom_preview_test" />
      )}
    </main>
  </QueryClientProvider>,
);
