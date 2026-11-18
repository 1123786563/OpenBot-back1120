import { ui, useLocale, uiNodes } from "@/lib/i18n";
import { IconPalette } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { appConfig } from "@/lib/generated/application-config";
import {
  saveSkinMutationOptions,
  useUserPreferences,
} from "@/lib/settings/message-list";
import { SKINS } from "./registry";
import { useSkinId } from "./store";
import { SKIN_IDS } from "./types";

/**
 * Choose a skin. It is drawn at once and saved on the person's account, so it follows them to every
 * device. Until the account's preferences have loaded there is nothing to save against, so the
 * control waits for them.
 */
export function SkinPicker() {
  useLocale();
  const skin = useSkinId();
  const preferences = useUserPreferences();
  const queryClient = useQueryClient();
  const save = useMutation(
    saveSkinMutationOptions(queryClient, preferences.userId),
  );

  return (
    <>
      <Item size="sm">
        <ItemMedia variant="icon">
          <IconPalette />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>{ui("Skin")}</ItemTitle>
          <ItemDescription>
            {uiNodes(
              "Change how {{slot0}}looks for you, on every device. Every skin keeps everything {{slot1}} does.",
              [appConfig.brand.productName, appConfig.brand.productName],
            )}
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <Select
            disabled={!preferences.data || save.isPending}
            value={skin}
            onValueChange={(value) => {
              const id = SKIN_IDS.find((known) => known === value);
              if (id && id !== skin) save.mutate(id);
            }}
          >
            <SelectTrigger aria-label={ui("Skin")}>
              <SelectValue>{SKINS[skin].name}</SelectValue>
            </SelectTrigger>
            {/* Wider than the trigger, so each skin's description has room to wrap. */}
            <SelectContent
              align="end"
              alignItemWithTrigger={false}
              className="w-72"
            >
              {SKIN_IDS.map((id) => (
                <SelectItem className="py-1.5" key={id} value={id}>
                  <span className="flex min-w-0 flex-col gap-0.5 whitespace-normal">
                    <span>{SKINS[id].name}</span>
                    <span className="text-muted-foreground text-xs">
                      {SKINS[id].description}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </ItemActions>
      </Item>
      {save.isError ? (
        <p className="px-3 pb-3 text-sm text-destructive" role="alert">
          {uiNodes(
            "Couldn't save that skin to your account, so {{slot0}}is back. Try again.",
            [SKINS[skin].name],
          )}
        </p>
      ) : null}
    </>
  );
}
