import { Link } from "@tanstack/react-router";
import { ui, useLocale } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * Beside Routines in a list of apps a Bot can use: what asking for one sounds like, and the way to
 * the Routines page. Without it, Routines reads as one more app next to Gmail, with no hint that it
 * means "do this on a schedule".
 */
export function RoutinesAppHint({ stacked = false }: { stacked?: boolean }) {
  useLocale();
  return (
    <span
      className={cn(
        "ml-auto flex min-w-0 items-center gap-2 text-muted-foreground text-xs",
        stacked &&
          "basis-full flex-wrap pb-2 pl-3 sm:basis-auto sm:pb-0 sm:pl-0",
      )}
    >
      <span className={stacked ? undefined : "truncate"}>
        {ui("e.g. “every weekday at 9, send me…”")}
      </span>
      <Link
        className="shrink-0 font-medium text-foreground underline-offset-2 hover:underline"
        to="/routines"
      >
        {ui("Open Routines")}
      </Link>
    </span>
  );
}
