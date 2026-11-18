import { ui, useLocale } from "@/lib/i18n";
import { z } from "zod";
import type { GalleryComponent } from "@/lib/copilot/gallery-registry";
import { GalleryFrame } from "./frame";
import { GalleryMarkdown } from "./markdown";

export const QuoteCardProps = z.object({
  quote: z
    .string()
    .describe("The quotation itself, without surrounding quote marks"),
  attribution: z
    .string()
    .describe(
      "Who said or wrote it, e.g. 'Grace Hopper' or 'the 2026 annual report'",
    ),
  context: z
    .string()
    .optional()
    .describe(
      "One short line of context: where it is from, or why it matters here",
    ),
});

type QuoteArgs = z.infer<typeof QuoteCardProps>;

export function QuoteCard({ quote, attribution, context }: Partial<QuoteArgs>) {
  useLocale();
  if (!quote) {
    return (
      <GalleryFrame title={ui("Quotation")}>
        <p className="text-sm text-muted-foreground">
          {ui("There is nothing to quote.")}
        </p>
      </GalleryFrame>
    );
  }

  return (
    <GalleryFrame caption={context} title={ui("Quotation")}>
      <blockquote className="border-l-2 border-border pl-4">
        <GalleryMarkdown className="text-sm leading-relaxed">
          {quote}
        </GalleryMarkdown>
        {attribution ? (
          <footer className="mt-2 text-xs text-muted-foreground">
            {attribution}
          </footer>
        ) : null}
      </blockquote>
    </GalleryFrame>
  );
}

export const GALLERY: GalleryComponent[] = [
  {
    name: "showQuote",
    get title() {
      return ui("Quotation");
    },
    kind: "card",
    get summary() {
      return ui("Shows a quotation and who said or wrote it.");
    },
    get description() {
      return "Show a quotation with its attribution. Use when the exact words matter, something a person said, or a line from a document you were given.";
    },
    parameters: QuoteCardProps,
    Component: QuoteCard as GalleryComponent["Component"],
    preview: {
      quote:
        "Meals under $75 need no receipt. Anything above needs one, and anything above $500 needs your manager before you spend it.",
      attribution: "the expense policy",
      context: "Last changed in March.",
    },
    confirmation: "The quotation is now on screen for the person.",
  },
];
