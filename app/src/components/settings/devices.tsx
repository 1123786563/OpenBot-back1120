import { ErrorDetails } from "@/lib/i18n/errors";
import { ui, useLocale, getLocale } from "@/lib/i18n";
import { IconDeviceMobile, IconDevices, IconSend } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
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
import {
  deliveryQueryOptions,
  type Reachability,
  removePushDeviceMutationOptions,
} from "@/lib/delivery";
import { queryClient } from "@/query-client";

const PLATFORM: Record<"ios" | "android", string> = {
  ios: "iOS",
  android: "Android",
};

type Delivery = Reachability["deliveries"][number];

/** Each channel as the switches under "Where updates go" name it. */
const CHANNEL: Record<Delivery["transport"], string> = {
  push: "Push",
  slack: "Slack",
  teams: "Microsoft Teams",
  sms: "SMS",
};

/**
 * What a delivery was about, as the kind of update it was routed under in "Where updates go", so a
 * row can be matched to the switch that let it through: a Bot's reply goes out as Progress, an
 * approval as a Decision, and a check-in ping as Something needs you.
 */
const KIND: Record<Delivery["kind"], string> = {
  reply: "Progress",
  approval: "Decision",
  question: "Question",
  attention: "Something needs you",
};

/**
 * Where a delivery got to. `accepted` is the provider taking it without saying yet that it arrived,
 * and `unknown` is a send that may or may not have gone; the error under the row says which.
 */
const STATE: Record<Delivery["state"], string> = {
  queued: "Waiting to send",
  running: "Sending",
  accepted: "Sending",
  sent: "Sent",
  delivered: "Delivered",
  failed: "Failed",
  unknown: "Not confirmed",
  opted_out: "Not sent",
};

/** The phones that receive push notifications for every one of the person's Bots. */
export function NativeDevices() {
  useLocale();
  const reach = useQuery(deliveryQueryOptions());
  const remove = useMutation(removePushDeviceMutationOptions(queryClient));
  const error = reach.error ?? remove.error;
  return (
    <PageSection
      description={ui(
        "Sign in to the OpenBot app on your phone and turn on notifications to add it here.",
      )}
      title={ui("Your devices")}
    >
      {error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {<ErrorDetails error={error} />}
        </p>
      ) : null}
      {reach.isPending || !reach.data ? null : reach.data.devices.length ===
        0 ? (
        <PageEmpty icon={IconDevices} title={ui("No devices yet")}>
          {ui("Phones and computers you sign in on show up here.")}
        </PageEmpty>
      ) : (
        <PageRows>
          {reach.data.devices.map((device, index) => (
            <Fragment key={device.id}>
              {index > 0 ? <Separator /> : null}
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconDeviceMobile />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{PLATFORM[device.platform]}</ItemTitle>
                </ItemContent>
                <ItemActions>
                  <Button
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(device.id)}
                    size="sm"
                    variant="outline"
                  >
                    {ui("Remove")}
                  </Button>
                </ItemActions>
              </Item>
            </Fragment>
          ))}
        </PageRows>
      )}
    </PageSection>
  );
}

/** What was sent to the person outside the web app, most recent first, with any failure. */
export function RecentDeliveries() {
  useLocale();
  const reach = useQuery(deliveryQueryOptions());
  return (
    <PageSection title={ui("Recent deliveries")}>
      {reach.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {<ErrorDetails error={reach.error} />}
        </p>
      ) : null}
      {reach.isPending || !reach.data ? null : reach.data.deliveries.length ===
        0 ? (
        <PageEmpty icon={IconSend} title={ui("No deliveries yet")}>
          {ui("Notifications sent to your devices show up here.")}
        </PageEmpty>
      ) : (
        <PageRows>
          {reach.data.deliveries.map((delivery, index) => (
            <Fragment key={delivery.id}>
              {index > 0 ? <Separator /> : null}
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconSend />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{KIND[delivery.kind]}</ItemTitle>
                  <ItemDescription>
                    {CHANNEL[delivery.transport]} · {STATE[delivery.state]} ·{" "}
                    {new Date(delivery.createdAt).toLocaleString(getLocale())}
                  </ItemDescription>
                  {delivery.error ? (
                    <ItemDescription className="line-clamp-none text-destructive">
                      {delivery.error}
                    </ItemDescription>
                  ) : null}
                </ItemContent>
              </Item>
            </Fragment>
          ))}
        </PageRows>
      )}
    </PageSection>
  );
}
