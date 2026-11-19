import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import type {
  LearningAutoAssignState,
  LearningOverview,
  LearningPersonalReview,
  LearningSettings,
} from "../../shared/learning";

const learning = "/admin/learning";
const baseSettings = {
  enabled: true,
  defaultTarget: null,
  agents: {},
} satisfies LearningSettings;
const pauseLabel = "Turn on automatic learning and skill delivery";
const defaultLabel = "Default container ID";
const savedNotice = "Settings saved.";
const createLabel = "Create the openbot container";
const missingContainer =
  'This project has no "openbot" Learning container yet. Nothing is collected.';
const assignedContainer =
  'OpenBot assigned this project\'s "openbot" container automatically. You can change it here.';
const instructions =
  "Sign in once with npx --yes copilotkit@latest login, then run bun scripts/setup-learning.ts.";
const approverLabel = "Who approves skills learned from people's recordings";
const peopleLabel = "Each person, for their own Bots";

function bot(id: string, hidden: boolean) {
  return {
    id,
    name: id,
    title: "Bot",
    roleDescription: "Helps",
    avatarSeed: id,
    visibility: "public",
    endpoint: null,
    builtIn: true,
    hasAuth: false,
    hasCallbackToken: false,
    hidden,
    systemOwned: true,
    canManage: true,
    mine: false,
  };
}

async function serveParticipation(
  browser: Browser,
  {
    settings = baseSettings,
    automatic = { state: "saved" },
    roster = [bot("active-bot", false), bot("hidden-bot", true)],
    readError,
    reviewResult,
  }: {
    settings?: LearningSettings;
    automatic?: LearningAutoAssignState;
    roster?: ReturnType<typeof bot>[];
    readError?: string;
    reviewResult?: Promise<{ error: string }>;
  } = {},
) {
  const writes: { method: string; path: string; body: unknown }[] = [];
  const rosterReads: (string | null)[] = [];
  await browser.route(/\/api\/agents(?:\?[^#]*)?$/, (route) => {
    const hidden = new URL(route.request.url).searchParams.get("hidden");
    rosterReads.push(hidden);
    return route.fulfill({
      json: {
        agents: roster.filter((agent) => agent.hidden === (hidden === "true")),
      },
    });
  });
  await browser.route(/\/api\/admin\/learning\/settings$/, (route) => {
    if (route.request.method === "PUT") {
      const body: LearningSettings = JSON.parse(
        route.request.postData ?? "null",
      );
      writes.push({ method: "PUT", path: "/settings", body });
      settings = { ...settings, ...body };
    } else if (readError) {
      return route.fulfill({ status: 503, json: { error: readError } });
    }
    return route.fulfill({ json: { settings, automatic } });
  });
  await browser.route(/\/api\/admin\/learning\/sharing-requests$/, (route) =>
    route.fulfill({ json: { requests: [] } }),
  );
  await browser.route(
    /\/api\/admin\/learning\/personal-review$/,
    async (route) => {
      const body: { personalReview: LearningPersonalReview } = JSON.parse(
        route.request.postData ?? "null",
      );
      writes.push({
        method: route.request.method,
        path: "/personal-review",
        body,
      });
      if (reviewResult)
        return route.fulfill({ status: 500, json: await reviewResult });
      settings = { ...settings, ...body };
      return route.fulfill({ json: { settings } });
    },
  );
  await browser.route(/\/api\/admin\/learning\/container$/, (route) => {
    writes.push({
      method: route.request.method,
      path: "/container",
      body: JSON.parse(route.request.postData ?? "null"),
    });
    if (automatic.state !== "absent" || !automatic.canCreate) {
      return route.fulfill({
        status: 403,
        json: { error: "This deployment cannot create the container." },
      });
    }
    settings = {
      ...settings,
      defaultTarget: { containerId: automatic.containerId },
    };
    automatic = { state: "assigned", containerId: automatic.containerId };
    return route.fulfill({ json: { automatic } });
  });
  await browser.route(
    /\/api\/admin\/learning\/overview(?:\?[^#]*)?$/,
    (route) =>
      route.fulfill({
        json: {
          overview: {
            configuration: "not_configured",
            pendingThreadCount: null,
            pendingCandidateCount: 0,
            publishedSkillCount: null,
            insightCount: null,
            hasActiveRun: false,
            latestRunStatus: null,
            links: { learning: null, candidates: null, runs: null },
          } satisfies LearningOverview,
        },
      }),
  );
  return { rosterReads, writes };
}

test("Learning excludes a Bot without changing the default container or pause state", async ({
  app,
  browser,
  screen,
}) => {
  const { writes } = await serveParticipation(browser, {
    roster: [],
    settings: {
      enabled: false,
      defaultTarget: { containerId: "support" },
      agents: { bot: { containerId: "sales" } },
    },
  });
  await app.open(learning);
  const participation = screen.getByRole("combobox", "bot participation", {
    exact: true,
  });
  const enabled = screen.getByRole("checkbox", pauseLabel, { exact: true });
  const defaultContainer = screen.getByLabel(defaultLabel, { exact: true });
  await expect(participation).toHaveValue("container");
  await expect(defaultContainer).toHaveValue("support");
  await expect(
    screen.getByLabel("bot container ID", { exact: true }),
  ).toHaveValue("sales");
  await participation.selectOption({ label: "Leave out of Learning" });
  await expect(participation).toHaveValue("exclude");
  await expect(
    screen.getByLabel("bot container ID", { exact: true }),
  ).toHaveCount(0);
  expect(writes).toEqual([]);

  await screen
    .getByRole("button", "Save Learning settings", { exact: true })
    .click();
  await expect(screen.getByText(savedNotice, { exact: true })).toBeVisible();
  expect(writes).toEqual([
    {
      method: "PUT",
      path: "/settings",
      body: {
        enabled: false,
        defaultTarget: { containerId: "support" },
        agents: { bot: null },
      },
    },
  ]);
  await browser.reload();
  await expect(participation).toHaveValue("exclude");
  await expect(defaultContainer).toHaveValue("support");
  await expect(enabled).not.toBeChecked();
});

test("a Learning settings failure remains visible in Participation and every approval section", async ({
  app,
  browser,
  screen,
}) => {
  const detail = "Learning settings could not be accessed.";
  const { writes } = await serveParticipation(browser, { readError: detail });
  await app.open(learning);
  for (const title of [
    "Participation",
    "Approval",
    "From people's recordings",
    "Sharing requests",
  ]) {
    const heading = screen.getByRole("heading", title, { exact: true });
    await expect(heading).toBeVisible();
    const error = browser
      .locator("main section")
      .filter({ has: heading })
      .getByRole("alert");
    await error.getByRole("button", "Details", { exact: true }).click();
    await expect(error).toContainText(detail);
  }
  await expect(
    screen.getByRole("button", "Save Learning settings", { exact: true }),
  ).toHaveCount(0);
  await expect(
    screen.getByRole("checkbox", pauseLabel, { exact: true }),
  ).toHaveCount(0);
  expect(writes).toEqual([]);
});

test("Learning offers participation controls for both active and hidden Bots", async ({
  app,
  browser,
  screen,
}) => {
  const { rosterReads, writes } = await serveParticipation(browser);
  await app.open(learning);
  for (const name of ["active-bot", "hidden-bot"]) {
    await expect(
      screen.getByRole("combobox", `${name} participation`, { exact: true }),
    ).toHaveValue("inherit");
  }
  expect(rosterReads).toContain(null);
  expect(rosterReads).toContain("true");
  expect(writes).toEqual([]);
});

for (const { automatic, defaultTarget, message } of [
  {
    automatic: { state: "absent", containerId: "openbot" },
    defaultTarget: null,
    message: missingContainer,
  },
  {
    automatic: { state: "assigned", containerId: "openbot" },
    defaultTarget: { containerId: "openbot" },
    message: assignedContainer,
  },
  {
    automatic: { state: "not_entitled" },
    defaultTarget: null,
    message:
      "This project's plan doesn't include Learning. No container was assigned.",
  },
  {
    automatic: { state: "learning_off" },
    defaultTarget: null,
    message:
      "Learning is switched off in the backend. Nothing is collected until it's turned on there.",
  },
] satisfies {
  automatic: LearningAutoAssignState;
  defaultTarget: LearningSettings["defaultTarget"];
  message: string;
}[]) {
  test(`Learning explains automatic container status ${automatic.state}`, async ({
    app,
    browser,
    screen,
  }) => {
    const { writes } = await serveParticipation(browser, {
      automatic,
      settings: { ...baseSettings, defaultTarget },
    });
    await app.open(learning);
    await expect(screen.getByText(message, { exact: true })).toBeVisible();
    await expect(screen.getByLabel(defaultLabel, { exact: true })).toHaveValue(
      defaultTarget?.containerId ?? "",
    );
    await expect(
      screen.getByText(/Couldn't reach the backend to find/),
    ).toHaveCount(0);
    expect(writes).toEqual([]);
  });
}

test("Learning keeps a manually selected container without an automatic assignment notice", async ({
  app,
  browser,
  screen,
}) => {
  const { writes } = await serveParticipation(browser, {
    settings: { ...baseSettings, defaultTarget: { containerId: "support" } },
  });
  await app.open(learning);
  await expect(screen.getByLabel(defaultLabel, { exact: true })).toHaveValue(
    "support",
  );
  for (const message of [/OpenBot assigned/, /Learning container yet/]) {
    await expect(screen.getByText(message)).toHaveCount(0);
  }
  expect(writes).toEqual([]);
});

for (const canCreate of [false, true]) {
  test(`Learning shows setup instructions when container creation is ${canCreate ? "available" : "unavailable"}`, async ({
    app,
    browser,
    screen,
  }) => {
    const { writes } = await serveParticipation(browser, {
      automatic: {
        state: "absent",
        containerId: "openbot",
        instructions,
        canCreate,
      },
    });
    await app.open(learning);
    await expect(
      screen.getByText(instructions, { exact: false }),
    ).toBeVisible();
    const create = screen.getByRole("button", createLabel, { exact: true });
    expect(writes).toEqual([]);
    if (!canCreate) {
      await expect(create).toHaveCount(0);
      return;
    }

    await create.click();
    await expect(
      screen.getByText(assignedContainer, { exact: true }),
    ).toBeVisible();
    await expect(create).toHaveCount(0);
    const container = screen.getByLabel(defaultLabel, { exact: true });
    await expect(container).toHaveValue("openbot");
    expect(writes).toEqual([{ method: "POST", path: "/container", body: {} }]);
    await browser.reload();
    await expect(container).toHaveValue("openbot");
    await expect(
      screen.getByText(assignedContainer, { exact: true }),
    ).toBeVisible();
  });
}

test("Learning saves the new approver independently of a pending Participation draft", async ({
  app,
  browser,
  screen,
}) => {
  const defaultTarget = { containerId: "openbot" };
  const { writes } = await serveParticipation(browser, {
    settings: {
      ...baseSettings,
      defaultTarget,
      personalReview: "admins",
      autoApprove: true,
    },
  });
  await app.open(learning);
  const enabled = screen.getByRole("checkbox", pauseLabel, { exact: true });
  await expect(enabled).toBeChecked();
  await enabled.click();
  await expect(enabled).not.toBeChecked();

  const approver = screen.getByRole("button", new RegExp(`^${approverLabel}`));
  await expect(approver).toContainText("Admins");
  await approver.click();
  const dialog = screen.getByRole("dialog", approverLabel);
  const people = dialog.getByRole("button", new RegExp(`^${peopleLabel}`));
  await people.click();
  await expect(people).toHaveAttribute("aria-pressed", "true");
  expect(writes).toEqual([]);
  await dialog.getByRole("button", "Save", { exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(approver).toContainText(peopleLabel);

  await expect(enabled).not.toBeChecked();
  await screen
    .getByRole("button", "Save Learning settings", { exact: true })
    .click();
  await expect(screen.getByText(savedNotice, { exact: true })).toBeVisible();
  expect(writes).toEqual([
    {
      method: "PUT",
      path: "/personal-review",
      body: { personalReview: "people" },
    },
    {
      method: "PUT",
      path: "/settings",
      body: { enabled: false, defaultTarget, agents: {} },
    },
  ]);
  await browser.reload();
  await expect(approver).toContainText(peopleLabel);
  await expect(enabled).not.toBeChecked();
  await expect(screen.getByLabel(defaultLabel, { exact: true })).toHaveValue(
    "openbot",
  );
});

test("Learning keeps the approval dialog open while saving and shows the server refusal", async ({
  app,
  browser,
  screen,
}) => {
  const failure = { error: "Couldn't save who approves." };
  const { promise, resolve } = Promise.withResolvers<typeof failure>();
  const { writes } = await serveParticipation(browser, {
    reviewResult: promise,
  });
  await app.open(learning);
  const approver = screen.getByRole("button", new RegExp(`^${approverLabel}`));
  await approver.click();
  const dialog = screen.getByRole("dialog", approverLabel);
  const people = dialog.getByRole("button", new RegExp(`^${peopleLabel}`));
  await people.click();
  const save = dialog.getByRole("button", "Save", { exact: true });
  const cancel = dialog.getByRole("button", "Cancel", { exact: true });
  await save.click();
  try {
    await expect(
      dialog.getByRole("button", "Saving…", { exact: true }),
    ).toBeDisabled();
    await expect(cancel).toBeDisabled();
    await expect(dialog).toBeVisible();
  } finally {
    resolve(failure);
  }
  const alert = dialog.getByRole("alert");
  await alert.getByRole("button", "Details", { exact: true }).click();
  await expect(alert).toContainText(failure.error);
  await expect(people).toHaveAttribute("aria-pressed", "true");
  await expect(save).toBeEnabled();
  await expect(cancel).toBeEnabled();
  expect(writes).toEqual([
    {
      method: "PUT",
      path: "/personal-review",
      body: { personalReview: "people" },
    },
  ]);
  await cancel.click();
  await expect(dialog).toHaveCount(0);
  await expect(approver).toContainText("Admins");
});
