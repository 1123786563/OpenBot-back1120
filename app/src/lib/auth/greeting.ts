import { ui } from "@/lib/i18n";
import type { AuthenticatedUser } from "./queries";

/** Keep the welcome out of message history, and never guess a first name. */
export function firstConversationGreeting(
  user: AuthenticatedUser | null | undefined,
  noConversations: boolean,
): string {
  const name = user?.name?.trim();
  if (!noConversations || !name || user?.needsName || name === user?.email)
    return ui("Start a conversation");
  return ui("Hi {{name}}, what would you like to work on?", { name });
}
