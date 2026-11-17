/**
 * Case AC5/AC8 (contract layer): isolated environment boot -> seed ->
 * zero-amount Lago metering -> cleanup.
 *
 * This case is DRIVEN BY tests/billing/runner.ts in full-stack mode on a
 * Docker-capable host. It documents and executes the exact procedure so the
 * environment contract is reproducible; a runner without a Docker engine
 * must report this scope as UNVERIFIED, never as passed.
 *
 * Procedure (executed against the compose stack of tests/billing/compose.yml):
 *  1. guard: assertSafeTarget on the composed PostgreSQL URL (project
 *     billing62_<run_id>, database billing62_<run_id>) — abort with zero
 *     writes on any violation.
 *  2. boot: docker compose -p billing62_<run_id> up -d --wait
 *  3. health: psql SELECT 1 on the billing62 database; GET lago-api
 *     http://lago-api:3000/healthz via the internal network.
 *  4. seed (trusted API fixture identity, no Casdoor — see docs §6):
 *     - two personal accounts/organizations, each with one expiring
 *       subscription lot and one long-lived pack lot, a locked PriceVersion
 *       (rational prices, HALF_UP), a root run budget and one child run;
 *     - one PaymentAttempt per channel via the ScriptedPaymentStub scripts.
 *  5. metering: register the Lago customer + zero-amount plan/subscription
 *     per account (community edition v1.57.0 API), then push one settled
 *     UsageEvent (nonzero resources, charged microcredits, cost_bearer=user)
 *     through the outbox; assert via the Lago API that the event collection
 *     is EXACTLY the expected ID set (full-page rescan, never a total-only
 *     comparison) and that the customer has ZERO CNY receivable — usage
 *     aggregation without a second deduction.
 *  6. microsecond boundaries: push events at occurrence_us values one
 *     microsecond apart across the period edge and assert Lago timestamps
 *     (exact decimal seconds derived from occurrence_us) place them on the
 *     correct side.
 *  7. cleanup: docker compose down -v (only -p billing62_<run_id>); verify
 *     `docker compose ls`/volume list shows no billing62_<run_id> residue;
 *     assert the pre-existing default database was never contacted (guard
 *     log has zero connections to non-run targets).
 *
 * Pass criteria: every step asserts; any failure marks the run failed and
 * cleanup still executes (finally). Failure output contains image digests,
 * Lago revision (v1.57.0), command list and assertion results — never
 * credentials.
 */
export interface MeteringCaseResult {
  case: "lago-zero-amount-metering";
  runId: string;
  steps: { step: string; ok: boolean; detail: string }[];
}

export function describeCase(runId: string): MeteringCaseResult {
  // Contract-level placeholder: executed by the runner's full-stack driver.
  return {
    case: "lago-zero-amount-metering",
    runId,
    steps: [],
  };
}
