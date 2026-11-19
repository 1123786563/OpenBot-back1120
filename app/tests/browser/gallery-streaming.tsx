import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MetricsCard } from "@/components/gallery/cards";
import { BarChartCard } from "@/components/gallery/charts";
import { GalleryStreamingContext } from "@/components/gallery/streaming";
import { DataTable } from "@/components/gallery/table";
import "@/styles.css";

function GalleryStreaming() {
  const [finished, setFinished] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const label = finished ? "Revenue" : "Re";
  const pendingPoint = { label: "Pending" } as NonNullable<
    Parameters<typeof BarChartCard>[0]["points"]
  >[number];
  return (
    <main className="mx-auto max-w-3xl p-4">
      <button type="button" onClick={() => setFinished(true)}>
        Finish labels and rows
      </button>
      <button type="button" onClick={() => setNarrow((value) => !value)}>
        {narrow ? "Widen chart" : "Narrow chart"}
      </button>
      <section aria-label="Streaming bar">
        <BarChartCard
          points={[
            { label, value: 4 },
            finished ? { label: "Pending", value: 2 } : pendingPoint,
          ]}
        />
      </section>
      <section aria-label="Repeated labels">
        <BarChartCard
          points={[
            { label: "Q1", value: 1 },
            { label: "Q1", value: 2 },
          ]}
        />
      </section>
      <section aria-label="Streaming metric">
        <MetricsCard metrics={[{ label, value: "3" }]} />
      </section>
      <section aria-label="Streaming table">
        <GalleryStreamingContext.Provider value={!finished}>
          <DataTable
            columns={["Quarter", label]}
            rows={[
              { cells: ["Q1", 8] },
              { cells: finished ? ["Q2", 9] : ["Q2"] },
            ]}
            title="Sales"
          />
        </GalleryStreamingContext.Provider>
      </section>
      <section aria-label="Invalid finished table">
        <DataTable
          columns={["Quarter", "Revenue"]}
          rows={[{ cells: ["Q1", 8] }, { cells: ["Q2"] }]}
          title="Sales"
        />
      </section>
      <section
        aria-label="Bar figure width"
        style={{ width: narrow ? 82 : 640 }}
      >
        <BarChartCard
          points={[
            { label: "Support", value: 14808 },
            { label: "Billing", value: 6170 },
          ]}
        />
      </section>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing browser test root");
createRoot(root).render(<GalleryStreaming />);
