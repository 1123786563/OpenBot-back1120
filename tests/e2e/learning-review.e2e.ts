import { type Browser, test } from "@e2e-dev/web";
import { expect, type TestFixtures } from "e2e";
import type {
  LearningEvidence,
  LearningProposal,
  LearningProposalDetail,
  LearningRunSummary,
  PersonalLearningSharing,
  PersonalReview,
} from "../../shared/learning";

const settings = "/api/settings/learning";
const timestamp = "2026-11-01T00:00:00Z";
const recordingLabel = "From your recordings";
const conversationLabel = "From your conversations";

function proposal(
  id: string,
  title: string,
  operation: LearningProposal["operation"] = "add",
  status: LearningProposal["status"] = "pending_review",
): LearningProposal {
  return {
    id,
    title,
    description: `${title} description`,
    reason: "Seen in your recordings.",
    operation,
    status,
    createdAt: timestamp,
    reviewedAt: null,
  };
}

const refund = proposal("p1", "refund-order");
const update = proposal("p2", "close-ticket", "update");
const removal = proposal("p3", "old-skill", "remove");
const approved = proposal("p4", "done-skill", "add", "approved");
const recordingSource = {
  containerId: "user-1",
  kind: "recordings",
  label: recordingLabel,
  latestRun: null,
  proposals: [refund, update, removal, approved],
} satisfies PersonalReview["sources"][number];

function conversationSource(
  containerId: string,
  fields: Partial<PersonalReview["sources"][number]> = {},
): PersonalReview["sources"][number] {
  return {
    containerId,
    kind: "conversations",
    label: conversationLabel,
    latestRun: null,
    proposals: [],
    ...fields,
  };
}

function run(
  id: string,
  status: LearningRunSummary["status"],
): LearningRunSummary {
  return {
    id,
    status,
    trigger: "manual",
    proposals: status === "succeeded" ? 1 : null,
    insights: null,
    failureCode: null,
    createdAt: id === "run-1" ? timestamp : "2026-11-02T00:00:00Z",
    startedAt: null,
    completedAt: null,
  };
}

function recording(
  id: string,
  title: string | null,
  eventCount: number,
  events: string[] = [],
): LearningEvidence {
  return { kind: "recording", id, title, available: true, eventCount, events };
}

type LearningFixture = {
  review: PersonalReview;
  skills?: PersonalLearningSharing["skills"];
  evidence?: LearningEvidence[];
  runFailure?: string;
  approveOnOpen?: LearningProposal;
};

async function openLearning(
  { app, browser }: Pick<TestFixtures, "app"> & { browser: Browser },
  state: LearningFixture,
) {
  const requests: { method: string; url: string; body: unknown }[] = [];
  let initialSkillsRead = false;
  let releaseInitialSkills: (() => void) | undefined;
  const initialSkills = new Promise<void>((resolve) => {
    releaseInitialSkills = resolve;
  });
  await browser.route(/\/api\/settings\/learning(?:[/?]|$)/, (route) => {
    const url = new URL(route.request.url);
    const method = route.request.method;
    const path = url.pathname;
    const requestPath = path + url.search;
    if (method !== "GET") {
      const body: unknown = JSON.parse(route.request.postData ?? "null");
      requests.push({ method, url: requestPath, body });
    }

    if (method === "GET" && path === settings) {
      initialSkillsRead = true;
      releaseInitialSkills?.();
      return route.fulfill({
        json: {
          mode: "closed",
          sharingAllowed: true,
          skills: state.skills ?? [],
        } satisfies PersonalLearningSharing,
      });
    }
    if (method === "GET" && path === `${settings}/review`) {
      return (async () => {
        if (state.approveOnOpen) {
          if (!initialSkillsRead) await initialSkills;
          const item = state.approveOnOpen;
          state.skills = [
            {
              name: item.title,
              description: item.description,
              open: false,
              approvedBy: "person",
              sharing: "none",
            },
          ];
          state.review = { ...state.review, approved: 1 };
          state.approveOnOpen = undefined;
        }
        return route.fulfill({ json: state.review });
      })();
    }
    if (method === "PUT" && path === `${settings}/auto-approve`) {
      const body: unknown = JSON.parse(route.request.postData ?? "null");
      if (
        typeof body === "object" &&
        body &&
        "autoApprove" in body &&
        typeof body.autoApprove === "boolean"
      ) {
        state.review = { ...state.review, autoApprove: body.autoApprove };
        return route.fulfill({ json: { autoApprove: body.autoApprove } });
      }
    }
    const source = state.review.sources.find(
      (entry) => entry.containerId === url.searchParams.get("container"),
    );
    if (method === "POST" && path === `${settings}/runs` && source) {
      if (state.runFailure === source.containerId) {
        return route.fulfill({ status: 500, json: { error: "Nope" } });
      }
      return route.fulfill({
        json: { run: { id: "run-2", status: "queued" } },
      });
    }
    const match = path.match(/\/proposals\/([^/]+)(?:\/(approve|reject))?$/);
    const item = source?.proposals?.find((entry) => entry.id === match?.[1]);
    if (source && item && match) {
      if (method === "GET" && !match[2]) {
        return route.fulfill({
          json: {
            proposal: {
              ...item,
              files: [{ path: "SKILL.md", content: "Look up the order." }],
              insights: state.evidence
                ? [
                    {
                      id: "i1",
                      statement: "Refunds start from the order page.",
                      impact: "Faster refunds.",
                      evidence: state.evidence,
                    },
                  ]
                : [],
            } satisfies LearningProposalDetail,
          },
        });
      }
      if (method === "POST" && match[2]) {
        const status = match[2] === "approve" ? "approved" : "rejected";
        source.proposals =
          source.proposals?.map((entry) =>
            entry.id === item.id ? { ...entry, status } : entry,
          ) ?? null;
        return route.fulfill({ json: { proposal: { id: item.id, status } } });
      }
    }
    return route.fulfill({
      status: 404,
      json: { error: "Unexpected Learning request" },
    });
  });
  await app.open("/settings/learning");
  return requests;
}

function asReviewer(
  sources: PersonalReview["sources"],
  autoApprove: boolean | null = false,
): PersonalReview {
  return { canReview: true, autoApprove, sources };
}

function learnRequest(container: string) {
  return {
    method: "POST",
    url: `${settings}/runs?container=${container}`,
    body: {},
  };
}

test("Learning lists pending operations and opens a read-only proposal for admin review", async (fixtures) => {
  const { screen } = fixtures;
  const requests = await openLearning(fixtures, {
    review: {
      canReview: false,
      autoApprove: null,
      sources: [{ ...recordingSource }],
    },
    evidence: [
      recording("r1", "Refund an order", 2, ["Open the order", "Click Refund"]),
      recording("r2", null, 2, ["Open the order", "Click Refund"]),
      recording("r3", "Recording r3", 1),
      recording("r4", "Recording r4", 2),
    ],
  });

  await expect(
    screen.getByRole("heading", "Waiting for an admin"),
  ).toBeVisible();
  await expect(screen.getByText(/An admin reviews these/)).toBeVisible();
  await expect(screen.getByText("New skill", { exact: true })).toBeVisible();
  await expect(screen.getByText("Update to Close ticket")).toBeVisible();
  await expect(screen.getByText("Remove Old skill")).toBeVisible();
  await expect(screen.getByRole("button", /^Done skill/)).toHaveCount(0);
  await expect(screen.getByRole("button", "Learn now")).toHaveCount(0);
  await expect(screen.getByText(/Latest run/)).toHaveCount(0);

  await screen.getByRole("button", /^Refund order/).tap();
  const dialog = screen.getByRole("dialog");
  await expect(dialog.getByRole("heading", "Refund order")).toBeVisible();
  await expect(dialog.getByText("Look up the order.")).toBeVisible();
  await expect(dialog.getByText("Refund an order")).toBeVisible();
  await expect(dialog.getByText("A recording")).toBeVisible();
  await expect(dialog.getByText("Open the order, Click Refund")).toHaveCount(2);
  await expect(dialog.getByText("1 step", { exact: true })).toBeVisible();
  await expect(dialog.getByText("2 steps", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", "Approve and publish")).toHaveCount(
    0,
  );
  await expect(dialog.getByRole("button", "Reject")).toHaveCount(0);
  await dialog.getByRole("button", "Done").tap();
  await expect(dialog).toHaveCount(0);
  expect(requests).toEqual([]);
});

for (const { item, name, button, action, result } of [
  {
    item: refund,
    name: /^Refund order/,
    button: "Approve and publish",
    action: "approve",
    result: "Published. Your Bots use it from their next conversation.",
  },
  {
    item: removal,
    name: /^Old skill/,
    button: "Approve removal",
    action: "approve",
    result: "Removed. Bots stop using it from their next conversation.",
  },
  {
    item: update,
    name: /^Close ticket/,
    button: "Reject",
    action: "reject",
    result: "Rejected. It won't be published.",
  },
]) {
  test(`Learning reports “${button}” on the proposal and leaves it out of the pending list`, async (fixtures) => {
    const { screen, browser } = fixtures;
    const requests = await openLearning(fixtures, {
      review: asReviewer([{ ...recordingSource }]),
    });
    const row = screen.getByRole("button", name);
    await row.tap();
    const dialog = screen.getByRole("dialog");
    await expect(dialog.getByText("Look up the order.")).toBeVisible();
    if (item.operation === "remove") {
      await expect(
        dialog.getByRole("button", "Approve and publish"),
      ).toHaveCount(0);
    }
    await dialog.getByRole("button", button, { exact: true }).tap();
    await expect(dialog.getByRole("status")).toHaveText(result);
    expect(requests).toEqual([
      {
        method: "POST",
        url: `${settings}/proposals/${item.id}/${action}?container=user-1`,
        body: {},
      },
    ]);
    await dialog.getByRole("button", "Done").tap();
    await expect(row).toHaveCount(0);
    await browser.reload();
    await expect(
      screen.getByRole("heading", "Waiting for your review"),
    ).toBeVisible();
    await expect(row).toHaveCount(0);
  });
}

for (const { name, sources, alert, unavailable } of [
  {
    name: "all sources are unreadable",
    sources: [{ ...recordingSource, proposals: null }],
    alert: "Couldn't read your proposed skills. Reload the page.",
  },
  {
    name: "at least one source was read",
    sources: [
      { ...recordingSource, proposals: null },
      conversationSource("bot-a"),
    ],
    alert: "Couldn't read some of your proposed skills.",
  },
  {
    name: "Learning is unavailable",
    sources: [
      {
        ...recordingSource,
        proposals: null,
        unavailable: "learning-off" as const,
      },
    ],
    unavailable:
      "Learning isn't available in the backend, so nothing is proposed here.",
  },
  {
    name: "Learning is unavailable for one source",
    sources: [
      {
        ...recordingSource,
        proposals: null,
        unavailable: "learning-off" as const,
      },
      conversationSource("bot-a"),
    ],
    unavailable:
      "Learning isn't available for From your recordings, so nothing is proposed there.",
  },
  {
    name: "one source is unavailable and another is unreadable",
    sources: [
      {
        ...recordingSource,
        proposals: null,
        unavailable: "learning-off" as const,
      },
      conversationSource("bot-a", { proposals: null }),
    ],
    alert: "Couldn't read your proposed skills. Reload the page.",
    unavailable:
      "Learning isn't available for From your recordings, so nothing is proposed there.",
  },
]) {
  test(`Learning explains when ${name}`, async (fixtures) => {
    const { screen } = fixtures;
    await openLearning(fixtures, { review: asReviewer(sources) });
    await expect(screen.getByRole("heading", "New skills")).toBeVisible();
    if (alert) await expect(screen.getByRole("alert")).toContainText(alert);
    if (unavailable) await expect(screen.getByText(unavailable)).toBeVisible();
    if (!alert) await expect(screen.getByRole("alert")).toHaveCount(0);
    await expect(screen.getByText("Nothing to review")).toHaveCount(0);
  });
}

for (const autoApprove of [false, null]) {
  test(`Learning explains the empty state for ${autoApprove === null ? "team" : "personal"} review`, async (fixtures) => {
    const { screen } = fixtures;
    await openLearning(fixtures, {
      review: { canReview: autoApprove !== null, autoApprove, sources: [] },
    });
    await expect(screen.getByRole("heading", "New skills")).toBeVisible();
    await expect(screen.getByText("Nothing to review")).toBeVisible();
    await expect(
      screen.getByText(
        autoApprove === null
          ? "New proposals show up here after Learning analyses your recordings."
          : "New proposals show up here after Learning analyses your recordings and conversations.",
      ),
    ).toBeVisible();
    await expect(screen.getByRole("heading", /^Waiting for/)).toHaveCount(0);
  });
}

test("personal Learning saves automatic approval and exposes proposals from both sources", async (fixtures) => {
  const { screen, browser } = fixtures;
  const state: LearningFixture = {
    review: asReviewer(
      [
        { ...recordingSource, proposals: [] },
        conversationSource("bot-a", { latestRun: run("run-1", "succeeded") }),
      ],
      true,
    ),
  };
  const requests = await openLearning(fixtures, state);
  const toggle = screen.getByRole("switch", "Approve new skills automatically");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(screen.getByRole("heading", "Your skills")).toBeVisible();
  await expect(screen.getByText("Who else's Bots use your skills")).toHaveCount(
    0,
  );
  await expect(screen.getByRole("button", "Learn now")).toHaveCount(2);
  await expect(screen.getByText("Nothing to review")).toHaveCount(0);
  await toggle.tap();
  await expect(screen.getByText("Nothing to review")).toBeVisible();
  expect(requests).toEqual([
    {
      method: "PUT",
      url: `${settings}/auto-approve`,
      body: { autoApprove: false },
    },
  ]);

  state.review = asReviewer([
    { ...recordingSource, proposals: [refund] },
    conversationSource("bot-a", {
      latestRun: run("run-1", "succeeded"),
      proposals: [proposal("p5", "reply-politely")],
    }),
  ]);
  await browser.reload();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(
    screen.getByRole("heading", "Waiting for your review"),
  ).toBeVisible();
  await expect(
    screen.getByText("Approve a skill to publish it to your Bots."),
  ).toBeVisible();
  await expect(screen.getByRole("heading", "New skills")).toHaveCount(0);
  await expect(screen.getByText(recordingLabel)).toBeVisible();
  await expect(screen.getByText(conversationLabel)).toBeVisible();
  await expect(screen.getByRole("button", /^Refund order/)).toBeVisible();
  await expect(screen.getByRole("button", /^Reply politely/)).toBeVisible();
  await expect(screen.getByText("No run yet.")).toBeVisible();
  await expect(screen.getByText("Latest run finished.")).toBeVisible();
  await expect(screen.getByRole("button", "Learn now")).toHaveCount(2);
  await browser
    .locator('[data-slot="item"]')
    .filter({ hasText: conversationLabel })
    .getByRole("button", "Learn now")
    .tap();
  await expect(
    screen.getByRole("button", "Learning in progress…"),
  ).toBeDisabled();
  expect(requests.slice(1)).toEqual([learnRequest("bot-a")]);
});

test("Learning groups same-label proposals and learns from every container even after one fails", async (fixtures) => {
  const { screen } = fixtures;
  const requests = await openLearning(fixtures, {
    review: asReviewer([
      conversationSource("bot-a", { proposals: [proposal("p-a", "skill-a")] }),
      conversationSource("bot-b", { proposals: [proposal("p-b", "skill-b")] }),
    ]),
    runFailure: "bot-a",
  });

  await expect(
    screen.getByText(conversationLabel, { exact: true }),
  ).toHaveCount(1);
  await expect(screen.getByRole("button", /^Skill a/)).toBeVisible();
  await screen.getByRole("button", /^Skill b/).tap();
  const dialog = screen.getByRole("dialog");
  await dialog.getByRole("button", "Approve and publish").tap();
  await expect(dialog.getByRole("status")).toContainText("Published.");
  expect(requests).toEqual([
    {
      method: "POST",
      url: `${settings}/proposals/p-b/approve?container=bot-b`,
      body: {},
    },
  ]);
  await dialog.getByRole("button", "Done").tap();

  const learn = screen.getByRole("button", "Learn now");
  await expect(learn).toHaveCount(1);
  await learn.tap();
  await expect(screen.getByRole("alert")).toContainText("Nope");
  expect(requests.slice(1)).toEqual([
    learnRequest("bot-a"),
    learnRequest("bot-b"),
  ]);
});

test("a Learn now failure stays with its source group", async (fixtures) => {
  const { browser, screen } = fixtures;
  const requests = await openLearning(fixtures, {
    review: asReviewer([
      { ...recordingSource, proposals: [] },
      conversationSource("bot-a"),
    ]),
    runFailure: recordingSource.containerId,
  });

  function sourceRow(label: string) {
    return browser.locator('[data-slot="item"]').filter({ hasText: label });
  }
  const recordings = sourceRow(recordingLabel);
  const conversations = sourceRow(conversationLabel);
  const learnRecordings = recordings.getByRole("button", "Learn now");
  await learnRecordings.tap();
  await expect(screen.getByRole("alert")).toContainText("Nope");
  await conversations.getByRole("button", "Learn now").tap();
  await expect(
    conversations.getByRole("button", "Learning in progress…"),
  ).toBeDisabled();
  await expect(learnRecordings).toBeEnabled();
  await expect(screen.getByRole("alert")).toHaveCount(1);
  await expect(screen.getByRole("alert")).toContainText("Nope");
  expect(requests).toEqual([
    learnRequest(recordingSource.containerId),
    learnRequest("bot-a"),
  ]);
});

test("Learn now remains disabled until the new run finishes", async (fixtures) => {
  const { screen } = fixtures;
  const state: LearningFixture = {
    review: asReviewer([
      { ...recordingSource, latestRun: run("run-1", "succeeded") },
    ]),
  };
  const requests = await openLearning(fixtures, state);
  const learn = screen.getByRole("button", "Learn now");
  const busy = screen.getByRole("button", "Learning in progress…");

  await expect(screen.getByText("Latest run finished.")).toBeVisible();
  await learn.tap();
  await expect(busy).toBeDisabled();
  await expect
    .poll(() => requests)
    .toEqual([learnRequest(recordingSource.containerId)]);
  await expect(screen.getByText(/Learning started/)).toHaveCount(0);

  state.review = asReviewer([
    { ...recordingSource, latestRun: run("run-2", "batching") },
  ]);
  await expect(screen.getByText("Latest run analyzing.")).toBeVisible();
  await expect(busy).toBeDisabled();
  state.review = asReviewer([
    { ...recordingSource, latestRun: run("run-2", "succeeded") },
  ]);
  await expect(screen.getByText("Latest run finished.")).toBeVisible();
  await expect(learn).toBeEnabled();
});

test("Learning shows a failed run's reason and keeps Learn now available", async (fixtures) => {
  const failure =
    "Learning couldn't reach OpenBot to use your model plan. Quit OpenBot and open it again, then choose Learn now.";
  await openLearning(fixtures, {
    review: asReviewer([
      {
        ...recordingSource,
        latestRun: {
          ...run("run-1", "failed"),
          failure,
          failureCode: "BatchInsightAgentFailed",
        },
      },
    ]),
  });
  const { screen } = fixtures;
  await expect(screen.getByText(`Latest run failed. ${failure}`)).toBeVisible();
  await expect(screen.getByRole("button", "Learn now")).toBeEnabled();
});

test("a queued run with automatic approval displays New skills until a proposal is pending", async (fixtures) => {
  const { screen, browser } = fixtures;
  const state: LearningFixture = {
    review: asReviewer(
      [
        {
          ...recordingSource,
          proposals: [],
          latestRun: run("run-1", "queued"),
        },
      ],
      true,
    ),
  };
  await openLearning(fixtures, state);
  const waiting = screen.getByRole("heading", "Waiting for your review");
  const newSkills = screen.getByRole("heading", "New skills");
  const description = screen.getByText(
    "Approve a skill to publish it to your Bots.",
  );
  await expect(
    screen.getByRole("button", "Learning in progress…"),
  ).toBeDisabled();
  await expect(screen.getByRole("heading", "Your skills")).toBeVisible();
  await expect(newSkills).toBeVisible();
  await expect(waiting).toHaveCount(0);
  await expect(description).toHaveCount(0);

  state.review = asReviewer(
    [
      {
        ...recordingSource,
        proposals: [],
        latestRun: run("run-1", "succeeded"),
      },
    ],
    true,
  );
  await expect(screen.getByRole("button", "Learn now")).toBeEnabled();
  await expect(waiting).toHaveCount(0);

  state.review = asReviewer(
    [{ ...recordingSource, proposals: [refund] }],
    true,
  );
  await browser.reload();
  await expect(waiting).toBeVisible();
  await expect(description).toBeVisible();
  await expect(screen.getByRole("button", /^Refund order/)).toBeVisible();
  await expect(newSkills).toHaveCount(0);
});

test("Your skills refreshes when background approval clears a proposal", async (fixtures) => {
  const { screen } = fixtures;
  const state: LearningFixture = {
    review: asReviewer([
      {
        ...recordingSource,
        proposals: [refund],
        latestRun: run("run-1", "batching"),
      },
    ]),
  };
  await openLearning(fixtures, state);
  const waiting = screen.getByRole("heading", "Waiting for your review");
  const publishedSkill = screen.getByRole("button", /^Refund order/);
  await expect(waiting).toBeVisible();
  await expect(publishedSkill).toHaveCount(1);
  await expect(screen.getByRole("heading", "Your skills")).toBeVisible();

  state.skills = [
    {
      name: refund.title,
      description: refund.description,
      open: false,
      approvedBy: "person",
      sharing: "none",
    },
  ];
  state.review = asReviewer([
    {
      ...recordingSource,
      proposals: [{ ...refund, status: "approved" }],
      latestRun: run("run-1", "succeeded"),
    },
  ]);

  await expect(waiting).toHaveCount(0);
  await expect(screen.getByText("Nothing to review")).toBeVisible();
  await expect(publishedSkill).toBeVisible();
});

test("Your skills includes skills approved while opening Learning", async (fixtures) => {
  await openLearning(fixtures, {
    review: asReviewer([], true),
    approveOnOpen: refund,
  });
  await expect(
    fixtures.screen.getByRole("heading", "Your skills"),
  ).toBeVisible();
  await expect(
    fixtures.screen.getByRole("button", /^Refund order/),
  ).toBeVisible();
});
