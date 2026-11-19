import { MetricsCard } from "@/components/gallery/cards";
import {
  BarChartCard,
  LineChartCard,
  PieChartCard,
  ProgressChartCard,
} from "@/components/gallery/charts";
import "@/styles.css";
import { createRoot } from "react-dom/client";
import {
  points,
  shortNames,
  stories,
} from "../../../tests/e2e/fixtures/gallery-chart-points";

const params = new URLSearchParams(location.search);
const example = params.get("example");
const linkedRecord = "https://crm.example.com/accounts/4821";

function Figures() {
  const destination = params.get("link");
  const link =
    destination === "web"
      ? linkedRecord
      : destination === "non-web"
        ? "javascript:void(0)"
        : undefined;
  return (
    <section aria-label="Gallery figures">
      <BarChartCard points={[{ label: "Support", value: 12, link }]} />
      <PieChartCard
        points={[
          { label: "Cloud", value: 3, link },
          { label: "People", value: 1 },
        ]}
      />
      <ProgressChartCard
        points={[{ label: "Hiring", value: 3, target: 8, link }]}
      />
      <MetricsCard metrics={[{ label: "Revenue", value: "$412k", link }]} />
    </section>
  );
}

function ProvenanceCharts() {
  const malformed = {
    basis: "read",
    points,
    sources: [null, { title: 3 }, { title: "Notes" }, { title: "Notes" }],
    asOf: { year: 2025 },
  } as unknown as Parameters<typeof BarChartCard>[0];

  return (
    <>
      <section aria-label="Chart from sources">
        <BarChartCard
          asOf="2025"
          basis="read"
          points={points}
          sources={[
            { title: "IMF World Economic Outlook", url: "https://imf.org/weo" },
            { title: "Annual report" },
          ]}
          title="GDP from readings"
        />
      </section>
      <section aria-label="Chart from the Bot">
        <LineChartCard
          basis="own-knowledge"
          labels={["2023", "2024"]}
          series={[{ name: "GDP", values: [1, 2] }]}
          title="GDP estimate"
        />
      </section>
      <section aria-label="Chart with both notes">
        <BarChartCard
          basis="own-knowledge"
          points={points}
          sources={[{ title: "Annual report" }]}
          title="GDP with notes"
        />
      </section>
      <section aria-label="Chart with malformed sources">
        <BarChartCard {...malformed} title="GDP partial sources" />
      </section>
      <section aria-label="Chart with a non-web address">
        <BarChartCard
          basis="read"
          points={points}
          sources={[{ title: "Notes", url: "javascript:void(0)" }]}
          title="GDP unsafe source"
        />
      </section>
      <section aria-label="Archived chart">
        <BarChartCard points={points} title="Archived GDP" />
      </section>
    </>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("The chart fixture needs a root");
createRoot(root).render(
  <main className="mx-auto max-w-3xl p-4">
    {example === "ranked" ? (
      <BarChartCard points={stories} title="Stories by score" />
    ) : example === "columns" ? (
      <BarChartCard points={shortNames} title="Department totals" />
    ) : example === "figures" ? (
      <Figures />
    ) : (
      <ProvenanceCharts />
    )}
  </main>,
);
