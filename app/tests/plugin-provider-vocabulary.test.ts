import { expect, test } from "bun:test";
import { managePaths } from "@/lib/manage-paths";
import {
  brokeredDisconnectNote,
  brokeredKeyMissing,
  brokeredReach,
  directoryDescriptions,
  disconnectSiblingsNotice,
  moreAppsRow,
} from "@/lib/plugins/provider-vocabulary";

test("a brokered app's sentences name no deployment in personal, and keep it in Admin", () => {
  const personal = managePaths("personal").edition;
  expect(
    brokeredReach("composio", { title: "Gmail", kind: "consent" }).description,
  ).not.toContain("deployment");
  expect(brokeredKeyMissing("composio", personal)).not.toContain("deployment");
  expect(brokeredReach("composio").description).toContain(
    "This deployment holds one key",
  );
  expect(brokeredKeyMissing("composio")).toContain("on this deployment.");
});

test("directory copy reflects the selected edition for both brokers", () => {
  for (const provider of ["composio", "arcade"] as const) {
    const personal = JSON.stringify([
      moreAppsRow(provider, true, "personal"),
      moreAppsRow(provider, false, "personal"),
      directoryDescriptions("personal"),
    ]);
    expect(personal).not.toMatch(
      /each person|deployment|admin|token to paste|whoever|that person|everybody/i,
    );
    expect(personal).not.toMatch(/composio|arcade|nobody here/i);
  }
  expect(moreAppsRow("composio", true, "personal").description).toBe(
    "A few hundred more apps you can connect.",
  );
  expect(moreAppsRow("composio", true).description).toBe(
    "A few hundred apps. Each person connects their own account.",
  );
  expect(directoryDescriptions()).toEqual({
    page: "Add an app to make its tools available to Bots. Each person still connects their own account before a Bot reads anything.",
    search: "Search by name. Nobody here has reviewed these apps.",
  });
});

test("apps that could not be asked about are a count and never names", () => {
  expect(disconnectSiblingsNotice({ siblings: [], unanswered: 0 })).toBeNull();
  expect(disconnectSiblingsNotice({ siblings: ["slack"], unanswered: 2 })).toBe(
    "Disconnecting also ends your access to slack, which shares this connection. 2 other apps couldn't be checked and may be affected too.",
  );
  expect(disconnectSiblingsNotice({ siblings: [], unanswered: 1 })).toBe(
    "1 app on this connection couldn't be checked, so disconnecting may end it too.",
  );
});

test("no screen names the broker, and only an admin is told the variable to set", () => {
  for (const provider of ["arcade", "composio"] as const) {
    expect(brokeredDisconnectNote(provider)).toBe(
      "Disconnecting also removes OpenBot's access to your account.",
    );
    expect(brokeredKeyMissing(provider, "team", "person")).toBe(
      "Connecting apps isn't set up yet, so this account can't be connected or disconnected here. Ask an admin to set it up.",
    );
  }
  expect(brokeredKeyMissing("arcade")).toBe(
    "Set ARCADE_API_KEY on this deployment. Until then, this account can't be connected or disconnected here. The app stays turned on, and its tool grants still stand.",
  );
  expect(brokeredKeyMissing("composio")).toBe(
    "Set COMPOSIO_API_KEY on this deployment. Until then, this account can't be connected or disconnected here. The app stays turned on, and its tool grants still stand.",
  );
});
