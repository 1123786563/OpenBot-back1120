import { ErrorDetails } from "@/lib/i18n/errors";
import { ui, useLocale } from "@/lib/i18n";
import type { UseQueryResult } from "@tanstack/react-query";
import { DryRunChanges } from "@/components/boundaries/dry-run-changes";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import type { DryRunReport } from "@/lib/computers/queries";

/**
 * What the rule would have stopped, worked out as it is written: a Bot's computer actions and its
 * app calls, in one list. A rule that can't be evaluated says why here, under the rule, and nothing
 * is replayed. The first answer arrives into an empty space, with no placeholder before it.
 *
 * Shared by Add rule and a rule's own page, which both replay the rule in the editor on its own.
 */
export function RulePreview({
  preview,
}: {
  preview: UseQueryResult<DryRunReport>;
}) {
  useLocale();
  if (preview.isPending) return null;
  return (
    <Field aria-labelledby="rule-preview" aria-live="polite">
      <FieldLabel id="rule-preview">{ui("On recent activity")}</FieldLabel>
      {preview.error ? (
        <p className="text-destructive text-sm" role="alert">
          {<ErrorDetails error={preview.error} />}
        </p>
      ) : preview.data.scanned === 0 ? (
        <FieldDescription>
          {ui(
            "No recorded actions to test against yet. You'll see what this rule stops once Bots have acted.",
          )}
        </FieldDescription>
      ) : (
        <div>
          <FieldDescription>
            {preview.data.wouldRefuse === 0
              ? ui(
                  "Of the last {{value0}} recorded actions, this rule would have stopped none. It may still stop future ones.",
                  { value0: String(preview.data.scanned) },
                )
              : ui(
                  "Of the last {{value0}} recorded actions, this rule would have stopped {{value1}}.",
                  {
                    value0: String(preview.data.scanned),
                    value1: String(preview.data.wouldRefuse),
                  },
                )}
          </FieldDescription>
          <DryRunChanges
            changes={preview.data.changes.filter(
              (change) => change.would === "refused",
            )}
            total={preview.data.wouldRefuse}
            verdict={ui("Would stop")}
          />
        </div>
      )}
    </Field>
  );
}
