import { type Browser, test } from "@e2e-dev/web";
import { expect, type TestFixtures } from "e2e";

const personal = process.env.OPENBOT_E2E_SUITE === "personal";
const page = personal ? "/settings/computer" : "/admin/computers";
const assistant = "Personal Assistant";
const botId = "personal-assistant";
const browserId = "person-5f0e3c1a9b7d4e2f8a6c0b1d3e5f7a9c";
const personalBrowser = "Your OpenBot browser";
const fleetTitle = personal
  ? "Your Bots' browsers"
  : "Computers in this deployment";
const foldersTitle = "Folders on this computer";
const seat = {
  computer: "person:dev-local-user",
  kind: "person",
  personId: "dev-local-user",
  person: { name: "dev@openbot.local", email: "dev@openbot.local" },
  botId,
  running: true,
  startedAt: "2026-11-07T04:21:42.051Z",
  egress: "network policy filter",
};
const teachBrowser = {
  computer: `bot:${browserId}`,
  kind: "bot",
  botId: browserId,
  running: true,
  startedAt: "2026-11-07T04:15:46.000Z",
  egress: "network policy filter",
};
const basicFleet = { isolation: "shared", computers: [seat] };
const disconnected = {
  connected: false,
  desktop: false,
  grants: [],
  pending: [],
};
const connected = { ...disconnected, desktop: true, connected: true };
const granted = {
  ...connected,
  grants: [
    {
      id: "host-grant-1",
      botId,
      actorId: "dev-local-user",
      displayName: "share",
      revoked: false,
    },
  ],
};
function waiting(kind: string, requestedBot = botId) {
  return {
    operationId: `op-${kind}`,
    kind,
    botId: requestedBot,
    actorId: "dev-local-user",
  };
}
type BrowserSeat = Omit<typeof seat, "startedAt" | "person" | "personId"> & {
  startedAt: string | null;
  personId?: string;
  person?: { name: string; email: string };
};
type HostStatus = {
  connected: boolean;
  desktop: boolean;
  grants: typeof granted.grants;
  pending: ReturnType<typeof waiting>[];
};

async function openComputers(
  {
    app,
    browser,
    screen,
  }: Pick<TestFixtures, "app" | "screen"> & { browser: Browser },
  {
    fleet = basicFleet,
    host = disconnected,
  }: {
    fleet?: { isolation: string; computers: BrowserSeat[] };
    host?: HostStatus;
  } = {},
) {
  const writes: { method: string; path: string; body: unknown }[] = [];
  await browser.route(/\/api\/agents(?:\?[^#]*)?$/, (route) => {
    const hidden =
      new URL(route.request.url).searchParams.get("hidden") === "true";
    return route.fulfill({
      json: {
        agents: hidden
          ? []
          : [
              {
                id: botId,
                name: assistant,
                title: "Bot",
                roleDescription: "Helps",
                avatarSeed: botId,
                visibility: "public",
                hidden: false,
                systemOwned: true,
                canManage: true,
                mine: false,
              },
            ],
      },
    });
  });
  await browser.route(/\/api\/computers\/fleet$/, (route) => {
    if (route.request.method === "GET") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(fleet),
      });
    }
    const body: { computer: string; botId: string; action: string } =
      JSON.parse(route.request.postData ?? "null");
    writes.push({
      method: route.request.method,
      path: "/api/computers/fleet",
      body,
    });
    fleet = {
      ...fleet,
      computers: fleet.computers.map((row) =>
        row.computer === body.computer && row.botId === body.botId
          ? { ...row, running: false, startedAt: null }
          : row,
      ),
    };
    return route.fulfill({ json: { ok: true } });
  });
  await browser.route(/\/api\/host-access$/, (route) =>
    route.fulfill({ json: host }),
  );
  await browser.route(/\/api\/host-access\/grants$/, (route) => {
    const body: { botId: string } = JSON.parse(
      route.request.postData ?? "null",
    );
    writes.push({
      method: route.request.method,
      path: "/api/host-access/grants",
      body,
    });
    host = { ...host, pending: [waiting("choose_folder", body.botId)] };
    return route.fulfill({ json: { ok: true } });
  });
  await app.open(page);
  const heading = (title: string) =>
    screen.getByRole("heading", title, { exact: true });
  const section = (title: string) =>
    browser.locator("main section").filter({ has: heading(title) });
  const fleetSection = section(fleetTitle);
  const folders = section(foldersTitle);
  const row = (name: string) =>
    browser.locator("main section [data-slot='item']").filter({
      has: screen.getByText(name, { exact: true }),
    });
  await expect(heading(personal ? "Computer" : "Computers")).toBeVisible();
  return { folders, fleetSection, row, writes };
}

if (personal) {
  test("personal Computer keeps each Bot's browser actions and omits deployment details", async (fixtures) => {
    const { browser, screen } = fixtures;
    const { folders, fleetSection, row, writes } =
      await openComputers(fixtures);
    const bot = row(assistant);
    const stop = bot.getByRole("button", "Stop browser", { exact: true });
    await expect(stop).toBeEnabled();
    await expect(
      bot.getByRole("button", "Reset", { exact: true }),
    ).toBeEnabled();
    await expect(
      folders.getByText("Needs OpenBot Desktop", { exact: true }),
    ).toBeVisible();
    for (const text of [
      "COMPUTER_SUPERVISOR_URL",
      "Computers in this deployment",
      "isolated Bot",
      "dev@openbot.local",
      "This person's profile",
      "network policy filter",
    ]) {
      await expect(
        browser.locator("main").getByText(text, { exact: false }),
      ).toHaveCount(0);
    }
    await expect(fleetSection).toBeVisible();
    await expect(
      screen.getByRole("heading", "Computer", { exact: true }),
    ).toBeVisible();

    await stop.click();
    await expect(bot).toContainText(
      "No browser running. It starts when the Bot next needs it.",
    );
    await expect(stop).toBeDisabled();
    expect(writes).toEqual([
      {
        method: "POST",
        path: "/api/computers/fleet",
        body: { action: "stop", computer: seat.computer, botId },
      },
    ]);
    await browser.reload();
    await expect(stop).toBeDisabled();
  });

  test("personal Computer offers Clear browser data for the Teach a Bot browser", async (fixtures) => {
    const { browser } = fixtures;
    const { fleetSection, row, writes } = await openComputers(fixtures, {
      fleet: { ...basicFleet, computers: [seat, teachBrowser] },
    });
    const own = row(personalBrowser);
    await expect(own).toContainText("You record in it with Teach a Bot.");
    await expect(
      own.getByRole("button", "Stop browser", { exact: true }),
    ).toBeEnabled();
    await expect(
      own.getByRole("button", "Clear browser data", { exact: true }),
    ).toBeEnabled();
    await expect(own.getByRole("button", "Reset", { exact: true })).toHaveCount(
      0,
    );
    await expect(
      row(assistant).getByRole("button", "Reset", { exact: true }),
    ).toBeEnabled();
    await expect(browser.locator("main")).toContainText(
      "Clear browser data does the same for your OpenBot browser.",
    );
    await expect(fleetSection).not.toContainText("A Bot no longer here");
    await expect(browser.locator("main")).not.toContainText(
      "closes a Bot's browser",
    );
    expect(writes).toEqual([]);
  });

  test("a stopped personal Teach a Bot browser says it opens when recording starts", async (fixtures) => {
    const { row } = await openComputers(fixtures, {
      fleet: {
        ...basicFleet,
        computers: [{ ...teachBrowser, running: false, startedAt: null }],
      },
    });
    const own = row(personalBrowser);
    await expect(own).toContainText(
      "No browser running. It opens when you record with Teach a Bot.",
    );
    await expect(own).not.toContainText("when the Bot next needs it");
    await expect(
      own.getByRole("button", "Stop browser", { exact: true }),
    ).toBeDisabled();
  });

  test("personal Computer offers the Desktop folder chooser and shows the pending request", async (fixtures) => {
    const { folders, writes } = await openComputers(fixtures, {
      host: connected,
    });
    await expect(folders.getByText(assistant, { exact: true })).toBeVisible();
    await expect(folders.getByText(/^Folders are read-only\./)).toBeVisible();
    const choose = folders.getByRole("button", "Choose folder", {
      exact: true,
    });
    await expect(choose).toBeEnabled();
    expect(writes).toEqual([]);
    await choose.click();
    await expect(
      folders.getByText("1 pending request", { exact: true }),
    ).toBeVisible();
    await expect(
      folders.getByText(
        "Folder access is waiting for you. OpenBot Desktop is asking you in a window.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(folders).not.toContainText("desktop owner");
    expect(writes).toEqual([
      {
        method: "POST",
        path: "/api/host-access/grants",
        body: { botId },
      },
    ]);
  });

  test("ordinary browser explains that folder access needs OpenBot Desktop", async (fixtures) => {
    const { folders, writes } = await openComputers(fixtures);
    await expect(
      folders.getByText("Needs OpenBot Desktop", { exact: true }),
    ).toBeVisible();
    await expect(
      folders.getByRole("button", "Choose folder", { exact: true }),
    ).toHaveCount(0);
    await expect(
      folders.getByRole("button", "Stop folder access", { exact: true }),
    ).toHaveCount(0);
    await expect(folders).not.toContainText("The desktop app is offline");
    expect(writes).toEqual([]);
  });

  test("personal folder grants are read-only and explain which requests need action", async (fixtures) => {
    const { folders, writes } = await openComputers(fixtures, {
      host: {
        ...granted,
        pending: ["write_file", "run_command", "list_files", "read_file"].map(
          (kind) => waiting(kind),
        ),
      },
    });
    for (const text of [
      "share",
      "Read-only",
      "A file change is waiting for you. OpenBot Desktop is asking you in a window.",
      "A command is waiting for you or still running. OpenBot Desktop asks you in a window.",
      "Listing files.",
      "Reading a file.",
    ]) {
      await expect(folders.getByText(text, { exact: true })).toBeVisible();
    }
    await expect(folders).not.toContainText("desktop owner");
    expect(writes).toEqual([]);
  });

  test("a stop folder request addressed to every Bot does not add a Bot row", async (fixtures) => {
    const { folders } = await openComputers(fixtures, {
      host: { ...granted, pending: [waiting("stop", "*")] },
    });
    await expect(folders.getByText("share", { exact: true })).toBeVisible();
    await expect(folders).not.toContainText("A Bot no longer here");
    await expect(folders).not.toContainText("1 pending request");
    await expect(
      folders.getByRole("button", "Choose folder", { exact: true }),
    ).toHaveCount(1);
  });
} else {
  test("team Computers identifies owners and asks before resetting a Teach a Bot browser", async (fixtures) => {
    const { screen } = fixtures;
    const { fleetSection, row, writes } = await openComputers(fixtures, {
      fleet: {
        isolation: "per-person",
        computers: [
          { ...teachBrowser, person: { name: "Ada", email: "ada@acme.test" } },
          {
            ...teachBrowser,
            computer: "bot:person-00000000000000000000000000000000",
            botId: "person-00000000000000000000000000000000",
          },
        ],
      },
    });
    const ada = row("Ada's OpenBot browser");
    await expect(ada).toContainText("Their own browser for Teach a Bot");
    await expect(ada).not.toContainText("Isolated");
    await expect(
      fleetSection.getByText("A person's OpenBot browser", { exact: true }),
    ).toBeVisible();
    await expect(fleetSection).not.toContainText("A Bot no longer here");

    const reset = ada.getByRole("button", "Reset", { exact: true });
    await reset.click();
    const dialog = screen.getByRole("dialog", "Reset Ada's OpenBot browser?", {
      exact: true,
    });
    await expect(dialog).toContainText(
      "The person is signed out of every site they signed in to in it.",
    );
    await expect(dialog).not.toContainText("The Bot is signed out");
    expect(writes).toEqual([]);
    await dialog.getByRole("button", "Cancel", { exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(writes).toEqual([]);

    await reset.click();
    await dialog.getByRole("button", "Reset it", { exact: true }).click();
    await expect(ada).toContainText("No browser running");
    expect(writes).toEqual([
      {
        method: "POST",
        path: "/api/computers/fleet",
        body: {
          action: "reset",
          computer: teachBrowser.computer,
          botId: browserId,
        },
      },
    ]);
  });

  test("team Computers explains per-person setup, the shared seat and network egress", async (fixtures) => {
    const { screen } = fixtures;
    const { fleetSection, row } = await openComputers(fixtures);
    await expect(
      screen.getByText("COMPUTER_SUPERVISOR_URL", { exact: true }),
    ).toBeVisible();
    await expect(fleetSection).toBeVisible();
    await expect(row("dev@openbot.local · Personal Assistant")).toContainText(
      "Leaves through network policy filter",
    );
  });

  test("team folder requests distinguish actions needing the Desktop owner from reads", async (fixtures) => {
    const { folders } = await openComputers(fixtures, {
      host: {
        ...granted,
        pending: ["choose_folder", "write_file", "list_files"].map((kind) =>
          waiting(kind),
        ),
      },
    });
    for (const text of [
      "Folder access waiting for approval from the desktop owner.",
      "File change waiting for approval from the desktop owner, or to finish.",
      "Listing files.",
      "Approved by the desktop owner · Read-only",
    ]) {
      await expect(folders.getByText(text, { exact: true })).toBeVisible();
    }
    await expect(folders).not.toContainText("Listing files from");
    await expect(folders).not.toContainText("OpenBot Desktop is asking you");
  });
}
