import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";

const fixture = "/tests/browser/composer-dictation.html";
const draft = "Existing draft";
const partial = `${draft} book a table for two`;
const spoken = `${partial} tonight`;
const transcribed = `${draft} dictated words`;
const microphone = "Dictate a message";
const stop = "Stop dictation";
const desktopCalls = (browser: Browser) =>
  browser.evaluate(() => {
    const calls = Reflect.get(window, "dictationDesktopCalls") as {
      command: string;
      args?: { language?: string };
    }[];
    return calls
      .filter(({ command }) => command.includes("|speech_"))
      .map(({ command, args }) => ({
        command: command.split("|").at(-1) ?? null,
        language: args?.language ?? null,
      }));
  });

for (const compact of [false, true]) {
  test(`desktop dictation stops on the first Enter and sends the final words on the second (compact=${compact})`, async ({
    app,
    browser,
    screen,
  }) => {
    await app.open(`${fixture}?source=desktop${compact ? "&compact" : ""}`);
    const box = screen.getByRole("textbox", "Message", { exact: true });
    const mic = screen.getByRole("button", microphone, { exact: true });
    const sent = screen.getByRole("status", "Sent drafts", { exact: true });
    await mic.click();
    await expect(box).toHaveText(partial);
    await expect(
      screen.getByRole("button", stop, { exact: true }),
    ).toBeVisible();
    await expect(mic).toHaveCount(0);
    expect((await desktopCalls(browser)).map(({ command }) => command)).toEqual(
      ["speech_available", "speech_start"],
    );
    expect((await desktopCalls(browser))[1]?.language).toBe(
      await browser.evaluate(() => navigator.language),
    );
    await box.press("Enter");
    await expect(box).toHaveText(spoken);
    await expect(mic).toBeVisible();
    await expect(sent).toHaveText("[]");
    expect((await desktopCalls(browser)).at(-1)?.command).toBe("speech_stop");
    await box.press("Enter");
    await expect(sent).toHaveText(JSON.stringify([spoken]));
  });
}

test("stopping desktop dictation leaves the final words in the draft", async ({
  app,
  screen,
}) => {
  await app.open(`${fixture}?source=desktop&compact`);
  const mic = screen.getByRole("button", microphone, { exact: true });
  await mic.click();
  const editor = screen.getByRole("textbox", "Message", { exact: true });
  await expect(editor).toHaveText(partial);
  await screen.getByRole("button", stop, { exact: true }).click();
  await expect(mic).toBeVisible();
  await expect(editor).toHaveText(spoken);
  await expect(
    screen.getByRole("status", "Sent drafts", { exact: true }),
  ).toHaveText("[]");
});

test("desktop waits for microphone permission before listening", async ({
  app,
  screen,
}) => {
  await app.open(`${fixture}?source=desktop&permission`);
  await screen.getByRole("button", microphone, { exact: true }).click();
  const waiting = screen.getByText(
    "Waiting for permission to use the microphone and speech recognition.",
    { exact: true },
  );
  await expect(waiting.first()).toBeVisible();
  await expect(
    screen.getByRole("textbox", "Message", { exact: true }),
  ).toHaveText(draft);
  await screen
    .getByRole("button", "Allow microphone access", { exact: true })
    .click();
  await expect(
    screen.getByRole("textbox", "Message", { exact: true }),
  ).toHaveText(partial);
  await expect(waiting).toHaveCount(0);
});

test("a refused microphone permission points to System Settings and preserves the draft", async ({
  app,
  screen,
}) => {
  await app.open(`${fixture}?source=desktop&refused`);
  const mic = screen.getByRole("button", microphone, { exact: true });
  await mic.click();
  await expect(screen.getByRole("alert")).toHaveText(
    "OpenBot can't use the microphone or speech recognition. Turn both on for OpenBot in System Settings, under Privacy & Security, then try again.",
  );
  await expect(
    screen.getByRole("textbox", "Message", { exact: true }),
  ).toHaveText(draft);
  await expect(mic).toBeVisible();
});

test("typing during desktop dictation stops it and keeps the edited draft", async ({
  app,
  browser,
  screen,
}) => {
  await app.open(`${fixture}?source=desktop&compact`);
  const mic = screen.getByRole("button", microphone, { exact: true });
  const box = screen.getByRole("textbox", "Message", { exact: true });
  await mic.click();
  await expect(box).toHaveText(partial);
  await box.press("End");
  await box.pressSequentially(", please");
  await expect(mic).toBeVisible();
  expect((await desktopCalls(browser)).at(-1)?.command).toBe("speech_abort");
  await expect(box).toHaveText(`${partial}, please`);
});

test("Chromium speech recognition streams interim words and sends only on the second Enter", async ({
  app,
  browser,
  screen,
}) => {
  await app.open(`${fixture}?source=web`);
  const box = screen.getByRole("textbox", "Message", { exact: true });
  const mic = screen.getByRole("button", microphone, { exact: true });
  const sent = screen.getByRole("status", "Sent drafts", { exact: true });
  const result = `${draft} I am opening the expenses page`;
  await mic.click();
  await expect(box).toHaveText(result);
  expect(
    await browser.evaluate(() => {
      const recognition = Reflect.get(window, "dictationRecognitions")[0];
      return [recognition.continuous, recognition.interimResults];
    }),
  ).toEqual([true, true]);
  await box.press("Enter");
  await expect(mic).toBeVisible();
  await expect(box).toHaveText(result);
  await expect(sent).toHaveText("[]");
  await box.press("Enter");
  await expect(sent).toHaveText(JSON.stringify([result]));
});

for (const [source, platform, expected] of [
  ["desktop", "windows", "windows"],
  ["desktop", "linux", "unsupported"],
  ["none", "linux", "unsupported"],
]) {
  test(`composer exposes the expected microphone for ${source} on ${platform}`, async ({
    app,
    screen,
  }) => {
    await app.open(`${fixture}?source=${source}&platform=${platform}`);
    await expect(
      screen.getByRole("status", "Speech platform", { exact: true }),
    ).toHaveText(expected);
    const mic = screen.getByRole("button", microphone, { exact: true });
    if (expected === "unsupported") await expect(mic).toHaveCount(0);
    else await expect(mic).toBeVisible();
  });
}

async function submitForm(browser: Browser) {
  await browser.evaluate(() => {
    const form = document.querySelector<HTMLFormElement>(
      'form[data-slot="composer"]',
    );
    if (!form) throw new Error("Missing composer form");
    form.requestSubmit();
    return null;
  });
}

for (const compact of [false, true]) {
  for (const action of ["stop", "send", "retry", "failed send", "cancel"]) {
    test(`provider dictation preserves the draft and follows ${action} (compact=${compact})`, async ({
      app,
      browser,
      screen,
    }) => {
      const release = Promise.withResolvers<void>();
      const requests: { method: string; tag?: string; type?: string }[] = [];
      await browser.route(/\/api\/audio\/transcriptions$/, async (route) => {
        requests.push({
          method: route.request.method,
          tag: route.request.headers["x-openbot-dictation"],
          type: route.request.headers["content-type"],
        });
        if (action === "retry" && requests.length === 1)
          return route.fulfill({
            status: 503,
            json: { error: "Please retry transcription" },
          });
        await release.promise;
        return route.fulfill({ json: { text: "  dictated words  " } });
      });
      const editor = screen.getByRole("textbox", "Message", { exact: true });
      const mic = screen.getByRole("button", microphone, { exact: true });
      const sent = screen.getByRole("status", "Sent drafts", { exact: true });
      await app.open(
        `${fixture}?source=provider${compact ? "&compact" : ""}${action === "failed send" ? "&fail-send" : ""}`,
      );
      await mic.click();
      try {
        await expect(
          screen.getByRole("img", "Live audio waveform", { exact: true }),
        ).toBeVisible();
        expect(
          await browser.evaluate(() => ({
            input: Reflect.get(window, "dictationRecording"),
            web: Reflect.get(window, "dictationRecognitions").length,
          })),
        ).toEqual({ input: { devices: 1, starts: 1 }, web: 0 });
        expect(await desktopCalls(browser)).toEqual([]);
        await expect(editor).toHaveCount(0);
        await expect(mic).toHaveCount(0);
        await submitForm(browser);
        await expect(sent).toHaveText("[]");
        if (action === "cancel") {
          await screen
            .getByRole("button", "Cancel dictation", { exact: true })
            .click();
        } else {
          await screen
            .getByRole(
              "button",
              action === "stop" ? "Stop and transcribe" : "Transcribe and send",
              { exact: true },
            )
            .click();
          await expect.poll(() => requests.length).toBe(1);
          if (action === "retry") {
            await expect(screen.getByRole("alert")).toContainText(
              "Please retry transcription",
            );
            await expect(sent).toHaveText("[]");
            await screen.getByRole("button", "Retry", { exact: true }).click();
            await expect.poll(() => requests.length).toBe(2);
          }
          await submitForm(browser);
          await expect(sent).toHaveText("[]");
        }
      } finally {
        release.resolve();
      }
      if (action === "cancel") {
        await expect(editor).toHaveText(draft);
        await expect(sent).toHaveText("[]");
        expect(requests).toHaveLength(0);
        return;
      }
      if (action === "stop") {
        await expect(editor).toHaveText(transcribed);
        await expect(sent).toHaveText("[]");
        await editor.press("Enter");
      }
      await expect(sent).toHaveText(JSON.stringify([transcribed]));
      if (action === "failed send")
        await expect(editor).toHaveText(transcribed);
      for (const request of requests) {
        expect(request.method).toBe("POST");
        expect(request.tag).toBe("1");
        expect(request.type).toMatch(/^multipart\/form-data; boundary=/);
      }
    });
  }
}

test("the idle dictation surface keeps the mention menu at the composer", async ({
  app,
  browser,
  screen,
}) => {
  await app.open(fixture);
  const box = screen.getByRole("textbox", "Message", { exact: true });
  await box.press("End");
  await box.pressSequentially(" @Billing");
  const option = screen.getByRole("option", /Billing Bot/);
  await expect(option).toBeVisible();
  const placement = await browser.evaluate(() => {
    const popup = document.querySelector('[role="listbox"]');
    const form = document.querySelector('form[data-slot="composer"]');
    if (!popup || !form) throw new Error("Missing mention menu or composer");
    const bounds = popup.getBoundingClientRect();
    const translated: string[] = [];
    for (
      let ancestor = popup.parentElement;
      ancestor;
      ancestor = ancestor.parentElement
    ) {
      const { translate, transform } = getComputedStyle(ancestor);
      if (translate !== "none" || transform !== "none")
        translated.push(ancestor.tagName);
    }
    return {
      translated,
      inViewport:
        bounds.left >= 0 &&
        bounds.top >= 0 &&
        bounds.right <= window.innerWidth &&
        bounds.bottom <= window.innerHeight,
    };
  });
  expect(placement).toEqual({ translated: [], inViewport: true });
  await option.click();
  await expect(box).toContainText("Billing Bot");
  await expect(option).toHaveCount(0);
});
