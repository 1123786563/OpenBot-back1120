import { readFile } from "node:fs/promises";
import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";

const fixture = "/tests/browser/tool-line.html";
const running = '[aria-label="Running steps"] .tool-line-running';

test("a long tool label wraps within the phone column while the detail truncates", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 320, height: 720 });
  await app.open(fixture);
  for (const name of ["Wrap without disclosure", "Wrap with disclosure"]) {
    const region = screen.getByRole("region", name, { exact: true });
    const label = region.getByText(
      "Read 1 file, searched for 2 patterns and listed 1 directory",
      { exact: true },
    );
    await expect(label).toBeVisible();
    const fit = await browser.evaluate((name) => {
      const region = document.querySelector(`[aria-label="${name}"]`);
      const text = region?.querySelector("span > span");
      const detail = text?.nextElementSibling;
      if (!region || !text || !detail) throw new Error("Missing tool line");
      const line = document.createRange();
      line.selectNodeContents(text);
      const lines = [...line.getClientRects()];
      const bounds = region.getBoundingClientRect();
      return {
        lines: lines.length,
        labelFits: lines.every(
          (line) => line.left >= bounds.left && line.right <= bounds.right + 1,
        ),
        detailClipped: detail.scrollWidth > detail.clientWidth,
        detailUsesEllipsis:
          getComputedStyle(detail).textOverflow === "ellipsis",
      };
    }, name);
    expect(fit.lines).toBeGreaterThan(1);
    expect(fit.labelFits).toBe(true);
    expect(fit.detailClipped).toBe(true);
    expect(fit.detailUsesEllipsis).toBe(true);
  }
  await screen
    .getByRole("region", "Wrap with disclosure")
    .getByText(/Read 1 file/)
    .tap();
  await expect(
    screen.getByText("What came back", { exact: true }),
  ).toBeVisible();
});

function painted(browser: Browser) {
  return browser.evaluate((selector) => {
    const muted = document.querySelector('[data-testid="muted"]');
    if (!muted) throw new Error("Missing muted text reference");
    return {
      muted: getComputedStyle(muted).color,
      reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
      labels: [...document.querySelectorAll(selector)].map((element) => {
        const style = getComputedStyle(element);
        return {
          text: element.textContent,
          color: style.color,
          fill: style.webkitTextFillColor,
          background: style.backgroundImage,
          animation: style.animationName,
        };
      }),
    };
  }, running);
}

test("reduced motion leaves the running labels static and visible in Chromium", async ({
  app,
  browser,
  screen,
}) => {
  await browser.emulateMedia({ reducedMotion: "reduce" });
  await app.open(fixture);
  await expect(screen.getByText("Asking Ana…", { exact: true })).toBeVisible();
  const appearance = await painted(browser);
  expect(appearance.reduced).toBe(true);
  expect(appearance.labels.map((label) => label.text)).toEqual([
    "Asked youWhich city should I search?",
    "Asking Ana…",
  ]);
  for (const label of appearance.labels) {
    expect(label).toMatchObject({
      animation: "none",
      background: "none",
      color: appearance.muted,
      fill: appearance.muted,
    });
    expect(label.fill).not.toBe("rgba(0, 0, 0, 0)");
  }
  await browser.evaluate(async () => {
    await document.fonts.ready;
    return null;
  });
  const shown = await readFile(await app.screenshot("running labels visible"));
  await browser.evaluate((selector) => {
    const label = document.querySelector<HTMLElement>(selector);
    if (!label) throw new Error("Missing running tool label");
    label.style.visibility = "hidden";
    return null;
  }, running);
  const hidden = await readFile(
    await app.screenshot("running tool label hidden"),
  );
  expect(shown.equals(hidden)).toBe(false);
});

test("running tool and progress labels pulse gently when motion is enabled", async ({
  app,
  browser,
  screen,
}) => {
  await browser.emulateMedia({ reducedMotion: "no-preference" });
  await app.open(fixture);
  await expect(screen.getByText("Asking Ana…", { exact: true })).toBeVisible();
  const appearance = await painted(browser);
  expect(appearance.reduced).toBe(false);
  expect(appearance.labels).toHaveLength(2);
  for (const label of appearance.labels) {
    expect(label).toMatchObject({
      animation: "tool-line-pulse",
      background: "none",
      color: appearance.muted,
      fill: appearance.muted,
    });
    expect(label.fill).not.toBe("rgba(0, 0, 0, 0)");
  }

  const cycles = await browser.evaluate((selector) => {
    return [...document.querySelectorAll(selector)].map((element) => {
      const [pulse] = element.getAnimations();
      if (!pulse?.effect) throw new Error("Missing running-label animation");
      pulse.pause();
      const timing = pulse.effect.getComputedTiming();
      const duration = Number(timing.duration);
      const opacities = Array.from({ length: 41 }, (_, point) => {
        pulse.currentTime = (duration * point) / 40;
        return Number(getComputedStyle(element).opacity);
      });
      return {
        duration,
        repeats: timing.iterations === Number.POSITIVE_INFINITY,
        easing: getComputedStyle(element).animationTimingFunction,
        opacities,
      };
    });
  }, running);
  expect(cycles).toHaveLength(2);
  for (const { duration, repeats, easing, opacities } of cycles) {
    expect(duration).toBeGreaterThanOrEqual(2000);
    expect(duration).toBeLessThanOrEqual(3000);
    expect(repeats).toBe(true);
    expect(easing).toBe("ease-in-out");
    expect(Math.max(...opacities)).toBe(1);
    expect(Math.min(...opacities)).toBeGreaterThanOrEqual(0.5);
    expect(Math.min(...opacities)).toBeLessThanOrEqual(0.7);
    for (const [index, opacity] of opacities.slice(1).entries()) {
      expect(Math.abs(opacity - opacities[index])).toBeLessThan(0.05);
    }
  }
});
