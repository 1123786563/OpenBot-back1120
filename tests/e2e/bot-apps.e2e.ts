import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { workspace } from "./signed-in";

const gmail = {
  key: "composio-gmail",
  displayName: "Gmail",
  logo: null,
  account: "personal",
};
const routines = {
  key: "routines",
  displayName: "Routines",
  logo: null,
  account: "deployment",
};
const enabled = [
  { id: gmail.key, title: gmail.displayName, logo: null },
  { id: "parallel-search", title: "Parallel Search", logo: null },
  { id: routines.key, title: routines.displayName, logo: null },
];

async function offerApps(browser: Browser, apps: (typeof routines)[]) {
  await browser.route(/\/api\/plugins\/giveable$/, async (route) => {
    await route.fulfill({ json: { apps } });
  });
}

test(
  "only Apps left checked are granted to a new Bot",
  workspace,
  async ({ app, browser, screen }) => {
    const name = `E2E App Grants ${crypto.randomUUID().slice(0, 8)}`;
    const granted: string[] = [];
    await offerApps(browser, [gmail, routines]);
    await browser.route(
      /\/api\/plugins\/for\/[^/]+\/apps\/[^/]+\/give$/,
      async (route) => {
        expect(route.request.method).toBe("POST");
        granted.push(new URL(route.request.url).pathname);
        await route.fulfill({ json: { granted: [] } });
      },
    );

    await app.open("/bots");
    await screen.getByRole("button", "New Bot", { exact: true }).first().tap();
    const dialog = screen.getByRole("dialog", "New Bot");
    await dialog.getByLabel("Name", { exact: true }).fill(name);
    const personalApp = dialog.getByRole("checkbox", "Gmail");
    const deploymentApp = dialog.getByRole("checkbox", "Routines");
    await expect(personalApp).toBeChecked();
    await expect(deploymentApp).toBeChecked();
    await deploymentApp.tap();
    await expect(deploymentApp).not.toBeChecked();
    await dialog.getByRole("button", "Create Bot", { exact: true }).tap();
    await expect(browser).toHaveURL(/\/bots\/[^/?#]+\/?$/);
    await expect(
      screen.getByRole("heading", name, { exact: true }),
    ).toBeVisible();
    const id = new URL(await browser.url()).pathname
      .split("/")
      .filter(Boolean)
      .at(-1);
    expect(granted).toEqual([
      `/api/plugins/for/${id}/apps/composio-gmail/give`,
    ]);
  },
);

test(
  "the team wizard offers only the Apps the person can grant",
  workspace,
  async ({ app, browser, screen }) => {
    await offerApps(browser, [routines]);
    let enabledListRequests = 0;
    await browser.route(/\/api\/plugins$/, async (route) => {
      enabledListRequests += 1;
      await route.fulfill({
        json: { catalogue: [], servers: enabled, skills: [] },
      });
    });
    await app.open("/bots");
    await expect(
      screen.getByRole("heading", "Bots", { exact: true }),
    ).toBeVisible();
    const baselineRequests = enabledListRequests;
    await screen.getByRole("button", "New Bot", { exact: true }).first().tap();
    const dialog = screen.getByRole("dialog", "New Bot");
    await expect(dialog.getByRole("checkbox", "Routines")).toBeChecked();
    await expect(dialog.getByText("Gmail", { exact: true })).toBeHidden();
    await expect(
      dialog.getByText("Parallel Search", { exact: true }),
    ).toBeHidden();
    await expect(
      dialog.getByText("It always uses the account of whoever is asking."),
    ).toBeVisible();
    expect(enabledListRequests).toBe(baselineRequests);
  },
);

test(
  "the team wizard does not ask for Apps when there are no grants to give",
  workspace,
  async ({ app, browser, screen }) => {
    await offerApps(browser, []);
    await app.open("/bots");
    const [response] = await Promise.all([
      browser.waitForResponse(/\/api\/plugins\/giveable$/),
      screen.getByRole("button", "New Bot", { exact: true }).first().tap(),
    ]);
    expect(response.status).toBe(200);
    const dialog = screen.getByRole("dialog", "New Bot");
    await expect(dialog.getByLabel("Name", { exact: true })).toBeVisible();
    await expect(
      dialog.getByText("Apps it can use", { exact: true }),
    ).toBeHidden();
  },
);

test(
  "personal Bot creation lists enabled Apps and keeps the Bot private",
  workspace,
  async ({ app, browser, screen }) => {
    await browser.route(/\/api\/capabilities$/, async (route) => {
      await route.fulfill({ json: { edition: "personal" } });
    });
    await offerApps(browser, [routines]);
    await browser.route(/\/api\/plugins$/, async (route) => {
      await route.fulfill({
        json: { catalogue: [], servers: enabled, skills: [] },
      });
    });
    let created: unknown;
    await browser.route(/\/api\/agents$/, async (route) => {
      if (route.request.method === "POST") {
        created = JSON.parse(route.request.postData ?? "null");
      }
      await route.continue();
    });

    await app.open("/bots");
    await screen.getByRole("button", "New Bot", { exact: true }).first().tap();
    const dialog = screen.getByRole("dialog", "New Bot");
    const list = dialog.getByRole("list", "Apps it can use");
    await expect(list.getByRole("listitem")).toHaveCount(3);
    for (const displayName of ["Gmail", "Parallel Search", "Routines"]) {
      await expect(list.getByText(displayName, { exact: true })).toBeVisible();
    }
    await expect(list.getByText(/every weekday at 9, send me/)).toBeVisible();
    await expect(list.getByRole("link", "Open Routines")).toHaveAttribute(
      "href",
      "/routines",
    );
    await expect(
      dialog.getByText(
        "Every Bot can use every app you turn on in Connections.",
      ),
    ).toBeVisible();
    await expect(dialog.getByText("Who can see it")).toBeHidden();
    await expect(dialog.getByRole("checkbox")).toHaveCount(0);
    await expect(
      dialog.getByRole(
        "link",
        "Give each Bot its own computer with OpenBot for Business.",
      ),
    ).toHaveAttribute("href", "https://open.bot/business");
    const name = `E2E Personal Bot ${crypto.randomUUID().slice(0, 8)}`;
    const input = dialog.getByLabel("Name", { exact: true });
    await input.fill(name);
    await input.press("Enter");
    await expect(
      screen.getByText(`${name} is ready`, { exact: true }),
    ).toBeVisible();
    expect(created).toMatchObject({
      name,
      visibility: "private",
      isolated: false,
    });
  },
);
