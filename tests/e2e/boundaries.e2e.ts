import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { confirmComposition } from "./ime";

const boundaries = "/admin/boundaries";
const template = {
  name: "Never type into a password field",
  description: "Stops a Bot typing into a field labelled as a password.",
  rule: 'intent == "type" && contains(element.name, "password")',
};
const custom = 'tool.name == "computer_run" && contains(command, "rm")';
const salesforce = 'mcp.server == "salesforce" && mcp.effect == "write"';
type Policy = {
  mode: "enforce" | "dry-run";
  deny: string[];
  allow: string[];
  labels?: Record<string, { name: string; description: string }>;
};
type PolicyWrite = Policy & { authoring?: { source: "english"; text: string } };
const empty = { mode: "enforce", deny: [], allow: ["true"] } satisfies Policy;
const emptyReplay = {
  scanned: 0,
  wouldRefuse: 0,
  wouldAllow: 0,
  unchanged: 0,
  changes: [],
};

async function servePolicy(
  browser: Browser,
  initial: Policy,
  {
    preview = () => Response.json({ report: emptyReplay }),
    readError,
    translate,
  }: {
    preview?: (candidate: Policy) => Response;
    readError?: () => Response;
    translate?: () => Response;
  } = {},
) {
  let stored = initial;
  const saved: PolicyWrite[] = [];
  const replayed: Policy[] = [];
  const described: { method: string; text: string }[] = [];
  await browser.route(/\/api\/computers\/policy$/, async (route) => {
    if (route.request.method === "PUT") {
      const updated: PolicyWrite = JSON.parse(route.request.postData ?? "null");
      const { authoring: _authoring, ...policy } = updated;
      stored = policy;
      saved.push(updated);
    } else if (readError) {
      const error = readError();
      return route.fulfill({
        status: error.status,
        contentType: "application/json",
        body: await error.text(),
      });
    }
    return route.fulfill({ json: { policy: stored } });
  });
  await browser.route(/\/api\/computers\/policy-dry-run$/, async (route) => {
    const input: { policy: Policy } = JSON.parse(
      route.request.postData ?? "null",
    );
    replayed.push(input.policy);
    const response = preview(input.policy);
    return route.fulfill({
      status: response.status,
      contentType: "application/json",
      body: await response.text(),
    });
  });
  if (translate) {
    await browser.route(
      /\/api\/computers\/policy-translate$/,
      async (route) => {
        const { text } = JSON.parse(route.request.postData ?? "null");
        described.push({ method: route.request.method, text });
        const response = translate();
        return route.fulfill({
          status: response.status,
          contentType: "application/json",
          body: await response.text(),
        });
      },
    );
  }
  return { saved, replayed, described };
}

function changed(overrides: Record<string, unknown>) {
  return {
    createdAt: "2026-11-09T10:45:00.000Z",
    bot: "general-assistant",
    page: "",
    element: null,
    command: null,
    file: null,
    initiator: { kind: "person", id: "" },
    was: "allowed",
    would: "refused",
    rule: salesforce,
    reason: "Blocked.",
    ...overrides,
  };
}

test("Boundaries shows saved names, template names and custom expressions", async ({
  app,
  browser,
  screen,
}) => {
  await servePolicy(browser, {
    ...empty,
    deny: ["true", template.rule, custom],
    labels: { true: { name: "Stop everything", description: "All of it." } },
  });
  await app.open(boundaries);
  for (const text of [
    "Stop everything",
    "All of it.",
    template.name,
    "Custom rule",
    custom,
  ]) {
    await expect(screen.getByText(text, { exact: true })).toBeVisible();
  }
});

test("adding a template preserves its name and description after reload", async ({
  app,
  browser,
  screen,
}) => {
  const { saved } = await servePolicy(browser, empty);
  await app.open(`${boundaries}/new`);
  await screen.getByText(template.name, { exact: true }).click();
  await screen.getByRole("button", "Add rule", { exact: true }).click();
  await expect(browser).toHaveURL(boundaries);
  await expect(screen.getByText(template.name, { exact: true })).toBeVisible();
  await browser.reload();
  await expect(screen.getByText(template.name, { exact: true })).toBeVisible();
  await expect(
    screen.getByText(template.description, { exact: true }),
  ).toBeVisible();
  expect(saved).toEqual([
    {
      ...empty,
      deny: [template.rule],
      labels: {
        [template.rule]: {
          name: template.name,
          description: template.description,
        },
      },
    },
  ]);
});

test("removing a boundary waits for confirmation and deletes its saved name", async ({
  app,
  browser,
  screen,
}) => {
  const { saved } = await servePolicy(browser, {
    ...empty,
    deny: [template.rule, custom],
    labels: { [custom]: { name: "No rm", description: "" } },
  });
  await app.open(`${boundaries}/1`);
  const remove = screen.getByRole("button", "Remove rule", { exact: true });
  const dialog = screen.getByRole("dialog");
  await remove.click();
  await expect(dialog.getByRole("heading", /Remove.*No rm/)).toBeVisible();
  expect(saved).toEqual([]);
  await dialog.getByRole("button", "Cancel", { exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(saved).toEqual([]);
  await remove.click();
  await dialog.getByRole("button", "Remove", { exact: true }).click();
  await expect.poll(() => saved.length).toBe(1);
  await app.open(boundaries);
  await expect(screen.getByText(template.name, { exact: true })).toBeVisible();
  await expect(screen.getByText("No rm", { exact: true })).toHaveCount(0);
  expect(saved).toEqual([{ ...empty, deny: [template.rule], labels: {} }]);
});

test("preview replays only the new rule and presents App and computer actions together", async ({
  app,
  browser,
  screen,
}) => {
  const { replayed, saved } = await servePolicy(
    browser,
    { ...empty, deny: [custom] },
    {
      preview: () =>
        Response.json({
          report: {
            scanned: 9,
            wouldRefuse: 2,
            wouldAllow: 0,
            unchanged: 7,
            changes: [
              changed({
                id: "a",
                kind: "app",
                action: "salesforce/update_record",
                initiator: { kind: "routine", id: "weekly-review" },
              }),
              changed({
                id: "c",
                kind: "computer",
                action: "computer_run_command",
                command: "sf data update record",
              }),
            ],
          },
        }),
    },
  );
  await app.open(`${boundaries}/new`);
  await screen.getByText("Write your own", { exact: true }).click();
  await screen.getByLabel("Rule", { exact: true }).fill(salesforce);
  await expect(screen.getByRole("button", /test/i)).toHaveCount(0);
  await expect(
    screen.getByText(
      "Of the last 9 recorded actions, this rule would have stopped 2.",
      { exact: true },
    ),
  ).toBeVisible();
  for (const text of [
    "Update record",
    "salesforce/update_record",
    "Started by a routine",
    "sf data update record",
  ]) {
    await expect(screen.getByText(text, { exact: true })).toBeVisible();
  }
  await expect(
    screen.getByRole("img", "App call", { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByRole("img", "Computer action", { exact: true }),
  ).toBeVisible();
  await expect(screen.getByText("Would stop", { exact: true })).toHaveCount(2);
  expect(replayed).toEqual([{ ...empty, deny: [salesforce] }]);
  expect(saved).toEqual([]);
});

test("a malformed boundary shows the compilation detail without a replay report", async ({
  app,
  browser,
  screen,
}) => {
  const why =
    'A rule can\'t check "elemnt". It can check tool, intent, bot, actor, initiator, page, element, key, file, command and mcp.';
  const invalid = 'elemnt.name == "Submit"';
  const { replayed, saved } = await servePolicy(browser, empty, {
    preview: (candidate) =>
      Response.json(
        { error: why, rule: candidate.deny.at(-1) },
        { status: 400 },
      ),
  });
  await app.open(`${boundaries}/new`);
  await screen.getByText("Write your own", { exact: true }).click();
  await screen.getByLabel("Rule", { exact: true }).fill(invalid);
  const alert = screen.getByRole("alert");
  await alert.getByRole("button", "Details", { exact: true }).click();
  await expect(alert).toContainText(why);
  await expect(screen.getByText(/recorded actions/)).toHaveCount(0);
  expect(replayed).toEqual([{ ...empty, deny: [invalid] }]);
  expect(saved).toEqual([]);
});

test("a saved boundary lists the App calls it stopped by comparing with its removal", async ({
  app,
  browser,
  screen,
}) => {
  const { replayed } = await servePolicy(
    browser,
    {
      ...empty,
      deny: [salesforce],
      labels: {
        [salesforce]: { name: "Never change Salesforce", description: "" },
      },
    },
    {
      preview: () =>
        Response.json({
          report: {
            scanned: 4,
            wouldRefuse: 0,
            wouldAllow: 1,
            unchanged: 3,
            changes: [
              changed({
                id: "s",
                kind: "app",
                action: "salesforce/delete_record",
                was: "refused",
                would: "allowed",
              }),
            ],
          },
        }),
    },
  );
  await app.open(`${boundaries}/0`);
  for (const text of [
    "It stopped 1 of the last 4 recorded actions.",
    "Delete record",
    "salesforce/delete_record",
    "Stopped",
  ]) {
    await expect(screen.getByText(text, { exact: true })).toBeVisible();
  }
  expect(replayed).toEqual([{ ...empty, labels: {} }]);
});

for (const { status, detail } of [
  { status: 500, detail: "The boundary could not be read." },
  { status: 403, detail: "Only an administrator may read the boundary." },
]) {
  test(`Boundaries shows its policy read failure (${status})`, async ({
    app,
    browser,
    screen,
  }) => {
    await servePolicy(browser, empty, {
      readError: () =>
        status === 500
          ? new Response(null, { status })
          : Response.json({ error: detail }, { status }),
    });
    await app.open(boundaries);
    await expect(
      screen.getByRole("heading", "Boundaries", { exact: true }),
    ).toBeVisible();
    const alert = screen.getByRole("alert");
    await alert.getByRole("button", "Details", { exact: true }).click();
    await expect(alert).toContainText(detail);
    await expect(screen.getByText("No rules yet", { exact: true })).toHaveCount(
      0,
    );
  });
}

const description = "Bots may not visit social media sites";
const social = {
  rule: 'intent == "navigate" && (page.host == "facebook.com" || matches(page.host, "[.]facebook[.]com$"))',
  effect: "deny",
  summary: "Stops a Bot opening Facebook.",
  explanation:
    "Stops a Bot from navigating to facebook.com, including its subdomains.",
  compile: { ok: true },
  warning: null,
};
const previewText =
  "Of the last 3 recorded actions, this rule would have stopped 1.";
const authoring = { source: "english", text: description };

function describedRulePreview() {
  return Response.json({
    report: {
      scanned: 3,
      wouldRefuse: 1,
      wouldAllow: 0,
      unchanged: 2,
      changes: [
        changed({
          id: "e1",
          kind: "computer",
          action: "computer_navigate",
          bot: "research-assistant",
          page: "https://www.facebook.com/groups/x",
          rule: social.rule,
        }),
      ],
    },
  });
}

test("a described boundary compiles, previews automatically and requires explicit Add", async ({
  app,
  browser,
  screen,
}) => {
  const { described, replayed, saved } = await servePolicy(browser, empty, {
    translate: () => Response.json(social),
    preview: describedRulePreview,
  });
  await app.open(`${boundaries}/new`);
  await screen.getByText("Describe it in words", { exact: true }).click();
  await screen
    .getByLabel("Describe the rule", { exact: true })
    .fill(description);
  await screen.getByRole("button", "Write rule", { exact: true }).click();

  await expect(screen.getByLabel("Rule", { exact: true })).toHaveValue(
    social.rule,
  );
  await expect(
    screen.getByText(social.explanation, { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByText("Compiles. OpenBot can check it on every action.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(screen.getByText(previewText, { exact: true })).toBeVisible();
  expect(described).toEqual([{ method: "POST", text: description }]);
  expect(replayed).toEqual([{ ...empty, deny: [social.rule] }]);
  expect(saved).toEqual([]);

  await screen.getByRole("button", "Add rule", { exact: true }).click();
  await expect(browser).toHaveURL(boundaries);
  expect(saved).toEqual([
    {
      ...empty,
      deny: [social.rule],
      labels: {
        [social.rule]: { name: description, description: social.summary },
      },
      authoring,
    },
  ]);
  await browser.reload();
  await expect(screen.getByText(description, { exact: true })).toBeVisible();
  await expect(screen.getByText(social.summary, { exact: true })).toBeVisible();
});

test("editing a generated boundary marks the original reading and keeps Add available", async ({
  app,
  browser,
  screen,
}) => {
  await servePolicy(browser, empty, { translate: () => Response.json(social) });
  await app.open(`${boundaries}/new`);
  await screen.getByText("Describe it in words", { exact: true }).click();
  await screen
    .getByLabel("Describe the rule", { exact: true })
    .fill(description);
  await screen.getByRole("button", "Write rule", { exact: true }).click();
  const rule = screen.getByLabel("Rule", { exact: true });
  const warning = screen.getByText(
    "You've changed the rule since it was written. The check and the reading above are for the written rule, not your edit.",
    { exact: true },
  );
  await expect(rule).toHaveValue(social.rule);
  await expect(warning).toHaveCount(0);

  const edited = `${social.rule} || page.host == "bsky.app"`;
  await rule.fill(edited);
  await expect(rule).toHaveValue(edited);
  await expect(warning).toBeVisible();
  await expect(
    screen.getByRole("button", "Add rule", { exact: true }),
  ).toBeEnabled();
});

test("regenerating a boundary replaces the generated summary and preserves the administrator's own", async ({
  app,
  browser,
  screen,
}) => {
  let translation = social;
  const { described } = await servePolicy(browser, empty, {
    translate: () => Response.json(translation),
  });
  await app.open(`${boundaries}/new`);
  await screen.getByText("Describe it in words", { exact: true }).click();
  await screen
    .getByLabel("Describe the rule", { exact: true })
    .fill(description);
  const write = screen.getByRole("button", "Write rule", { exact: true });
  const summary = screen.getByLabel("What it stops", { exact: true });
  await write.click();
  await expect(summary).toHaveValue(social.summary);

  translation = { ...social, summary: "Stops a Bot opening Facebook or X." };
  await write.click();
  await expect(summary).toHaveValue(translation.summary);

  const customSummary = "Keeps Bots off social sites.";
  await summary.fill(customSummary);
  translation = {
    ...social,
    summary: "Blocks visits to Facebook.",
    explanation: "Matches Facebook and its subdomains for navigation requests.",
  };
  await write.click();
  await expect(
    screen.getByText(translation.explanation, { exact: true }),
  ).toBeVisible();
  await expect(screen.getByLabel("Rule", { exact: true })).toHaveValue(
    social.rule,
  );
  await expect(summary).toHaveValue(customSummary);
  expect(described).toEqual(
    Array(3).fill({ method: "POST", text: description }),
  );
});

test("an uncompiled generated boundary shows the compiler detail and cannot preview or save", async ({
  app,
  browser,
  screen,
}) => {
  const invalid =
    "intent == \"navigate\" && (page.url[page.url.indexOf('?') + 1:].length > 200)";
  const error =
    "Expecting token of type --> CloseBracket <-- but found --> ':' <--";
  const { replayed, saved } = await servePolicy(browser, empty, {
    translate: () =>
      Response.json({
        ...social,
        rule: invalid,
        summary: null,
        explanation: null,
        compile: { ok: false, error },
      }),
  });
  await app.open(`${boundaries}/new`);
  await screen.getByText("Describe it in words", { exact: true }).click();
  await screen
    .getByLabel("Describe the rule", { exact: true })
    .fill("Block any URL with a query string longer than 200 characters");
  await screen.getByRole("button", "Write rule", { exact: true }).click();
  await expect(
    screen.getByText(`Doesn't compile, so OpenBot won't save it. ${error}`, {
      exact: true,
    }),
  ).toBeVisible();
  await expect(screen.getByLabel("Rule", { exact: true })).toHaveValue(invalid);
  await expect(
    screen.getByText("What this rule does", { exact: true }),
  ).toHaveCount(0);
  await expect(
    screen.getByRole("button", "Add rule", { exact: true }),
  ).toBeDisabled();

  // A broken generated rule must still have no preview after the 400 ms debounce.
  await Bun.sleep(600);
  await expect(screen.getByText(/recorded actions/)).toHaveCount(0);
  expect(replayed).toEqual([]);
  expect(saved).toEqual([]);
});

for (const { title, text, error, translation } of [
  {
    title: "an allow-only description leaves the boundary rule empty",
    text: "Let Bots use Gmail",
    error:
      "That says what Bots may do. A rule here stops an action, so describe what no Bot may do.",
    translation: () =>
      Response.json({
        ...social,
        effect: "allow",
        rule: 'contains(mcp.server, "gmail")',
      }),
  },
  {
    title:
      "a missing model key shows setup instructions and leaves the rule empty",
    text: description,
    error:
      "OpenBot needs a model key to write a rule from a description. Add one on the Credentials page, or write the rule in CEL.",
    translation: (error: string) => Response.json({ error }, { status: 503 }),
  },
]) {
  test(title, async ({ app, browser, screen }) => {
    const { described, saved } = await servePolicy(browser, empty, {
      translate: () => translation(error),
    });
    await app.open(`${boundaries}/new`);
    await screen.getByText("Describe it in words", { exact: true }).click();
    await screen.getByLabel("Describe the rule", { exact: true }).fill(text);
    await screen.getByRole("button", "Write rule", { exact: true }).click();
    await expect(screen.getByRole("alert")).toHaveText(error);
    await expect(screen.getByLabel("Rule", { exact: true })).toHaveValue("");
    await expect(
      screen.getByRole("button", "Add rule", { exact: true }),
    ).toBeDisabled();
    expect(described).toEqual([{ method: "POST", text }]);
    expect(saved).toEqual([]);
  });
}

test("rewriting a saved boundary previews the candidate and saves it with the original label", async ({
  app,
  browser,
  screen,
}) => {
  const old = 'intent == "navigate" && contains(page.host, "facebook.com")';
  const label = { name: "No Facebook", description: "Keeps Bots off it." };
  const { described, replayed, saved } = await servePolicy(
    browser,
    { ...empty, deny: ["true", old], labels: { [old]: label } },
    {
      translate: () => Response.json(social),
      preview: describedRulePreview,
    },
  );
  await app.open(`${boundaries}/1`);
  const rule = screen.getByLabel("Rule", { exact: true });
  const save = screen.getByRole("button", "Save rule", { exact: true });
  await expect(rule).toHaveValue(old);
  await expect(save).toHaveCount(0);
  await expect.poll(() => replayed.length).toBe(1);

  await screen
    .getByLabel("Describe the rule", { exact: true })
    .fill(description);
  await screen.getByRole("button", "Write rule", { exact: true }).click();
  await expect(rule).toHaveValue(social.rule);
  await expect(
    screen.getByText(social.explanation, { exact: true }),
  ).toBeVisible();
  await expect(screen.getByText(previewText, { exact: true })).toBeVisible();
  expect(described).toEqual([{ method: "POST", text: description }]);
  expect(replayed).toEqual([
    { ...empty, deny: ["true"], labels: {} },
    { ...empty, deny: [social.rule] },
  ]);
  expect(saved).toEqual([]);

  await save.click();
  await expect(save).toHaveCount(0);
  expect(saved).toEqual([
    {
      ...empty,
      deny: ["true", social.rule],
      labels: { [social.rule]: label },
      authoring,
    },
  ]);
  await browser.reload();
  await expect(rule).toHaveValue(social.rule);
  await expect(
    screen.getByRole("heading", label.name, { exact: true }),
  ).toBeVisible();
});

test("composing a character in a boundary name does not add the rule", async ({
  app,
  browser,
  screen,
}) => {
  const initial: Policy = { mode: "enforce", deny: [], allow: [] };
  const { saved } = await servePolicy(browser, initial);
  await app.open(`${boundaries}/new`);
  await screen.getByText("Write your own", { exact: true }).click();
  const editor = screen.getByLabel("Rule", { exact: true });
  for (const [attribute, value] of [
    ["spellcheck", "false"],
    ["autocorrect", "off"],
    ["autocapitalize", "off"],
  ])
    await expect(editor).toHaveAttribute(attribute, value);
  const rule = 'contains(element.name, "送信")';
  const ruleName = "送信しない";
  await editor.fill(rule);
  const name = screen.getByLabel("Name", { exact: true });
  await name.fill(ruleName);
  await name.focus();
  expect(await confirmComposition(browser)).toEqual([true, true]);
  const ordinaryEnterAllowed = await browser.evaluate(
    () =>
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          keyCode: 13,
          bubbles: true,
          cancelable: true,
        }),
      ) ?? false,
  );
  expect(ordinaryEnterAllowed).toBe(true);
  await expect(name).toHaveValue(ruleName);
  await expect(editor).toHaveValue(rule);
  expect(saved).toEqual([]);

  await screen.getByRole("button", "Add rule", { exact: true }).click();
  await expect(browser).toHaveURL(boundaries);
  expect(saved).toEqual([
    {
      ...initial,
      deny: [rule],
      labels: { [rule]: { name: ruleName, description: "" } },
    },
  ]);
});
