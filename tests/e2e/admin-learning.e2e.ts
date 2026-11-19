import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import type {
  LearningOverview,
  LearningRunSummary,
} from "../../shared/learning";

test("Admin opens a published skill using the encoded skill name and selected Bot", async ({
  app,
  browser,
  screen,
}) => {
  const name = "a b/c";
  const description = "Checks the example order.";
  const agentId = "general-assistant";
  const root = "/api/admin/learning/skills";
  const reads: string[] = [];
  await browser.route(
    /\/api\/admin\/learning\/skills(?:\?[^#]*)?$/,
    async (route) => {
      const selected = new URL(route.request.url).searchParams.get("agentId");
      await route.fulfill({
        json: {
          containerId: selected === agentId ? "fixture-container" : null,
          skills: selected === agentId ? [{ name, description }] : [],
        },
      });
    },
  );
  await browser.route(
    /\/api\/admin\/learning\/skills\/[^/?#]+(?:\?[^#]*)?$/,
    (route) => {
      const url = new URL(route.request.url);
      reads.push(url.pathname + url.search);
      if (
        url.pathname + url.search !==
        `${root}/a%20b%2Fc?agentId=${agentId}`
      ) {
        return route.fulfill({
          status: 404,
          json: { error: "No skill at this address" },
        });
      }
      return route.fulfill({
        json: {
          skill: {
            name,
            description,
            files: [
              {
                path: "SKILL.md",
                text: "---\nname: a b/c\n---\n\nCheck the order first.",
              },
            ],
          },
        },
      });
    },
  );

  await app.open("/admin/learning");
  const container = screen.getByLabel("Show the container for");
  await expect(container).toBeVisible();
  await container.selectOption({ value: agentId });
  await expect(
    screen.getByRole("heading", "Published skills", { exact: true }),
  ).toBeVisible();
  const dialog = screen.getByRole("dialog");
  const row = screen.getByRole("button", /Checks the example order\./);
  await expect(row).toBeVisible();
  await expect(dialog).toHaveCount(0);
  expect(reads).toEqual([]);
  await row.tap();

  await expect(
    dialog.getByText("Check the order first.", { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText("SKILL.md", { exact: true })).toHaveCount(0);
  expect(reads).toEqual([`${root}/a%20b%2Fc?agentId=${agentId}`]);
  await dialog.getByRole("button", "Done", { exact: true }).tap();
  await expect(dialog).toHaveCount(0);
});

const learning = "/admin/learning";
const api = "/api/admin/learning";
const dashboard = "https://app.intelligence.example/o/acme/support/learning";
const runsLink = "https://app.intelligence.example/o/acme/support/runs";
const modelProblem =
  "Learning can't run on the model you signed in with. To use it, sign OpenBot in with an OpenAI or Anthropic API key, or a Claude or ChatGPT plan.";
const noModel = "The backend has no model set up for Learning yet.";
const noDashboard = {
  configuration: "configured",
  container: { id: "openbot", name: "OpenBot" },
  pendingThreadCount: null,
  pendingCandidateCount: 1,
  publishedSkillCount: null,
  insightCount: null,
  hasActiveRun: false,
  latestRunStatus: null,
  links: { learning: null, candidates: null, runs: null },
} satisfies LearningOverview;
const finished = {
  id: "0198a012-a20f-77c0-9e33-8992f18e74c2",
  status: "succeeded",
  trigger: "manual",
  proposals: 2,
  insights: 5,
  failureCode: null,
  createdAt: "2026-11-05T10:00:00.000Z",
  startedAt: "2026-11-05T10:00:01.000Z",
  completedAt: "2026-11-05T10:03:00.000Z",
} satisfies LearningRunSummary;
const failed = {
  id: "0198a012-a20f-77c0-9e33-8992f18e74c3",
  status: "failed",
  trigger: "automatic",
  proposals: null,
  insights: null,
  failureCode: "LEARNING_MODEL_NOT_CONFIGURED",
  createdAt: "2026-11-04T10:00:00.000Z",
  startedAt: null,
  completedAt: null,
} satisfies LearningRunSummary;

async function serveRuns(
  browser: Browser,
  {
    overview = noDashboard,
    runs = [],
    containerId = "openbot",
  }: {
    overview?: LearningOverview;
    runs?: LearningRunSummary[];
    containerId?: string | null;
  } = {},
) {
  const reads: string[] = [];
  const posts: { method: string; path: string; body: unknown }[] = [];
  const readPaths = new Map([
    ["/overview", { overview }],
    [
      "/settings",
      {
        settings: {
          enabled: true,
          defaultTarget: containerId ? { containerId } : null,
          agents: {},
        },
        automatic: { state: "saved" },
      },
    ],
    ["/proposals", { containerId, proposals: [] }],
    [
      "/skills",
      {
        containerId,
        skills: containerId
          ? [
              {
                name: "invoice-lookup",
                description: "Find an invoice by number.",
              },
            ]
          : [],
      },
    ],
    [
      "/skills/invoice-lookup",
      {
        skill: {
          name: "invoice-lookup",
          description: "Find an invoice by number.",
          files: [
            {
              path: "SKILL.md",
              text: "Search billing for the invoice number.",
            },
          ],
        },
      },
    ],
    ["/runs", { containerId, runs }],
    ["/people/proposals", { people: [] }],
    ["/sharing-requests", { requests: [] }],
  ]);
  await browser.route(/\/api\/admin\/learning\/[^?#]+$/, (route) => {
    const { pathname } = new URL(route.request.url);
    const path = pathname.slice(api.length);
    const { method } = route.request;
    if (method === "POST" && path === "/runs") {
      posts.push({
        method,
        path,
        body: JSON.parse(route.request.postData ?? "null"),
      });
      return route.fulfill({
        json: { run: { id: "queued-run", status: "queued" } },
      });
    }
    const data = readPaths.get(path);
    if (!data)
      return route.fulfill({
        status: 404,
        json: { error: "Unexpected Learning request" },
      });
    reads.push(path);
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(data),
    });
  });
  return { reads, posts };
}

test("Refresh status reads the overview, proposals, analysis runs and published skills again", async ({
  app,
  browser,
  screen,
}) => {
  const { reads, posts } = await serveRuns(browser);
  const paths = ["/overview", "/proposals", "/runs", "/skills"];
  const counts = () =>
    paths.map((name) => reads.filter((path) => path === name).length);
  await app.open(learning);
  await expect.poll(counts).toEqual([1, 1, 1, 1]);
  await screen.getByRole("button", "Refresh status", { exact: true }).click();
  await expect.poll(counts).toEqual([2, 2, 2, 2]);
  await screen.getByRole("button", /^Invoice lookup/).click();
  await expect(
    screen
      .getByRole("dialog", "Invoice lookup", { exact: true })
      .getByText("Search billing for the invoice number.", { exact: true }),
  ).toBeVisible();
  expect(reads).toContain("/skills/invoice-lookup");
  expect(posts).toEqual([]);
});

test("Learn now starts a run for the deployment's displayed container", async ({
  app,
  browser,
  screen,
}) => {
  const { posts } = await serveRuns(browser);
  await app.open(learning);
  await expect(
    screen.getByText("OpenBot (openbot)", { exact: true }),
  ).toBeVisible();
  const start = screen.getByRole("button", "Learn now", { exact: true });
  expect(posts).toEqual([]);
  await start.click();
  await expect(
    screen.getByText(
      "Learning started. New skills appear here when it finishes.",
      { exact: true },
    ),
  ).toBeVisible();
  expect(posts).toEqual([{ method: "POST", path: "/runs", body: {} }]);
});

test("Analysis runs names failures and keeps the dashboard link at the Learning overview", async ({
  app,
  browser,
  screen,
}) => {
  await serveRuns(browser, {
    overview: {
      ...noDashboard,
      pendingThreadCount: 4,
      publishedSkillCount: 2,
      insightCount: 3,
      links: { learning: dashboard, candidates: null, runs: runsLink },
    },
    runs: [
      finished,
      failed,
      {
        ...failed,
        id: "0198a012-a20f-77c0-9e33-8992f18e74c4",
        failureCode: "SOMETHING_NEW",
      },
    ],
  });
  await app.open(learning);
  const heading = screen.getByRole("heading", "Analysis runs", { exact: true });
  const section = browser.locator("main section").filter({ has: heading });
  for (const text of [
    "Finished · Manual",
    "2 proposed, 5 insights",
    noModel,
    "The run failed.",
  ]) {
    await expect(section.getByText(text, { exact: true })).toBeVisible();
  }
  await expect(
    section.getByText("Failed · Automatic", { exact: true }),
  ).toHaveCount(2);
  await expect(section.getByText(noModel, { exact: true })).toHaveAttribute(
    "title",
    "LEARNING_MODEL_NOT_CONFIGURED",
  );
  await expect(
    section.getByText("LEARNING_MODEL_NOT_CONFIGURED", { exact: true }),
  ).toHaveCount(0);
  const manage = screen.getByRole(
    "link",
    "Manage Learning in the backend dashboard",
    { exact: true },
  );
  await expect(manage).toHaveAttribute("href", dashboard);
  await expect(browser.locator(`a[href="${runsLink}"]`)).toHaveCount(0);
  await expect(
    screen.getByText("Threads ready", { exact: true }),
  ).toBeVisible();
});

test("Analysis runs explains when no container is set", async ({
  app,
  browser,
  screen,
}) => {
  await serveRuns(browser, { containerId: null });
  await app.open(learning);
  const heading = screen.getByRole("heading", "Analysis runs", { exact: true });
  const section = browser.locator("main section").filter({ has: heading });
  await expect(
    section.getByText("No container", { exact: true }),
  ).toBeVisible();
  await expect(
    section.getByText("No analysis runs yet", { exact: true }),
  ).toHaveCount(0);
});

for (const problem of [undefined, modelProblem]) {
  test(`Learning ${problem ? "shows incompatible model sign-in before starting a run" : "omits unsupported dashboard links and counters"}`, async ({
    app,
    browser,
    screen,
  }) => {
    const { posts } = await serveRuns(browser, {
      overview: { ...noDashboard, modelProblem: problem },
    });
    await app.open(learning);
    await expect(
      screen.getByText("OpenBot (openbot)", { exact: true }),
    ).toBeVisible();
    if (problem) {
      await expect(
        screen.getByRole("alert").filter({ hasText: modelProblem }),
      ).toBeVisible();
    } else {
      await expect(screen.getByText(modelProblem, { exact: true })).toHaveCount(
        0,
      );
      await expect(
        screen.getByRole("link", "Manage Learning in the backend dashboard", {
          exact: true,
        }),
      ).toHaveCount(0);
      await expect(
        screen.getByText("Threads ready", { exact: true }),
      ).toHaveCount(0);
      await expect(
        screen.getByText("Candidates to review", { exact: true }),
      ).toBeVisible();
    }
    expect(posts).toEqual([]);
  });
}
