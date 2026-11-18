import { beforeEach, describe, expect, test } from "bun:test";
import { mutationOptions } from "@tanstack/react-query";
import {
  beginIdentitySwitch,
  freezeIdentity,
  identityGeneration,
  installIdentityGuards,
  resumeIdentity,
} from "@/lib/auth/identity";
import { queryClient } from "@/query-client";

/**
 * The old identity's in-flight mutation must not write into the new identity's cache.
 *
 * A sign-out freezes the page and a switch empties it, but a mutation whose success callback was
 * already past cancellation finishes AFTER both — and by then the next person has signed in, the
 * freeze has lifted for them, and a check of "is the cache frozen" alone waves the old
 * identity's write straight into their cache. This is the failure the identity generation exists
 * to close, reproduced against the application's real `QueryClient` and real guards: a controlled
 * promise stands in for the network, everything else is the code as shipped.
 */

const KEY = ["t04", "instructions"] as const;

installIdentityGuards();

function saveMutationOptions(onSuccess: (saved: string) => void) {
  return mutationOptions({
    mutationFn: (_input: void) => Promise.resolve("never-resolved"),
    onSuccess,
  });
}

beforeEach(() => {
  queryClient.clear();
  queryClient.setQueryData(KEY, "base");
});

describe("identity generation guards the cache write", () => {
  test("a mutation started under A cannot land after B has taken over the page", async () => {
    // A's request is in the air.
    let releaseA: (saved: string) => void = () => {};
    const gate = new Promise<string>((resolve) => {
      releaseA = resolve;
    });
    const startedAt = identityGeneration();
    queryClient
      .getMutationCache()
      .build(
        queryClient,
        mutationOptions({
          mutationFn: () => gate,
          onSuccess: (saved) => queryClient.setQueryData(KEY, saved),
        }),
      )
      .execute(undefined);

    // A signs out; the sign-out succeeds; the cache empties. B signs in and the page proves
    // them, which lifts the freeze — the state the old guard alone could not survive.
    freezeIdentity();
    beginIdentitySwitch();
    resumeIdentity();
    expect(identityGeneration()).toBeGreaterThan(startedAt);
    // B's own data, written by B's own code now that the page is theirs again.
    queryClient.setQueryData(KEY, "B-before-resume");
    expect(queryClient.getQueryData<string>(KEY)).toBe("B-before-resume");

    // A's response arrives at last, and tries to write A's data.
    releaseA("A-marker");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(queryClient.getQueryData<string>(KEY)).toBe("B-before-resume");
  });

  test("a mutation started before a refused sign-out writes nothing after the freeze lifts", async () => {
    // A refused sign-out: freeze, then resume — the same person, the page alive again, and the
    // same stale-callback hazard, because the generation moved either way.
    let release: (saved: string) => void = () => {};
    const gate = new Promise<string>((resolve) => {
      release = resolve;
    });
    queryClient
      .getMutationCache()
      .build(
        queryClient,
        mutationOptions({
          mutationFn: () => gate,
          onSuccess: (saved) => queryClient.setQueryData(KEY, saved),
        }),
      )
      .execute(undefined);

    freezeIdentity();
    resumeIdentity();

    release("A-late-marker");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(queryClient.getQueryData<string>(KEY)).toBe("base");
  });

  test("the per-call callbacks of mutate() are bound like the hook's own", async () => {
    const startedAt = identityGeneration();
    let releaseA: (saved: string) => void = () => {};
    const gate = new Promise<string>((resolve) => {
      releaseA = resolve;
    });
    const observer = queryClient.getMutationCache().build(
      queryClient,
      mutationOptions({ mutationFn: (input: string) => Promise.resolve(input) }),
    );
    observer.execute("unused");
    // The observer's own `mutate` is what carries the per-call callbacks.
    const { MutationObserver } = await import("@tanstack/react-query");
    const perCall = new MutationObserver(queryClient, {
      mutationFn: () => gate,
    });
    perCall.mutate(undefined, {
      onSuccess: (saved) => queryClient.setQueryData(KEY, saved),
    });

    freezeIdentity();
    beginIdentitySwitch();
    resumeIdentity();
    expect(identityGeneration()).toBeGreaterThan(startedAt);
    // B's own data, written once the page is theirs again.
    queryClient.setQueryData(KEY, "B-before-resume");

    releaseA("A-per-call-marker");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(queryClient.getQueryData<string>(KEY)).toBe("B-before-resume");
  });

  test("a mutation of the CURRENT identity writes normally — isolation must not break the page", async () => {
    const options = saveMutationOptions((saved) =>
      queryClient.setQueryData(KEY, saved),
    );
    await queryClient
      .getMutationCache()
      .build(queryClient, options)
      .execute(undefined);
    expect(queryClient.getQueryData<string>(KEY)).toBe("never-resolved");

    // And after a full switch, the NEW identity's mutations write too.
    freezeIdentity();
    beginIdentitySwitch();
    resumeIdentity();
    queryClient.setQueryData(KEY, "base");
    const fresh = saveMutationOptions((saved) =>
      queryClient.setQueryData(KEY, saved),
    );
    await queryClient
      .getMutationCache()
      .build(queryClient, fresh)
      .execute(undefined);
    expect(queryClient.getQueryData<string>(KEY)).toBe("never-resolved");
  });
});
