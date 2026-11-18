import { ui } from "@/lib/i18n";
/**
 * How widely something is granted, in words rather than a fraction.
 *
 * "0/3" needs decoding and reads as a score. The two ends are the ones worth recognising without
 * reading (nothing holds it, or everything does), so they are named, and the middle is the only
 * case that gets a number.
 */
export function grantSummary(held: number, total: number): string {
  if (held === 0) return ui("No Bots");
  if (held === total) return total === 1 ? ui("1 Bot") : ui("All Bots");
  return ui("{{value0}} of {{value1}} Bots", {
    value0: String(held),
    value1: String(total),
  });
}
