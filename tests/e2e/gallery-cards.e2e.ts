import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";

const fixture = "/tests/browser/gallery-cards.html";
const answerPath = /\/tests\/gallery-answer$/;
const address = "https://mail.google.com/mail/u/0/#inbox/1a1b9a5fcb357c40";

async function captureAnswers(browser: Browser) {
  const answers: unknown[] = [];
  await browser.route(answerPath, (route) => {
    answers.push(JSON.parse(route.request.postData ?? "null"));
    return route.fulfill({ json: {} });
  });
  return answers;
}

test("notice points display readable email links and preserve the rest of each message", async ({
  app,
  screen,
}) => {
  await app.open(fixture);
  const notice = screen.getByRole("region", "Email notice", { exact: true });
  for (const [name, id, words] of [
    ["Northwind Traders", "1a1b9a5fcb357c40", "5:00–5:25 pm."],
    [
      "Contoso",
      "1a1b9a5ac4f756e7",
      "4:00–5:00 pm. Proof-of-concept discussion.",
    ],
    ["Fabrikam", "1a1b9a594ffa763a", "2:00–3:00 pm. Weekly engineering sync."],
    ["Tailspin Toys", "1a1b9a121f53fe9c", "7:30–7:55 am."],
    ["Litware", "1a1b99f29f125e40", "7:00–7:25 am."],
  ]) {
    await expect(
      notice.getByRole("link", name, { exact: true }),
    ).toHaveAttribute("href", `https://mail.google.com/mail/u/0/#inbox/${id}`);
    await expect(notice).toContainText(words);
  }
  await expect(notice.getByRole("link")).toHaveCount(5);
  await expect(notice).toContainText(
    "Times are Pacific; your attendance is marked optional.",
  );
  await expect(notice).not.toContainText(/\]\(http|mail\.google\.com/);
});

test("a markdown link opens a separate tab without an opener or referrer", async ({
  app,
  browser,
  screen,
}) => {
  await browser.route(/^https:\/\/mail\.google\.com\/mail\/u\/0\/$/, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<title>Email fixture</title>",
    }),
  );
  await app.open(fixture);
  const link = screen
    .getByRole("region", "Email notice", { exact: true })
    .getByRole("link", "Northwind Traders", { exact: true });
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", /noreferrer/);
  const popup = await browser.waitForPopup(() => link.click());
  await expect.poll(() => popup.title()).toBe("Email fixture");
  expect(
    await browser.evaluate(
      () => window.opener === null && document.referrer === "",
    ),
  ).toBe(true);
  await popup.close();
});

test("notice bodies render bold, inline code and lists without markdown syntax", async ({
  app,
  browser,
  screen,
}) => {
  await app.open(fixture);
  const notice = screen.getByRole("region", "Rich notice", { exact: true });
  await expect(notice.getByRole("listitem")).toHaveCount(2);
  await expect(notice.getByText("Contoso", { exact: true })).toBeVisible();
  await expect(notice.getByText("Fabrikam", { exact: true })).toBeVisible();
  await expect(
    browser.locator('[aria-label="Rich notice"] [data-streamdown="strong"]'),
  ).toHaveText("Two");
  await expect(browser.locator('[aria-label="Rich notice"] code')).toHaveText(
    "Friday",
  );
  await expect(notice).not.toContainText(/\*\*|`/);
});

test("card prose cannot create executable markup or javascript links", async ({
  app,
  browser,
  screen,
}) => {
  await app.open(fixture);
  await expect(
    screen.getByRole("region", "Unsafe notice", { exact: true }),
  ).toBeVisible();
  await expect(
    browser.locator('[aria-label="Unsafe notice"] img[onerror]'),
  ).toHaveCount(0);
  await expect(
    browser.locator('[aria-label="Unsafe notice"] a[href^="javascript:"]'),
  ).toHaveCount(0);
  expect(
    await browser.evaluate(
      () => Reflect.get(window, "__galleryUnsafe") === undefined,
    ),
  ).toBe(true);
});

for (const kind of [
  "Record",
  "Checklist",
  "Quote",
  "Approval",
  "Choice",
  "Table",
]) {
  test(`${kind.toLowerCase()} prose renders the email as a readable link`, async ({
    app,
    browser,
    screen,
  }) => {
    await app.open(fixture);
    const card = screen.getByRole("region", `${kind} markdown`, {
      exact: true,
    });
    await expect(card.getByRole("link")).toHaveCount(1);
    await expect(
      card.getByRole("link", "Northwind Traders", { exact: true }),
    ).toHaveAttribute("href", address);
    await expect(card).not.toContainText("](http");
    if (kind === "Checklist" || kind === "Approval") {
      await expect(
        browser.locator(
          `[aria-label="${kind} markdown"] [data-streamdown="strong"]`,
        ),
      ).toHaveText("Contoso");
    }
    if (kind === "Table") {
      const number = card.getByRole("cell", "25", { exact: true });
      await expect(number).toBeVisible();
      expect(
        await browser.evaluate(
          () =>
            getComputedStyle(
              document.querySelector(
                '[aria-label="Table markdown"] td:last-child',
              )!,
            ).fontVariantNumeric,
        ),
      ).toContain("tabular-nums");
    }
  });
}

test("a notice point containing a list has no duplicate dot or extra indent", async ({
  app,
  browser,
  screen,
}) => {
  await app.open(fixture);
  await expect(
    screen.getByRole("region", "Nested list notice", { exact: true }),
  ).toBeVisible();
  const points = await browser.evaluate(() =>
    Array.from(
      document.querySelectorAll<HTMLElement>(
        '[aria-label="Nested list notice"] figure > div > ul > li',
      ),
      (item) => {
        const dot = item.querySelector(":scope > span");
        const list = item.querySelector(":scope > div > ul");
        return {
          dotVisible: dot ? getComputedStyle(dot).display !== "none" : false,
          indent: list ? getComputedStyle(list).paddingLeft : null,
          text: (list?.textContent ?? item.textContent ?? "")
            .replace(/\s+/g, " ")
            .trim(),
        };
      },
    ),
  );
  expect(points).toHaveLength(2);
  expect(points[0]).toEqual({
    dotVisible: false,
    indent: "0px",
    text: "Contoso Fabrikam",
  });
  expect(points[1].dotVisible).toBe(true);
  expect(points[1].text).toContain("One plain point");
});

for (const width of [360, 720]) {
  test(`long links and choice descriptions fit their cards at ${width}px`, async ({
    app,
    browser,
    screen,
  }) => {
    await browser.setViewport({ width, height: 900 });
    await app.open(fixture);
    for (const name of [
      "Long notice",
      "Long checklist",
      "Long quote",
      "Long choice",
    ]) {
      await expect(
        screen.getByRole("region", name, { exact: true }),
      ).toBeVisible();
    }
    const fits = await browser.evaluate(() =>
      ["Long notice", "Long checklist", "Long quote", "Long choice"].map(
        (name) => {
          const section = document.querySelector(`[aria-label="${name}"]`)!;
          const card = section.querySelector("figure")!;
          const cardBox = card.getBoundingClientRect();
          const text = Array.from(
            section.querySelectorAll<HTMLElement>(
              "a, fieldset, [data-streamdown]",
            ),
          );
          return {
            name,
            cardFits: card.scrollWidth <= card.clientWidth + 1,
            contentsFit:
              text.length > 0 &&
              text.every((node) => {
                const box = node.getBoundingClientRect();
                return (
                  box.left >= cardBox.left - 1 && box.right <= cardBox.right + 1
                );
              }),
          };
        },
      ),
    );
    for (const result of fits)
      expect(result).toEqual({
        name: result.name,
        cardFits: true,
        contentsFit: true,
      });
  });
}

test("finished checklist tasks stay readable and expose Done or To do to screen readers", async ({
  app,
  browser,
  screen,
}) => {
  await app.open(fixture);
  const list = screen.getByRole("region", "Checklist status", { exact: true });
  await expect(list.getByText("2 of 3", { exact: true })).toBeVisible();
  await expect(list.getByRole("listitem")).toHaveCount(3);
  const tasks = await browser.evaluate(() =>
    Array.from(
      document.querySelectorAll('[aria-label="Checklist status"] li'),
      (item) => ({
        text: item.textContent,
        crossedOut: [item, ...item.querySelectorAll("*")].some((node) =>
          getComputedStyle(node).textDecorationLine.includes("line-through"),
        ),
      }),
    ),
  );
  expect(tasks.map(({ text }) => text)).toEqual([
    "✓Done: Raise the connection pool to 20",
    "✓Done: Cache the pricing lookup",
    "To do: Retry the webhook with backoff",
  ]);
  expect(tasks.every(({ crossedOut }) => !crossedOut)).toBe(true);
});

test("a quotation displays only its source name and omits an absent attribution", async ({
  app,
  browser,
  screen,
}) => {
  await app.open(fixture);
  await expect(
    screen.getByRole("region", "Attributed quote", { exact: true }),
  ).toContainText("A Kubernetes operator is a custom controller.");
  await expect(
    browser.locator('[aria-label="Attributed quote"] blockquote footer'),
  ).toHaveText("Knowledge Bot");
  await expect(
    browser.locator('[aria-label="Anonymous quote"] blockquote footer'),
  ).toHaveCount(0);
});

for (const [tone, badge] of [
  ["positive", "Good news"],
  ["caution", "Heads up"],
  ["negative", "Problem"],
  ["neutral", ""],
  ["posi", ""],
]) {
  test(`a ${tone} notice uses readable badge words`, async ({
    app,
    browser,
    screen,
  }) => {
    await app.open(fixture);
    const card = screen.getByRole("region", `Notice tone ${tone}`, {
      exact: true,
    });
    await expect(card).not.toContainText(tone);
    if (badge)
      await expect(card.getByText(badge, { exact: true })).toBeVisible();
    else
      await expect(
        browser.locator(`[aria-label="Notice tone ${tone}"] figcaption span`),
      ).toHaveCount(0);
  });
}

test("table sorting works by click and Enter with numeric values and accessible sort headers", async ({
  app,
  browser,
  screen,
}) => {
  await app.open(`${fixture}?example=table`);
  const order = () =>
    browser.evaluate(() =>
      Array.from(
        document.querySelectorAll("tbody tr"),
        (row) => row.querySelector("td")?.textContent ?? null,
      ),
    );
  expect(await order()).toEqual(["Design", "Product", "Engineering"]);
  const hours = screen.getByRole("columnheader", "Hours", { exact: true });
  await screen.getByRole("button", "Hours", { exact: true }).click();
  await expect(hours).toHaveAttribute("aria-sort", "ascending");
  expect(await order()).toEqual(["Product", "Design", "Engineering"]);
  await browser.keyboard.press("Enter");
  await expect(hours).toHaveAttribute("aria-sort", "descending");
  expect(await order()).toEqual(["Engineering", "Design", "Product"]);
  await expect(screen.getByRole("region")).toHaveAttribute("tabindex", "0");
});

for (const state of ["empty", "invalid"]) {
  test(`an ${state} table does not pretend to contain valid rows`, async ({
    app,
    screen,
  }) => {
    await app.open(`${fixture}?example=table&state=${state}`);
    if (state === "empty") {
      await expect(
        screen.getByText("No rows to show.", { exact: true }),
      ).toBeVisible();
      await expect(screen.getByRole("columnheader")).toHaveCount(2);
    } else await expect(screen.getByRole("table")).toHaveCount(0);
  });
}

test("required and typed form fields keep answers pending until corrected", async ({
  app,
  browser,
  screen,
}) => {
  const answers = await captureAnswers(browser);
  await app.open(`${fixture}?example=form`);
  const submit = screen.getByRole("button", "Submit answers", { exact: true });
  await submit.click();
  await expect(screen.getByRole("alert")).toHaveCount(4);
  const team = screen.getByRole("textbox", /^Team/);
  await expect(team).toBeFocused();
  await expect(team).toHaveAttribute("aria-invalid", "true");
  await team.fill("  Design  ");
  await screen.getByRole("textbox", /^Work email/).fill("invalid");
  await screen.getByRole("spinbutton", /^Seats/).fill("21");
  await screen.getByRole("combobox", /^Priority/).selectOption("This month");
  await submit.click();
  await expect(
    screen.getByText("Enter a valid email address.", { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByText("Enter 20 or less.", { exact: true }),
  ).toBeVisible();
  expect(answers).toEqual([]);
  await screen
    .getByRole("textbox", /^Work email/)
    .fill("designer@example.test");
  await screen.getByRole("spinbutton", /^Seats/).fill("3");
  await submit.click();
  await expect(screen.getByText("Submitted", { exact: true })).toBeVisible();
  expect(answers).toEqual([
    {
      status: "submitted",
      values: {
        team: "Design",
        email: "designer@example.test",
        seats: 3,
        priority: "This month",
      },
    },
  ]);
  await expect(screen.getByRole("form")).toHaveCount(0);
  await expect(screen.getByText("Not provided", { exact: true })).toBeVisible();
});

test("a failed form answer preserves its draft and sends a pending retry only once", async ({
  app,
  browser,
  screen,
}) => {
  const answers: unknown[] = [];
  const release = Promise.withResolvers<void>();
  await browser.route(answerPath, async (route) => {
    answers.push(JSON.parse(route.request.postData ?? "null"));
    if (answers.length === 1) return route.fulfill({ status: 503, json: {} });
    await release.promise;
    return route.fulfill({ json: {} });
  });
  try {
    await app.open(`${fixture}?example=form`);
    await screen.getByRole("textbox", /^Team/).fill("  Design  ");
    await screen
      .getByRole("textbox", /^Work email/)
      .fill("designer@example.test");
    await screen.getByRole("spinbutton", /^Seats/).fill("3");
    await screen.getByRole("combobox", /^Priority/).selectOption("This month");
    const submit = screen.getByRole("button", "Submit answers", {
      exact: true,
    });
    await submit.click();
    await expect(screen.getByRole("alert")).toContainText(
      "Couldn't send your answers",
    );
    await expect(screen.getByRole("textbox", /^Team/)).toHaveValue(
      "  Design  ",
    );
    await submit.click();
    await expect(
      screen.getByRole("button", "Sending…", { exact: true }),
    ).toBeDisabled();
    await browser.evaluate(() =>
      document
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    expect(answers).toHaveLength(2);
    expect(answers[1]).toEqual(answers[0]);
    release.resolve();
    await expect(screen.getByText("Submitted", { exact: true })).toBeVisible();
    await expect(screen.getByRole("form")).toHaveCount(0);
    expect(answers).toHaveLength(2);
  } finally {
    release.resolve();
  }
});

for (const state of ["saved", "unreadable", "streaming", "disabled"]) {
  test(`a ${state} form never offers an active submission`, async ({
    app,
    browser,
    screen,
  }) => {
    const answers = await captureAnswers(browser);
    await app.open(`${fixture}?example=form&state=${state}`);
    if (state === "saved") {
      await expect(
        screen.getByText("Saved team", { exact: true }),
      ).toBeVisible();
      await expect(screen.getByText("7", { exact: true })).toBeVisible();
      await expect(screen.getByText(/First line\s+Second line/)).toBeVisible();
    } else if (state === "unreadable") {
      await expect(
        screen.getByText(/saved answers are unavailable/),
      ).toBeVisible();
    } else if (state === "streaming") {
      await expect(
        screen.getByText("Preparing your form…", { exact: true }),
      ).toBeVisible();
    } else {
      await expect(
        screen.getByRole("button", "Submit answers", { exact: true }),
      ).toBeDisabled();
    }
    if (state !== "disabled") {
      await expect(screen.getByRole("textbox")).toHaveCount(0);
      await expect(
        screen.getByRole("button", "Submit answers", { exact: true }),
      ).toHaveCount(0);
    }
    expect(answers).toEqual([]);
  });
}

test("invalid form questions release the suspended call once across rerenders", async ({
  app,
  browser,
  screen,
}) => {
  const answers = await captureAnswers(browser);
  await app.open(`${fixture}?example=form&state=invalid`);
  await expect(screen.getByRole("alert")).toContainText(
    "The Bot can send a corrected form.",
  );
  await expect(screen.getByRole("form")).toHaveCount(0);
  expect(answers).toEqual([
    {
      status: "invalid",
      message:
        "The form could not be displayed because its questions were invalid. Send a corrected form with unique field IDs, valid types, and options for each select field.",
    },
  ]);
  for (let i = 0; i < 3; i++)
    await screen.getByRole("button", "Rerender", { exact: true }).click();
  expect(answers).toHaveLength(1);
});

test("decision options describe their consequences and select the first answer by default", async ({
  app,
  screen,
}) => {
  await app.open(`${fixture}?example=decision`);
  const staging = screen.getByRole("radio", "Staging", { exact: true });
  await expect(staging).toBeChecked();
  await expect(staging).toHaveAttribute("aria-describedby", /.+/);
  await expect(
    screen.getByText("Safe, and reversible", { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByText("Live customers", { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByRole("button", "Staging", { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByText("Waiting on you", { exact: true }),
  ).toBeVisible();
});

test("a decision's number shortcut selects its answer and Enter submits and folds the card", async ({
  app,
  browser,
  screen,
}) => {
  const answers = await captureAnswers(browser);
  await app.open(`${fixture}?example=decision`);
  await expect(
    screen.getByRole("radio", "Staging", { exact: true }),
  ).toBeChecked();
  await browser.keyboard.press("2");
  await expect(
    screen.getByRole("radio", "Production", { exact: true }),
  ).toBeChecked();
  await expect(
    screen.getByRole("button", "Production", { exact: true }),
  ).toBeVisible();
  await browser.keyboard.press("Enter");
  await expect(screen.getByText("Answered", { exact: true })).toBeVisible();
  await expect(screen.getByRole("radio")).toHaveCount(0);
  expect(answers).toEqual([
    { title: "Which environment?", value: "production", text: "" },
  ]);
});

test("only the newest waiting decision takes number and Enter shortcuts", async ({
  app,
  browser,
  screen,
}) => {
  const answers = await captureAnswers(browser);
  await app.open(`${fixture}?example=decision&state=multiple`);
  const first = screen.getByRole("group", "First", { exact: true });
  await expect(
    first.getByRole("radio", "Staging", { exact: true }),
  ).toBeChecked();
  await browser.keyboard.press("2");
  await expect(
    screen
      .getByRole("group", "Second", { exact: true })
      .getByRole("radio", "Production", { exact: true }),
  ).toBeChecked();
  await browser.keyboard.press("Enter");
  await expect(screen.getByText("Answered", { exact: true })).toBeVisible();
  await expect(
    first.getByRole("radio", "Staging", { exact: true }),
  ).toBeChecked();
  expect(answers).toEqual([{ title: "Second", value: "production", text: "" }]);
});

test("typing in the message box does not choose or answer a waiting decision", async ({
  app,
  browser,
  screen,
}) => {
  const answers = await captureAnswers(browser);
  await app.open(`${fixture}?example=decision`);
  await expect(
    screen.getByRole("radio", "Staging", { exact: true }),
  ).toBeChecked();
  await screen.getByRole("textbox", "Message", { exact: true }).click();
  await browser.keyboard.press("2");
  await browser.keyboard.press("Enter");
  await expect(
    screen.getByRole("textbox", "Message", { exact: true }),
  ).toHaveValue("2\n");
  await expect(
    screen.getByRole("radio", "Staging", { exact: true }),
  ).toBeChecked();
  expect(answers).toEqual([]);
});

test("the other answer requires words and submits its trimmed text with Enter", async ({
  app,
  browser,
  screen,
}) => {
  const answers = await captureAnswers(browser);
  await app.open(`${fixture}?example=decision&state=other`);
  await expect(
    screen.getByRole("radio", "Staging", { exact: true }),
  ).toBeChecked();
  await browser.keyboard.press("3");
  const field = screen.getByRole("textbox", "Your answer", { exact: true });
  await expect(field).toBeFocused();
  await expect(
    screen.getByRole("button", "Send", { exact: true }),
  ).toBeDisabled();
  await field.fill("   ");
  await expect(
    screen.getByRole("button", "Send", { exact: true }),
  ).toBeDisabled();
  await field.fill("  Neither, wait for Monday  ");
  await browser.keyboard.press("Enter");
  await expect(screen.getByText("Answered", { exact: true })).toBeVisible();
  expect(answers).toEqual([
    {
      title: "Which environment?",
      value: "__other__",
      text: "Neither, wait for Monday",
    },
  ]);
});

test("typing directly into the other answer selects it without a number shortcut", async ({
  app,
  browser,
  screen,
}) => {
  const answers = await captureAnswers(browser);
  await app.open(`${fixture}?example=decision&state=other`);
  await expect(
    screen.getByRole("radio", "Staging", { exact: true }),
  ).toBeChecked();
  await screen
    .getByRole("textbox", "Your answer", { exact: true })
    .fill("Wait for Monday");
  await expect(
    screen.getByRole("radio", "Answer something else…", { exact: true }),
  ).toBeChecked();
  await expect(
    screen.getByRole("button", "Send", { exact: true }),
  ).toBeEnabled();
  await browser.keyboard.press("Enter");
  await expect(screen.getByText("Answered", { exact: true })).toBeVisible();
  expect(answers).toEqual([
    {
      title: "Which environment?",
      value: "__other__",
      text: "Wait for Monday",
    },
  ]);
});

test("an archived decision shows its answer and no longer takes shortcuts", async ({
  app,
  browser,
  screen,
}) => {
  const answers = await captureAnswers(browser);
  await app.open(`${fixture}?example=decision&state=answered`);
  await expect(screen.getByText("Answered", { exact: true })).toBeVisible();
  await expect(screen.getByText("Production", { exact: true })).toBeVisible();
  await expect(screen.getByRole("radio")).toHaveCount(0);
  await browser.keyboard.press("1");
  await browser.keyboard.press("Enter");
  expect(answers).toEqual([]);
});
