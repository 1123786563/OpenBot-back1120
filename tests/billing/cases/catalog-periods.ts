/**
 * Case #65 (catalog & periods): the exact-amount and Beijing-time evidence
 * the implementation ticket must produce, executed through the PRODUCTION
 * billing-catalog module and a real PostgreSQL.
 *
 * Layer 1 (pure, always executed): the calendar rules over integer
 * microseconds — leap-year clamp, common-year clamp, clamp-then-restore,
 * cross-year, half-open microsecond boundary attribution. These are the
 * contract's own examples, fixed before the module existed.
 *
 * Layer 2 (driven by tests/billing/runner.ts full/catalog phases): the
 * business-level suite `server/tests/billing-catalog.integration.test.ts`
 * against a REAL isolated PostgreSQL 17 — publish/selection integrity,
 * sellability closure, pinned-version step pricing and restart replay, the
 * eligibility table over the trusted projection, and the negative space.
 *
 * Layer 3 (full phase only): the Lago CE v1.57.0 zero-amount metering
 * evidence — nonzero resources with zero CNY receivable, event-ID set
 * equality by full-page rescan, and occurrence_us values one microsecond
 * apart across a Beijing period boundary. Failure or absence of this layer is
 * reported as UNVERIFIED scope, never as passed.
 *
 * Credentials for layers 2/3 are generated one-time by the runner and never
 * appear in output; cleanup touches only this run's containers/volumes.
 */

import {
  type LocalWallTime,
  localToUtcUs,
  periodByIndex,
  periodOf,
} from "../../../server/src/billing-catalog/periods";
import { stepCostMicrocreditsExact } from "../../../server/src/billing-catalog/pricing";

export interface CatalogPeriodsResult {
  case: "catalog-periods";
  layer1: { step: string; ok: boolean; detail: string }[];
  layer2Command: string;
  layer3Command: string;
}

const ANCHOR = (us: number): LocalWallTime => ({
  year: 2024,
  month: 1,
  day: 31,
  hour: Math.floor(us / 10) % 24,
  minute: 30,
  second: 15,
  microsecond: 123456,
});

export function runCatalogPeriodsLayer1(): CatalogPeriodsResult["layer1"] {
  const steps: CatalogPeriodsResult["layer1"] = [];
  const ok = (cond: boolean, step: string, detail: string) =>
    steps.push({ step, ok: cond, detail });

  // A8: 2024-01-31 09:30:15.123456 +08 anchors Feb 29 then Mar 31.
  const jan31: LocalWallTime = {
    year: 2024,
    month: 1,
    day: 31,
    hour: 9,
    minute: 30,
    second: 15,
    microsecond: 123456,
  };
  const b0 = periodByIndex(jan31, 0n);
  const b1 = periodByIndex(jan31, 1n);
  const b2 = periodByIndex(jan31, 2n);
  ok(
    b0.startIso === "2024-01-31T01:30:15.123456Z" &&
      b0.endIso === "2024-02-29T01:30:15.123456Z",
    "A8 leap-year first period",
    `${b0.startIso} .. ${b0.endIso}`,
  );
  ok(
    b1.endIso === "2024-03-31T01:30:15.123456Z",
    "A8 clamp restores the original day",
    `B(2) = ${b2.startIso}`,
  );

  // A9: common year clamps to 02-28 and restores 03-31; the clamp never leaks.
  const jan31_2025: LocalWallTime = { ...jan31, year: 2025 };
  const c1 = periodByIndex(jan31_2025, 1n);
  const c2 = periodByIndex(jan31_2025, 2n);
  ok(
    c1.startIso.endsWith("T01:30:15.123456Z") &&
      periodByIndex(jan31_2025, 1n).startLocal.day === 28,
    "A9 common-year clamp to Feb 28",
    `B(1) local day = ${c1.startLocal.day}`,
  );
  ok(
    c2.startLocal.day === 31 && c2.startLocal.month === 3,
    "A9 original day restored after the short month",
    `B(2) local = ${c2.startLocal.year}-${c2.startLocal.month}-${c2.startLocal.day}`,
  );

  // A9: August (31d) -> September (30d) -> October (31d), non-zero time kept.
  const aug31: LocalWallTime = { ...jan31, month: 8, microsecond: 1 };
  const a1 = periodByIndex(aug31, 1n);
  const a2 = periodByIndex(aug31, 2n);
  ok(
    a1.startLocal.day === 30 &&
      a2.startLocal.day === 31 &&
      a1.startLocal.microsecond === 1,
    "A9 big-small month chain with microsecond fidelity",
    `B(1)=${a1.startLocal.day} B(2)=${a2.startLocal.day} µs=${a1.startLocal.microsecond}`,
  );

  // A10: exactly-at-boundary belongs to the NEXT period; -1µs stays in the old one.
  const atBoundary = periodOf(jan31, b1.startUs);
  const beforeBoundary = periodOf(jan31, b1.startUs - 1n);
  ok(
    atBoundary.index === 1n && beforeBoundary.index === 0n,
    "A10 half-open boundary attribution at ±1µs",
    `at=${atBoundary.index} before=${beforeBoundary.index}`,
  );

  // A3: 0.0000004 + 0.0000001 + 0.0000004 credits -> exactly 1 microcredit.
  const perMillionth = (n: number) => ({
    numerator: BigInt(n),
    denominator: 10_000_000n,
    unitSize: 1n,
  });
  const micro = stepCostMicrocreditsExact([
    { resource: "model_input_tokens", quantity: 1n, price: perMillionth(4) },
    { resource: "model_output_tokens", quantity: 1n, price: perMillionth(1) },
    {
      resource: "model_cache_read_tokens",
      quantity: 1n,
      price: perMillionth(4),
    },
  ]);
  ok(
    micro === 1n,
    "A3 exact sum then one rounding",
    `0.4+0.1+0.4 µcredit -> ${micro}`,
  );

  // Timezone integrity: a DST-gap wall time is rejected, never shifted.
  let gapRejected = false;
  try {
    localToUtcUs({
      year: 1988,
      month: 4,
      day: 17,
      hour: 2,
      minute: 30,
      second: 0,
      microsecond: 0,
    });
  } catch {
    gapRejected = true;
  }
  ok(
    gapRejected,
    "R4 nonexistent wall time rejected",
    "1988-04-17 02:30 +08 (DST gap)",
  );

  void ANCHOR; // kept for the documented layer-2 fixture shapes
  return steps;
}

export function describeCase(runId: string): CatalogPeriodsResult {
  return {
    case: "catalog-periods",
    layer1: runCatalogPeriodsLayer1(),
    // Executed by the runner against the isolated billing62_<run_id> database.
    layer2Command:
      "TEST_DATABASE_URL=<billing62_<run_id> url> bun test server/tests/billing-catalog.integration.test.ts",
    layer3Command: `BILLING62_RUN_ID=${runId} docker compose -p billing62_${runId} -f tests/billing/compose.yml up -d --wait`,
  };
}
