import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import recorded from "../../server/tests/fixtures/network-allowlist-recorded.json";

const computers = "/admin/computers";
const { text, writer, reader } = recorded.writtenFirstTime;
const { mode, entries } = JSON.parse(writer[0]!) as {
  mode: "allowlist_only";
  entries: { type: "domain"; value: string }[];
};
const reading = JSON.parse(reader) as {
  summary: string;
  reachable: string[];
  explanation: string;
};
const rules = entries.map(({ type, value }) => ({ type, value }));
const writtenList = rules.map(({ value }) => value).join("\n");
const scope = { scopeKind: "organization", scopeId: "", locked: false };
const inForce = {
  ...scope,
  mode: "defaults_plus_allowlist",
  rules: [
    { type: "domain", value: "intranet.acme.example", ports: "8443" },
    { type: "domain", value: "hubspot.com" },
  ],
} as const;
const candidate = { ...scope, mode, rules };
const summary =
  "Of the last 5 visits by Bots this policy applies to, this list would block 3 that are allowed today and would allow 1 that is blocked today.";

async function serveNetwork(browser: Browser) {
  const described: unknown[] = [];
  const replayed: unknown[] = [];
  const saved: unknown[] = [];
  let stored: typeof inForce | typeof candidate = inForce;
  await browser.route(/\/api\/admin\/enterprise$/, (route) =>
    route.fulfill({
      json: {
        capabilities: [],
        settings: {
          inactiveComputerDays: 30,
          actionRecording: false,
        },
        groups: [],
        network: [stored],
        defaultDestinations: [
          "github.com",
          "githubusercontent.com",
          "ghcr.io",
          "registry.npmjs.org",
          "pypi.org",
        ],
        mcpServers: [],
      },
    }),
  );
  await browser.route(/\/api\/agents(?:\?|$)/, (route) =>
    route.fulfill({
      json: { agents: [{ id: "ops-bot", name: "Ops Bot" }] },
    }),
  );
  await browser.route(
    /\/api\/admin\/enterprise\/network\/translate$/,
    (route) => {
      described.push({
        method: route.request.method,
        body: JSON.parse(route.request.postData ?? "null"),
      });
      return route.fulfill({
        json: { mode, rules, ...reading, check: { ok: true }, warning: null },
      });
    },
  );
  await browser.route(/\/api\/admin\/enterprise\/network\/replay$/, (route) => {
    replayed.push(JSON.parse(route.request.postData ?? "null"));
    return route.fulfill({
      json: {
        report: {
          scanned: 6,
          covered: 5,
          wouldBlock: 3,
          wouldAllow: 1,
          undecided: 0,
          unchanged: 1,
          sites: 2,
          hosts: [
            {
              host: "www.linkedin.com",
              change: "block",
              visits: 2,
              bots: ["ops-bot"],
              lastVisit: "2026-11-09T18:00:00.000Z",
            },
            {
              host: "docs.google.com",
              change: "allow",
              visits: 1,
              bots: ["ops-bot"],
              lastVisit: "2026-11-09T18:01:00.000Z",
            },
          ],
        },
      },
    });
  });
  await browser.route(/\/api\/admin\/enterprise\/network$/, (route) => {
    const body = JSON.parse(route.request.postData ?? "null");
    saved.push({ method: route.request.method, body });
    const { authoring: _authoring, ...policy } = body;
    stored = policy;
    return route.fulfill({ json: { saved: stored } });
  });
  return { described, replayed, saved };
}

test("a described network policy fills the mode and list, previews visits, and saves only on confirmation", async ({
  app,
  browser,
  screen,
}) => {
  const { described, replayed, saved } = await serveNetwork(browser);
  await browser.setViewport({ width: 600, height: 670 });
  await app.open(computers);
  const organization = screen.getByRole("button", /^Organization/);
  await organization.click();
  const dialog = screen.getByRole("dialog", "Organization network policy");
  await dialog.getByLabel("Describe the allowlist", { exact: true }).fill(text);
  await dialog.getByRole("button", "Write list", { exact: true }).click();
  for (const line of [
    "Every entry is valid. Bot computers can enforce this list.",
    "What becomes reachable",
    ...reading.reachable,
    reading.explanation,
    "www.linkedin.com",
    "docs.google.com",
    "Would block",
    "Would allow",
    summary,
  ]) {
    await expect(dialog.getByText(line, { exact: true })).toBeVisible();
  }
  await expect(dialog.getByText(/^2 visits by Ops Bot/)).toBeVisible();
  await expect(
    dialog.getByText(/^Only page visits are recorded/),
  ).toBeVisible();
  await expect(dialog.getByLabel("Allowlist", { exact: true })).toHaveValue(
    writtenList,
  );
  const modeControl = dialog.getByRole("combobox", "Mode", { exact: true });
  await expect(modeControl).toHaveText("Team allowlist only");
  expect(described).toEqual([{ method: "POST", body: { text } }]);
  expect(replayed).toEqual([candidate]);
  expect(saved).toEqual([]);

  const layout = await browser.evaluate((headline) => {
    const body = document.querySelector<HTMLElement>(
      '[role="dialog"] [data-slot="dialog-body"]',
    );
    const paragraphs = Array.from(body?.querySelectorAll("p") ?? []);
    const preview = paragraphs.find((p) => p.textContent === headline);
    const limitations = paragraphs.find((p) =>
      p.textContent?.startsWith("Only page visits are recorded."),
    );
    const list = body?.querySelector("#network-rules");
    if (!body || !preview || !limitations || !list) return null;
    const width = list.getBoundingClientRect().width;
    const verticallyScrollable = body.scrollHeight > body.clientHeight;
    return {
      previewFillsWidth: preview.getBoundingClientRect().width >= width - 4,
      noteFillsWidth: limitations.getBoundingClientRect().width >= width - 4,
      verticallyScrollable,
      horizontalOverflow: getComputedStyle(body).overflowX,
    };
  }, summary);
  expect(layout).toEqual({
    previewFillsWidth: true,
    noteFillsWidth: true,
    verticallyScrollable: true,
    horizontalOverflow: "hidden",
  });

  await dialog.getByRole("button", "Save", { exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(saved).toEqual([
    {
      method: "PUT",
      body: { ...candidate, authoring: { source: "english", text } },
    },
  ]);
  await browser.reload();
  await organization.click();
  await expect(dialog.getByLabel("Allowlist", { exact: true })).toHaveValue(
    writtenList,
  );
  await expect(modeControl).toHaveText("Team allowlist only");
});

test("editing a generated allowlist flags the old reading and previews the new list", async ({
  app,
  browser,
  screen,
}) => {
  const { replayed, saved } = await serveNetwork(browser);
  await app.open(computers);
  await screen.getByRole("button", /^Organization/).click();
  const dialog = screen.getByRole("dialog", "Organization network policy");
  await dialog.getByLabel("Describe the allowlist", { exact: true }).fill(text);
  await dialog.getByRole("button", "Write list", { exact: true }).click();
  await expect(dialog.getByText(summary, { exact: true })).toBeVisible();

  const allowlist = dialog.getByLabel("Allowlist", { exact: true });
  await allowlist.fill(`${writtenList}\nslack.com`);
  await expect(
    dialog.getByText(
      "You've changed the list since it was written. The check and the reading above are for the written list, not your edit.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect.poll(() => replayed.length).toBe(2);
  expect(replayed).toEqual([
    candidate,
    { ...candidate, rules: [...rules, { type: "domain", value: "slack.com" }] },
  ]);
  expect(saved).toEqual([]);
});

test("saving an unchanged network policy preserves domain ports and skips preview", async ({
  app,
  browser,
  screen,
}) => {
  const { replayed, saved } = await serveNetwork(browser);
  await app.open(computers);
  await screen.getByRole("button", /^Organization/).click();
  const dialog = screen.getByRole("dialog", "Organization network policy");
  await expect(dialog.getByLabel("Allowlist", { exact: true })).toHaveValue(
    "intranet.acme.example 8443\nhubspot.com",
  );
  await dialog.getByRole("button", "Save", { exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(saved).toEqual([{ method: "PUT", body: inForce }]);
  expect(replayed).toEqual([]);
});
