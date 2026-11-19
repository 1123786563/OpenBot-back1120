import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import type {
  LearningOverview,
  LearningProposal,
  LearningProposalDetail,
  LearningSettings,
} from "../../shared/learning";

const PROPOSAL = "0198a012-a20f-77c0-9e33-8992f18e74d1";
const SKILL_MD =
  "---\nname: Refund triage\ndescription: Sort refund requests.\n---\n\n# Refund triage\n\n1. Read the order date from the conversation.\n";
const pending: LearningProposal = {
  id: PROPOSAL,
  title: "Refund triage",
  description:
    "Sort refund requests by whether they are inside the 30-day window.",
  reason: "Three support conversations checked the order date by hand.",
  operation: "add",
  status: "pending_review",
  createdAt: "2026-11-04T12:00:00.000Z",
  reviewedAt: null,
};
const PERSON = "user-dana";
const PERSON_PROPOSAL = "0198a012-a20f-77c0-9e33-8992f18e74d2";
const personPending: LearningProposal = {
  ...pending,
  id: PERSON_PROPOSAL,
  title: "Quote follow-up",
  description: "Send a follow-up after a quote goes quiet.",
};
const detail: LearningProposalDetail = {
  ...pending,
  files: [
    { path: "SKILL.md", content: SKILL_MD },
    { path: "references/policy.md", content: "Refunds inside 30 days." },
  ],
  insights: [
    {
      id: "0198a012-a20f-77c0-9e33-8992f18e74a9",
      statement: "Agents look up the order date before every refund answer.",
      impact: "Answers refund questions without a hand check.",
      evidence: [
        {
          kind: "conversation",
          id: "thread-1",
          title: "Refund for order 1182",
          available: true,
          messages: [
            {
              id: "message-1",
              role: "user",
              content: "Can I get a refund on order 1182?",
            },
          ],
        },
      ],
    },
  ],
};
const noDashboard: LearningOverview = {
  configuration: "configured",
  container: { id: "openbot", name: "OpenBot" },
  pendingThreadCount: null,
  pendingCandidateCount: 1,
  publishedSkillCount: null,
  insightCount: null,
  hasActiveRun: false,
  latestRunStatus: null,
  links: { learning: null, candidates: null, runs: null },
};

const page = "/admin/learning";
const api = "/api/admin/learning";
const person = `${api}/people/${PERSON}`;
const teamProposal = `${api}/proposals/${PROPOSAL}`;
const personalProposal = `${person}/proposals/${PERSON_PROPOSAL}`;
const sharingList = `${api}/sharing-requests`;
const sharingDecision = `${sharingList}/${PERSON}/quote-follow-up`;
const skillPath = `${person}/skills/quote-follow-up`;
const firstVersion = "2026-11-05T09:00:00.000Z";
const nextVersion = "2026-11-06T08:00:00.000Z";
const versionConflict =
  "This skill changed after you opened it. Open it again to see the new version.";
const proposalFailure = "Couldn't publish this skill.";
const skillFailure = "Couldn't read this skill.";
const content = "Ask whether the quote still fits.";
const personReadFailure =
  "Couldn't read Sam Ortiz's skills. Reload the page to try again.";
const approve = "Approve and publish";
const share = "Approve sharing";

async function serveReview(
  browser: Browser,
  {
    personalReview = "admins",
    onlyUnreadable = false,
    failFirstApproval = false,
    failSharingList = false,
    failSkill = false,
    staleSharing = false,
    waitForSkill,
  }: {
    personalReview?: LearningSettings["personalReview"];
    onlyUnreadable?: boolean;
    failFirstApproval?: boolean;
    failSharingList?: boolean;
    failSkill?: boolean;
    staleSharing?: boolean;
    waitForSkill?: Promise<void>;
  } = {},
) {
  let teamStatus: LearningProposal["status"] = "pending_review";
  let personStatus: LearningProposal["status"] = "pending_review";
  let requestedAt = firstVersion;
  let sharingDecided = false;
  const reads: string[] = [];
  const posts: { method: string; path: string; body: unknown }[] = [];
  await browser.route(/\/api\/admin\/learning(?:\/[^?#]*)?$/, async (route) => {
    const { pathname: path } = new URL(route.request.url);
    const { method } = route.request;
    if (method === "GET") {
      reads.push(path);
    } else {
      posts.push({
        method,
        path,
        body: JSON.parse(route.request.postData ?? "null"),
      });
    }
    switch (path) {
      case `${api}/settings`:
        return route.fulfill({
          json: {
            settings: {
              enabled: true,
              defaultTarget: { containerId: "openbot" },
              agents: {},
              personalReview,
            },
            automatic: { state: "saved" },
          },
        });
      case `${api}/overview`:
        return route.fulfill({ json: { overview: noDashboard } });
      case `${api}/proposals`:
        return route.fulfill({
          json: {
            containerId: "openbot",
            proposals: [{ ...pending, status: teamStatus }],
          },
        });
      case `${api}/people/proposals`:
        return route.fulfill({
          json: {
            people: [
              ...(onlyUnreadable
                ? []
                : [
                    {
                      userId: PERSON,
                      name: "Dana Reyes",
                      proposals: [{ ...personPending, status: personStatus }],
                    },
                  ]),
              { userId: "user-unreadable", name: "Sam Ortiz", proposals: null },
            ],
          },
        });
      case `${api}/runs`:
        return route.fulfill({ json: { containerId: "openbot", runs: [] } });
      case `${api}/skills`:
        return route.fulfill({ json: { containerId: "openbot", skills: [] } });
      case teamProposal:
        return route.fulfill({
          json: { proposal: { ...detail, status: teamStatus } },
        });
      case personalProposal:
        return route.fulfill({
          json: {
            proposal: { ...detail, ...personPending, status: personStatus },
          },
        });
      case `${teamProposal}/approve`:
      case `${teamProposal}/reject`:
      case `${personalProposal}/approve`:
      case `${personalProposal}/reject`: {
        const approved = path.endsWith("/approve");
        if (approved && failFirstApproval) {
          failFirstApproval = false;
          return route.fulfill({
            status: 502,
            json: { error: proposalFailure },
          });
        }
        const isPersonal = path.startsWith(person);
        const status = approved ? "approved" : "rejected";
        if (isPersonal) personStatus = status;
        else teamStatus = status;
        return route.fulfill({
          json: {
            proposal: { id: isPersonal ? PERSON_PROPOSAL : PROPOSAL, status },
          },
        });
      }
      case sharingList:
        if (failSharingList) return route.fulfill({ status: 500, body: "{}" });
        return route.fulfill({
          json: {
            requests: sharingDecided
              ? []
              : [
                  {
                    userId: PERSON,
                    name: "Dana Reyes",
                    skillName: "quote-follow-up",
                    requestedAt,
                  },
                ],
          },
        });
      case skillPath:
        await waitForSkill;
        if (failSkill) {
          return route.fulfill({ status: 503, json: { error: skillFailure } });
        }
        return route.fulfill({
          json: {
            skill: {
              name: "quote-follow-up",
              description: "Follow up on a quiet quote.",
              files: [{ path: "SKILL.md", text: content }],
            },
          },
        });
      case `${sharingDecision}/approve`:
      case `${sharingDecision}/decline`:
        if (staleSharing && requestedAt === firstVersion) {
          requestedAt = nextVersion;
          return route.fulfill({
            status: 409,
            json: { error: versionConflict },
          });
        }
        sharingDecided = true;
        return route.fulfill({
          json: {
            sharing: path.endsWith("/approve") ? "approved" : "declined",
          },
        });
      default:
        return route.fulfill({
          status: 404,
          json: { error: "Unexpected Learning request" },
        });
    }
  });
  return { posts, reads };
}

for (const proposal of [
  {
    kind: "container",
    name: "Refund triage",
    request: teamProposal,
    published:
      "Published. Bots on this container use it from their next conversation.",
  },
  {
    kind: "recording",
    name: "Quote follow-up",
    request: personalProposal,
    published: "Published. Their Bots use it from their next conversation.",
  },
]) {
  for (const decision of ["approve", "reject"]) {
    test(`Admin can ${decision} a ${proposal.kind} Learning proposal`, async ({
      app,
      browser,
      screen,
    }) => {
      const { posts, reads } = await serveReview(browser);
      await app.open(page);
      const row = screen.getByRole("button", new RegExp(`^${proposal.name}`));
      if (proposal.kind === "recording") {
        await expect(row).toContainText("Dana Reyes");
        await expect(
          screen.getByText(personReadFailure, { exact: true }),
        ).toBeVisible();
      }
      await row.click();
      const dialog = screen.getByRole("dialog", proposal.name, { exact: true });
      await expect(
        dialog.getByText("Read the order date from the conversation.", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        dialog.getByText("references/policy.md", { exact: true }),
      ).toBeVisible();
      await expect(
        dialog.getByText("Person: Can I get a refund on order 1182?", {
          exact: true,
        }),
      ).toBeVisible();
      expect(reads).toContain(proposal.request);
      expect(posts).toEqual([]);

      await dialog
        .getByRole("button", decision === "approve" ? approve : "Reject", {
          exact: true,
        })
        .click();
      await expect(
        dialog.getByText(
          decision === "approve"
            ? proposal.published
            : "Rejected. It won't be published.",
          { exact: true },
        ),
      ).toBeVisible();
      expect(posts).toEqual([
        { method: "POST", path: `${proposal.request}/${decision}`, body: {} },
      ]);
      await dialog.getByRole("button", "Done", { exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await browser.reload();
      if (proposal.kind === "container") {
        await expect(row).toContainText(
          decision === "approve" ? "Published" : "Rejected",
        );
      } else {
        await expect(
          screen.getByText(personReadFailure, { exact: true }),
        ).toBeVisible();
        await expect(row).toHaveCount(0);
      }
    });
  }

  test(`a refused ${proposal.kind} proposal approval keeps the choices and can be retried`, async ({
    app,
    browser,
    screen,
  }) => {
    const { posts } = await serveReview(browser, { failFirstApproval: true });
    await app.open(page);
    await screen.getByRole("button", new RegExp(`^${proposal.name}`)).click();
    const dialog = screen.getByRole("dialog", proposal.name, { exact: true });
    const publish = dialog.getByRole("button", approve, { exact: true });
    await publish.click();
    const alert = dialog.getByRole("alert");
    await alert.getByRole("button", "Details", { exact: true }).click();
    await expect(alert).toContainText(proposalFailure);
    await expect(publish).toBeEnabled();
    await expect(
      dialog.getByRole("button", "Reject", { exact: true }),
    ).toBeEnabled();
    const approval = {
      method: "POST",
      path: `${proposal.request}/approve`,
      body: {},
    };
    expect(posts).toEqual([approval]);

    await publish.click();
    await expect(
      dialog.getByText(proposal.published, { exact: true }),
    ).toBeVisible();
    expect(posts).toEqual([approval, approval]);
  });
}

test("Admin sees the person's read failure without an empty review message", async ({
  app,
  browser,
  screen,
}) => {
  await serveReview(browser, { onlyUnreadable: true });
  await app.open(page);
  await expect(
    screen.getByText(personReadFailure, { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByText("Nothing to review", { exact: true }),
  ).toHaveCount(0);
});

test("Admin keeps sharing requests available when people approve their own proposals", async ({
  app,
  browser,
  screen,
}) => {
  const { reads } = await serveReview(browser, { personalReview: "people" });
  await app.open(page);
  await expect(
    screen.getByRole("heading", "Sharing requests", { exact: true }),
  ).toBeVisible();
  await expect(screen.getByRole("button", /^Quote follow up/)).toBeVisible();
  await expect(
    screen.getByRole("heading", "From people's recordings", { exact: true }),
  ).toHaveCount(0);
  await expect(screen.getByRole("button", /^Quote follow-up/)).toHaveCount(0);
  expect(reads).not.toContain(`${api}/people/proposals`);
});

for (const decision of ["approve", "decline"]) {
  test(`Admin can ${decision} sharing after reading the skill`, async ({
    app,
    browser,
    screen,
  }) => {
    const { posts, reads } = await serveReview(browser, {
      personalReview: "people",
    });
    await app.open(page);
    const row = screen.getByRole("button", /^Quote follow up/);
    await expect(row).toContainText("Dana Reyes");
    await row.click();
    const dialog = screen.getByRole("dialog", "Quote follow up", {
      exact: true,
    });
    await expect(dialog.getByText(content, { exact: true })).toBeVisible();
    expect(reads).toContain(skillPath);
    expect(posts).toEqual([]);

    await dialog
      .getByRole("button", decision === "approve" ? share : "Decline", {
        exact: true,
      })
      .click();
    await expect(dialog).toHaveCount(0);
    await expect(row).toHaveCount(0);
    expect(posts).toEqual([
      {
        method: "POST",
        path: `${sharingDecision}/${decision}`,
        body: { requestedAt: firstVersion },
      },
    ]);
    await browser.reload();
    await expect(
      screen.getByText("No requests to share", { exact: true }),
    ).toBeVisible();
    await expect(row).toHaveCount(0);
  });
}

test("retrying a refused sharing decision submits the refreshed request version", async ({
  app,
  browser,
  screen,
}) => {
  const { posts, reads } = await serveReview(browser, { staleSharing: true });
  await app.open(page);
  const row = screen.getByRole("button", /^Quote follow up/);
  await row.click();
  const dialog = screen.getByRole("dialog", "Quote follow up", { exact: true });
  await expect(dialog.getByText(content, { exact: true })).toBeVisible();
  const publish = dialog.getByRole("button", share, { exact: true });
  const countReads = () => reads.filter((path) => path === sharingList).length;
  const before = countReads();
  await publish.click();
  const alert = dialog.getByRole("alert");
  await alert.getByRole("button", "Details", { exact: true }).click();
  await expect(alert).toContainText(versionConflict);
  await expect(dialog.getByText(content, { exact: true })).toBeVisible();
  await expect.poll(countReads).toBeGreaterThan(before);
  await expect(publish).toBeEnabled();

  await publish.click();
  await expect(dialog).toHaveCount(0);
  await expect(row).toHaveCount(0);
  expect(posts).toEqual(
    [firstVersion, nextVersion].map((requestedAt) => ({
      method: "POST",
      path: `${sharingDecision}/approve`,
      body: { requestedAt },
    })),
  );
});

for (const failSkill of [false, true]) {
  test(`sharing stays unavailable ${failSkill ? "if the skill cannot be read" : "until the skill can be read"}`, async ({
    app,
    browser,
    screen,
  }) => {
    const { promise, resolve } = Promise.withResolvers<void>();
    const { posts, reads } = await serveReview(browser, {
      failSkill,
      waitForSkill: promise,
    });
    await app.open(page);
    await screen.getByRole("button", /^Quote follow up/).click();
    const dialog = screen.getByRole("dialog", "Quote follow up", {
      exact: true,
    });
    const publish = dialog.getByRole("button", share, { exact: true });
    const decline = dialog.getByRole("button", "Decline", { exact: true });
    try {
      await expect.poll(() => reads.includes(skillPath)).toBe(true);
      await expect(publish).toBeDisabled();
      await expect(decline).toBeDisabled();
    } finally {
      resolve();
    }

    if (failSkill) {
      const alert = dialog.getByRole("alert");
      await alert.getByRole("button", "Details", { exact: true }).click();
      await expect(alert).toContainText(skillFailure);
      await expect(publish).toBeDisabled();
      await expect(decline).toBeDisabled();
    } else {
      await expect(dialog.getByText(content, { exact: true })).toBeVisible();
      await expect(publish).toBeEnabled();
      await expect(decline).toBeEnabled();
    }
    expect(posts).toEqual([]);
  });
}

test("a sharing requests read failure keeps the section and server details visible", async ({
  app,
  browser,
  screen,
}) => {
  await serveReview(browser, { failSharingList: true });
  await app.open(page);
  const heading = screen.getByRole("heading", "Sharing requests", {
    exact: true,
  });
  await expect(heading).toBeVisible();
  const section = browser.locator("main section").filter({ has: heading });
  const alert = section.getByRole("alert");
  await alert.getByRole("button", "Details", { exact: true }).click();
  await expect(alert).toContainText("{}");
  await expect(
    section.getByText("No requests to share", { exact: true }),
  ).toHaveCount(0);
});
