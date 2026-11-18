import { ui } from "@/lib/i18n";
import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { clearSkin } from "@/skins/store";
import { beginIdentitySwitch, freezeIdentity, resumeIdentity } from "./identity";
import { authKeys } from "./queries";

async function signOut() {
  await client("/api/auth/sign-out", {
    method: "POST",
    // What a refused sign-out means whoever answers it (Better Auth puts its sentence where `client` does not read).
    fallback: ui("Signing out did not finish. Try again."),
  });
}

/**
 * Every way out of OpenBot signs out through here, the skins' own menus included.
 *
 * The skin is the account's, and this browser only caches it to paint before the preferences load.
 * Clearing it here means the next person on a shared machine starts from the default rather than
 * from the last person's skin.
 *
 * THE IDENTITY SWITCH, NOT THE SIGN-OUT REQUEST, IS WHAT ENDS THE DATA. The request's first act
 * freezes the page: every in-flight business query is cancelled and cache writes held, so a late
 * response arriving while the request is being answered is dropped, not shown. On SUCCESS the full
 * switch runs — cache emptied, skin reset, account-scoped storage cleared — because the identity
 * has ended and nothing of it may survive in this browser. On a REFUSED sign-out the person is
 * still signed in, so the freeze lifts and the screen they were on works as it did. See
 * `identity.ts` for the full lifecycle.
 */
export function signOutMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: signOut,
    onMutate: () => {
      // From this moment nothing in flight may land: cancelled queries drop their results and
      // business cache writes freeze. Nothing is cleared yet — the sign-out may still be
      // refused, and a person who is refused stays signed in exactly where they were.
      freezeIdentity();
    },
    onSuccess: () => {
      // The identity has ended. Everything it could still reach in this browser goes.
      beginIdentitySwitch();
      queryClient.removeQueries({ queryKey: authKeys.all });
    },
    onError: () => {
      // Refused, so the person is still themselves: the screen they were on may write again.
      resumeIdentity();
    },
  });
}

/** Saves the person's display name, then refreshes who they are. */
export function updateProfileNameMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (name: string) =>
      client("/api/me/profile", "profile", {
        method: "PATCH",
        body: { name },
        fallback: ui("Your name could not be saved"),
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: authKeys.currentUser(),
        refetchType: "all",
      }),
  });
}
