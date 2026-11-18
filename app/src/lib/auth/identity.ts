import type { QueryClient, QueryKey } from "@tanstack/react-query";
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
let channel: BroadcastChannel | undefined;

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
 * Drop business cache writes while frozen, and let guarded callers compare generations.
 *
 * Patched onto the one `QueryClient` instance rather than wrapped in every caller, because a
 * wrapper is a discipline that one new call site can forget; an instance patch is a property of
 * the cache itself. Cancelled queries are already dropped by React Query; this catches the other
 * door into the cache — a mutation's `onSuccess` that was already past cancellation when the
 * switch began.
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
    if (frozen) return undefined;
    // Bound above, so the generic dispatch still resolves the updater against the cached type.
    return (
      original as unknown as (
        key: TTaggedQueryKey,
        updater: Parameters<QueryClient["setQueryData"]>[1],
        options?: Parameters<QueryClient["setQueryData"]>[2],
      ) => TQueryFnData | undefined
    )(queryKey, updater, options);
  };
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
    };
  } catch {
    // As above: this tab cleans itself up regardless.
  }
}
