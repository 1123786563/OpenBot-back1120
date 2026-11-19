import { expect, test } from "bun:test";
import { appAccessSentence } from "@/components/plugins/app-access-action";
import type { AppAccess } from "@/lib/app-access/queries";
import { appAccess } from "./app-access-fixture";

const COPY: [string, Partial<AppAccess>, RegExp][] = [
  ["ready", {}, /^Ready to use\.$/],
  [
    "ready, on the owner's account",
    { accountHolder: "owner" },
    /^Ready to use\. This Bot uses its owner's Gmail account\.$/,
  ],
  [
    "ready, asking first",
    { asksFirst: true },
    /^Ready to use with your own Gmail account\. You'll be asked to allow it the first time\.$/,
  ],
  [
    "not_connected",
    { state: "not_connected" },
    /You haven't connected your Gmail account yet\./,
  ],
  [
    "reconnect",
    { state: "reconnect" },
    /^Your Gmail connection needs reconnecting\.$/,
  ],
  [
    "reconnect, on the owner's account",
    { state: "reconnect", accountHolder: "owner" },
    /^This Bot uses its owner's Gmail account, which needs reconnecting\. Only the Bot's owner can reconnect it\.$/,
  ],
  [
    "shared_not_connected",
    { state: "shared_not_connected" },
    /Your organisation's Gmail account isn't connected yet\. Only an admin can connect it\./,
  ],
  [
    "shared_not_approved",
    { state: "shared_not_approved" },
    /^This Bot reaches more people than an admin approved for your organisation's Gmail account\. Only an admin can approve it\.$/,
  ],
  [
    "disabled, never switched on",
    { state: "disabled", unavailable: "absent" },
    /^Gmail isn't turned on yet\. Only an admin can turn it on\.$/,
  ],
  [
    "disabled, with no reason given",
    { state: "disabled", unavailable: null },
    /^Gmail isn't turned on yet\./,
  ],
  [
    "disabled, with no Composio key",
    { state: "disabled", unavailable: "composio_unconfigured" },
    /^Gmail isn't set up yet\. An admin has to turn it on\.$/,
  ],
  ...(
    ["scheme_unreadable", "oauth_client_missing", "token_missing"] as const
  ).map((unavailable): [string, Partial<AppAccess>, RegExp] => [
    `disabled, ${unavailable}`,
    { state: "disabled", unavailable },
    /^Gmail isn't fully set up yet\. Only an admin can finish setting it up\.$/,
  ]),
  [
    "not_granted",
    { state: "not_granted" },
    /This Bot hasn't been given Gmail\. Only an admin can give it\./,
  ],
];

test.each(COPY)("says whose move it is: %s", (_, overrides, sentence) => {
  expect(appAccessSentence(appAccess(overrides))).toMatch(sentence);
});

test("no sentence about a switched-off app says an admin turned it off", () => {
  for (const [, overrides] of COPY.filter(([, o]) => o.state === "disabled"))
    expect(appAccessSentence(appAccess(overrides))).not.toMatch(/Turned off/);
});

test("in the personal edition, an app that isn't set up says what is missing, not who to ask", () => {
  expect(
    appAccessSentence(
      appAccess({ state: "disabled", unavailable: "composio_unconfigured" }),
      undefined,
      "personal",
    ),
  ).toBe("Gmail isn't set up yet. Set it up to connect it.");
  expect(
    appAccessSentence(
      appAccess({ state: "disabled", unavailable: "token_missing" }),
      undefined,
      "personal",
    ),
  ).toBe("Gmail isn't fully set up yet. Set it up to finish.");
});

test("in the personal edition, the card says what is missing rather than who to ask", () => {
  for (const state of ["disabled", "not_granted"] as const) {
    const sentence = appAccessSentence(
      appAccess({ state, unavailable: state === "disabled" ? "absent" : null }),
      undefined,
      "personal",
    );
    expect(sentence).toBe("Gmail isn't connected yet.");
  }
});

test("an owner is asked about their own app, by the Bot's name where the caller has it", () => {
  const owners = appAccess({ state: "owner_grantable", granted: false });
  expect(appAccessSentence(owners)).toBe("Let this Bot use your Gmail?");
  expect(appAccessSentence(owners, "Research Bot")).toBe(
    "Let Research Bot use your Gmail?",
  );
  expect(
    appAccessSentence({ ...owners, needsConnect: true }, "Research Bot"),
  ).toBe("Let Research Bot use your Gmail? Connect it first.");
  // An app on nobody's own account is not "your" anything.
  expect(
    appAccessSentence(
      { ...owners, displayName: "Routines", account: "deployment" },
      "Research Bot",
    ),
  ).toBe("Let Research Bot use Routines?");
});
