import type { Browser } from "@e2e-dev/web";

export function readAuditRows(browser: Browser) {
  return browser.evaluate(() =>
    Array.from(document.querySelectorAll("tbody tr[data-outcome]"), (row) => {
      const lines = (column: string) =>
        Array.from(
          row.querySelector(`[data-column="${column}"]`)?.children ?? [],
          (line) => line.textContent,
        );
      return {
        what: lines("what"),
        who: lines("bot"),
        decision: lines("decision"),
        outcome: row.getAttribute("data-outcome"),
      };
    }),
  );
}
