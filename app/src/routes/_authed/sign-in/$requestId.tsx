import { ui, useLocale } from "@/lib/i18n";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { PageShell } from "@/components/layout/page-shell";
import { SignInForm } from "@/components/passwords/sign-in-form";
import { signInRequestQueryOptions } from "@/lib/passwords/queries";

/**
 * The private sign-in form, on a page of its own.
 *
 * Its own route, outside the chat layout, because this is where a link sent to Slack, SMS or a phone
 * lands: a person can answer a Bot that is working unattended without opening its conversation, and
 * nothing typed here is ever part of one.
 */
export const Route = createFileRoute("/_authed/sign-in/$requestId")({
  component: SignInPage,
});

function SignInPage() {
  useLocale();
  const { requestId } = Route.useParams();
  const request = useQuery(signInRequestQueryOptions(requestId));
  return (
    <PageShell
      title={
        request.data
          ? ui("Sign in to {{value0}}", { value0: String(request.data.origin) })
          : ui("Sign in")
      }
      description={
        request.data?.reason ??
        ui(
          "Your Bot needs to sign in to continue. What you type here goes to its browser, not the conversation.",
        )
      }
    >
      <SignInForm requestId={requestId} />
    </PageShell>
  );
}
