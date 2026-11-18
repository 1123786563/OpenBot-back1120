import { ErrorDetails } from "@/lib/i18n/errors";
import { ui, useLocale, getLocale } from "@/lib/i18n";
import { IconKey, IconLockOff, IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { deleteSavedLoginMutationOptions } from "@/lib/passwords/mutations";
import { savedLoginsQueryOptions } from "@/lib/passwords/queries";
import { queryClient } from "@/query-client";

/**
 * The logins you saved from a private sign-in form.
 *
 * The site and username only: a password is write-only, and this page can delete one but never show
 * it. A saved login is used only when you confirm it in a sign-in form.
 *
 * Under Settings. The personal edition calls it Saved logins, and links to it from Connections too.
 */
export function PasswordsPage() {
  useLocale();
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";
  const logins = useQuery(savedLoginsQueryOptions());
  const remove = useMutation(deleteSavedLoginMutationOptions(queryClient));
  return (
    <PageShell
      title={personal ? ui("Saved logins") : ui("Passwords")}
      description={ui(
        "Manage saved website logins. Bots cannot see your passwords, and you approve each use.",
      )}
    >
      <PageSection title={personal ? undefined : ui("Saved logins")}>
        {logins.isPending ? null : logins.error ? (
          <p className="text-destructive text-sm" role="alert">
            {ui("Couldn't load your passwords. Reload the page.")}
          </p>
        ) : !logins.data.passwordManager ? (
          <PageEmpty icon={IconLockOff} title={ui("Saved passwords are off")}>
            {ui(
              "An admin turned them off. Your logins are kept but won't be offered.",
            )}
          </PageEmpty>
        ) : logins.data.logins.length === 0 ? (
          <PageEmpty icon={IconKey} title={ui("No saved logins yet")}>
            {ui(
              "Choose Save to Passwords when you sign a Bot in to a website.",
            )}
          </PageEmpty>
        ) : (
          <PageRows>
            {logins.data.logins.map((login, index) => (
              <div key={login.id}>
                {index > 0 ? <Separator /> : null}
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <IconKey />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{login.origin}</ItemTitle>
                    <ItemDescription>
                      {login.username}
                      {login.lastUsedAt
                        ? ui(" · last used {{value0}}", {
                            value0: String(
                              new Date(login.lastUsedAt).toLocaleDateString(
                                getLocale(),
                              ),
                            ),
                          })
                        : ui(" · never used")}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      aria-label={ui("Delete login for {{value0}}", {
                        value0: String(login.origin),
                      })}
                      size="sm"
                      variant="ghost"
                      disabled={remove.isPending}
                      onClick={() => remove.mutate(login.id)}
                    >
                      <IconTrash />
                    </Button>
                  </ItemActions>
                </Item>
              </div>
            ))}
          </PageRows>
        )}
        {remove.error ? (
          <p className="mt-2 text-destructive text-sm" role="alert">
            {<ErrorDetails error={remove.error} />}
          </p>
        ) : null}
      </PageSection>
    </PageShell>
  );
}
