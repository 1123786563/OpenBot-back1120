import { type Browser, test } from "@e2e-dev/web";
import type {
  RecordingRow,
  RecordingsPage,
} from "@openbot/shared/recorder-api";
import { expect } from "e2e";

const fixture = "/tests/browser/your-recordings.html";
const empty = "No recordings yet. Each task you record shows up here.";
const offline =
  "Couldn't reach the backend to list your recordings. Try again in a moment.";
const backendUnavailable =
  "The backend isn't available, so your recordings can't be listed.";
const row = (overrides: Partial<RecordingRow> = {}): RecordingRow => ({
  id: "r1",
  title: "Refund an order",
  recordedAt: "2026-11-02T14:30:00.000Z",
  ended: "succeeded",
  reason: null,
  ...overrides,
});
const page = (
  recordings: RecordingRow[] = [],
  nextCursor: string | null = null,
): RecordingsPage => ({ recordings, nextCursor });
type Response = RecordingsPage | "error";

async function recordings(
  browser: Browser,
  respond: (cursor: string) => Response,
) {
  const cursors: string[] = [];
  await browser.route(/\/api\/recorder\/recordings(?:\?|$)/, (route) => {
    const query = new URL(route.request.url).search;
    cursors.push(query);
    const response = respond(new URLSearchParams(query).get("cursor") ?? "");
    return response === "error"
      ? route.fulfill({ status: 500, json: { error: "Server trouble" } })
      : route.fulfill({ json: response });
  });
  return cursors;
}

test("recording rows show the title, local date and each stopping reason", async ({
  app,
  browser,
  screen,
}) => {
  await recordings(browser, () =>
    page([
      row(),
      row({ id: "r2", title: null, ended: "sending" }),
      row({ id: "r3", ended: "missing" }),
      row({ id: "r4", ended: "stopped", reason: "signed-out" }),
      row({ id: "r5", ended: "stopped", reason: "interrupted" }),
      row({ id: "r6", ended: "stopped", reason: "disconnected" }),
      row({ id: "r7", ended: "unknown" }),
    ]),
  );
  await app.open(fixture);
  for (const label of [
    "Untitled recording",
    "Still sending",
    "No result",
    "Not in the backend",
    "Stopped early: signed out",
    "Stopped early: browser closed",
    "Stopped early: disconnected",
  ]) {
    await expect(screen.getByText(label, { exact: true })).toBeVisible();
  }
  const date = await browser.evaluate(
    (value) => new Date(value).toLocaleString("en"),
    row().recordedAt,
  );
  await expect(screen.getByText(date, { exact: true })).toHaveCount(7);
  await expect(
    screen.getByText("Refund an order", { exact: true }),
  ).toHaveCount(6);
  await expect(
    screen.getByRole("button", "Show more", { exact: true }),
  ).toHaveCount(0);
});

for (const { name, response, text } of [
  { name: "empty", response: page(), text: empty },
  {
    name: "unavailable",
    response: { ...page(), unavailable: "unavailable" },
    text: backendUnavailable,
  },
  {
    name: "unreachable",
    response: { ...page(), unavailable: "unreachable" },
    text: offline,
  },
  { name: "HTTP failure", response: "error", text: "Server trouble" },
] as const) {
  test(`recordings display the ${name} state`, async ({
    app,
    browser,
    screen,
  }) => {
    await recordings(browser, () => response);
    await app.open(fixture);
    await expect(screen.getByText(text, { exact: true })).toBeVisible();
    if (text !== empty)
      await expect(screen.getByText(empty, { exact: true })).toHaveCount(0);
    if (response === "error")
      await expect(screen.getByRole("alert")).toHaveText(text);
  });
}

for (const initial of ["success", "empty", "unreachable", "HTTP failure"]) {
  test(`Show more keeps loaded rows and can finish after a ${initial} page`, async ({
    app,
    browser,
    screen,
  }) => {
    const cursor = "older/page";
    let fail = initial === "unreachable" || initial === "HTTP failure";
    const asked = await recordings(browser, (requested) => {
      if (!requested) return page(initial === "empty" ? [] : [row()], cursor);
      if (fail)
        return initial === "unreachable"
          ? { ...page([], cursor), unavailable: "unreachable" }
          : "error";
      return page([row({ id: "r2", title: "Close a ticket" })]);
    });
    await app.open(fixture);
    const more = screen.getByRole("button", "Show more", { exact: true });
    const refund = screen.getByText("Refund an order", { exact: true });
    await expect(more).toBeEnabled();
    await expect(screen.getByText(empty, { exact: true })).toHaveCount(0);
    await more.click();
    const errorText =
      initial === "unreachable"
        ? offline
        : "Couldn't load more recordings. Try again.";
    if (fail) {
      await expect(screen.getByText(errorText, { exact: true })).toBeVisible();
      await expect(refund).toBeVisible();
      fail = false;
      await more.click();
    }
    await expect(
      screen.getByText("Close a ticket", { exact: true }),
    ).toBeVisible();
    await expect(screen.getByText(errorText, { exact: true })).toHaveCount(0);
    await expect(more).toHaveCount(0);
    if (initial !== "empty") await expect(refund).toBeVisible();
    expect(asked[0]).toBe("");
    expect(new Set(asked.slice(1))).toEqual(new Set(["?cursor=older%2Fpage"]));
  });
}

test("a failed refresh shows its error below the recordings that are already on screen", async ({
  app,
  browser,
  screen,
}) => {
  let fail = false;
  await recordings(browser, () => (fail ? "error" : page([row()])));
  await app.open(fixture);
  const refund = screen.getByText("Refund an order", { exact: true });
  await expect(refund).toBeVisible();
  fail = true;
  await screen
    .getByRole("button", "Refresh recordings", { exact: true })
    .click();
  await expect(
    screen.getByText("Couldn't refresh your recordings.", { exact: true }),
  ).toBeVisible();
  await expect(refund).toBeVisible();
  await expect(screen.getByRole("alert")).toHaveCount(0);
});
