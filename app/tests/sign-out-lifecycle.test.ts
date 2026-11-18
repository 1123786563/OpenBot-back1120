import { afterEach, describe, expect, test } from "bun:test";
import { mutationOptions, QueryClient } from "@tanstack/react-query";
import {
  beginIdentitySwitch,
  freezeIdentity,
  identityFrozen,
  identityGeneration,
  resumeIdentity,
} from "@/lib/auth/identity";
import { signOutMutationOptions } from "@/lib/auth/mutations";
import { queryClient } from "@/query-client";

/**
 * The sign-out mutation performs the identity switch itself — and that is exactly why its own
 * lifecycle callbacks must never be gated on the generation.
 *
 * `onMutate` is what moves the generation (the freeze, which makes every in-flight result
 * unwritable). The response's `onSuccess` then carries `beginIdentitySwitch` — the act that ends
 * the identity, empties the cache and sends the person to the sign-in page. If a callback whose
 * stamp no longer matched the page were refused outright, the sign-out mutation would refuse its
 * own success: the server session would end and the person would stand in the app forever. The
 * same shape holds on a refusal, where `onError` lifts the freeze. Both run; what the generation
 * gates is what they WRITE.
 */

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubSignOut(status: number): void {
  globalThis.fetch = (async () =>
    new Response(null, { status })) as unknown as typeof fetch;
}

describe("the sign-out mutation runs its own lifecycle across its own freeze", () => {
  test("a successful sign-out performs the switch its onSuccess carries", async () => {
    stubSignOut(200);
    const client = new QueryClient();
    // Install the guards onto the app's own client, which the mutation's callbacks drive.
    const { installIdentityGuards } = await import("@/lib/auth/identity");
    installIdentityGuards();
    // Something of the signed-in identity is in the cache, as there always is at sign-out.
    queryClient.setQueryData(["auth", "current-user"], { name: "someone" });
    const before = identityGeneration();
    await client
      .getMutationCache()
      .build(client, signOutMutationOptions(queryClient))
      .execute(undefined);

    // The switch ran — not the freeze alone: the cache the signed-in identity held is GONE,
    // which only `beginIdentitySwitch` does. A callback refused for carrying a stale stamp
    // would leave the freeze standing AND the cache intact.
    expect(identityFrozen()).toBe(true);
    expect(identityGeneration()).toBeGreaterThan(before);
    expect(queryClient.getQueryData(["auth", "current-user"])).toBeUndefined();
  });

  test("a refused sign-out lifts the freeze, and the page writes again", async () => {
    stubSignOut(403);
    const client = new QueryClient();
    const before = identityGeneration();
    await client
      .getMutationCache()
      .build(client, signOutMutationOptions(queryClient))
      .execute(undefined)
      // A refused sign-out REJECTS the mutation — that is what routes it to `onError`.
      .catch(() => {});

    // `onError` ran — the person is still themselves and the screen works again.
    expect(identityFrozen()).toBe(false);
    expect(identityGeneration()).toBeGreaterThan(before);
    queryClient.setQueryData(["t04", "still-here"], "yes");
    expect(queryClient.getQueryData<string>(["t04", "still-here"])).toBe("yes");
    // And the module's own door agrees, for the writes the real screen makes.
    freezeIdentity();
    beginIdentitySwitch();
    resumeIdentity();
    queryClient.setQueryData(["t04", "after"], "landed");
    expect(queryClient.getQueryData<string>(["t04", "after"])).toBe("landed");
  });

  test("a mutation whose own onMutate freezes still lands its post-response work", async () => {
    // The generic shape behind the sign-out: a mutation that freezes in `onMutate` and writes in
    // `onSuccess` must have that write land — the freeze it made cannot un-own its own callback.
    stubSignOut(200);
    const client = new QueryClient();
    const { installIdentityGuards } = await import("@/lib/auth/identity");
    installIdentityGuards();
    const KEY = ["t04", "self-freezing"] as const;
    queryClient.setQueryData(KEY, "before");
    await client
      .getMutationCache()
      .build(
        client,
        mutationOptions({
          mutationFn: async () => {
            freezeIdentity();
            return "done";
          },
          onSuccess: () => {
            resumeIdentity();
            queryClient.setQueryData(KEY, "after");
          },
        }),
      )
      .execute(undefined);
    expect(queryClient.getQueryData<string>(KEY)).toBe("after");
  });
});
