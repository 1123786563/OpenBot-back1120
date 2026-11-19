import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";

const page = "/settings/this-computer";
const prefix = "plugin:openbot-desktop";
const current = "0.3.2";
const newer = "0.3.3";
const logFolder =
  "C:\\Users\\Administrator\\AppData\\Local\\ai.copilotkit.openbot.desktop\\logs";
const updateWarning =
  "This version of OpenBot doesn't update itself. Install a released version of OpenBot to get updates.";
const updateError =
  "OpenBot couldn't check for updates. Check your internet connection and try again.";

type Options = {
  result?: "upToDate" | "available" | "notOffered" | "error";
  updatesItself?: boolean;
  background?: boolean;
  services?: boolean;
  logs?: "available" | "missing" | "error";
  diagnostics?: "running" | "stopped";
};

type ComputerFixture = {
  calls: { command: string; args: Record<string, boolean> | null }[];
  opened: string[];
  ready: boolean;
  copied: string[];
};

const stackId = "local-e0cf90debea88453ad454b93";
const diagnosticBuild = "Built 2026-11-09 18:30 UTC from 795f619 on main";

async function emulateComputer(browser: Browser, options: Options = {}) {
  await browser.addInitScript(
    ({
      prefix,
      options,
      current,
      newer,
      logFolder,
      updateError,
      stackId,
      diagnosticBuild,
    }) => {
      const fixture: ComputerFixture = {
        calls: [],
        opened: [],
        ready: false,
        copied: [],
      };
      const stopped = options.diagnostics === "stopped";
      const status = {
        openbotRunning: !stopped,
        openbotHeld: !stopped,
        processes: [],
        containers:
          options.diagnostics === "running"
            ? [{ name: "openbot-desktop-server-1", memoryBytes: 412_000_000 }]
            : [],
        intelligenceStack: options.diagnostics
          ? stackId
          : options.services
            ? "local-abc"
            : null,
        intelligenceContainers: options.services
          ? [{ name: "k3d-local-abc-server-0", memoryBytes: 1_200_000_000 }]
          : options.diagnostics === "running"
            ? [{ name: `k3d-${stackId}-server-0`, memoryBytes: 2_380_000_000 }]
            : [],
        engine: stopped ? null : options.diagnostics ? "podman" : "docker",
        root: "C:\\Users\\Administrator\\OpenBot",
        appPort: stopped ? null : 3010,
        version: current,
        build: options.diagnostics ? diagnosticBuild : `v${current} (b214c97e)`,
        ...(options.logs === "missing" ? {} : { logFolder }),
      };
      let installing = false;
      if (options.diagnostics) {
        Object.defineProperty(navigator.clipboard, "writeText", {
          async value(text: string) {
            fixture.copied.push(text);
          },
        });
      }
      Object.assign(window, {
        thisComputerFixture: fixture,
        __TAURI_INTERNALS__: {
          transformCallback: () => 0,
          async invoke(command: string, args?: Record<string, boolean>) {
            fixture.calls.push({ command, args: args ?? null });
            switch (command) {
              case `${prefix}|status`:
                return status;
              case `${prefix}|intelligence`:
                return options.diagnostics
                  ? {
                      outcome: "completed",
                      readiness: stopped ? "stopped" : "ready",
                    }
                  : null;
              case `${prefix}|update_offer`:
                return {
                  version: options.background ? newer : null,
                  current,
                  installing: installing
                    ? { downloaded: 50, total: 200, restarting: false }
                    : null,
                  ...(options.updatesItself === undefined
                    ? {}
                    : { updatesItself: options.updatesItself }),
                  ...(options.background
                    ? {
                        ready: fixture.ready
                          ? { state: "ready" }
                          : { state: "preparing", done: 300, total: 1000 },
                      }
                    : {}),
                };
              case `${prefix}|check_update`:
                if (options.result === "error") throw updateError;
                if (options.result === "available")
                  return { found: "available", version: newer, current };
                if (options.result === "notOffered")
                  return {
                    found: "notOffered",
                    current: `${current}-internal.731.gabc1234`,
                  };
                return { found: "upToDate", current };
              case `${prefix}|install_update`:
                installing = true;
                return new Promise(() => {});
              case `${prefix}|open_logs`:
                if (options.logs === "error") throw "no file manager answered";
                fixture.opened.push(logFolder);
                return null;
              default:
                return null;
            }
          },
        },
      });
    },
    {
      prefix,
      options,
      current,
      newer,
      logFolder,
      updateError,
      stackId,
      diagnosticBuild,
    },
  );
  return () =>
    browser.evaluate(() => {
      const fixture = (
        window as Window & { thisComputerFixture?: ComputerFixture }
      ).thisComputerFixture;
      if (!fixture) throw new Error("This Computer fixture was not installed");
      return fixture;
    });
}

for (const scenario of [
  {
    result: "upToDate",
    updatesItself: true,
    text: "OpenBot 0.3.2 is up to date.",
  },
  { result: "notOffered", text: updateWarning },
  { result: "error", updatesItself: true, text: updateError },
] as const) {
  test(`This computer reports an update check result of ${scenario.result}`, async ({
    app,
    browser,
    screen,
  }) => {
    const read = await emulateComputer(browser, scenario);
    await app.open(page);
    const check = screen.getByRole("button", "Check for updates", {
      exact: true,
    });
    const version = browser.locator('[data-slot="item"]').filter({
      has: screen.getByText(`Version ${current}`, { exact: true }),
    });
    await expect(check).toBeVisible();
    await expect(version).not.toContainText(updateWarning);
    await check.click();
    await expect(
      version.getByRole(scenario.result === "error" ? "alert" : "status"),
    ).toHaveText(scenario.text);
    await expect(check).toBeEnabled();
    expect(
      (await read()).calls.filter(
        ({ command }) => command === `${prefix}|check_update`,
      ),
    ).toEqual([{ command: `${prefix}|check_update`, args: null }]);
  });
}

test("a build without automatic updates shows the installed version and offers no update action", async ({
  app,
  browser,
  screen,
}) => {
  const read = await emulateComputer(browser, { updatesItself: false });
  await app.open(page);
  await expect(screen.getByText(updateWarning, { exact: true })).toBeVisible();
  await expect(
    screen.getByText(`Version ${current}`, { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByRole("button", "Check for updates", { exact: true }),
  ).toHaveCount(0);
  await expect(
    screen.getByRole("button", "Update and restart", { exact: true }),
  ).toHaveCount(0);
  expect(
    (await read()).calls.filter(
      ({ command }) => command === `${prefix}|check_update`,
    ),
  ).toEqual([]);
});

for (const background of [false, true]) {
  test(`the version row polls ${background ? "background readiness" : "installation progress"}`, async ({
    app,
    browser,
    screen,
  }) => {
    const read = await emulateComputer(browser, {
      updatesItself: true,
      result: "available",
      background,
    });
    await app.open(page);
    await screen
      .getByRole("button", "Check for updates", { exact: true })
      .click();
    const version = browser.locator('[data-slot="item"]').filter({
      has: screen.getByText(`Version ${current}`, { exact: true }),
    });
    const status = version.getByRole("status");
    const install = version.getByRole("button", "Update and restart", {
      exact: true,
    });
    if (background) {
      await expect(status).toHaveText(
        `OpenBot ${newer} is downloading in the background (30%).`,
      );
      await expect(install).toBeEnabled();
      const before = (await read()).calls.filter(
        ({ command }) => command === `${prefix}|update_offer`,
      ).length;
      await browser.evaluate(() => {
        const state = (
          window as Window & { thisComputerFixture?: ComputerFixture }
        ).thisComputerFixture;
        if (!state) throw new Error("This Computer fixture was not installed");
        state.ready = true;
        return null;
      });
      await expect(status).toHaveText(
        `OpenBot ${newer} is ready to install. It takes a few minutes.`,
      );
      expect(
        (await read()).calls.filter(
          ({ command }) => command === `${prefix}|update_offer`,
        ).length,
      ).toBeGreaterThan(before);
    } else {
      await expect(status).toHaveText(`OpenBot ${newer} is available.`);
      await install.click();
      await expect(
        version.getByRole("button", "Downloading… 25%", { exact: true }),
      ).toBeDisabled();
      expect(
        (await read()).calls.filter(
          ({ command }) => command === `${prefix}|install_update`,
        ),
      ).toEqual([{ command: `${prefix}|install_update`, args: null }]);
    }
  });
}

for (const logs of ["available", "missing", "error"] as const) {
  test(`the Desktop log folder handles ${logs} access`, async ({
    app,
    browser,
    screen,
  }) => {
    const read = await emulateComputer(browser, { logs });
    await app.open(page);
    await expect(
      screen.getByText("Installed in", { exact: true }),
    ).toBeVisible();
    const open = screen.getByRole("button", "Open log folder", { exact: true });
    if (logs === "missing") {
      await expect(open).toHaveCount(0);
      await expect(screen.getByText("Logs", { exact: true })).toHaveCount(0);
      return;
    }
    await expect(screen.getByText(logFolder, { exact: true })).toBeVisible();
    await expect(
      screen.getByText(
        "Logs stay on this computer and leave out your keys and messages. Share them when you ask for help.",
        { exact: true },
      ),
    ).toBeVisible();
    await open.click();
    if (logs === "error") {
      const error = screen.getByRole("alert").filter({
        hasText: "Couldn't open the log folder. Find it at the path above.",
      });
      await expect(error).toBeVisible();
      await expect(screen.getByText(logFolder, { exact: true })).toBeVisible();
      expect((await read()).opened).toEqual([]);
    } else {
      await expect.poll(async () => (await read()).opened).toEqual([logFolder]);
      await expect(
        screen
          .getByRole("alert")
          .filter({ hasText: "Couldn't open the log folder" }),
      ).toHaveCount(0);
    }
    expect(
      (await read()).calls.filter(
        ({ command }) => command === `${prefix}|open_logs`,
      ),
    ).toEqual([{ command: `${prefix}|open_logs`, args: null }]);
  });
}

test("OpenBot's local services describe the data they keep", async ({
  app,
  browser,
  screen,
}) => {
  await emulateComputer(browser, { services: true });
  await app.open(page);
  const services = browser.locator("section").filter({
    has: screen.getByRole("heading", "OpenBot's services", { exact: true }),
  });
  await expect(
    services.getByText(
      "These keep your Bots' conversations and skills. OpenBot needs them while it runs.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    services.getByText("Conversations and learning", { exact: true }),
  ).toBeVisible();
  await expect(services).not.toContainText(/conversations, memory/i);
});

for (const diagnostics of ["running", "stopped"] as const) {
  test(`This computer keeps technical details in Copy diagnostics when services are ${diagnostics}`, async ({
    app,
    browser,
    screen,
  }) => {
    const running = diagnostics === "running";
    const read = await emulateComputer(browser, { diagnostics });
    await app.open(page);
    const sections = ["App", "OpenBot's services", "Details"];
    const services = browser.locator("section").filter({
      has: screen.getByRole("heading", sections[1], { exact: true }),
    });
    await expect(
      screen.getByText("Installed in", { exact: true }),
    ).toBeVisible();
    await expect(
      screen.getByText("Software OpenBot runs on", { exact: true }),
    ).toBeVisible();
    await expect(
      screen.getByText(`Version ${current}`, { exact: true }),
    ).toBeVisible();
    await expect(services).toContainText(
      running ? /Ready.*in use/s : /Not using memory/,
    );
    const publicCopy = await browser.evaluate(
      (titles) =>
        [...document.querySelectorAll("section")]
          .filter((section) =>
            titles.includes(section.querySelector("h2")?.textContent ?? ""),
          )
          .flatMap((section) => [
            section.textContent ?? "",
            ...[...section.querySelectorAll("[aria-label]")].map(
              (node) => node.getAttribute("aria-label") ?? "",
            ),
          ]),
      sections,
    );
    expect(publicCopy.join(" ")).not.toMatch(
      /Podman|\bDocker\b(?! Desktop)|\bengines?\b|back[ -]?end|front[ -]?end|\bcontainers?\b|\bk3[sd]\b|Intelligence|\bCLI\b|\bCompose\b|\bstack\b|\bports?\b|\bUTC\b|\bBuilt\b|\b[0-9a-f]{7,40}\b|openbot-desktop-|local-[0-9a-f]|—/i,
    );

    await screen
      .getByRole("button", "Copy diagnostics", { exact: true })
      .click();
    await expect(
      screen.getByRole("button", "Copied", { exact: true }),
    ).toBeVisible();
    const { copied } = await read();
    expect(copied).toHaveLength(1);
    expect(copied[0]).toContain(diagnosticBuild);
    expect(copied[0]).toContain(
      `Container engine: ${running ? "podman" : "not answering"}`,
    );
    expect(copied[0]).toContain(stackId);
  });
}
