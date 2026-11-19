import { expect, test } from "bun:test";
import {
  DEFAULT_USER_PREFERENCES,
  type UserPreferences,
} from "@openbot/shared/user-preferences";
import { QueryClient } from "@tanstack/react-query";
import {
  saveUserPreferencesMutationOptions,
  userPreferencesQueryOptions,
} from "@/lib/settings/message-list";

test("a preference write updates only the current account and a failure preserves its saved values", async () => {
  const client = new QueryClient();
  const currentKey = userPreferencesQueryOptions("alice").queryKey;
  const otherKey = userPreferencesQueryOptions("bob").queryKey;
  const current = {
    ...DEFAULT_USER_PREFERENCES,
    messageListEmphasis: "agent",
  } as const;
  const other = { ...current, skin: "opendots" } as const;
  const saved = { ...current, messageListEmphasis: "thread" } as const;
  client.setQueryData(currentKey, current);
  client.setQueryData(otherKey, other);

  const mutation = client
    .getMutationCache()
    .build(client, saveUserPreferencesMutationOptions(client, "alice"));
  const originalFetch = globalThis.fetch;
  let response = Response.json({ preferences: saved });
  globalThis.fetch = Object.assign(async () => response, {
    preconnect: originalFetch.preconnect,
  });

  try {
    await mutation.execute({ messageListEmphasis: "thread" });
    expect(client.getQueryData<UserPreferences>(currentKey)).toEqual(saved);
    expect(client.getQueryData<UserPreferences>(otherKey)).toEqual(other);

    response = Response.json({ error: "Could not save" }, { status: 500 });
    await expect(
      mutation.execute({ messageListEmphasis: "agent" }),
    ).rejects.toThrow("Could not save");
    expect(client.getQueryData<UserPreferences>(currentKey)).toEqual(saved);
    expect(client.getQueryData<UserPreferences>(otherKey)).toEqual(other);
  } finally {
    client.clear();
    globalThis.fetch = originalFetch;
  }
});
