import {
  Mutation,
  MutationObserver,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { queryClient } from "@/query-client";
import { clearSkin } from "@/skins/store";

/**
 * The identity lifecycle: one generation per signed-in identity, and a switch that ends it.
 *
 * Sign-out used to clear the skin and the auth queries and nothing else. Everything else — the
 * Bots, the conversations, the connections, the in-flight request for any of them — stayed in this
 * module-level `QueryClient`, and the next person signing in on the same browser was served the
 * last person's data from memory while their own refetches were still in the air. A thread id
 * remembered per Bot also survived, so the new identity could be handed the old one's
 * conversation as if it were theirs.
 *
 * A switch, then, does four things, and does them in this order:
 *
 * 1. the generation increments, so anything still in flight can tell it is no longer wanted;
 * 2. every query is cancelled — React Query drops the results of cancelled fetches, so a response
 *    that arrives after this point writes nothing;
 * 3. the cache is emptied and the account-scoped `localStorage` keys are deleted;
 * 4. business cache writes freeze until the next identity proves itself, so a mutation whose
 *    `onSuccess` was already past cancellation cannot repopulate a single entry after the clear.
 *
 * The freeze lifts when a signed-in identity is loaded again (see `resumeIdentity`), because a
 * frozen cache is only ever correct while nobody is signed in: it must never hold a signed-in
 * user's screen hostage.
 *
 * THE FREEZE ALONE IS NOT ENOUGH, and the gap is exactly the ordering above: a mutation whose
 * `onSuccess` was already running when the switch began finishes after it. By the time its
 * `setQueryData` runs, the new identity has loaded, the freeze has lifted — and a check of
 * "is the cache frozen" alone would wave the OLD identity's write straight into the NEW one's
 * cache. So every mutation is bound to the generation it started under: the cache write door
 * compares the running callback's generation against the page's and drops the write when they
 * differ, no matter how long the response took or how many identities came and went in between.
 * See `installIdentityGuards` for where that binding is attached.
 *
 * The switch is broadcast on a `BroadcastChannel`, so tabs sharing the cookie clear themselves
 * instead of going on receiving the old identity's events from a socket that the server — which
 * now revokes on sign-out — is about to close under them.
 */

const ACCOUNT_SCOPED_KEY_PREFIXES = [
  // The direct Bot chat's thread per Bot. The old identity's conversation must not become the
  // new one's: the key is deleted, and the next chat mints its own thread under its own identity.
  "openbot.bot-thread.",
  // One-shot "carry this tool call on" grants and per-computer activity wipe markers. Both are
  // account-scoped facts, not facts about the browser.
  "openbot:carried-on:",
  "openbot:computer-activity-wiped:",
] as const;

const BROADCAST_CHANNEL = "openbot.identity";
const SWITCH_MESSAGE = "identity-switched";

let generation = 0;
let frozen = false;
/**
 * The generation the identity-scoped callback currently running was started under, or `null`
 * outside any such callback. Set only while a guarded callback runs (see
 * `runForGeneration`), so it never leaks into unrelated code between awaits.
 */
let executing: number | null = null;
let channel: BroadcastChannel | undefined;

/**
 * Run `fn` as a callback of the identity generation `startedAt`, nesting-safe — and ACROSS ITS
 * ENTIRE EXECUTION, not just its first synchronous stretch.
 *
 * A lifecycle callback may `await` before it writes: an `async onSuccess` that stores a result
 * after a round trip, an `onSettled` that awaits a refetch. Restoring `executing` the moment `fn`
 * RETURNS would unbind everything after its first `await` — the door would then read
 * `executing === null`, wave the write through, and the stale result the binding existed to stop
 * would land after all. So when `fn` answers a promise, the binding is held until that promise
 * settles: the continuation after every `await` still runs under the generation the callback
 * started under, and the door can still tell it from the new identity's writes.
 *
 * THE COST IS HONEST AND BOUNDED. While a stale callback's promise is in flight, `executing` names
 * its generation, and an UNGUARDED write that happens to run inside that window — code that calls
 * `setQueryData` outside any bound callback — is dropped with the stale writes. That window is
 * exactly the leak window (a stale callback still pending after a newer identity resumed), it ends
 * when the callback settles, and no bound write is ever mis-dropped: a bound callback stamps its
 * own generation on entry and restores what was there before. Dropping a stranger's write while a
 * known-stale callback is still live errs toward the side this module exists to guard; the
 * alternative — letting the stale write through because the marker happened to be down — is the
 * bug.
 */
function runForGeneration<T>(startedAt: number, fn: () => T): T {
  const outer = executing;
  executing = startedAt;
  const settle = (): void => {
    executing = outer;
  };
  let result: T;
  try {
    result = fn();
  } catch (error) {
    settle();
    throw error;
  }
  if (
    result instanceof Promise ||
    (result !== null &&
      typeof result === "object" &&
      typeof (result as { then?: unknown }).then === "function")
  ) {
    // `Promise.resolve` also takes a foreign thenable; `finally` passes the outcome through
    // untouched, so the caller's await sees exactly what `fn` answered.
    return Promise.resolve(result).finally(settle) as unknown as T;
  }
  settle();
  return result;
}

/**
 * Whether a cache write must be dropped.
 *
 * Frozen — nobody holds the page — is the obvious case. The other is the stale one: a callback
 * bound to an earlier generation is running NOW, while a later identity owns the page. Both are
 * answered by one predicate so a caller cannot pass one and forget the other.
 */
function writeIsStale(): boolean {
  return frozen || (executing !== null && executing !== generation);
}

function clearAccountScopedStorage(): void {
  try {
    const doomed: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (
        key &&
        ACCOUNT_SCOPED_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))
      )
        doomed.push(key);
    }
    for (const key of doomed) window.localStorage.removeItem(key);
  } catch {
    // Storage can be unavailable. The cache clear below still stands; only continuity is lost.
  }
}

/** The generation of the identity whose data this page may hold. Compare before writing. */
export function identityGeneration(): number {
  return generation;
}

/**
 * Stop the current identity's writes without ending it.
 *
 * Cancels every in-flight query and freezes business cache writes, but clears nothing: the
 * identity may still prove to be the same person, and a refused sign-out leaves them signed in
 * exactly where they were. Used when a sign-out STARTS, so nothing in flight can land while the
 * request is being answered; the full clear is `beginIdentitySwitch`, run when the sign-out
 * actually succeeds.
 */
export function freezeIdentity(): void {
  generation += 1;
  frozen = true;
  // Cancelled fetches have their results dropped by React Query itself: a response that lands
  // after this line never reaches the cache through a query.
  void queryClient.cancelQueries().catch(() => {});
}

/**
 * Let a freshly proven identity write again.
 *
 * Called when a signed-in user has been loaded, or when a sign-out came back refused — the
 * person is still themselves, and the screen they were on may write again. After a real switch
 * this runs only once the new identity's user object has been loaded, which can only be the new
 * person, since the cache and storage the old one could come back from are gone.
 *
 * The generation moves again here on purpose. A callback that started under the old identity
 * must stay stale across the resume — its generation no longer matches, whichever identity now
 * holds the page — so the resume may never restore the number the old callback is still bound
 * to.
 */
export function resumeIdentity(): void {
  if (!frozen) return;
  frozen = false;
  generation += 1;
}

/**
 * End the current identity, if there is one, and leave nothing of it behind.
 *
 * Idempotent and safe to call twice — the sign-out flow calls it when the sign-out SUCCEEDS, and
 * again should anything have slipped in past the freeze. It is also the whole cleanup a tab that
 * only *hears* about another tab's switch performs.
 */
export function beginIdentitySwitch(): void {
  freezeIdentity();
  queryClient.clear();
  clearSkin();
  clearAccountScopedStorage();
  /*
   * The broadcast targets OTHER TABS of a real browser document — that is who hears it and
   * reloads. Where there is no document (a test process, a worker), posting would only hand a
   * stray message to whatever listener happens to share the channel name later in the same
   * process, and this tab has no other tabs to tell anyway.
   */
  if (typeof document === "undefined") return;
  try {
    channel ??= new BroadcastChannel(BROADCAST_CHANNEL);
    channel.postMessage(SWITCH_MESSAGE);
  } catch {
    // No BroadcastChannel (old browser, unusual storage settings): this tab is still clean; the
    // others reload or refetch on their next navigation.
  }
}

/** Whether business cache writes are being dropped because no identity holds the page. */
export function identityFrozen(): boolean {
  return frozen;
}

/**
 * Wrap one mutation callback so it runs bound to the generation the mutation started under.
 *
 * The binding is what `writeIsStale` reads: a success callback of a mutation started under the
 * old identity writes nothing after a switch, even though the freeze it used to be stopped by
 * has since lifted for the new identity. `startedAt` is read at execute time by the caller —
 * per execution, not per mutation, so a mutation object that runs twice binds each run to the
 * generation it itself started under.
 */
function bindCallback<A extends unknown[]>(
  callback: ((...args: A) => unknown) | undefined,
  startedAt: () => number,
): ((...args: A) => unknown) | undefined {
  if (!callback) return undefined;
  return (...args: A) =>
    runForGeneration(startedAt(), () => callback(...args));
}

/**
 * Copy mutation options with each lifecycle callback bound. The original object belongs to the
 * hook that declared it and is reused across mutations; wrapping in place would stack a wrapper
 * on a wrapper on every rebuild.
 */
function bindMutationOptions<
  TData,
  TError,
  TVariables,
  TContext,
>(options: {
  onSuccess?: (data: TData, variables: TVariables, context: TContext) => unknown;
  onError?: (error: TError, variables: TVariables, context: TContext) => unknown;
  onSettled?: (
    data: TData | undefined,
    error: TError | null,
    variables: TVariables,
    context: TContext,
  ) => unknown;
  [key: string]: unknown;
}, startedAt: () => number): typeof options {
  return {
    ...options,
    onSuccess: bindCallback(options.onSuccess, startedAt),
    onError: bindCallback(options.onError, startedAt),
    onSettled: bindCallback(options.onSettled, startedAt),
  };
}

/**
 * Drop business cache writes while frozen or stale, and bind mutations to their generation.
 *
 * Patched onto the one `QueryClient` instance rather than wrapped in every caller, because a
 * wrapper is a discipline that one new call site can forget; an instance patch is a property of
 * the cache itself.
 *
 * Three doors lead into the cache, and each is closed here:
 *
 * - `setQueryData`, guarded by `writeIsStale` — catches the success callback of a mutation that
 *   was already past cancellation when the switch began, and any direct write from code that a
 *   stale response woke up.
 * - every mutation the cache builds, whose lifecycle callbacks are wrapped to run bound to the
 *   generation the mutation was executed under — that binding is what makes the door above able
 *   to tell an old callback from a new one.
 * - the per-call callbacks of `mutate(variables, { onSuccess })`, which bypass the mutation's own
 *   options entirely (the observer runs them after `execute` answers) and are bound the same
 *   way at the call.
 *
 * Query fetches need no door: `freezeIdentity` cancels them, and React Query drops the results
 * of cancelled fetches by itself.
 */
let installed = false;
export function installIdentityGuards(): void {
  if (installed) return;
  installed = true;
  const original = queryClient.setQueryData.bind(queryClient);
  queryClient.setQueryData = <TQueryFnData, TTaggedQueryKey extends QueryKey>(
    queryKey: TTaggedQueryKey,
    updater: Parameters<QueryClient["setQueryData"]>[1],
    options?: Parameters<QueryClient["setQueryData"]>[2],
  ): TQueryFnData | undefined => {
    if (writeIsStale()) return undefined;
    // Bound above, so the generic dispatch still resolves the updater against the cached type.
    return (
      original as unknown as (
        key: TTaggedQueryKey,
        updater: Parameters<QueryClient["setQueryData"]>[1],
        options?: Parameters<QueryClient["setQueryData"]>[2],
      ) => TQueryFnData | undefined
    )(queryKey, updater, options);
  };

  /*
   * Every mutation the cache builds gets an `execute` that stamps the generation it started
   * under, and lifecycle callbacks that read that stamp while they run. `bindMutationOptions`
   * copies rather than mutates, and the WeakSet keeps a rebuilt mutation from being wrapped
   * twice.
   */
  const cache = queryClient.getMutationCache();
  const wrapped = new WeakSet<object>();
  /** Options objects `bindMutationOptions` already produced, so they are never wrapped twice. */
  const boundOptions = new WeakSet<object>();
  /*
   * The generation getter of every mutation this cache builds, kept by identity so a LATER write
   * to the mutation's options can bind to the same stamp (see `Mutation.setOptions` below). The
   * mutation object is the key; the stamp itself is read per execution.
   */
  const stamps = new WeakMap<object, () => number>();
  const originalBuild = cache.build.bind(cache);
  cache.build = ((
    client: Parameters<typeof cache.build>[0],
    options: Parameters<typeof cache.build>[1],
    state: Parameters<typeof cache.build>[2],
  ) => {
    const startedAt = { value: -1 };
    const bound =
      options
        ? (bindMutationOptions(
            options as unknown as Parameters<typeof bindMutationOptions>[0],
            () => startedAt.value,
          ) as typeof options)
        : options;
    const mutation = originalBuild(client, bound, state);
    // The copy this build wrapped, so a `setOptions` carrying it back (the constructor's first
    // call, and an observer refresh that passes it through) is not wrapped a second time.
    if (bound) boundOptions.add(bound as object);
    stamps.set(mutation, () => startedAt.value);
    if (wrapped.has(mutation)) return mutation;
    wrapped.add(mutation);
    const originalExecute = mutation.execute.bind(mutation);
    type Execute = typeof mutation.execute;
    (mutation as { execute: Execute }).execute = (
      variables: Parameters<Execute>[0],
    ) => {
      startedAt.value = identityGeneration();
      return originalExecute(variables);
    };
    return mutation;
  }) as typeof cache.build;

  /*
   * A PENDING MUTATION'S OPTIONS ARE REPLACED, NOT ONLY READ — and the replacement is unbound.
   *
   * While a mutation is in flight, every re-render of its hook runs `observer.setOptions`, and the
   * observer answers a still-pending mutation with `mutation.setOptions(its own raw options)` —
   * the hook's callbacks as declared, never the wrapped copy `cache.build` made. That swap lands
   * BETWEEN `execute` starting and the lifecycle callbacks running, so the `onSuccess` that fires
   * when the response arrives is the RAW one: no stamp, no binding, and a stale result writing
   * straight into the new identity's cache through the door above. This wrapper re-binds whatever
   * arrives, to THIS mutation's own stamp — the same generation its `execute` stamped — so the
   * swapped-in callbacks stay bound to the run that is still going, however many renders refresh
   * the observer under it. Options that are themselves an already-bound copy (the constructor's
   * first call) pass through untouched: wrapping a wrapper would stack one more on every rebuild.
   */
  const mutationPrototype = Mutation.prototype as unknown as {
    setOptions: (options: Record<string, unknown> | undefined) => void;
  };
  const originalMutationSetOptions = mutationPrototype.setOptions;
  mutationPrototype.setOptions = function (options) {
    if (!options || boundOptions.has(options)) {
      return originalMutationSetOptions.call(this, options);
    }
    const stamp = stamps.get(this as object);
    if (!stamp) return originalMutationSetOptions.call(this, options);
    return originalMutationSetOptions.call(
      this,
      bindMutationOptions(
        options as unknown as Parameters<typeof bindMutationOptions>[0],
        stamp,
      ) as unknown as Record<string, unknown>,
    );
  };

  /*
   * The per-call callbacks of `mutate()` never reach the mutation's options — the observer holds
   * them beside it and runs them from its own notification after `execute` settles. The same
   * binding attaches here, at the call, where the generation is the caller's.
   */
  const observerPrototype = MutationObserver.prototype as unknown as {
    mutate: (
      this: { /* shape irrelevant to the wrapper */ },
      variables: unknown,
      options?:
        | {
            onSuccess?: (...args: unknown[]) => unknown;
            onError?: (...args: unknown[]) => unknown;
            onSettled?: (...args: unknown[]) => unknown;
          }
        | undefined,
      ...rest: unknown[]
    ) => unknown;
  };
  const originalMutate = observerPrototype.mutate;
  observerPrototype.mutate = function (variables, options, ...rest) {
    if (!options) return originalMutate.call(this, variables, options, ...rest);
    const startedAt = identityGeneration();
    return originalMutate.call(
      this,
      variables,
      {
        ...options,
        onSuccess: bindCallback(options.onSuccess, () => startedAt),
        onError: bindCallback(options.onError, () => startedAt),
        onSettled: bindCallback(options.onSettled, () => startedAt),
      },
      ...rest,
    );
  };

  // The listener belongs to a real browser document, like the broadcast it answers (see
  // `beginIdentitySwitch`): without a document there is no tab set to keep clean, and a listener
  // registered anyway would fire into whatever this process is doing when a message lands.
  if (typeof document === "undefined") return;
  try {
    channel ??= new BroadcastChannel(BROADCAST_CHANNEL);
    channel.onmessage = (message) => {
      if (message.data !== SWITCH_MESSAGE) return;
      // Another tab switched identity under the shared cookie. Do the same cleanup here; do not
      // re-publish, or the tabs echo at each other forever.
      freezeIdentity();
      queryClient.clear();
      clearSkin();
      clearAccountScopedStorage();
      /*
       * THEN LEAVE THE DOCUMENT, because the cache was never the whole of what this tab holds.
       * Component state is not: a dialog A had open — a draft A was halfway through typing, an
       * unchanged form holding A's data — lives in this React tree, survives every cache clear,
       * and would sit on screen for whoever the cookie names next. Reloading remounts the whole
       * application from nothing under the cookie as it is NOW, which is the only state that is
       * certainly clean. The requests in flight at this moment are over: nothing that answered
       * for the old identity may land in the new one's document, and the generation guards
       * already drop anything that lands in this one before the reload finishes.
       */
      try {
        window.location.reload();
      } catch {
        // A reload that cannot run (tests, exotic embeds) still leaves the cleanup above: the
        // cache and storage are clear, and the guards hold the write door.
      }
    };
  } catch {
    // As above: this tab cleans itself up regardless.
  }
}
