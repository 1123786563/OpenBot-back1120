import { readFile } from "node:fs/promises";
import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";

const fixture = "/tests/browser/onboarding.html";
const header = "[data-onboarding-frame] > header";
const drag = "data-tauri-drag-region";

test("a regular browser leaves the onboarding header without a drag region", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 1000, height: 800 });
  await app.open(fixture);
  await expect(screen.getByRole("heading", "Connect your apps")).toBeVisible();
  await expect(browser.locator(`[${drag}]`)).toHaveCount(0);
});

test("the macOS shell marks each new onboarding header while leaving Back clickable", async ({
  app,
  browser,
  screen,
}) => {
  const shell = await readFile(
    new URL("../../desktop/src-tauri/src/main.rs", import.meta.url),
    "utf8",
  );
  const script = /const OVERLAY_TITLE_BAR_PAGE: &str = r#"([\s\S]*?)"#;/.exec(
    shell,
  )?.[1];
  if (!script) throw new Error("Missing the desktop title bar script");
  await browser.addInitScript(`
    document.addEventListener("DOMContentLoaded", () => {
      ${script}
    }, { once: true });
  `);
  await browser.setViewport({ width: 1000, height: 800 });
  await app.open(fixture);
  await expect(screen.getByRole("heading", "Connect your apps")).toBeVisible();
  await expect(browser.locator("html")).toHaveAttribute(
    "data-desktop-titlebar",
    "overlay",
  );
  const handle = browser.locator(header);
  await expect(handle).toHaveAttribute(drag, "");
  await expect(browser.locator(`[${drag}]`)).toHaveCount(1);
  await expect(browser.locator(`${header} [${drag}]`)).toHaveCount(0);
  const back = screen.getByRole("button", "Back", { exact: true });
  await expect(back).toBeVisible();

  await browser.evaluate((selector) => {
    const original = document.querySelector<HTMLElement>(selector);
    if (!original) throw new Error("Missing the first step header");
    original.dataset.testOriginalHeader = "";
    return null;
  }, header);
  await screen.getByRole("button", "Continue", { exact: true }).tap();
  await expect(screen.getByRole("heading", "Talk to us")).toBeVisible();
  await expect(browser.locator("[data-test-original-header]")).toHaveCount(0);
  await expect(handle).toHaveAttribute(drag, "");
  await expect(browser.locator(`[${drag}]`)).toHaveCount(1);
  await back.tap();
  await expect(screen.getByRole("heading", "Connect your apps")).toBeVisible();
});

for (const { name, width, overlay, top } of [
  { name: "macOS desktop overlay", width: 1000, overlay: true, top: 48 },
  { name: "browser or Windows title bar", width: 1000, overlay: false, top: 0 },
  { name: "two-column macOS overlay", width: 1280, overlay: true, top: 48 },
]) {
  test(`onboarding reserves the correct title bar space for the ${name}`, async ({
    app,
    browser,
    screen,
  }) => {
    await browser.setViewport({ width, height: 800 });
    await app.open(`${fixture}${overlay ? "?overlay" : ""}`);
    await expect(
      screen.getByRole("heading", "Connect your apps", { exact: true }),
    ).toBeVisible();
    const placement = await browser.evaluate((selector) => {
      const header = document.querySelector(selector);
      const back = document.querySelector('[data-onboarding-back="phone"]');
      if (!header) throw new Error("Missing the onboarding header");
      const box = back?.getBoundingClientRect();
      return {
        inset: parseFloat(getComputedStyle(header).paddingTop),
        back:
          box && box.height > 0
            ? {
                top: box.top,
                right: box.right,
                bottom: box.bottom,
                left: box.left,
              }
            : null,
      };
    }, header);
    expect(placement.inset).toBe(top);
    if (width === 1000) {
      if (!placement.back) throw new Error("Missing the compact Back button");
      if (overlay) {
        const windowButtons = { left: 19, top: 21, right: 81, bottom: 37 };
        const { back } = placement;
        expect(back.top).toBeGreaterThanOrEqual(windowButtons.bottom);
        expect(
          back.left < windowButtons.right &&
            back.right > windowButtons.left &&
            back.top < windowButtons.bottom &&
            back.bottom > windowButtons.top,
        ).toBe(false);
      } else {
        expect(placement.back.top).toBe(12);
      }
    }
  });
}

/**
 * Where the orb paints and where it may: the disc with its scale, and the glow, whose box is blurred
 * outward by the blur's radius. And the area it can be seen in: the window, below the header when
 * the header sits over the page, and inside every ancestor that clips what overflows it.
 */
function measureOrb(browser: Browser) {
  return browser.evaluate(() => {
    const box = (element: Element) => {
      const { top, right, bottom, left } = element.getBoundingClientRect();
      return { top, right, bottom, left };
    };
    const orb = document.querySelector("[data-onboarding-demo] [data-orb]");
    const disc = orb?.querySelector(".agent-orb");
    const glow = disc?.previousElementSibling;
    if (!orb || !disc || !glow) throw new Error("No orb on the name step");
    const blur = Number.parseFloat(
      /blur\(([\d.]+)px\)/.exec(getComputedStyle(glow).filter)?.[1] ?? "0",
    );
    const halo = box(glow);
    const painted = [
      box(disc),
      {
        top: halo.top - blur,
        right: halo.right + blur,
        bottom: halo.bottom + blur,
        left: halo.left - blur,
      },
    ].reduce((all, one) => ({
      top: Math.min(all.top, one.top),
      right: Math.max(all.right, one.right),
      bottom: Math.max(all.bottom, one.bottom),
      left: Math.min(all.left, one.left),
    }));

    const visible = {
      top: 0,
      right: window.innerWidth,
      bottom: window.innerHeight,
      left: 0,
    };
    const header = document.querySelector("[data-onboarding-frame] > header");
    if (header && getComputedStyle(header).position === "sticky") {
      visible.top = Math.max(visible.top, box(header).bottom);
    }
    for (let at = orb.parentElement; at; at = at.parentElement) {
      if (at === document.body) break;
      const { overflowX, overflowY } = getComputedStyle(at);
      const clips = (overflow: string) => overflow !== "visible";
      const edge = box(at);
      if (clips(overflowY)) {
        visible.top = Math.max(visible.top, edge.top);
        visible.bottom = Math.min(visible.bottom, edge.bottom);
      }
      if (clips(overflowX)) {
        visible.left = Math.max(visible.left, edge.left);
        visible.right = Math.min(visible.right, edge.right);
      }
    }
    return { painted, visible, scale: getComputedStyle(disc).transform };
  });
}

for (const [state, scale] of [
  ["listening", "matrix(1.06, 0, 0, 1.06, 0, 0)"],
  ["done", "matrix(1.1, 0, 0, 1.1, 0, 0)"],
]) {
  for (const { name, width, height, overlay } of [
    { name: "Windows desktop", width: 1000, height: 800, overlay: false },
    { name: "macOS desktop", width: 1000, height: 800, overlay: true },
    { name: "phone", width: 360, height: 740, overlay: false },
    { name: "two columns", width: 1280, height: 800, overlay: false },
  ]) {
    test(`the ${state} onboarding orb and glow fit in ${name}`, async ({
      app,
      browser,
      screen,
    }) => {
      await browser.setViewport({ width, height });
      await app.open(`${fixture}?step=${state}${overlay ? "&overlay" : ""}`);
      await expect(
        screen.getByRole("textbox", "Name", { exact: true }),
      ).toBeVisible();
      await expect(
        screen.getByRole(
          "button",
          state === "done" ? "All set" : "Get started",
          { exact: true },
        ),
      ).toBeVisible();
      await expect
        .poll(async () => (await measureOrb(browser)).scale)
        .toBe(scale);
      const { painted, visible } = await measureOrb(browser);
      expect(painted.top).toBeGreaterThanOrEqual(visible.top);
      expect(painted.right).toBeLessThanOrEqual(visible.right);
      expect(painted.bottom).toBeLessThanOrEqual(visible.bottom);
      expect(painted.left).toBeGreaterThanOrEqual(visible.left);
    });
  }
}
