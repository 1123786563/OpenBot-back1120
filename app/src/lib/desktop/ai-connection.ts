import { ui } from "@/lib/i18n";
import type { DesktopAiConnection } from "./queries";

/** One line of the AI model dialog: what it is, and this installation's answer. */
export type AiConnectionDetail = { label: string; value: string };

/** The AI connection in a person's words: who provides it, how OpenBot signs in, and the model. */
export type AiConnectionSummary = {
  provider: string;
  /** The row's second line: how OpenBot signs in, and the model when one was named. */
  summary: string;
  details: AiConnectionDetail[];
};

/**
 * The addresses the setup window fills in for a provider's own row (`endpointPresets` in
 * desktop/src/ProviderPicker.tsx), by host. Any other address is the person's own.
 */
const PRESET_HOSTS: Record<string, string> = {
  "generativelanguage.googleapis.com": "Google Gemini",
  "api.x.ai": "xAI",
  "api.unbiased.ai": "Unbiased AI",
};

function signedIn(
  kind: NonNullable<DesktopAiConnection["kind"]>,
  host: string | null,
): { provider: string; signIn: string; said: string } {
  switch (kind) {
    case "claude-plan":
      return {
        provider: "Anthropic",
        signIn: ui("Claude plan"),
        said: ui("Signed in with your Claude plan."),
      };
    case "chat-gpt-plan":
      return {
        provider: "OpenAI",
        signIn: ui("ChatGPT plan"),
        said: ui("Signed in with your ChatGPT plan."),
      };
    case "anthropic-api-key":
      return {
        provider: "Anthropic",
        signIn: ui("API key"),
        said: ui("Uses your Anthropic API key."),
      };
    case "open-ai-api-key":
      return {
        provider: "OpenAI",
        signIn: ui("API key"),
        said: ui("Uses your OpenAI API key."),
      };
    case "google-oauth":
      return {
        provider: ui("Google Gemini"),
        signIn: ui("Google account"),
        said: ui("Signed in with your Google account."),
      };
    case "xai-oauth":
      return {
        provider: "xAI",
        signIn: ui("xAI account"),
        said: ui("Signed in with your xAI account."),
      };
    case "compatible-endpoint": {
      const preset = host ? PRESET_HOSTS[host] : undefined;
      if (preset)
        return {
          provider: preset,
          signIn: ui("API key"),
          said: ui("Uses your {{provider}} API key.", { provider: preset }),
        };
      return {
        provider: "OpenAI-compatible",
        signIn: host ?? ui("Your own address"),
        said: host
          ? ui("Connected to {{host}}.", { host })
          : ui("Connected to your own address."),
      };
    }
  }
}

/** What Settings says about the AI connection; null when none has been chosen yet. */
export function describeAiConnection(
  connection: DesktopAiConnection,
): AiConnectionSummary | null {
  if (!connection.kind) return null;
  const { provider, signIn, said } = signedIn(
    connection.kind,
    connection.endpointHost,
  );
  const details: AiConnectionDetail[] = [
    { label: ui("Provider"), value: provider },
    {
      label:
        connection.kind === "compatible-endpoint" &&
        !PRESET_HOSTS[connection.endpointHost ?? ""]
          ? ui("Address")
          : ui("Sign-in"),
      value: signIn,
    },
  ];
  if (connection.model)
    details.push({ label: ui("Model"), value: connection.model });
  return {
    provider,
    summary: connection.model
      ? ui("{{value0}} Model: {{value1}}", {
          value0: String(said),
          value1: String(connection.model),
        })
      : said,
    details,
  };
}
