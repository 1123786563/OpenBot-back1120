import { beforeEach, describe, expect, test } from "bun:test";
import { mutationOptions } from "@tanstack/react-query";
import {
  beginIdentitySwitch,
  freezeIdentity,
  identityGeneration,
  inFallbackBindingForTests,
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

  /*
   * THE TWO GAPS BELOW ARE THE REVIEWER'S OWN REPRODUCTIONS, kept as regressions.
   *
   * A real `useMutation` renders an observer, and every re-render of a pending mutation hands the
   * observer fresh options — which the observer copies onto the STILL-PENDING mutation, replacing
   * the wrapped copy `cache.build` made with the raw hook callbacks. A guard that only wraps at
   * build time is silently uninstalled by the first render after the request went out.
   */
  test("an observer options refresh while the mutation is pending does not unbind the callbacks", async () => {
    const { MutationObserver } = await import("@tanstack/react-query");
    let releaseA: (saved: string) => void = () => {};
    const gate = new Promise<string>((resolve) => {
      releaseA = resolve;
    });
    const startedAt = identityGeneration();
    const observer = new MutationObserver(queryClient, {
      mutationFn: () => gate,
      onSuccess: (saved: string) => queryClient.setQueryData(KEY, saved),
    });
    const running = observer.mutate(undefined);
    expect(observer.getCurrentResult().isPending).toBe(true);

    // A re-render while the mutation is in flight: fresh options object, same callbacks. This is
    // the swap that used to overwrite the bound copies with raw ones.
    observer.setOptions({
      mutationFn: () => gate,
      onSuccess: (saved: string) => queryClient.setQueryData(KEY, saved),
    });
    expect(observer.getCurrentResult().isPending).toBe(true);

    // The switch runs to completion; the page belongs to B; B writes their own value.
    freezeIdentity();
    beginIdentitySwitch();
    resumeIdentity();
    expect(identityGeneration()).toBeGreaterThan(startedAt);
    queryClient.setQueryData(KEY, "B-current");

    // A's response finally lands — through the swapped-in callbacks.
    releaseA("STALE");
    await running.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(queryClient.getQueryData<string>(KEY)).toBe("B-current");
  });

  /*
   * An `async` lifecycle callback writes after its own `await`. Restoring the binding when the
   * callback FIRST returns — before its promise settles — would leave everything after the first
   * `await` running unbound, which is the same hole one render later.
   */
  test("a stale async callback writes nothing after its own await, across the switch", async () => {
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
          onSuccess: async (saved: string) => {
            // The callback does real work before writing — a refetch, a second request.
            await new Promise((resolve) => setTimeout(resolve, 10));
            queryClient.setQueryData(KEY, saved);
          },
        }),
      )
      .execute(undefined);

    freezeIdentity();
    beginIdentitySwitch();
    resumeIdentity();
    expect(identityGeneration()).toBeGreaterThan(startedAt);
    queryClient.setQueryData(KEY, "B-current");

    releaseA("STALE-AFTER-AWAIT");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(queryClient.getQueryData<string>(KEY)).toBe("B-current");
  });

  test("the CURRENT identity's async callback still lands — the binding must not swallow it", async () => {
    queryClient
      .getMutationCache()
      .build(
        queryClient,
        mutationOptions({
          mutationFn: () => Promise.resolve("mine"),
          onSuccess: async (saved: string) => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            queryClient.setQueryData(KEY, saved);
          },
        }),
      )
      .execute(undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(queryClient.getQueryData<string>(KEY)).toBe("mine");
  });

  /*
   * THE TWO OVERLAPS BELOW ARE THE CONCURRENT PAIR THE REVIEW ASKED FOR, in both settle orders.
   *
   * A's lifecycle callback was already invoked — and already waiting on its own work — when the
   * switch ran; B's starts afterwards. The two promises are then in flight together, and their
   * settle order is whatever the world does. A shared marker held across a promise cannot tell
   * those continuations apart: settling in entry order handed the marker back wrong, letting A's
   * late value into B's cache and dropping one of B's. Each test below pins one settle order with
   * deterministic gates, against the real QueryClient and the real guards.
   */
  const gatedAsyncMutation = (gate: Promise<unknown>, marker: string) =>
    mutationOptions({
      mutationFn: () => Promise.resolve("started"),
      onSuccess: async () => {
        await gate;
        queryClient.setQueryData(KEY, marker);
      },
    });

  const switchToB = (startedAt: number): void => {
    freezeIdentity();
    beginIdentitySwitch();
    resumeIdentity();
    expect(identityGeneration()).toBeGreaterThan(startedAt);
  };

  const settleFor = async (ms: number): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  };

  test("two overlapping async callbacks, stale settles FIRST: its write never lands, B's does", async () => {
    let releaseA: () => void = () => {};
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let releaseB: () => void = () => {};
    const gateB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    const startedAt = identityGeneration();
    // A's callback is INVOKED here — before the switch — and registers as pending.
    queryClient
      .getMutationCache()
      .build(queryClient, gatedAsyncMutation(gateA, "A-overlap"))
      .execute(undefined);
    await settleFor(10);
    switchToB(startedAt);
    queryClient.setQueryData(KEY, "B-owns");
    // B's callback starts under B and is pending when A settles.
    queryClient
      .getMutationCache()
      .build(queryClient, gatedAsyncMutation(gateB, "B-overlap"))
      .execute(undefined);
    await settleFor(10);

    // A settles first — and its write must land nowhere.
    releaseA();
    await settleFor(20);
    expect(queryClient.getQueryData<string>(KEY)).toBe("B-owns");

    // Then B settles, under no live stale callback: the write of the page's own identity lands.
    releaseB();
    await settleFor(20);
    expect(queryClient.getQueryData<string>(KEY)).toBe("B-overlap");
  });

  test("two overlapping async callbacks, stale settles LAST: B writes normally through the whole window, and A's write lands nowhere", async () => {
    let releaseA: () => void = () => {};
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let releaseB: () => void = () => {};
    const gateB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    let releaseQuiescence: () => void = () => {};
    const quiescence = new Promise<void>((resolve) => {
      releaseQuiescence = resolve;
    });
    const startedAt = identityGeneration();
    queryClient
      .getMutationCache()
      .build(queryClient, gatedAsyncMutation(gateA, "A-overlap"))
      .execute(undefined);
    await settleFor(10);
    switchToB(startedAt);
    queryClient.setQueryData(KEY, "B-owns");
    // B's own callback writes twice: once while A's stale callback is still pending, once after.
    queryClient
      .getMutationCache()
      .build(
        queryClient,
        mutationOptions({
          mutationFn: () => Promise.resolve("started"),
          onSuccess: async () => {
            await gateB;
            queryClient.setQueryData(KEY, "B-in-window");
            await quiescence;
            queryClient.setQueryData(KEY, "B-final");
          },
        }),
      )
      .execute(undefined);
    await settleFor(10);

    // B settles FIRST, while A is still pending — and the exact binding attributes B's write to
    // B: the new identity writes normally through the window, in either settle order.
    releaseB();
    await settleFor(20);
    expect(queryClient.getQueryData<string>(KEY)).toBe("B-in-window");

    // A settles last, and its write still lands nowhere.
    releaseA();
    await settleFor(20);
    expect(queryClient.getQueryData<string>(KEY)).toBe("B-in-window");

    // And B's later write lands as always.
    releaseQuiescence();
    await settleFor(20);
    expect(queryClient.getQueryData<string>(KEY)).toBe("B-final");
    expect(queryClient.getQueryData<string>(KEY)).not.toBe("A-overlap");
  });

  test("a response released while B is already on the business page invokes A's callback into a closed door", async () => {
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
          onSuccess: async (saved: string) => {
            // Real work after the response: a refetch, a second round trip. Every continuation
            // below is invoked after B owns the page.
            await new Promise((resolve) => setTimeout(resolve, 10));
            queryClient.setQueryData(KEY, saved);
            await new Promise((resolve) => setTimeout(resolve, 10));
            queryClient.setQueryData(KEY, `${saved}-again`);
          },
        }),
      )
      .execute(undefined);

    // B signs in and is already using the page — reading and writing — when A's response arrives.
    switchToB(startedAt);
    queryClient.setQueryData(KEY, "B-working");

    releaseA("A-late-response");
    await settleFor(60);

    // Neither continuation lands, and B's own write is untouched by either.
    expect(queryClient.getQueryData<string>(KEY)).toBe("B-working");
    queryClient.setQueryData(KEY, "B-after");
    expect(queryClient.getQueryData<string>(KEY)).toBe("B-after");
  });
});

/*
 * THE FALLBACK BINDING, exercised as a browser runs it.
 *
 * Everything above runs under the exact binding, because Bun has an async context. The browser
 * build ships the fallback — no `AsyncLocalStorage` there — and a green run over the exact path
 * alone would prove nothing about what production does. So the same overlap pair runs here with
 * the context removed: the stale callback's write must still land nowhere, and what changes is
 * visible and deliberate — the fallback cannot attribute a post-`await` write to its callback, so
 * while a stale callback is pending it refuses the unattributed ones, B's own included, until the
 * stale one settles. Both settle orders are pinned, and the cost is pinned with them, because a
 * reader of these tests is entitled to see what the fallback costs rather than be told it has
 * none.
 */
describe("identity generation without an async context (the browser fallback)", () => {
  const settleFor = async (ms: number): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  };
  const gatedAsyncMutation = (gate: Promise<unknown>, marker: string) =>
    mutationOptions({
      mutationFn: () => Promise.resolve("started"),
      onSuccess: async () => {
        await gate;
        queryClient.setQueryData(KEY, marker);
      },
    });

  test("stale settles FIRST: its write never lands, and B's writes land once the window closes", async () => {
    await inFallbackBindingForTests(async () => {
      let releaseA: () => void = () => {};
      const gateA = new Promise<void>((resolve) => {
        releaseA = resolve;
      });
      let releaseB: () => void = () => {};
      const gateB = new Promise<void>((resolve) => {
        releaseB = resolve;
      });
      const startedAt = identityGeneration();
      queryClient
        .getMutationCache()
        .build(queryClient, gatedAsyncMutation(gateA, "A-fallback"))
        .execute(undefined);
      await settleFor(10);
      freezeIdentity();
      beginIdentitySwitch();
      resumeIdentity();

      // B's direct write during the window: refused with the stale callback's — the fallback
      // cannot tell whose unattributed hand a write came from, and refuses rather than guess.
      // It is answered at the next write, once the window closes.
      queryClient.setQueryData(KEY, "B-owns");
      expect(queryClient.getQueryData<string>(KEY)).toBeUndefined();

      queryClient
        .getMutationCache()
        .build(queryClient, gatedAsyncMutation(gateB, "B-fallback"))
        .execute(undefined);
      await settleFor(10);

      releaseA();
      await settleFor(20);
      expect(queryClient.getQueryData<string>(KEY)).toBeUndefined();

      releaseB();
      await settleFor(20);
      expect(queryClient.getQueryData<string>(KEY)).toBe("B-fallback");
      queryClient.setQueryData(KEY, "B-direct");
      expect(queryClient.getQueryData<string>(KEY)).toBe("B-direct");
    });
  });

  test("stale settles LAST: B's synchronous and post-await writes return when it is gone", async () => {
    await inFallbackBindingForTests(async () => {
      let releaseA: () => void = () => {};
      const gateA = new Promise<void>((resolve) => {
        releaseA = resolve;
      });
      let releaseB: () => void = () => {};
      const gateB = new Promise<void>((resolve) => {
        releaseB = resolve;
      });
      const startedAt = identityGeneration();
      queryClient
        .getMutationCache()
        .build(queryClient, gatedAsyncMutation(gateA, "A-fallback"))
        .execute(undefined);
      await settleFor(10);
      freezeIdentity();
      beginIdentitySwitch();
      resumeIdentity();

      queryClient
        .getMutationCache()
        .build(queryClient, gatedAsyncMutation(gateB, "B-fallback"))
        .execute(undefined);
      await settleFor(10);

      // B settles first, still inside the window: its write is refused with A's.
      releaseB();
      await settleFor(20);
      expect(queryClient.getQueryData<string>(KEY)).toBeUndefined();

      // A settles and closes the window; its write landed nowhere.
      releaseA();
      await settleFor(20);
      expect(queryClient.getQueryData<string>(KEY)).toBeUndefined();

      // From here the page is B's without qualification: any write lands.
      queryClient.setQueryData(KEY, "B-owns");
      expect(queryClient.getQueryData<string>(KEY)).toBe("B-owns");
    });
  });
});
