import { ui, useLocale } from "@/lib/i18n";
import { IconKey, IconPlug } from "@tabler/icons-react";
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

/** Admin, Plugins: the allowlist of MCP servers Bots may call tools on. */
export function McpAllowlistSection() {
  useLocale();
  return (
    <ControlsSection
      description={ui(
        "With the allowlist on, Bots can only call tools on the MCP servers approved here. Calls to any other server are refused.",
      )}
      title={ui("MCP servers")}
    >
      {({ data, setSetting, saving }) => {
        const { mcpAllowlist } = data.settings;
        return (
          <PageRows>
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconPlug />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{ui("Only approved servers")}</ItemTitle>
                <ItemDescription>
                  {mcpAllowlist.enabled
                    ? ui("{{value0}} approved", {
                        value0: String(mcpAllowlist.servers.length),
                      })
                    : ui(
                        "Off. Bots can use any registered server they have access to.",
                      )}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Switch
                  aria-label={ui("Only approved MCP servers")}
                  checked={mcpAllowlist.enabled}
                  disabled={saving}
                  onCheckedChange={(enabled) =>
                    setSetting("mcpAllowlist", { ...mcpAllowlist, enabled })
                  }
                />
              </ItemActions>
            </Item>
            {data.mcpServers.map((server) => (
              <div key={server.id}>
                <Separator />
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <IconKey />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{server.title}</ItemTitle>
                    <ItemDescription>{server.url}</ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Switch
                      aria-label={ui("Approve {{value0}}", {
                        value0: String(server.title),
                      })}
                      checked={mcpAllowlist.servers.includes(server.id)}
                      disabled={saving}
                      onCheckedChange={(checked) =>
                        setSetting("mcpAllowlist", {
                          ...mcpAllowlist,
                          servers: checked
                            ? [...mcpAllowlist.servers, server.id]
                            : mcpAllowlist.servers.filter(
                                (id) => id !== server.id,
                              ),
                        })
                      }
                    />
                  </ItemActions>
                </Item>
              </div>
            ))}
          </PageRows>
        );
      }}
    </ControlsSection>
  );
}
