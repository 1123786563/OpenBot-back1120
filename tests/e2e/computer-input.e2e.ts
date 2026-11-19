import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { computerConversation, type Fixtures } from "./computer-fixtures";

const screenCanvas = '[role="dialog"][aria-label="The Bot\'s screen"] canvas';

test("Computer routes Shift+N and Ctrl+B to the focused remote screen until control is handed back", async (fixtures) => {
  const { browser, screen } = fixtures;
  const { path } = await computerConversation(
    fixtures,
    { status: "ready", frame: "frame" },
    {
      terminal: true,
      prepare: (state) => state.holdForViewer(),
    },
  );
  const pane = screen.getByRole("region", "Computer sidebar", { exact: true });
  const dialog = screen.getByRole("dialog", "The Bot's screen", {
    exact: true,
  });
  const sidebar = browser.locator('[data-slot="sidebar"][data-state]');
  const canvas = browser.locator(screenCanvas);
  const remoteKeys = async () =>
    JSON.parse(
      await browser.evaluate(() =>
        JSON.stringify(Reflect.get(window, "screenKeyboardMessages")),
      ),
    );
  await expect(sidebar).toHaveAttribute("data-state", "expanded");
  await pane
    .getByRole("button", "Open the Bot's screen full size", { exact: true })
    .click();
  await expect(canvas).toHaveAttribute("data-connected", "true");
  await expect(canvas).toBeFocused();
  await browser.keyboard.press("Shift+N");
  await browser.keyboard.press("Control+b");
  await expect.poll(remoteKeys).toEqual(
    expect.arrayContaining([
      {
        type: "key",
        event: "down",
        key: "N",
        code: "KeyN",
        text: "N",
        windowsVirtualKeyCode: 78,
        modifiers: 8,
      },
      {
        type: "key",
        event: "down",
        key: "b",
        code: "KeyB",
        text: "b",
        windowsVirtualKeyCode: 66,
        modifiers: 2,
      },
    ]),
  );
  await expect(browser).toHaveURL(`${path}?watch=true`);
  await expect(sidebar).toHaveAttribute("data-state", "expanded");

  await dialog.getByRole("button", "Hand back", { exact: true }).click();
  await expect(
    dialog.getByRole("button", "Take control", { exact: true }),
  ).toBeEnabled();
  await dialog
    .getByRole("button", "Close the Bot's screen", { exact: true })
    .focus();
  const forwarded = await remoteKeys();
  await browser.keyboard.press("Control+b");
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");
  expect(await remoteKeys()).toEqual(forwarded);
  await browser.keyboard.press("Shift+N");
  await expect(browser).toHaveURL(/\/channel\/new(?:[/?#]|$)/);
});

async function sentScreenMessages(browser: Browser): Promise<unknown[]> {
  const json = await browser.evaluate(() =>
    JSON.stringify(Reflect.get(window, "screenFixture").messages),
  );
  return JSON.parse(json);
}

async function openDrivingCanvas(fixtures: Fixtures) {
  const { browser, screen } = fixtures;
  await computerConversation(
    fixtures,
    { status: "ready", frame: "frame" },
    {
      terminal: true,
      prepare: (state) => state.holdForViewer(),
    },
  );
  await screen
    .getByRole("button", "Open the Bot's screen full size", { exact: true })
    .click();
  const canvas = browser.locator(screenCanvas);
  await expect(canvas).toHaveAttribute("data-connected", "true");
  const frame = () =>
    browser.evaluate(() => {
      Reflect.get(window, "screenFixture").frame("#0000ff", 400, 200);
      return null;
    });
  await frame();
  await expect(canvas).toHaveAttribute("width", "400");
  await expect(canvas).toHaveAttribute("height", "200");
  return { canvas, frame, sent: () => sentScreenMessages(browser) };
}

function mouse(event: string, properties: object) {
  return expect.objectContaining({ type: "mouse", event, ...properties });
}

function expectCenter(message: unknown) {
  if (
    !message ||
    typeof message !== "object" ||
    !("x" in message) ||
    !("y" in message)
  )
    throw new Error("Expected a screen message with coordinates");
  expect(Math.abs(Number(message.x) - 200)).toBeLessThanOrEqual(2);
  expect(Math.abs(Number(message.y) - 100)).toBeLessThanOrEqual(2);
}

test("the remote screen forwards Chromium single and double click counts", async (fixtures) => {
  const { canvas, sent } = await openDrivingCanvas(fixtures);
  const clicks = async () =>
    (await sent()).filter(
      (message) =>
        message &&
        typeof message === "object" &&
        "clickCount" in message &&
        message.clickCount !== 0,
    );
  await canvas.click();
  const left = { button: "left", modifiers: 0 };
  await expect
    .poll(clicks)
    .toEqual([
      mouse("pressed", { ...left, clickCount: 1, buttons: 1 }),
      mouse("released", { ...left, clickCount: 1, buttons: 0 }),
    ]);

  await canvas.dblclick();
  await expect
    .poll(async () => (await clicks()).slice(2))
    .toEqual([
      mouse("pressed", { ...left, clickCount: 1 }),
      mouse("released", { ...left, clickCount: 1 }),
      mouse("pressed", { ...left, clickCount: 2 }),
      mouse("released", { ...left, clickCount: 2 }),
    ]);
});

test("the remote screen coalesces pointer moves before a click and releases a drag at the edge", async (fixtures) => {
  const { browser } = fixtures;
  const { sent } = await openDrivingCanvas(fixtures);
  const checkpoint = (await sent()).length;
  const beforePress = await browser.evaluate((selector) => {
    const canvas = document.querySelector<HTMLCanvasElement>(selector);
    if (!canvas) throw new Error("Missing live screen canvas");
    const { left, top, width, height } = canvas.getBoundingClientRect();
    const clientY = Math.round(top + height / 2);
    for (const fraction of [0.15, 0.25, 0.35, 0.5])
      canvas.dispatchEvent(
        new MouseEvent("mousemove", {
          bubbles: true,
          clientX: Math.round(left + width * fraction),
          clientY,
        }),
      );
    const messages = Reflect.get(window, "screenFixture").messages;
    const beforePress = messages.length;
    const clientX = Math.round(left + width / 2);
    canvas.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        clientX,
        clientY,
        buttons: 1,
        detail: 0,
      }),
    );
    canvas.dispatchEvent(
      new MouseEvent("mousemove", {
        bubbles: true,
        clientX,
        clientY,
        buttons: 1,
      }),
    );
    document.body.dispatchEvent(
      new MouseEvent("mouseup", {
        bubbles: true,
        clientX: Math.floor(left) - 10,
        clientY,
        buttons: 0,
      }),
    );
    document.body.dispatchEvent(
      new MouseEvent("mouseup", {
        bubbles: true,
        clientX: Math.floor(left) - 10,
        clientY,
        buttons: 0,
      }),
    );
    return beforePress;
  }, screenCanvas);
  expect(beforePress).toBe(checkpoint);
  const events = (await sent()).slice(checkpoint);
  expect(events).toEqual([
    mouse("moved", {
      button: "none",
      buttons: 0,
      clickCount: 0,
      x: expect.any(Number),
      y: expect.any(Number),
    }),
    mouse("pressed", { button: "left", buttons: 1, clickCount: 1 }),
    mouse("moved", { button: "left", buttons: 1, clickCount: 0 }),
    mouse("released", { button: "left", buttons: 0, clickCount: 1, x: 0 }),
  ]);
  for (const event of events.slice(0, 3)) expectCenter(event);
});

test("the remote screen consumes wheel input, batches a frame and converts line deltas to pixels", async (fixtures) => {
  const { browser } = fixtures;
  const { sent } = await openDrivingCanvas(fixtures);
  const checkpoint = (await sent()).length;
  async function wheel(deltas: number[], deltaMode: number) {
    return browser.evaluate(
      ({ selector, deltas, deltaMode }) => {
        const canvas = document.querySelector<HTMLCanvasElement>(selector);
        if (!canvas) throw new Error("Missing live screen canvas");
        const { left, top, width, height } = canvas.getBoundingClientRect();
        return deltas.map((deltaY) => {
          const event = new WheelEvent("wheel", {
            bubbles: true,
            cancelable: true,
            clientX: Math.round(left + width / 2),
            clientY: Math.round(top + height / 2),
            deltaY,
            deltaMode,
          });
          canvas.dispatchEvent(event);
          return event.defaultPrevented;
        });
      },
      { selector: screenCanvas, deltas, deltaMode },
    );
  }
  expect(await wheel([40, 40, -20], 0)).toEqual([true, true, true]);
  const scroll = (deltaY: number) =>
    expect.objectContaining({
      type: "wheel",
      deltaY,
      deltaX: 0,
      modifiers: 0,
    });
  await expect
    .poll(async () => (await sent()).slice(checkpoint))
    .toEqual([scroll(60)]);
  expect(await wheel([3], 1)).toEqual([true]);
  await expect
    .poll(async () => (await sent()).slice(checkpoint))
    .toEqual([scroll(60), scroll(120)]);
  for (const event of (await sent()).slice(checkpoint)) expectCenter(event);
});

test("the live screen confirms frames only after the Computer requests acknowledgements", async (fixtures) => {
  const { browser } = fixtures;
  const { frame, sent } = await openDrivingCanvas(fixtures);
  const acknowledgements = async () =>
    (await sent()).filter(
      (message) =>
        message &&
        typeof message === "object" &&
        "type" in message &&
        message.type === "frame-received",
    );
  await frame();
  expect(await acknowledgements()).toEqual([]);
  await browser.evaluate(() => {
    const connection = Reflect.get(window, "screenFixture");
    connection.receive({ type: "hello", confirmFrames: true });
    connection.frame("#ff0000");
    connection.frame("#00ff00");
    return null;
  });
  expect(await acknowledgements()).toEqual([
    { type: "frame-received" },
    { type: "frame-received" },
  ]);
});

type KeyStroke = Pick<
  KeyboardEventInit,
  "key" | "code" | "keyCode" | "ctrlKey" | "metaKey" | "shiftKey"
> & {
  type: "keydown" | "keyup";
  target?: "focused";
};

function sendKeys(browser: Browser, strokes: KeyStroke[]) {
  return browser.evaluate(
    ({ selector, strokes }) => {
      const canvas = document.querySelector<HTMLCanvasElement>(selector);
      if (!canvas) throw new Error("Missing live screen canvas");
      return strokes.map(({ type, target = "screen", ...details }) => {
        const element = target === "focused" ? document.activeElement : canvas;
        if (!element) throw new Error("No focused key target");
        const event = new KeyboardEvent(type, {
          bubbles: true,
          cancelable: true,
          ...details,
        });
        element.dispatchEvent(event);
        return event.defaultPrevented;
      });
    },
    { selector: screenCanvas, strokes },
  );
}

function key(event: "down" | "up", details: object) {
  return expect.objectContaining({ type: "key", event, ...details });
}

const shiftKey = { key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 };

test("paste shortcuts stay local across keyboard layouts and the resulting clipboard text goes to the remote screen once", async (fixtures) => {
  const { browser } = fixtures;
  const { canvas, sent } = await openDrivingCanvas(fixtures);
  await expect(canvas).toBeFocused();
  for (const shortcut of [
    { key: "v", code: "KeyV", ctrlKey: true },
    { key: "v", code: "KeyV", metaKey: true },
    { key: "м", code: "KeyV", ctrlKey: true },
    { key: "ω", code: "KeyV", ctrlKey: true },
    { key: "v", code: "Period", ctrlKey: true },
  ]) {
    expect(
      await sendKeys(browser, [
        { type: "keydown", ...shortcut },
        { type: "keyup", key: shortcut.key, code: shortcut.code },
      ]),
    ).toEqual([false, false]);
  }
  expect(await sent()).toEqual([]);

  expect(
    await sendKeys(browser, [
      { type: "keydown", key: "k", code: "KeyV", keyCode: 75, ctrlKey: true },
      { type: "keyup", key: "k", code: "KeyV", keyCode: 75 },
    ]),
  ).toEqual([true, true]);
  const pasteConsumed = await browser.evaluate((selector) => {
    const canvas = document.querySelector(selector);
    if (!canvas) throw new Error("Missing live screen canvas");
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", "First line\nSecond line");
    const event = new ClipboardEvent("paste", {
      clipboardData,
      bubbles: true,
      cancelable: true,
    });
    canvas.dispatchEvent(event);
    return event.defaultPrevented;
  }, screenCanvas);
  expect(pasteConsumed).toBe(true);
  expect(await sent()).toEqual([
    key("down", {
      key: "k",
      code: "KeyV",
      text: "k",
      windowsVirtualKeyCode: 75,
      modifiers: 2,
    }),
    key("up", {
      key: "k",
      code: "KeyV",
      windowsVirtualKeyCode: 75,
      modifiers: 0,
    }),
    { type: "text", text: "First line\nSecond line" },
  ]);
});

test("the remote screen preserves punctuation and emoji and maps Command+A to Control+A with both releases", async (fixtures) => {
  const { browser } = fixtures;
  const { sent } = await openDrivingCanvas(fixtures);
  expect(
    await sendKeys(browser, [
      { type: "keydown", key: ".", code: "Period", keyCode: 190 },
      { type: "keyup", key: ".", code: "Period", keyCode: 190 },
      { type: "keydown", key: "😀" },
      { type: "keyup", key: "😀" },
      { type: "keydown", key: "a", code: "KeyA", keyCode: 65, ctrlKey: true },
      { type: "keyup", key: "a", code: "KeyA", keyCode: 65 },
      {
        type: "keydown",
        key: "Meta",
        code: "MetaLeft",
        keyCode: 91,
        metaKey: true,
      },
      { type: "keydown", key: "a", code: "KeyA", keyCode: 65, metaKey: true },
      { type: "keyup", key: "Meta", code: "MetaLeft", keyCode: 91 },
    ]),
  ).toEqual(Array(9).fill(true));
  const a = { key: "a", code: "KeyA", windowsVirtualKeyCode: 65 };
  const control = {
    key: "Control",
    code: "ControlLeft",
    windowsVirtualKeyCode: 17,
  };
  expect(await sent()).toEqual([
    key("down", {
      key: ".",
      code: "Period",
      text: ".",
      windowsVirtualKeyCode: 190,
      modifiers: 0,
    }),
    key("up", {
      key: ".",
      code: "Period",
      windowsVirtualKeyCode: 190,
      modifiers: 0,
    }),
    key("down", { key: "😀", text: "😀" }),
    key("up", { key: "😀" }),
    key("down", { ...a, text: "a", modifiers: 2 }),
    key("up", { ...a, modifiers: 0 }),
    key("down", { ...control, modifiers: 2 }),
    key("down", { ...a, text: "a", modifiers: 2 }),
    key("up", { ...control, modifiers: 0 }),
    key("up", { ...a, modifiers: 0 }),
  ]);
});

test("a held key is released after focus leaves the canvas and local controls keep their keys", async (fixtures) => {
  const { browser, screen } = fixtures;
  const { canvas, sent } = await openDrivingCanvas(fixtures);
  await expect(canvas).toBeFocused();
  await expect(canvas).toHaveAttribute("tabindex", "0");
  await expect(canvas).toHaveAttribute("role", "application");
  await sendKeys(browser, [
    {
      type: "keydown",
      key: "Shift",
      code: "ShiftLeft",
      shiftKey: true,
      keyCode: 16,
    },
  ]);
  const close = screen.getByRole("button", "Close the Bot's screen", {
    exact: true,
  });
  await close.focus();
  await expect(close).toBeFocused();
  expect(
    await sendKeys(browser, [
      {
        type: "keyup",
        key: "Shift",
        code: "ShiftLeft",
        keyCode: 16,
        target: "focused",
      },
    ]),
  ).toEqual([true]);
  const localKeys = ["ArrowLeft", "Tab", "Enter", " ", "Delete"];
  expect(
    await sendKeys(
      browser,
      localKeys.map((key) => ({
        type: "keydown",
        key,
        target: "focused",
      })),
    ),
  ).toEqual(localKeys.map(() => false));
  expect(await sent()).toEqual([
    key("down", { ...shiftKey, modifiers: 8 }),
    key("up", { ...shiftKey, modifiers: 0 }),
  ]);
});

for (const action of ["Hand back", "Escape"] as const) {
  test(`${action} releases a held key before the remote screen stops taking input`, async (fixtures) => {
    const { browser, screen } = fixtures;
    const { canvas, sent } = await openDrivingCanvas(fixtures);
    const dialog = screen.getByRole("dialog", "The Bot's screen", {
      exact: true,
    });
    await expect(canvas).toBeFocused();
    await sendKeys(browser, [
      {
        type: "keydown",
        key: "Shift",
        code: "ShiftLeft",
        shiftKey: true,
        keyCode: 16,
      },
    ]);
    if (action === "Escape") {
      await browser.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      expect(
        await browser.evaluate(() =>
          Reflect.get(window, "screenFixture").isOpen(),
        ),
      ).toBe(false);
    } else {
      await dialog.getByRole("button", "Hand back", { exact: true }).click();
      await expect(
        dialog.getByRole("button", "Take control", { exact: true }),
      ).toBeEnabled();
      await expect(canvas).not.toHaveAttribute("tabindex", "0");
      await expect(canvas).not.toHaveAttribute("role", "application");
    }
    await expect
      .poll(sent)
      .toEqual([
        key("down", { ...shiftKey, modifiers: 8 }),
        key("up", { ...shiftKey, modifiers: 0 }),
      ]);
  });
}

test("a refused input is announced while the connected remote screen stays open", async (fixtures) => {
  const { browser, screen } = fixtures;
  const { canvas } = await openDrivingCanvas(fixtures);
  await browser.evaluate(() => {
    Reflect.get(window, "screenFixture").receive({
      type: "input-error",
      error: "Take control first.",
    });
    return null;
  });
  const dialog = screen.getByRole("dialog", "The Bot's screen", {
    exact: true,
  });
  await expect(
    dialog.getByRole("status").filter({ hasText: "Take control first." }),
  ).toBeVisible();
  await expect(canvas).toHaveAttribute("data-connected", "true");
  await expect(canvas).toHaveAttribute("width", "400");
  await expect(
    dialog.getByRole("button", "Retry", { exact: true }),
  ).toHaveCount(0);
});
