import { ui, useLocale } from "@/lib/i18n";
import { IconFingerprint, IconShieldLock } from "@tabler/icons-react";
import { PageRows } from "@/components/layout/page-shell";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { ControlsSection } from "./controls-section";

/** Admin, Identity providers: whether SSO is the only way in, and directory provisioning. */
export function SignInSection() {
  useLocale();
  return (
    <ControlsSection
      description={ui(
        "Addresses in INITIAL_ADMIN_EMAILS can always use social sign-in as an emergency way in. Each of those sign-ins shows in Audit.",
      )}
      title={ui("Sign-in")}
    >
      {({ data, setSetting, saving }) => (
        <PageRows>
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconShieldLock />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{ui("Require SSO")}</ItemTitle>
              <ItemDescription>
                {data.settings.ssoRequired
                  ? ui(
                      "People can only sign in through a registered SAML or OpenID Connect provider.",
                    )
                  : ui(
                      "People can also sign in with Google, Microsoft or Okta.",
                    )}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label={ui("Require SSO")}
                checked={data.settings.ssoRequired}
                disabled={saving}
                onCheckedChange={(checked) =>
                  setSetting("ssoRequired", checked)
                }
              />
            </ItemActions>
          </Item>
          <Separator />
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconFingerprint />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{ui("SCIM provisioning")}</ItemTitle>
              <ItemDescription className="line-clamp-none">
                {data.scim.configured
                  ? ui(
                      "Directory base URL {{value0}} with the SCIM_BEARER_TOKEN bearer token. Deprovisioning ends sessions, blocks the address, retires connector credentials and stops their computers.",
                      {
                        value0: String(
                          data.scim.baseUrl ?? "(set BETTER_AUTH_URL)",
                        ),
                      },
                    )
                  : ui(
                      "Off. Set SCIM_BEARER_TOKEN to accept provisioning from Okta, Entra or another directory.",
                    )}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <span className="text-muted-foreground text-sm">
                {data.scim.configured ? ui("On") : ui("Off")}
              </span>
            </ItemActions>
          </Item>
        </PageRows>
      )}
    </ControlsSection>
  );
}
