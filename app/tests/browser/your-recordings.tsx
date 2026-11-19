import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { YourRecordings } from "@/components/browser/your-recordings";
import { recorderKeys } from "@/lib/recorder/queries";
import { queryClient } from "@/query-client";
import "@/styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing browser test root");
createRoot(root).render(
  <QueryClientProvider client={queryClient}>
    <main>
      <button
        type="button"
        onClick={() => {
          void queryClient.invalidateQueries({
            queryKey: recorderKeys.recordings(),
          });
        }}
      >
        Refresh recordings
      </button>
      <YourRecordings />
    </main>
  </QueryClientProvider>,
);
