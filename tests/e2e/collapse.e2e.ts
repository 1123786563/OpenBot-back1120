import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";

const fixture = "/tests/browser/collapse.html";

async function controlCollapseObserver(browser: Browser) {
  await browser.addInitScript(() => {
    const targetClass = "collapse-fixture-content";
    const nativeHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "offsetHeight",
    )?.get;
    if (!nativeHeight) throw new Error("Chromium needs a layout height getter");
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get(this: HTMLElement) {
        if (this.classList.contains(targetClass)) {
          performance.mark("collapse-height-read");
        }
        return nativeHeight.call(this);
      },
    });

    const NativeObserver = window.ResizeObserver;
    window.ResizeObserver = class extends NativeObserver {
      private deliver: () => void;
      constructor(callback: ResizeObserverCallback) {
        super(callback);
        this.deliver = () => callback([], this);
      }
      observe(target: Element, options?: ResizeObserverOptions) {
        if (!target.classList.contains(targetClass)) {
          super.observe(target, options);
          return;
        }
        window.addEventListener("collapse-fixture-resize", this.deliver);
        performance.mark("collapse-observer-ready");
      }
      disconnect() {
        window.removeEventListener("collapse-fixture-resize", this.deliver);
        super.disconnect();
      }
    };
  });
}

function panelHeight(browser: Browser) {
  return browser.evaluate(() => {
    const panel = document.querySelector(
      '[aria-label="Collapsible panel"] > div',
    );
    if (!panel) throw new Error("The collapse panel is missing");
    return panel.getBoundingClientRect().height;
  });
}

test("Collapse measures the first and subsequent opens and ignores the observer while closed", async ({
  app,
  browser,
  screen,
}) => {
  await controlCollapseObserver(browser);
  await app.open(fixture);
  await expect.poll(() => panelHeight(browser)).toBe(0);
  await expect
    .poll(() =>
      browser.evaluate(
        () => performance.getEntriesByName("collapse-observer-ready").length,
      ),
    )
    .toBe(1);

  await screen.getByRole("button", "Open at 64 pixels").tap();
  await expect.poll(() => panelHeight(browser)).toBe(64);
  await screen.getByRole("button", "Close", { exact: true }).tap();
  await expect.poll(() => panelHeight(browser)).toBe(0);

  const closedMeasurements = await browser.evaluate(() => {
    performance.clearMarks("collapse-height-read");
    window.dispatchEvent(new Event("collapse-fixture-resize"));
    return performance.getEntriesByName("collapse-height-read").length;
  });
  expect(closedMeasurements).toBe(0);

  await screen.getByRole("button", "Open at 96 pixels").tap();
  await expect.poll(() => panelHeight(browser)).toBe(96);
});

test("a suspended close leaves the committed Collapse responsive to resized content", async ({
  app,
  browser,
  screen,
}) => {
  await controlCollapseObserver(browser);
  await app.open(fixture);
  await screen.getByRole("button", "Open at 64 pixels").tap();
  await expect.poll(() => panelHeight(browser)).toBe(64);
  await screen.getByRole("button", "Start suspended close").tap();
  await expect
    .poll(() =>
      browser.evaluate(
        () =>
          performance.getEntriesByName("collapse-transition-suspended").length,
      ),
    )
    .toBeGreaterThan(0);
  await expect(
    screen.getByText("Panel content", { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByText("Waiting to close", { exact: true }),
  ).toHaveCount(0);
  expect(await panelHeight(browser)).toBe(64);

  await browser.evaluate(() => {
    const content = document.querySelector(
      '[data-testid="collapse-fixture-body"]',
    );
    if (!(content instanceof HTMLElement))
      throw new Error("The panel content is missing");
    content.style.height = "96px";
    window.dispatchEvent(new Event("collapse-fixture-resize"));
    return null;
  });
  await expect.poll(() => panelHeight(browser)).toBe(96);
});
