import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { chatRunPath, configureChatStream, readChatRun } from "./chat-stream";
import { createConversation } from "./conversations";
import { createBot } from "./signed-in";

const personal = process.env.OPENBOT_E2E_SUITE === "personal";
const title = "Finance Operations";
const role = "Reads every expense claim against the travel policy.";
const headingSelector = "[data-transcript-column]";

test("the conversation shows the Bot's introduction, large orb and edition-specific visibility", async (fixtures) => {
  const { app, browser } = fixtures;
  const bot = await createBot(fixtures);
  const id = await createConversation(browser, bot.id);
  await configureChatStream(browser, []);
  let profile: {
    title: string;
    roleDescription: string | null;
    visibility: "private" | "public";
  } = {
    title,
    roleDescription: role,
    visibility: "private",
  };
  await browser.route(/\/api\/agents$/, async (route) => {
    const response = await route.fetch();
    const data = await response.json<{
      agents: (Record<string, unknown> & { id: string })[];
    }>();
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ...data,
        agents: data.agents.map((agent) =>
          agent.id === bot.id ? { ...agent, ...profile } : agent,
        ),
      }),
    });
  });

  const path = `/channel/${id}`;
  await app.open(path);
  const intro = browser.locator(headingSelector);
  const name = intro.getByRole("heading", bot.name, { exact: true });
  const orb = intro.getByRole("img", bot.name, { exact: true });
  const privateBadge = intro.getByText("Private", { exact: true });
  const publicBadge = intro.getByText("Public", { exact: true });
  await expect(name).toBeVisible();
  await expect(
    intro.getByText(`${title} · ${role}`, { exact: true }),
  ).toBeVisible();
  await expect(orb).toHaveCount(1);
  await expect(orb).toHaveAttribute("data-variant", "live");
  await expect(privateBadge).toHaveCount(personal ? 0 : 1);
  await expect(publicBadge).toHaveCount(0);

  profile = { title, roleDescription: null, visibility: "public" };
  await browser.reload();
  await expect(intro.getByText(title, { exact: true })).toBeVisible();
  await expect(privateBadge).toHaveCount(0);
  await expect(publicBadge).toHaveCount(personal ? 0 : 1);

  const longRole =
    "Check one expense claim at a time against the policy as it is written. "
      .repeat(6)
      .trim();
  profile = { ...profile, roleDescription: longRole };
  await browser.setViewport({ width: 600, height: 780 });
  await browser.reload();
  const description = `${title} · ${longRole}`;
  await expect(intro.getByText(description, { exact: true })).toHaveAttribute(
    "title",
    description,
  );
  const lines = await browser.evaluate((description) => {
    const paragraph = [...document.querySelectorAll("p[title]")].find(
      (element) => element.getAttribute("title") === description,
    );
    if (!paragraph) throw new Error("The Bot description is missing");
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const bounds = paragraph.getBoundingClientRect();
    const tops = [
      ...new Set([...range.getClientRects()].map((rect) => rect.top)),
    ];
    return {
      total: tops.length,
      visible: tops.filter((top) => top < bounds.bottom).length,
    };
  }, description);
  expect(lines.total).toBeGreaterThan(2);
  expect(lines.visible).toBe(2);

  if (personal) {
    const starterRole =
      "Help with email, your calendar, research, planning and everyday errands.";
    profile = {
      ...profile,
      title: "Everyday life. Powered by LangChain (LangGraph).",
      roleDescription: starterRole,
    };
    await browser.reload();
    await expect(
      intro.getByText(
        `Everyday life agent. (powered by a LangChain agent; you can bring your own agent from any stack.) · ${starterRole}`,
        { exact: true },
      ),
    ).toBeVisible();
    await expect(intro).not.toContainText("LangGraph");
  }
});

test("only a person's first message triggers the offer above the composer", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const emptyId = await createConversation(
    browser,
    bot.id,
    "Empty conversation",
  );
  const historyId = await createConversation(
    browser,
    bot.id,
    "Opening greeting",
  );
  await browser.addInitScript(() => {
    Object.defineProperty(Notification, "permission", {
      configurable: true,
      value: "default",
    });
  });
  await configureChatStream(browser, []);
  await app.open(`/channel/${emptyId}`);
  const transcript = screen.getByRole("region", "Messages", { exact: true });
  const offer = browser.locator("[data-notify-prompt]");
  await expect(
    transcript.getByRole("heading", bot.name, { exact: true }),
  ).toBeVisible();
  await expect(offer).toHaveCount(0);

  const greeting = "Hello there.";
  await configureChatStream(browser, [
    { id: "opening-greeting", role: "assistant", content: greeting },
  ]);
  await browser.route(chatRunPath, (route) => {
    const { threadId, runId } = readChatRun(route.request.postData);
    const events = [
      { type: "RUN_STARTED", threadId, runId },
      { type: "RUN_FINISHED", threadId, runId },
    ];
    return route.fulfill({
      contentType: "text/event-stream",
      body: events
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join(""),
    });
  });
  await app.open(`/channel/${historyId}`);
  await expect(transcript.getByText(greeting, { exact: true })).toBeVisible();
  await expect(offer).toHaveCount(0);

  const question = "Book a table.";
  await screen.getByRole("textbox", "Message", { exact: true }).fill(question);
  await screen.getByRole("button", "Send message", { exact: true }).tap();
  await expect(transcript.getByText(question, { exact: true })).toBeVisible();
  const columnOffer = browser.locator(
    '[data-slot="composer-column"] [data-notify-prompt]',
  );
  await expect(columnOffer).toContainText(
    "Get notified when your Bot finishes or needs your approval.",
  );
  const overlaps = await browser.evaluate(() => {
    const banner = document.querySelector("[data-notify-prompt]");
    const editor = document.querySelector('[data-slot="composer-input"]');
    if (!banner || !editor)
      throw new Error("Missing notification offer or composer");
    return (
      banner.getBoundingClientRect().bottom > editor.getBoundingClientRect().top
    );
  });
  expect(overlaps).toBe(false);
});

type Box = { top: number; right: number; bottom: number; left: number };

/**
 * Where the halo paints, and where it can be seen. The halo is the pattern's box (its mask is gone
 * by the box's edge) and the orb's glow, whose box is blurred outward by the blur's radius. It can
 * be seen inside the window and inside every ancestor that clips what overflows it.
 */
async function halo(browser: Browser) {
  return browser.evaluate(() => {
    const box = (element: Element) => {
      const { top, right, bottom, left } = element.getBoundingClientRect();
      return { top, right, bottom, left };
    };
    const pattern = document.querySelector(".orb-pattern");
    const disc = document.querySelector(".bot-orb-live .agent-orb");
    const glow = disc?.previousElementSibling;
    if (!pattern || !disc || !glow) throw new Error("No orb in the intro");
    const blur = Number.parseFloat(
      /blur\(([\d.]+)px\)/.exec(getComputedStyle(glow).filter)?.[1] ?? "0",
    );
    const bloom = box(glow);
    const painted = [
      box(pattern),
      {
        top: bloom.top - blur,
        right: bloom.right + blur,
        bottom: bloom.bottom + blur,
        left: bloom.left - blur,
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
    for (let at = pattern.parentElement; at; at = at.parentElement) {
      if (at === document.body) break;
      const { overflowX, overflowY, contain } = getComputedStyle(at);
      const paints = /paint|content|strict/.test(contain);
      const edge = box(at);
      if (paints || overflowY !== "visible") {
        visible.top = Math.max(visible.top, edge.top);
        visible.bottom = Math.min(visible.bottom, edge.bottom);
      }
      if (paints || overflowX !== "visible") {
        visible.left = Math.max(visible.left, edge.left);
        visible.right = Math.min(visible.right, edge.right);
      }
    }
    return { painted, visible };
  });
}

const inside = (painted: Box, visible: Box) => ({
  top: painted.top >= visible.top,
  right: painted.right <= visible.right,
  bottom: painted.bottom <= visible.bottom,
  left: painted.left >= visible.left,
});
const whole = { top: true, right: true, bottom: true, left: true };

/** How the orb is drawn: its outline, the disc's ground, and the halo's pattern against the page. */
async function drawn(browser: Browser) {
  return browser.evaluate(() => {
    const wrapper = document.querySelector(".bot-orb-live");
    const disc = wrapper?.querySelector(".agent-orb");
    const pattern = document.querySelector(".orb-pattern");
    if (!wrapper || !disc || !pattern) throw new Error("No orb in the intro");
    // Resolved to rgb by drawing each color on a canvas, so oklch and rgb compare alike.
    const canvas = document.createElement("canvas").getContext("2d");
    const rgb = (color: string) => {
      if (!canvas) throw new Error("No canvas");
      canvas.clearRect(0, 0, 1, 1);
      canvas.fillStyle = color;
      canvas.fillRect(0, 0, 1, 1);
      return [...canvas.getImageData(0, 0, 1, 1).data];
    };
    // Perceived lightness: the cube root of luminance, as OKLab's L is.
    const lightness = (color: string) => {
      const [r, g, b] = rgb(color).map((channel) => {
        const c = channel / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return Math.cbrt(0.2126 * r + 0.7152 * g + 0.0722 * b);
    };
    const page = getComputedStyle(document.documentElement)
      .getPropertyValue("--background")
      .trim();
    const shown = getComputedStyle(pattern);
    // Every shadow on the wrapper, less the transparent ones Tailwind keeps in its stack.
    const outlines = getComputedStyle(wrapper)
      .boxShadow.split(/,(?![^(]*\))/)
      .map((shadow) => shadow.trim())
      .filter((shadow) => {
        const color = /^(\w+\([^)]*\)|#\w+|\w+)/.exec(shadow)?.[1];
        return shadow !== "none" && color !== undefined && rgb(color)[3] > 0;
      });
    return {
      outlines,
      ground: rgb(getComputedStyle(disc).backgroundColor),
      halo:
        Number(shown.opacity) *
        Math.abs(lightness(shown.backgroundColor) - lightness(page)),
    };
  });
}

test("the conversation orb's halo fits the transcript in light and dark themes", async (fixtures) => {
  const { app, browser } = fixtures;
  const bot = await createBot(fixtures);
  const id = await createConversation(browser, bot.id);
  await configureChatStream(browser, []);
  await browser.emulateMedia({ reducedMotion: "reduce" });
  const shades: Awaited<ReturnType<typeof drawn>>[] = [];
  const intro = browser.locator(headingSelector);
  const orb = intro.getByRole("img", bot.name, { exact: true });
  for (const theme of ["light", "dark"] as const) {
    await browser.evaluate((theme) => {
      localStorage.setItem("openbot-theme", theme);
      return null;
    }, theme);
    await browser.setViewport({ width: 650, height: 800 });
    await app.open(`/channel/${id}`);
    await expect(orb).toBeVisible();
    await expect
      .poll(() =>
        browser.evaluate(() =>
          document.documentElement.classList.contains("dark"),
        ),
      )
      .toBe(theme === "dark");
    shades.push(await drawn(browser));
    for (const width of [370, 650, 1100]) {
      await browser.setViewport({ width, height: 800 });
      const fits = await halo(browser);
      expect({ theme, width, ...inside(fits.painted, fits.visible) }).toEqual({
        theme,
        width,
        ...whole,
      });
    }
  }
  const [light, dark] = shades;
  expect(light.outlines).toEqual([]);
  expect(dark.outlines).toEqual([]);
  expect(light.ground[3]).toBe(255);
  expect(dark.ground).toEqual(light.ground);
  expect(light.halo).toBeGreaterThan(0);
  expect(dark.halo).toBeLessThanOrEqual(light.halo * 1.05);
});
