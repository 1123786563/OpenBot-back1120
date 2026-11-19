import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";

const fixture = "/tests/browser/onboarding-components.html";
const progress = 'header [role="progressbar"]';
const primary = "[data-onboarding-primary]";
const draftPicture = '[data-demo="test"]';
const phone = { width: 390, height: 740 };
const desktop = { width: 1280, height: 700 };

function currentDash(browser: Browser) {
  return browser.evaluate(
    (selector) =>
      [...document.querySelectorAll(`${selector} > span`)].map((dash) =>
        dash.hasAttribute("data-current"),
      ),
    progress,
  );
}

test("phone navigation updates the progress dashes, moves focus, and pins Continue below the contents", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport(phone);
  await app.open(`${fixture}?step=one`);
  const first = screen.getByRole("heading", "One", { exact: true });
  const second = screen.getByRole("heading", "Two", { exact: true });
  const back = screen.getByRole("button", "Back", { exact: true });
  const next = screen.getByRole("button", "Continue", { exact: true });
  const dashes = browser.locator(progress);
  await expect(first).toBeVisible();
  await expect(back).toHaveCount(0);
  await expect(dashes).toHaveAttribute("aria-valuetext", "Step 1 of 3");
  expect(await currentDash(browser)).toEqual([true, false, false]);
  await next.tap();
  await expect(second).toBeFocused();
  await expect(dashes).toHaveAttribute("aria-valuetext", "Step 2 of 3");
  expect(await currentDash(browser)).toEqual([false, true, false]);
  await expect(
    browser.locator('header [data-onboarding-back="phone"]'),
  ).toBeVisible();
  await expect(screen.getByRole("button", "Not now")).toHaveCount(0);
  const placement = await browser.evaluate(() => {
    const frame = document.querySelector("[data-onboarding-frame]");
    const heading = frame?.querySelector("h1");
    const picture = frame?.querySelector("[data-onboarding-demo]");
    const action = frame?.querySelector("[data-onboarding-primary]");
    const footer = frame?.querySelector("footer");
    if (!heading || !picture || !action || !footer)
      throw new Error("Missing the wizard layout");
    const button = action.getBoundingClientRect();
    return {
      below:
        heading.getBoundingClientRect().bottom <= button.top &&
        picture.getBoundingClientRect().bottom <= button.top,
      footer: getComputedStyle(footer).position,
      onScreen: button.bottom <= innerHeight,
    };
  });
  expect(placement).toEqual({ below: true, footer: "sticky", onScreen: true });
  await back.tap();
  await expect(first).toBeFocused();
  await expect(back).toHaveCount(0);
  await expect(dashes).toHaveAttribute("aria-valuetext", "Step 1 of 3");
});

test("a picture-first step moves the illustration above the words on a phone and keeps the desktop columns", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport(phone);
  await app.open(`${fixture}?picture-first`);
  await expect(
    screen.getByRole("heading", "Two", { exact: true }),
  ).toBeVisible();
  const placement = () =>
    browser.evaluate(() => {
      const box = (selector: string) => {
        const element = document.querySelector(selector);
        if (!element) throw new Error(`Missing ${selector}`);
        const { left, right, top, bottom } = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          left,
          right,
          top,
          bottom,
          position: style.position,
          borderLeft: style.borderLeftWidth,
          borderRight: style.borderRightWidth,
          overflowY: style.overflowY,
        };
      };
      return {
        intro: box("[data-onboarding-intro]"),
        demo: box("[data-onboarding-demo]"),
        header: box("[data-onboarding-frame] > header"),
        footer: box("[data-onboarding-frame] > footer"),
      };
    });
  const narrow = await placement();
  expect(narrow.demo.bottom).toBeLessThanOrEqual(narrow.intro.top);
  await browser.setViewport(desktop);
  for (const params of ["?picture-first", ""]) {
    await app.open(`${fixture}${params}`);
    await expect(screen.getByText("About Two.", { exact: true })).toBeVisible();
    await expect(
      screen.getByText("Picture of Two", { exact: true }),
    ).toBeVisible();
    const { intro, demo, header, footer } = await placement();
    expect(intro.right).toBeLessThanOrEqual(demo.left);
    expect(header.left).toBe(intro.left);
    expect(footer.left).toBe(intro.left);
    expect(header.bottom).toBeLessThanOrEqual(intro.top);
    expect(footer.top).toBeGreaterThanOrEqual(intro.bottom);
    expect(footer.bottom).toBeLessThanOrEqual(desktop.height);
    expect(intro.overflowY).toBe("visible");
    expect(footer.overflowY).toBe("visible");
    expect(demo.position).toBe("sticky");
    expect(demo.borderLeft).toBe("1px");
    expect(demo.borderRight).toBe("0px");
    expect(demo.bottom - demo.top).toBe(desktop.height);
  }
});

test("single-step onboarding has no navigation and keeps the desktop brand", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport(desktop);
  await app.open(`${fixture}?mode=single&step=one`);
  await expect(
    screen.getByRole("heading", "Only", { exact: true }),
  ).toBeVisible();
  await expect(
    browser.locator("[data-onboarding-frame] > header"),
  ).toContainText("OpenBot");
  await expect(
    browser.locator(
      "[data-onboarding-steps], [data-onboarding-back], [role=progressbar]",
    ),
  ).toHaveCount(0);
});

test("a late local step updates progress without moving the current step", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport(phone);
  await app.open(`${fixture}?mode=insert`);
  await expect(browser.locator(progress)).toHaveAttribute(
    "aria-valuetext",
    "Step 2 of 3",
  );
  await screen.getByRole("button", "Reveal local step", { exact: true }).tap();
  await expect(
    screen.getByRole("heading", "Two", { exact: true }),
  ).toBeVisible();
  await expect(browser.locator(progress)).toHaveAttribute(
    "aria-valuetext",
    "Step 2 of 4",
  );
});

for (const choice of ["Continue", "Not now"]) {
  test(`optional onboarding puts the footnote above equal actions and advances with ${choice}`, async ({
    app,
    browser,
    screen,
  }) => {
    await browser.setViewport(phone);
    await app.open(`${fixture}?mode=optional`);
    await expect(
      screen.getByText("You can connect more apps later.", { exact: true }),
    ).toBeVisible();
    await expect(
      screen.getByRole("button", "Continue", { exact: true }),
    ).toBeVisible();
    await expect(
      screen.getByRole("button", "Not now", { exact: true }),
    ).toBeVisible();
    const layout = await browser.evaluate(() => {
      const footer = document.querySelector("[data-onboarding-frame] > footer");
      const footnote = footer?.querySelector("[data-onboarding-footnote]");
      const primary = footer?.querySelector("[data-onboarding-primary]");
      const secondary = footer?.querySelector("[data-onboarding-secondary]");
      if (!footnote || !primary || !secondary)
        throw new Error("Missing optional step controls");
      const a = primary.getBoundingClientRect();
      const b = secondary.getBoundingClientRect();
      return {
        footnoteAbove: footnote.getBoundingClientRect().bottom <= a.top,
        stacked:
          a.bottom <= b.top &&
          a.left === b.left &&
          a.width === b.width &&
          primary.parentElement === secondary.parentElement,
        heights: [a.height, b.height],
        radii: [
          getComputedStyle(primary).borderTopLeftRadius,
          getComputedStyle(secondary).borderTopLeftRadius,
        ],
      };
    });
    expect(layout.footnoteAbove).toBe(true);
    expect(layout.stacked).toBe(true);
    expect(layout.heights).toEqual([52, 52]);
    expect(layout.radii[0]).toBe(layout.radii[1]);
    expect(parseFloat(layout.radii[0])).toBeGreaterThanOrEqual(26);
    await screen.getByRole("button", choice, { exact: true }).tap();
    await expect(
      screen.getByRole("heading", "Three", { exact: true }),
    ).toBeFocused();
  });
}

for (const leave of [false, true]) {
  test(`a deferred onboarding action ${leave ? "cannot move a step after Back" : "advances only when its callback finishes"}`, async ({
    app,
    browser,
    screen,
  }) => {
    await browser.setViewport(phone);
    await app.open(`${fixture}?mode=deferred`);
    await screen
      .getByRole("button", "Turn on notifications", { exact: true })
      .tap();
    await expect(
      screen.getByRole("heading", "Connect your apps", { exact: true }),
    ).toBeVisible();
    if (leave) await screen.getByRole("button", "Back", { exact: true }).tap();
    const final = screen.getByRole("heading", leave ? "One" : "Three", {
      exact: true,
    });
    if (leave) await expect(final).toBeFocused();
    await screen
      .getByRole("button", "Finish notification request", { exact: true })
      .tap();
    await expect(final).toBeVisible();
    if (leave)
      await expect(
        screen.getByRole("heading", "Three", { exact: true }),
      ).toHaveCount(0);
  });
}

test("a pending control shows its spinner and the done control keeps its position and checkmark", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport(phone);
  await browser.emulateMedia({ reducedMotion: "no-preference" });
  await app.open(`${fixture}?mode=pending`);
  const pending = screen.getByRole("button", "Turn on notifications", {
    exact: true,
  });
  await expect(pending).toBeDisabled();
  await expect(pending).toHaveAttribute("aria-busy", "true");
  const before = await browser.evaluate(() => {
    const button = document.querySelector("[data-onboarding-primary]");
    const spinner = button?.querySelector("span[aria-hidden]");
    if (!button || !spinner) throw new Error("Missing waiting control");
    return {
      top: button.getBoundingClientRect().top,
      animation: getComputedStyle(spinner).animationName,
    };
  });
  expect(before.animation).not.toBe("none");
  await screen
    .getByRole("button", "Resolve notification request", { exact: true })
    .tap();
  const done = screen.getByRole("button", "Notifications on", { exact: true });
  await expect(done).toHaveAttribute("data-done", "");
  await expect(browser.locator(`${primary} svg`)).toBeVisible();
  await expect(
    screen.getByRole("button", "Not now", { exact: true }),
  ).toHaveCount(0);
  await expect(
    browser.locator("[data-onboarding-secondary-slot]"),
  ).toHaveAttribute("aria-hidden", "true");
  const after = () =>
    browser.evaluate(() => {
      const button = document.querySelector("[data-onboarding-primary]");
      const slot = document.querySelector("[data-onboarding-secondary-slot]");
      if (!button || !slot) throw new Error("Missing done control");
      const sample = document.createElement("span");
      sample.style.backgroundColor =
        "color-mix(in oklab, var(--color-emerald-500) 10%, transparent)";
      button.append(sample);
      const painted = getComputedStyle(button).backgroundColor;
      const expected = getComputedStyle(sample).backgroundColor;
      sample.remove();
      return {
        top: button.getBoundingClientRect().top,
        slot: slot.getBoundingClientRect().height,
        painted,
        expected,
      };
    });
  const settled = await after();
  expect(settled.top).toBe(before.top);
  expect(settled.slot).toBe(52);
  expect(settled.expected).not.toBe("rgba(0, 0, 0, 0)");
  await expect.poll(async () => (await after()).painted).toBe(settled.expected);
});

test("the footer submit button submits the step's form without navigating", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport(desktop);
  await app.open(`${fixture}?mode=form&step=three`);
  const submit = screen.getByRole("button", "Get started", { exact: true });
  await expect(submit).toHaveAttribute("type", "submit");
  await expect(submit).toHaveAttribute("form", "last-step-form");
  await expect(browser.locator('[data-onboarding-back="phone"]')).toBeHidden();
  await expect(
    browser.locator('footer [data-onboarding-back="desktop"]'),
  ).toBeVisible();
  const beside = await browser.evaluate(() => {
    const back = document.querySelector('[data-onboarding-back="desktop"]');
    const submit = document.querySelector("[data-onboarding-primary]");
    if (!back || !submit) throw new Error("Missing footer buttons");
    const a = back.getBoundingClientRect();
    const b = submit.getBoundingClientRect();
    return (
      back.parentElement === submit.parentElement &&
      a.right <= b.left &&
      Math.abs(a.top - b.top) <= 6
    );
  });
  expect(beside).toBe(true);
  await screen
    .getByRole("textbox", "Workspace name", { exact: true })
    .fill("Example workspace");
  await submit.tap();
  await expect(
    screen.getByRole("status", "Submitted workspace", { exact: true }),
  ).toHaveText("Example workspace");
  await expect(
    screen.getByRole("heading", "Three", { exact: true }),
  ).toBeVisible();
});

test("a controlled wizard asks for forward, Back, and menu moves until its caller changes the step", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport(desktop);
  await app.open(`${fixture}?mode=controlled`);
  const moves = screen.getByRole("status", "Requested moves", { exact: true });
  const second = screen.getByRole("heading", "Two", { exact: true });
  await screen.getByRole("button", "Continue", { exact: true }).tap();
  await screen.getByRole("button", "Back", { exact: true }).tap();
  await expect(moves).toHaveText("three forward, one back");
  await expect(second).toBeVisible();
  await screen.getByRole("button", "Step 2 of 3", { exact: true }).tap();
  const menu = screen.getByRole("navigation", "Onboarding steps", {
    exact: true,
  });
  await menu.getByRole("button", /One.*done/).tap();
  await expect(moves).toHaveText("three forward, one back, one back");
  await expect(second).toBeVisible();
  await screen.getByRole("button", "Apply first step", { exact: true }).tap();
  await expect(
    screen.getByRole("heading", "One", { exact: true }),
  ).toBeFocused();
});

test("the desktop menu opens over the unchanged step and permits only reached steps", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport(desktop);
  await app.open(fixture);
  const open = screen.getByRole("button", "Step 2 of 3", { exact: true });
  const menu = screen.getByRole("navigation", "Onboarding steps", {
    exact: true,
  });
  await expect(menu).toHaveCount(0);
  await expect(browser.locator(progress)).toBeHidden();
  await expect(
    browser.locator('header [data-onboarding-back="phone"]'),
  ).toBeHidden();
  const position = () =>
    browser.evaluate(() => {
      const header = document.querySelector("[data-onboarding-frame] > header");
      const trigger = header?.querySelector("[data-onboarding-steps]");
      const heading = document.querySelector("[data-onboarding-intro] h1");
      const nav = document.querySelector('[aria-label="Onboarding steps"]');
      if (!header || !trigger || !heading)
        throw new Error("Missing the desktop step header");
      return {
        titleTop: heading.getBoundingClientRect().top,
        afterTrigger:
          heading.getBoundingClientRect().top >=
          trigger.getBoundingClientRect().bottom,
        inlineList: Boolean(header.querySelector("nav, li")),
        insideFrame: Boolean(nav?.closest("[data-onboarding-frame]")),
      };
    });
  await expect(open).toBeVisible();
  const before = await position();
  expect(before.afterTrigger).toBe(true);
  expect(before.inlineList).toBe(false);
  await open.tap();
  await expect(menu).toBeVisible();
  expect(await position()).toEqual(before);
  await expect(menu.getByRole("listitem")).toHaveCount(3);
  await expect(
    menu.getByText("not yet available", { exact: false }),
  ).toBeAttached();
  await expect(browser.locator('[aria-current="step"]')).toContainText("Two");
  await expect(menu.getByRole("button", /Two|Three/)).toHaveCount(0);
  await menu.getByRole("button", /One.*done/).tap();
  await expect(menu).toHaveCount(0);
  await expect(
    screen.getByRole("heading", "One", { exact: true }),
  ).toBeFocused();
  await screen.getByRole("button", "Step 1 of 3", { exact: true }).tap();
  await expect(menu.getByRole("button", /Three/)).toHaveCount(0);
  await menu.getByRole("button", "Two", { exact: true }).tap();
  await expect(
    screen.getByRole("heading", "Two", { exact: true }),
  ).toBeFocused();
  await screen.getByRole("button", "Back", { exact: true }).tap();
  await expect(
    screen.getByRole("heading", "One", { exact: true }),
  ).toBeFocused();
});

function focusedRing(browser: Browser, selector: string) {
  return browser.evaluate((selector) => {
    const button = document.querySelector<HTMLButtonElement>(selector);
    if (!button) throw new Error("Missing the focus target");
    const expected = getComputedStyle(button).getPropertyValue("--ring").trim();
    const actual = getComputedStyle(button)
      .getPropertyValue("--tw-ring-color")
      .trim();
    return {
      fullStrength: actual === expected && expected !== "",
      focused: button.matches(":focus-visible"),
      shadow: getComputedStyle(button).boxShadow,
    };
  }, selector);
}

test("the phone Back and desktop step menu show a full-strength keyboard focus ring", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport(phone);
  await app.open(fixture);
  const back = screen.getByRole("button", "Back", { exact: true });
  await expect(back).toBeVisible();
  await browser.locator("body").press("Tab");
  await expect(back).toBeFocused();
  const phoneRing = await focusedRing(
    browser,
    '[data-onboarding-back="phone"]',
  );
  expect(phoneRing.fullStrength).toBe(true);
  expect(phoneRing.focused).toBe(true);
  expect(phoneRing.shadow).not.toBe("none");

  await browser.setViewport(desktop);
  await app.open(fixture);
  const trigger = screen.getByRole("button", "Step 2 of 3", { exact: true });
  await trigger.press("Enter");
  const item = screen.getByRole("button", /One.*done/);
  await expect(item).toBeFocused();
  const menuRing = await focusedRing(browser, "[data-onboarding-pick]");
  expect(menuRing.fullStrength).toBe(true);
  expect(menuRing.focused).toBe(true);
  expect(menuRing.shadow).not.toBe("none");
});

async function verifyPausedBeat(browser: Browser) {
  const both = await browser.evaluate(async (selector) => {
    const demo = document.querySelector(selector);
    if (!demo) throw new Error("Missing demo");
    const before = demo.getAttribute("data-demo-beat");
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    return [before, demo.getAttribute("data-demo-beat")];
  }, draftPicture);
  expect(both[1]).toBe(both[0]);
}

test("the illustration is one accessible image and its animation pauses when scrolled away", async ({
  app,
  browser,
  screen,
}) => {
  await browser.emulateMedia({ reducedMotion: "no-preference" });
  await app.open(`${fixture}?mode=demo`);
  const image = screen.getByRole("img", "A test picture", { exact: true });
  const demo = browser.locator(draftPicture);
  await expect(image).toBeVisible();
  await expect(
    browser.locator('[aria-label="A test picture"] > [inert]'),
  ).toHaveCount(1);
  const insideCanFocus = await browser.evaluate(() => {
    const action = document.querySelector<HTMLButtonElement>(
      '[aria-label="A test picture"] button',
    );
    if (!action) throw new Error("Missing illustrated control");
    action.focus();
    return document.activeElement === action;
  });
  expect(insideCanFocus).toBe(false);
  await screen.getByRole("button", "Before illustration").press("Tab");
  await expect(screen.getByRole("button", "After illustration")).toBeFocused();
  await expect(demo).toHaveAttribute("data-playing", "");
  await expect(demo).toHaveAttribute("data-demo-beat", /[12]/);
  await browser.evaluate(() => {
    window.scrollTo(0, document.body.scrollHeight);
    return null;
  });
  await expect(browser.locator(`${draftPicture}[data-playing]`)).toHaveCount(0);
  await verifyPausedBeat(browser);
  await browser.evaluate(() => {
    window.scrollTo(0, 0);
    return null;
  });
  await expect(demo).toHaveAttribute("data-playing", "");
});

test("the illustration clock pauses in a hidden tab and resumes when shown", async ({
  app,
  browser,
}) => {
  await browser.emulateMedia({ reducedMotion: "no-preference" });
  await app.open(`${fixture}?mode=demo`);
  const demo = browser.locator(draftPicture);
  const visibility = (hidden: boolean) =>
    browser.evaluate((hidden) => {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        get: () => hidden,
      });
      document.dispatchEvent(new Event("visibilitychange"));
      return null;
    }, hidden);
  await expect(demo).toHaveAttribute("data-playing", "");
  await visibility(true);
  await expect(browser.locator(`${draftPicture}[data-playing]`)).toHaveCount(0);
  await verifyPausedBeat(browser);
  await visibility(false);
  await expect(demo).toHaveAttribute("data-playing", "");
});

test("each onboarding illustration is named, muted, and drawn without interactive controls", async ({
  app,
  browser,
}) => {
  await browser.setViewport({ width: 1280, height: 1000 });
  await browser.emulateMedia({ reducedMotion: "reduce" });
  await app.open(`${fixture}?mode=pictures`);
  for (const kind of ["welcome", "computer", "team", "self-host"]) {
    const selector = `[data-demo="${kind}"] [role="img"]`;
    await expect(browser.locator(selector)).toBeVisible();
    const presentation = await browser.evaluate((selector) => {
      const image = document.querySelector(selector);
      const drawing = image?.firstElementChild;
      if (!image || !drawing) throw new Error("Missing the named illustration");
      const styles = getComputedStyle(drawing);
      return {
        label: image.getAttribute("aria-label"),
        inert: drawing.hasAttribute("inert"),
        pointerEvents: styles.pointerEvents,
        filter: styles.filter,
        interactive: drawing.querySelectorAll(
          "button, a, input, textarea, [tabindex]",
        ).length,
        interactiveStyling: [...drawing.querySelectorAll("*")].some((element) =>
          [...element.classList].some(
            (className) =>
              className.startsWith("hover:") || className === "bg-primary",
          ),
        ),
      };
    }, selector);
    expect(presentation.label).toMatch(/\S/);
    expect(presentation.inert).toBe(true);
    expect(presentation.pointerEvents).toBe("none");
    expect(presentation.filter).toContain("saturate(0.75)");
    expect(presentation.interactive).toBe(0);
    expect(presentation.interactiveStyling).toBe(false);
  }
});
