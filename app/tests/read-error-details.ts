import { expect } from "bun:test";
import { fireEvent, within } from "@testing-library/react";

/** Read a refusal through the new details control, or through a legacy inline presenter. */
export function readErrorDetails(alert: HTMLElement): string | null {
  const detail = alert.querySelector<HTMLElement>("[data-error-detail]");
  if (!detail) return alert.textContent;
  if (detail.hidden)
    fireEvent.click(within(alert).getByRole("button", { name: "Details" }));
  expect(detail.hidden).toBe(false);
  return detail.textContent;
}
