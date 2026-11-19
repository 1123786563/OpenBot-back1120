import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import {
  computerConversation,
  computerStep,
  serveComputer,
} from "./computer-fixtures";

const question = "Open the report site.";
const reply = "The navigation is recorded.";
const toolName = "computer_navigate";
const openScreen = "Open the Bot's screen full size";

for (const scenario of [
  {
    name: "refused",
    host: "blocked.example.test",
    result: {
      ok: false,
      refused: true,
      reason: 'Policy rule: page.host == "blocked.example.test"',
    },
    failed: true,
  },
  {
    name: "failed",
    host: "lookup-failed.example.test",
    result: { ok: false, reason: "net::ERR_NAME_NOT_RESOLVED" },
    failed: true,
  },
  {
    name: "waiting for approval",
    host: "approval.example.test",
    result: { waiting: true },
    failed: false,
  },
]) {
  test(`a ${scenario.name} navigation does not leave a Computer picture in the transcript`, async (fixtures) => {
    const { browser, screen } = fixtures;
    const history = [
      { id: "browse-question", role: "user", content: question },
      ...computerStep(
        "browser-step",
        toolName,
        { url: `https://${scenario.host}/report` },
        scenario.result,
      ),
      { id: "browse-reply", role: "assistant", content: reply },
    ];
    const { state } = await computerConversation(
      fixtures,
      { status: "ready", frame: "frame" },
      { search: "", history },
    );
    const transcript = screen.getByRole("region", "Messages", { exact: true });
    await expect(transcript.getByText(reply, { exact: true })).toBeVisible();
    if (scenario.failed) {
      const summary = transcript.getByText("Used the browser", { exact: true });
      await expect(summary).toBeVisible();
      await summary.click();
      const row = transcript
        .getByRole("listitem")
        .filter({ hasText: scenario.host });
      await expect(row.getByText("Didn't work", { exact: true })).toBeVisible();
    } else {
      await expect(transcript).not.toContainText(/Opened|Blocked/);
    }
    await expect(
      transcript.getByRole("button", openScreen, { exact: true }),
    ).toHaveCount(0);
    await expect(browser.locator('[aria-label="Messages"] figure')).toHaveCount(
      0,
    );
    await expect(transcript).not.toContainText(/did not open a page/);
    expect(state.screenshots()).toBe(0);
  });
}

const previewPage = "/tests/browser/computer-navigation.html";
const previewHost = "report-preview.example.test";
const previewTitle = "Fixture reports portal";

async function servePreviewComputer(browser: Browser) {
  const computerId = "navigation-preview-fixture";
  const fixture = await serveComputer(browser, computerId, {
    status: "ready",
    frame: "frame",
  });
  fixture.setPage(`https://${previewHost}/order`);
  await browser.route(
    new RegExp(`/api/computers/${computerId}/page-frame/[^/?]+$`),
    (route) => route.fulfill({ json: { frame: null } }),
  );
  return fixture;
}

for (const scenario of [
  { name: "refused", label: "Blocked: Open" },
  { name: "failed", label: "Opened, didn't work" },
  { name: "waiting", label: null },
  { name: "standalone-empty", label: null },
]) {
  test(`the navigation preview draws no picture when ${scenario.name}`, async ({
    app,
    browser,
    screen,
  }) => {
    const fixture = await servePreviewComputer(browser);
    await app.open(`${previewPage}?scenario=${scenario.name}`);
    const preview = screen.getByRole("main", "Navigation preview", {
      exact: true,
    });
    await expect(preview).toHaveCount(1);
    if (scenario.label) {
      await expect(
        preview.getByText(scenario.label, { exact: true }),
      ).toBeVisible();
      await expect(
        preview.getByText(previewHost, { exact: true }),
      ).toBeVisible();
    } else {
      await expect(preview).toHaveText("");
    }
    await expect(
      preview.getByRole("button", openScreen, { exact: true }),
    ).toHaveCount(0);
    await expect(
      browser.locator('[aria-label="Navigation preview"] figure'),
    ).toHaveCount(0);
    await expect(preview).not.toContainText(
      /did not open a page|page\.host|ERR_NAME_NOT_RESOLVED/,
    );
    expect(fixture.screenshots()).toBe(0);
  });
}

for (const scenario of ["live", "standalone-page"]) {
  test(`the ${scenario} navigation preview keeps its page host and title`, async ({
    app,
    browser,
    screen,
  }) => {
    await servePreviewComputer(browser);
    await app.open(`${previewPage}?scenario=${scenario}`);
    const preview = screen.getByRole("main", "Navigation preview", {
      exact: true,
    });
    const figure = browser.locator('[aria-label="Navigation preview"] figure');
    await expect(
      preview.getByRole("button", openScreen, { exact: true }),
    ).toBeVisible();
    await expect(figure).toHaveCount(1);
    if (scenario === "live") {
      await expect(
        preview.getByRole("img", "What the Bot is looking at", { exact: true }),
      ).toBeVisible();
      await preview
        .getByRole("button", "Finish opening the page", { exact: true })
        .click();
      await expect(figure).toHaveCount(1);
    }
    await expect(
      browser.locator('[aria-label="Navigation preview"] figcaption'),
    ).toContainText(previewHost);
    await expect(figure.getByText(previewTitle, { exact: true })).toBeVisible();
    await expect(preview).not.toContainText(/didn't work|Blocked/);
  });
}
