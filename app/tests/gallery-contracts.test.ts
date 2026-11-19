import { expect, test } from "bun:test";
import { COMPONENT_GUIDANCE } from "@openbot/shared/bot-prompt";
import { GALLERY as ACTIVITY } from "@/components/gallery/activity";
import { GALLERY as CARDS } from "@/components/gallery/cards";
import { GALLERY as CHARTS } from "@/components/gallery/charts";
import { GALLERY as DECISIONS } from "@/components/gallery/decisions";
import { GALLERY as FORMS, FormCardArgs } from "@/components/gallery/form";
import { GALLERY as QUOTES } from "@/components/gallery/quote";
import { DataTableProps, GALLERY as TABLES } from "@/components/gallery/table";

const form = {
  title: "Project brief",
  fields: [{ id: "team", label: "Team", type: "text", required: true }],
};

test("checklist guidance reserves checklists for tasks instead of crossed-out recommendations", () => {
  const description =
    CARDS.find(
      (entry) => entry.name === "showChecklist",
    )?.description.toLowerCase() ?? "";
  expect(description).toContain("tasks");
  expect(description).toMatch(/not .*(information|findings|recommendations)/);
  const guidance = COMPONENT_GUIDANCE.replace(/\s+/g, " ");
  expect(guidance).not.toMatch(/a list or a plan: a checklist/i);
  expect(guidance).toMatch(/recommendations[^.]*never a checklist/i);
});

test("table schemas refuse duplicate column names and mismatched row widths", () => {
  expect(
    DataTableProps.safeParse({
      title: "Capacity",
      columns: ["Team", "Hours"],
      rows: [{ cells: ["Design"] }],
    }).success,
  ).toBe(false);
  expect(
    DataTableProps.safeParse({
      title: "Capacity",
      columns: ["Same", "Same"],
      rows: [],
    }).success,
  ).toBe(false);
});

test("form schemas refuse select fields without options and duplicate IDs", () => {
  expect(
    FormCardArgs.safeParse({
      title: "Bad",
      fields: [{ id: "team", label: "Team", type: "select" }],
    }).success,
  ).toBe(false);
  expect(
    FormCardArgs.safeParse({
      ...form,
      fields: [form.fields[0], form.fields[0]],
    }).success,
  ).toBe(false);
});

test("table and form tools publish previews that satisfy their argument schemas", () => {
  expect(TABLES[0].name).toBe("showTable");
  expect(TABLES[0].kind).toBe("card");
  expect(DataTableProps.safeParse(TABLES[0].preview).success).toBe(true);
  expect(FORMS[0].name).toBe("askForm");
  expect(FORMS[0].kind).toBe("decision");
  expect(FormCardArgs.safeParse(FORMS[0].preview?.args).success).toBe(true);
});

test("all built-in component summaries are short sentences for a person, not model instructions", () => {
  for (const entry of [
    ...ACTIVITY,
    ...CARDS,
    ...CHARTS,
    ...DECISIONS,
    ...FORMS,
    ...QUOTES,
    ...TABLES,
  ]) {
    expect(entry.summary.length).toBeGreaterThan(0);
    expect(entry.summary).not.toMatch(/\b(show|ask)[A-Z]\w+/);
    expect(entry.summary).not.toMatch(/deployment|rather than|—/);
    expect(entry.summary.split(/\s+/).length).toBeLessThanOrEqual(25);
    expect(entry.summary).not.toBe(entry.description);
  }
});
