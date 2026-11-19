/**
 * Purchase eligibility (#65) — the observable renewal / tier-change /
 * refund-block decisions of requirement R5/R6.
 *
 * This module is a PURE function of a trusted state snapshot. It never reads
 * client claims: refunds, prepaid commitments and subscription state arrive
 * only from the trusted projection (order/refund services), each snapshot
 * carrying its state_revision and observed_at_us. The module returns a
 * deterministic outcome plus the reason and next action the order service
 * must surface; the ORDER service (not this module) rechecks state_revision
 * and re-queries before committing a purchase — a query can never reserve
 * eligibility.
 *
 * Out of scope here (owned by #66/#68/#71): creating orders, the refund state
 * machine, idempotent grant execution, and the "at most one prepaid period"
 * uniqueness constraint — this module only DESCRIBES what a purchase attempt
 * should observe, and #68 must treat a stale revision as 409 state_conflict.
 */

import {
  BillingValueError,
  parseTimestampUs,
} from "../billing-contract/money-time.js";
import { type LocalWallTime, periodByIndex, periodOf } from "./periods.js";

/** Why a purchase attempt is allowed or blocked (closed set; contract mirrors this). */
export const ELIGIBILITY_REASONS = [
  "eligible",
  "already_prepaid",
  "refund_required",
  "refund_pending",
  "refund_outcome_unknown",
  "state_conflict",
] as const;
export type EligibilityReason = (typeof ELIGIBILITY_REASONS)[number];

/** What the caller should do next (closed set). */
export const ELIGIBILITY_NEXT_ACTIONS = [
  "create_order",
  "refund_existing_prepurchase_first",
  "wait_for_refund_outcome",
  "keep_existing_commitment",
  "recheck_state",
] as const;
export type EligibilityNextAction = (typeof ELIGIBILITY_NEXT_ACTIONS)[number];

/** Trusted refund fact for the target period (never a client report). */
export interface TrustedRefundFact {
  /** Stable refund id from the order/refund service. */
  refundId: string;
  /** Processing or unknown both BLOCK repurchase; only succeeded unblocks (then rechecked). */
  status:
    | "processing"
    | "unknown"
    | "succeeded"
    | "failed"
    | "rejected"
    | "revoked";
}

/** Trusted subscription + commitment projection for one billing account. */
export interface TrustedSubscriptionSnapshot {
  /**
   * Optimistic-concurrency revision of the whole snapshot; the order service
   * must recheck it in the purchase transaction.
   */
  stateRevision: bigint;
  /** Server-observed time of the snapshot (trusted clock domain, microseconds). */
  observedAtUs: bigint;
  /** Null when the account has never had a subscription. */
  subscription: {
    /** Original activation anchor (Asia/Shanghai local fields + UTC instant). */
    anchor: LocalWallTime;
    /** Current period index the subscription is living in (or last lived in). */
    currentPeriodIndex: bigint;
    /** active until its end boundary, expired afterwards. */
    status: "active" | "expired";
    /** The tier currently in effect (product_id of the monthly plan). */
    currentProductId: string;
    /** Prepaid next-period commitment, at most one. */
    prepaid: {
      /** Product id committed for the next period. */
      productId: string;
      /** First microsecond of the committed period. */
      targetPeriodStartUs: bigint;
      /** Target period index (derived from the anchor). */
      targetPeriodIndex: bigint;
    } | null;
  } | null;
  /** Refund facts scoped to the target period only; unrelated packs never appear. */
  refundsForTargetPeriod: TrustedRefundFact[];
}

export interface EligibilityInput {
  /** The product this purchase attempt is for. */
  requestedProductId: string;
  /**
   * The product type of the attempt. MONTHLY PLANS live on the subscription
   * cycle and follow the renewal/tier-change/refund table; LONG-LIVED CREDIT
   * PACKS are independent of it — a subscription commitment (prepaid next
   * period, its renewal or a refund scoped to that period) must never block
   * buying a pack.
   */
  requestedProductType: "monthly_plan" | "credit_pack";
  /** Trusted evaluation instant (server clock, never a client-provided now). */
  nowUs: bigint;
  snapshot: TrustedSubscriptionSnapshot;
}

export interface EligibilityOutcome {
  allowed: boolean;
  reason: EligibilityReason;
  nextAction: EligibilityNextAction;
  /**
   * The period this purchase would take effect for: the next period for a
   * renewal/tier change on an active subscription; for a fresh/expired
   * purchase the anchor is NOT known yet (activation defines it), so
   * targetPeriod is null and the quote returns only a preview computed by the
   * period service from a hypothetical anchor.
   */
  targetPeriod: { index: bigint; startUs: bigint; endUs: bigint } | null;
  /** The snapshot revision this outcome was computed from. */
  stateRevision: bigint;
  /** Present when blocked by an existing commitment, so the caller can show it. */
  existingCommitment: { productId: string; targetPeriodStartUs: bigint } | null;
}

function bad(message: string): never {
  throw new BillingValueError("out_of_range", message);
}

/**
 * Evaluate one purchase attempt. Deterministic and side-effect free.
 */
export function evaluatePurchaseEligibility(
  input: EligibilityInput,
): EligibilityOutcome {
  const now = parseTimestampUs(input.nowUs.toString());
  const snap = input.snapshot;
  if (!snap) bad("a trusted subscription snapshot is required");

  const fail = (
    reason: EligibilityReason,
    nextAction: EligibilityNextAction,
    existingCommitment: EligibilityOutcome["existingCommitment"] = null,
    targetPeriod: EligibilityOutcome["targetPeriod"] = null,
  ): EligibilityOutcome => ({
    allowed: false,
    reason,
    nextAction,
    targetPeriod,
    stateRevision: snap.stateRevision,
    existingCommitment,
  });

  // Fresh purchase or expired without commitment: activation will set a new
  // anchor; gaps are never back-filled or charged.
  const sub = snap.subscription;
  if (!sub) {
    return {
      allowed: true,
      reason: "eligible",
      nextAction: "create_order",
      targetPeriod: null,
      stateRevision: snap.stateRevision,
      existingCommitment: null,
    };
  }

  const nextIndex = sub.currentPeriodIndex + 1n;

  // Long-lived credit packs stand OUTSIDE the subscription cycle: whatever the
  // subscription's prepaid commitment, its renewal state or that period's
  // refund facts say, buying a pack is allowed (pack-level duplicate/refund
  // checks belong to the order service #68; no target period applies).
  if (input.requestedProductType === "credit_pack") {
    return {
      allowed: true,
      reason: "eligible",
      nextAction: "create_order",
      targetPeriod: null,
      stateRevision: snap.stateRevision,
      existingCommitment: null,
    };
  }

  // A prepaid commitment exists: the purchase continues it, whatever the wall
  // clock says — an attempt at the boundary with a prepaid next period is a
  // continuation of the original anchor, never an expired re-purchase. A
  // refund that is processing/unknown for that period takes precedence over
  // every other answer: while its outcome is open, NO repurchase of the
  // period is allowed, not even of the already-committed product.
  if (sub.prepaid) {
    const prepaid = sub.prepaid;
    const commitment = {
      productId: prepaid.productId,
      targetPeriodStartUs: prepaid.targetPeriodStartUs,
    };
    const blocking = snap.refundsForTargetPeriod.find(
      (r) => r.status === "processing" || r.status === "unknown",
    );
    if (blocking) {
      return fail(
        blocking.status === "processing"
          ? "refund_pending"
          : "refund_outcome_unknown",
        "wait_for_refund_outcome",
        commitment,
      );
    }
    if (prepaid.productId === input.requestedProductId) {
      return fail("already_prepaid", "keep_existing_commitment", commitment);
    }
    // Different product while a commitment is live: refund first, then buy.
    return fail(
      "refund_required",
      "refund_existing_prepurchase_first",
      commitment,
    );
  }

  // Subscription expired with no commitment: a NEW anchor starts at activation.
  if (sub.status === "expired") {
    return {
      allowed: true,
      reason: "eligible",
      nextAction: "create_order",
      targetPeriod: null,
      stateRevision: snap.stateRevision,
      existingCommitment: null,
    };
  }

  // Active subscription, no commitment. A refund against the NEXT period that
  // succeeded means the previous commitment was refunded — repurchase is
  // allowed after recheck; processing/unknown blocks; failed/revoked leaves
  // no commitment (handled above as none) so the purchase proceeds.
  const nextPeriod = periodByIndex(sub.anchor, nextIndex);
  const blockingRefund = snap.refundsForTargetPeriod.find(
    (r) => r.status === "processing" || r.status === "unknown",
  );
  if (blockingRefund) {
    return fail(
      blockingRefund.status === "processing"
        ? "refund_pending"
        : "refund_outcome_unknown",
      "wait_for_refund_outcome",
      null,
      {
        index: nextPeriod.index,
        startUs: nextPeriod.startUs,
        endUs: nextPeriod.endUs,
      },
    );
  }

  // The committed next period must not have started already: if it has, the
  // snapshot is behind the wall clock and the caller must recheck (the order
  // service turns this into 409 state_conflict).
  if (now >= nextPeriod.startUs) {
    return fail("state_conflict", "recheck_state");
  }

  return {
    allowed: true,
    reason: "eligible",
    nextAction: "create_order",
    targetPeriod: {
      index: nextPeriod.index,
      startUs: nextPeriod.startUs,
      endUs: nextPeriod.endUs,
    },
    stateRevision: snap.stateRevision,
    existingCommitment: null,
  };
}

/**
 * The deterministic due-action for a prepaid next-period commitment
 * (grant_at_us = next_period_start_us). Before the boundary there is nothing
 * due; exactly at the boundary the commitment becomes due ONCE, keyed by
 * (subscription identity, period index, grant) — the executing ticket (#68)
 * owns idempotency; this module only derives the time and identity.
 */
export function prepaidGrantDueAction(args: {
  /** Stable subscription identity of the commitment holder. */
  subscriptionId: string;
  snapshot: NonNullable<TrustedSubscriptionSnapshot>;
  nowUs: bigint;
}): {
  due: boolean;
  grantAtUs: bigint;
  /** Business identity of the single grant action. */
  actionIdentity: string;
  periodIndex: bigint;
} {
  const prepaid = args.snapshot.subscription?.prepaid;
  if (!prepaid) bad("no prepaid commitment to evaluate");
  const now = parseTimestampUs(args.nowUs.toString());
  const due = now >= prepaid.targetPeriodStartUs;
  return {
    due,
    grantAtUs: prepaid.targetPeriodStartUs,
    actionIdentity: `${args.subscriptionId}:${prepaid.targetPeriodIndex.toString()}:grant`,
    periodIndex: prepaid.targetPeriodIndex,
  };
}

/** Convenience: which period does an event at `occurrenceUs` belong to. */
export function periodForOccurrence(
  snapshot: NonNullable<TrustedSubscriptionSnapshot>,
  occurrenceUs: bigint,
) {
  const sub = snapshot.subscription;
  if (!sub) bad("no subscription anchor to locate a period with");
  return periodOf(sub.anchor, occurrenceUs);
}
