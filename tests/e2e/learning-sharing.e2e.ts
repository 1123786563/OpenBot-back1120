import { type Browser, test } from "@e2e-dev/web";
import { expect, type TestFixtures } from "e2e";
import type {
  LearningSharingMode,
  PersonalLearningSharing,
  PersonalReview,
} from "../../shared/learning";

const api = "/api/settings/learning";
const personal = process.env.OPENBOT_E2E_SUITE === "personal";
const sharingTitle = "Who else's Bots use your skills";
const choices = {
  closed: {
    name: "Only my Bots",
    description: "Only the Bots you use draw on your skills.",
  },
  open: {
    name: "Everyone's Bots",
    description: "Every Bot on OpenBot draws on all of your skills.",
  },
  choose: {
    name: "The skills I choose",
    description:
      "Every Bot draws on the skills you open below; your own Bots use all of them.",
  },
};
const blocked =
  "An admin hasn't turned on sharing skills with every Bot, so only the Bots you use draw on yours.";
const closedDescription = "Only the Bots you use draw on these skills.";
const unavailable =
  "Couldn't read your Skills from the backend just now. Your choice above still applies to them.";
const empty =
  "No Skills learned from your recordings yet. Once there are, each one you open here reaches every Bot.";
const readFailure = "Couldn't load your Learning settings. Reload the page.";
const writeFailure = "Your Learning settings could not be saved.";
const directions = "Step one: look up the order.";
type Skill = NonNullable<PersonalLearningSharing["skills"]>[number];

const refund = {
  name: "refund-order",
  description: "Refunds an order.",
  open: false,
  approvedBy: null,
  sharing: "none",
} satisfies Skill;
const ticket = {
  name: "close-ticket",
  description: "Closes a ticket.",
  open: true,
  approvedBy: null,
  sharing: "none",
} satisfies Skill;
const reopen = {
  name: "reopen-ticket",
  description: "Reopens a ticket.",
  open: false,
  approvedBy: "admin",
  sharing: "none",
} satisfies Skill;
const selfApproved = (
  skill: Skill,
  sharing: Skill["sharing"] = "none",
): Skill => ({
  ...skill,
  approvedBy: "person",
  sharing,
});
const awaiting = [
  selfApproved(refund),
  selfApproved(ticket, "requested"),
  reopen,
];

const review = {
  canReview: false,
  autoApprove: null,
  sources: [],
} satisfies PersonalReview;

function changeMode(mode: LearningSharingMode) {
  return { method: "PUT", path: `${api}/mode`, body: { mode } };
}

function changeSkill(skill: Skill, open: boolean) {
  return { method: "PUT", path: `${api}/skills/${skill.name}`, body: { open } };
}

function askToShare(skill: Skill) {
  return {
    method: "POST",
    path: `${api}/skills/${skill.name}/share-request`,
    body: {},
  };
}

async function openSharing(
  {
    app,
    browser,
    screen,
  }: Pick<TestFixtures, "app" | "screen"> & { browser: Browser },
  initial: Partial<PersonalLearningSharing> = {},
  { failRead = false, failWrite = false } = {},
) {
  let data: PersonalLearningSharing = {
    mode: "closed",
    sharingAllowed: true,
    skills: [refund, ticket],
    ...initial,
  };
  const reads: string[] = [];
  const writes: { path: string; method: string; body: unknown }[] = [];
  await browser.route(/\/api\/settings\/learning(?:\/[^?#]*)?$/, (route) => {
    const { pathname: path } = new URL(route.request.url);
    const { method } = route.request;
    if (method === "GET") {
      if (path === api) {
        return failRead
          ? route.fulfill({ status: 500, body: "" })
          : route.fulfill({ json: data });
      }
      if (path === `${api}/review`) return route.fulfill({ json: review });
      const skill = data.skills?.find(
        ({ name }) => path === `${api}/skills/${name}`,
      );
      if (skill) {
        reads.push(path);
        return route.fulfill({
          json: {
            skill: {
              name: skill.name,
              description: skill.description,
              files: [{ path: "SKILL.md", text: directions }],
            },
          },
        });
      }
    } else {
      const body = JSON.parse(route.request.postData ?? "null");
      writes.push({ method, path, body });
      if (failWrite) {
        return route.fulfill({ status: 503, json: { error: writeFailure } });
      }
      if (method === "PUT" && path === `${api}/mode`) {
        data = { ...data, mode: body.mode };
        return route.fulfill({ json: { ok: true } });
      }
      const skill = data.skills?.find(({ name }) =>
        method === "PUT"
          ? path === `${api}/skills/${name}`
          : path === `${api}/skills/${name}/share-request`,
      );
      if (skill) {
        data = {
          ...data,
          skills:
            data.skills?.map((entry) =>
              entry.name === skill.name
                ? method === "PUT"
                  ? { ...entry, open: body.open }
                  : { ...entry, sharing: "requested" }
                : entry,
            ) ?? null,
        };
        return route.fulfill({ json: { ok: true } });
      }
    }
    return route.fulfill({
      status: 404,
      json: { error: "Unexpected Learning request" },
    });
  });

  await app.open("/settings/learning");
  const section = (title: string) =>
    browser.locator("main section").filter({
      has: screen.getByRole("heading", title, { exact: true }),
    });
  const settings = section(sharingTitle);
  const skills = section("Your skills");
  const choice = (mode: LearningSharingMode) =>
    settings.getByRole("button", new RegExp(`^${choices[mode].name}`));
  const row = (title: string) =>
    skills.getByRole("button", new RegExp(`^${title}`));
  const toggle = (title: string) =>
    skills.getByRole("switch", `Open ${title} to everyone`, { exact: true });
  return { settings, skills, choice, row, toggle, reads, writes };
}

if (personal) {
  test("personal edition opens learned skills without sharing modes or controls", async (fixtures) => {
    const { screen } = fixtures;
    const { settings, skills, row, reads, writes } = await openSharing(
      fixtures,
      {
        mode: "choose",
        skills: [
          selfApproved(refund),
          { ...ticket, approvedBy: "admin", sharing: "approved" },
        ],
      },
    );
    await expect(row("Refund order")).toBeVisible();
    await expect(row("Close ticket")).toBeVisible();
    await expect(settings).toHaveCount(0);
    await expect(skills.getByRole("switch")).toHaveCount(0);
    await expect(
      skills.getByRole("button", "Ask to share", { exact: true }),
    ).toHaveCount(0);
    await expect(
      skills.getByText(
        /Bots use it|Every Bot|Asked to share|Only the Bots you use|Open a skill to let/,
      ),
    ).toHaveCount(0);
    await row("Refund order").click();
    await expect(
      screen
        .getByRole("dialog", "Refund order", { exact: true })
        .getByText(directions, { exact: true }),
    ).toBeVisible();
    expect(reads).toEqual([`${api}/skills/refund-order`]);
    expect(writes).toEqual([]);
  });
} else {
  for (const mode of ["closed", "open", "choose"] as const) {
    test(`team Learning lists skills in ${mode} sharing mode`, async (fixtures) => {
      const { settings, skills, choice, row, writes } = await openSharing(
        fixtures,
        { mode },
      );
      await expect(row("Refund order")).toBeVisible();
      await expect(row("Close ticket")).toBeVisible();
      await expect(settings.getByRole("button")).toHaveCount(3);
      for (const value of ["closed", "open", "choose"] as const) {
        await expect(choice(value)).toHaveAttribute(
          "aria-pressed",
          String(value === mode),
        );
        await expect(choice(value)).toContainText(choices[value].description);
      }
      await expect(skills.getByRole("switch")).toHaveCount(
        mode === "choose" ? 2 : 0,
      );
      await expect(row("Close ticket")).toContainText(ticket.description);
      if (mode !== "choose") {
        await expect(
          skills.getByText(/Every Bot may use it|Only your Bots use it/),
        ).toHaveCount(0);
      }
      expect(writes).toEqual([]);
    });
  }

  test("selecting a new sharing mode saves immediately and selecting it again sends no write", async (fixtures) => {
    const { browser } = fixtures;
    const { choice, writes } = await openSharing(fixtures);
    await expect(choice("closed")).toHaveAttribute("aria-pressed", "true");
    await choice("closed").click();
    await choice("open").click();
    await expect(choice("open")).toBeEnabled();
    await expect(choice("open")).toHaveAttribute("aria-pressed", "true");
    expect(writes).toEqual([changeMode("open")]);
    await browser.reload();
    await expect(choice("open")).toHaveAttribute("aria-pressed", "true");
    await choice("open").click();
    await choice("choose").click();
    await expect(choice("choose")).toBeEnabled();
    await expect(choice("choose")).toHaveAttribute("aria-pressed", "true");
    expect(writes).toEqual([changeMode("open"), changeMode("choose")]);
  });

  for (const mode of ["closed", "choose"] as const) {
    test(`the skill row opens its SKILL.md in ${mode} sharing mode`, async (fixtures) => {
      const { browser, screen } = fixtures;
      const { row, toggle, reads, writes } = await openSharing(fixtures, {
        mode,
      });
      if (mode === "choose") {
        const open = toggle("Refund order");
        await expect(open).toHaveAttribute("aria-checked", "false");
        await expect(toggle("Close ticket")).toHaveAttribute(
          "aria-checked",
          "true",
        );
        await expect(row("Refund order")).toContainText(
          "Only your Bots use it. Refunds an order.",
        );
        await expect(row("Close ticket")).toContainText(
          "Every Bot may use it. Closes a ticket.",
        );
        await open.click();
        await expect(open).toBeEnabled();
        await expect(open).toHaveAttribute("aria-checked", "true");
        await expect(row("Refund order")).toContainText(
          "Every Bot may use it. Refunds an order.",
        );
        expect(writes).toEqual([changeSkill(refund, true)]);
        await browser.reload();
        await expect(open).toHaveAttribute("aria-checked", "true");
      } else {
        await expect(toggle("Refund order")).toHaveCount(0);
      }

      const dialog = screen.getByRole("dialog", "Refund order", {
        exact: true,
      });
      await expect(dialog).toHaveCount(0);
      expect(reads).toEqual([]);
      await row("Refund order").click();
      await expect(dialog.getByText(directions, { exact: true })).toBeVisible();
      expect(reads).toEqual([`${api}/skills/refund-order`]);
    });
  }

  for (const { state, skills, message } of [
    { state: "empty", skills: [], message: empty },
    {
      state: "off",
      skills: null,
      message:
        "An admin has turned off automatic learning, so no skills are learned from your recordings.",
    },
    { state: "unavailable", skills: null, message: unavailable },
  ] as const) {
    test(`team Learning explains ${state} skills`, async (fixtures) => {
      const {
        skills: section,
        choice,
        writes,
      } = await openSharing(fixtures, {
        mode: "choose",
        skills: skills ? [] : null,
        ...(state === "empty" ? {} : { unavailable: state }),
      });
      await expect(section.getByText(message, { exact: true })).toBeVisible();
      await expect(section.getByRole("switch")).toHaveCount(0);
      if (state === "unavailable") {
        await choice("closed").click();
        await expect(choice("closed")).toBeEnabled();
        await expect(choice("closed")).toHaveAttribute("aria-pressed", "true");
        expect(writes).toEqual([changeMode("closed")]);
      } else {
        expect(writes).toEqual([]);
      }
    });
  }

  for (const mode of ["closed", "open", "choose"] as const) {
    test(`the administrator sharing restriction applies to a saved ${mode} mode`, async (fixtures) => {
      const { browser } = fixtures;
      const { settings, skills, choice, toggle, writes } = await openSharing(
        fixtures,
        {
          mode,
          sharingAllowed: false,
        },
      );
      const notice =
        mode === "closed"
          ? blocked
          : `${blocked} Your choice below applies again if an admin turns it on.`;
      await expect(settings.getByText(notice, { exact: true })).toBeVisible();
      await expect(choice("closed")).toBeEnabled();
      await expect(choice("open")).toBeDisabled();
      await expect(choice("choose")).toBeDisabled();
      await expect(choice(mode)).toHaveAttribute("aria-pressed", "true");
      await expect(
        skills.getByText(closedDescription, { exact: true }),
      ).toBeVisible();
      await expect(
        skills.getByText(
          /Every Bot on OpenBot draws on these|Open a skill to let every Bot|Every Bot may use it/,
        ),
      ).toHaveCount(0);
      expect(writes).toEqual([]);

      if (mode === "choose") {
        await expect(skills.getByText(/Only your Bots use it/)).toHaveCount(2);
        const closedSkill = toggle("Refund order");
        const openSkill = toggle("Close ticket");
        await expect(closedSkill).toBeDisabled();
        await expect(openSkill).toBeEnabled();
        await openSkill.click();
        await expect(openSkill).toHaveAttribute("aria-checked", "false");
        await expect(openSkill).toBeDisabled();
        expect(writes).toEqual([changeSkill(ticket, false)]);
        await browser.reload();
        await expect(openSkill).toHaveAttribute("aria-checked", "false");
      }
    });
  }

  test("team Learning displays the read error without showing editable sharing settings", async (fixtures) => {
    const { screen } = fixtures;
    const { settings, skills, writes } = await openSharing(
      fixtures,
      {},
      { failRead: true },
    );
    const alert = screen.getByRole("alert").filter({ hasText: readFailure });
    await alert.getByRole("button", "Details", { exact: true }).click();
    await expect(alert).toContainText(readFailure);
    await expect(settings).toHaveCount(0);
    await expect(skills).toHaveCount(0);
    expect(writes).toEqual([]);
  });

  test("a refused sharing mode save reports the error and retains the previous mode", async (fixtures) => {
    const { browser, screen } = fixtures;
    const { choice, writes } = await openSharing(
      fixtures,
      {},
      { failWrite: true },
    );
    await choice("open").click();
    await expect(
      screen.getByRole("alert").filter({ hasText: writeFailure }),
    ).toBeVisible();
    await expect(choice("closed")).toHaveAttribute("aria-pressed", "true");
    expect(writes).toEqual([changeMode("open")]);
    await browser.reload();
    await expect(choice("closed")).toHaveAttribute("aria-pressed", "true");
  });

  test("Everyone's Bots offers one sharing request for a skill still awaiting approval", async (fixtures) => {
    const { browser } = fixtures;
    const { skills, row, writes } = await openSharing(fixtures, {
      mode: "open",
      skills: awaiting,
    });
    const ask = skills.getByRole("button", "Ask to share", { exact: true });
    const requested = skills.getByText("Asked to share", { exact: true });
    await expect(ask).toHaveCount(1);
    await expect(requested).toHaveCount(1);
    await expect(skills.getByRole("switch")).toHaveCount(0);
    await expect(row("Refund order")).toContainText("Only your Bots use it.");
    await expect(row("Reopen ticket")).toContainText(reopen.description);
    await expect(row("Reopen ticket")).not.toContainText(
      "Only your Bots use it.",
    );
    await ask.click();
    await expect(requested).toHaveCount(2);
    await expect(ask).toHaveCount(0);
    expect(writes).toEqual([askToShare(refund)]);
    await browser.reload();
    await expect(requested).toHaveCount(2);
    await expect(row("Refund order")).toContainText("Only your Bots use it.");
  });

  test("The skills I choose keeps an individual switch for skills still awaiting approval", async (fixtures) => {
    const { skills, toggle, writes } = await openSharing(fixtures, {
      mode: "choose",
      skills: awaiting,
    });
    for (const [title, checked] of [
      ["Refund order", "false"],
      ["Close ticket", "true"],
      ["Reopen ticket", "false"],
    ]) {
      await expect(toggle(title)).toHaveAttribute("aria-checked", checked);
    }
    await expect(skills.getByRole("switch")).toHaveCount(3);
    await expect(
      skills.getByRole("button", "Ask to share", { exact: true }),
    ).toHaveCount(0);
    await expect(
      skills.getByText("Asked to share", { exact: true }),
    ).toHaveCount(1);
    await expect(skills.getByText(/Every Bot may use it/)).toHaveCount(0);
    await expect(skills.getByText(/Only your Bots use it/)).toHaveCount(3);
    expect(writes).toEqual([]);
  });

  test("an open skill awaiting approval can be closed without asking to share", async (fixtures) => {
    const { browser } = fixtures;
    const { toggle, writes } = await openSharing(fixtures, {
      mode: "choose",
      skills: [selfApproved(ticket)],
    });
    const open = toggle("Close ticket");
    await expect(open).toHaveAttribute("aria-checked", "true");
    await open.click();
    await expect(open).toBeEnabled();
    await expect(open).toHaveAttribute("aria-checked", "false");
    expect(writes).toEqual([changeSkill(ticket, false)]);
    await browser.reload();
    await expect(open).toHaveAttribute("aria-checked", "false");
    expect(writes).toEqual([changeSkill(ticket, false)]);
  });

  for (const sharing of ["none", "requested"] as const) {
    test(`opening a skill with sharing status ${sharing} avoids duplicate approval requests`, async (fixtures) => {
      const { browser } = fixtures;
      const { skills, row, toggle, writes } = await openSharing(fixtures, {
        mode: "choose",
        skills: [selfApproved(refund, sharing)],
      });
      const open = toggle("Refund order");
      const requested = skills.getByText("Asked to share", { exact: true });
      await expect(open).toHaveAttribute("aria-checked", "false");
      await expect(requested).toHaveCount(sharing === "requested" ? 1 : 0);
      await open.click();
      await expect(requested).toHaveCount(1);
      await expect(open).toBeEnabled();
      await expect(open).toHaveAttribute("aria-checked", "true");
      await expect(row("Refund order")).toContainText("Only your Bots use it.");
      const expected = [
        changeSkill(refund, true),
        ...(sharing === "requested" ? [] : [askToShare(refund)]),
      ];
      expect(writes).toEqual(expected);
      await browser.reload();
      await expect(open).toHaveAttribute("aria-checked", "true");
      await expect(requested).toHaveCount(1);
      expect(writes).toEqual(expected);
    });
  }
}
