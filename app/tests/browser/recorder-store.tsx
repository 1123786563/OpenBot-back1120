import { RECORDER_STORE_IDS } from "@openbot/shared/recorder-extension";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { ThisBrowser } from "@/components/settings/browsers/this-browser";
import { Toaster } from "@/components/ui/toast";
import { queryClient } from "@/query-client";
import "@/styles.css";

RECORDER_STORE_IDS.chrome = "s".repeat(32);

const root = document.querySelector("#root");
if (!root) throw new Error("Missing browser test root");

createRoot(root).render(
  <QueryClientProvider client={queryClient}>
    <main>
      <ThisBrowser />
      <Toaster />
    </main>
  </QueryClientProvider>,
);
