import { expect, test } from "bun:test";
import {
  AreaChartProps,
  BarChartProps,
  GALLERY,
  LineChartProps,
  PieChartProps,
  ProgressChartProps,
} from "@/components/gallery/charts";

const POINTS = [
  { label: "France", value: 3.1 },
  { label: "Japan", value: 4.2 },
];

test("the model has to say where a chart's figures came from", () => {
  expect(
    BarChartProps.safeParse({ title: "GDP", points: POINTS }).success,
  ).toBe(false);
  const schemas = [
    BarChartProps,
    PieChartProps,
    LineChartProps,
    AreaChartProps,
    ProgressChartProps,
  ];
  GALLERY.forEach((chart, index) => {
    expect(schemas[index].safeParse(chart.preview).success).toBe(true);
  });
});
