import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";

test("an explicit tab stop keeps a short message viewport in Chromium's keyboard order", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/tests/browser/message-scroller.html");
  const messages = screen.getByRole("region", "Messages", { exact: true });
  const before = screen.getByRole("button", "Before messages", { exact: true });
  const after = screen.getByRole("button", "After messages", { exact: true });
  await expect(messages).toContainText("One short message.");
  await expect(messages).toHaveAttribute("tabindex", "0");
  await before.focus();
  await browser.keyboard.press("Tab");
  await expect(messages).toBeFocused();
  await browser.keyboard.press("Tab");
  await expect(after).toBeFocused();
});

type Drag = {
  target: "Page margin" | "File drop target";
  kind: "file" | "text";
};

function dispatchDrag(browser: Browser, drag: Drag) {
  return browser.evaluate(({ target, kind }) => {
    const node = document.querySelector(`[aria-label="${target}"]`);
    if (!node) throw new Error("The drop target is missing");
    const dataTransfer = new DataTransfer();
    if (kind === "file") {
      dataTransfer.items.add(
        new File(["Test notes"], "notes.txt", { type: "text/plain" }),
      );
    } else {
      dataTransfer.setData("text/plain", "Test notes");
    }
    // Chromium only updates the native effect during a trusted drag session.
    Object.defineProperty(dataTransfer, "dropEffect", {
      value: "copy",
      writable: true,
    });
    const initialEffect = dataTransfer.dropEffect;
    const over = new DragEvent("dragover", {
      bubbles: true,
      cancelable: true,
      dataTransfer,
    });
    const drop = new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      dataTransfer,
    });
    node.dispatchEvent(over);
    const finalEffect = dataTransfer.dropEffect;
    node.dispatchEvent(drop);
    return {
      over: over.defaultPrevented,
      drop: drop.defaultPrevented,
      initialEffect,
      finalEffect,
    };
  }, drag);
}

test("the root guard refuses unclaimed file drags and leaves text and claimed file drops alone", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/tests/browser/root-drop-guard.html");
  const remove = screen.getByRole("button", "Remove drop guard", {
    exact: true,
  });
  await expect(remove).toBeEnabled();
  const path = "/tests/browser/root-drop-guard.html";
  const ignored = await dispatchDrag(browser, {
    target: "Page margin",
    kind: "text",
  });
  expect(ignored).toEqual({
    over: false,
    drop: false,
    initialEffect: "copy",
    finalEffect: "copy",
  });

  const rejected = await dispatchDrag(browser, {
    target: "Page margin",
    kind: "file",
  });
  expect(rejected).toEqual({
    over: true,
    drop: true,
    initialEffect: "copy",
    finalEffect: "none",
  });
  await expect(browser).toHaveURL(path);

  const accepted = await dispatchDrag(browser, {
    target: "File drop target",
    kind: "file",
  });
  expect(accepted).toEqual({
    over: true,
    drop: true,
    initialEffect: "copy",
    finalEffect: "copy",
  });
  await expect(
    screen.getByRole("region", "File drop target", { exact: true }),
  ).toContainText("notes.txt");

  await remove.click();
  await expect(remove).toBeDisabled();
  const removed = await dispatchDrag(browser, {
    target: "Page margin",
    kind: "file",
  });
  expect(removed).toEqual({
    over: false,
    drop: false,
    initialEffect: "copy",
    finalEffect: "copy",
  });
});

test("native and link-backed buttons retain their keyboard and accessibility semantics", async ({
  app,
  browser,
  screen,
}) => {
  await browser.addInitScript(() => {
    const baseUIErrors: string[] = [];
    Object.defineProperty(window, "e2eBaseUIErrors", { value: baseUIErrors });
    const originalError = console.error;
    console.error = (...args) => {
      const message = args.map(String).join(" ");
      if (message.startsWith("Base UI:")) baseUIErrors.push(message);
      originalError(...args);
    };
  });
  await app.open("/tests/browser/button-semantics.html");
  for (const label of ["Save", "Open"]) {
    const button = browser.locator("button").filter({ hasText: label });
    await expect(button).toHaveAttribute("type", "button");
    expect(await button.getAttribute("role")).toBeNull();
  }

  for (const [label, hash] of [
    ["Settings", "#settings"],
    ["Agents", "#agents"],
  ]) {
    const link = screen.getByRole("button", label, { exact: true });
    await expect(link).toHaveAttribute("href", hash);
    await expect(link).toHaveAttribute("role", "button");
    expect(await link.getAttribute("type")).toBeNull();
    await link.press("Space");
    await expect(browser).toHaveURL(
      `/tests/browser/button-semantics.html${hash}`,
    );
  }
  expect(
    await browser.evaluate(() => Reflect.get(window, "e2eBaseUIErrors")),
  ).toEqual([]);
});

test("a disabled action row is dimmed and skipped in the keyboard order", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/tests/browser/button-semantics.html");
  const row = screen.getByRole("button", "Run now", { exact: true });
  await expect(row).toBeDisabled();
  expect(
    await browser.evaluate(() => {
      const element = document.querySelector('button[data-slot="item"]');
      if (!element) throw new Error("The disabled action row is missing");
      const { opacity, pointerEvents } = getComputedStyle(element);
      return { opacity, pointerEvents };
    }),
  ).toEqual({ opacity: "0.5", pointerEvents: "none" });
  await screen.getByRole("button", "Open", { exact: true }).focus();
  await browser.keyboard.press("Tab");
  await expect(
    screen.getByRole("button", "Next control", { exact: true }),
  ).toBeFocused();
});

for (const [orientation, backwards, forwards, perpendicular] of [
  ["Horizontal", "ArrowLeft", "ArrowRight", "ArrowUp"],
  ["Vertical", "ArrowUp", "ArrowDown", "ArrowLeft"],
]) {
  test(`the ${orientation.toLowerCase()} carousel only uses its own arrow keys`, async ({
    app,
    screen,
  }) => {
    await app.open("/tests/browser/carousel-keyboard.html");
    const carousel = screen.getByRole("region", `${orientation} slides`, {
      exact: true,
    });
    const previous = carousel.getByRole("button", "Previous slide", {
      exact: true,
    });
    const next = carousel.getByRole("button", "Next slide", { exact: true });
    await expect(next).toBeEnabled();
    await expect(previous).toBeDisabled();

    await carousel.press(perpendicular);
    await expect(previous).toBeDisabled();
    await carousel.press(forwards);
    await expect(previous).toBeEnabled();
    await expect(next).toBeDisabled();
    await carousel.press(backwards);
    await expect(previous).toBeDisabled();
    await expect(next).toBeEnabled();
  });
}

test("editable controls inside a carousel keep their arrow keys", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/tests/browser/carousel-keyboard.html");
  const carousel = screen.getByRole("region", "Horizontal slides", {
    exact: true,
  });
  const previous = carousel.getByRole("button", "Previous slide", {
    exact: true,
  });
  await expect(
    carousel.getByRole("button", "Next slide", { exact: true }),
  ).toBeEnabled();

  for (const field of [
    carousel.getByRole("textbox", "Slide input", { exact: true }),
    carousel.getByRole("textbox", "Slide notes", { exact: true }),
    browser.locator('[contenteditable="true"]'),
  ]) {
    await field.focus();
    await browser.evaluate(() => {
      const node = document.activeElement;
      if (
        node instanceof HTMLInputElement ||
        node instanceof HTMLTextAreaElement
      ) {
        node.setSelectionRange(2, 2);
      } else if (node instanceof HTMLElement) {
        const text = node.firstChild;
        if (!text) throw new Error("The slide editor is empty");
        window.getSelection()?.collapse(text, 2);
      }
      return null;
    });
    for (const [key, offset] of [
      ["ArrowLeft", 1],
      ["ArrowRight", 2],
    ] as const) {
      await browser.keyboard.press(key);
      const caret = await browser.evaluate(() => {
        const node = document.activeElement;
        if (
          node instanceof HTMLInputElement ||
          node instanceof HTMLTextAreaElement
        )
          return node.selectionStart;
        return window.getSelection()?.anchorOffset ?? null;
      });
      expect(caret).toBe(offset);
      await expect(previous).toBeDisabled();
    }
  }

  await carousel.getByRole("combobox", "Slide option").focus();
  const arrowsReachSelect = await browser.evaluate(() => {
    const field = document.activeElement;
    if (!(field instanceof HTMLSelectElement))
      throw new Error("The slide option is not focused");
    return ["ArrowLeft", "ArrowRight"].map((key) =>
      field.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
      ),
    );
  });
  expect(arrowsReachSelect).toEqual([true, true]);
  await expect(previous).toBeDisabled();
});

test("brand trademarks are drawn without changing accessible names", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/tests/browser/brand-names.html");
  for (const [name, destination] of [
    ["OpenBot", "#openbot"],
    ["OpenBot for Business", "#business"],
  ]) {
    const link = screen.getByRole("link", name, { exact: true });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", destination);
    await expect(link).toHaveText(`${name}™`);
    const trademark = browser.locator(`a[href="${destination}"] sup`);
    await expect(trademark).toHaveText("™");
    await expect(trademark).toHaveAttribute("aria-hidden", "true");
  }
  for (const [name, destination] of [
    ["Acme Assistant", "#custom"],
    ["OpenBot is ready", "#prose"],
    ["Bots", "#bots"],
  ]) {
    const link = screen.getByRole("link", name, { exact: true });
    await expect(link).toHaveText(name);
    await expect(link).toHaveAttribute("href", destination);
    await expect(browser.locator(`a[href="${destination}"] sup`)).toHaveCount(
      0,
    );
  }
});
