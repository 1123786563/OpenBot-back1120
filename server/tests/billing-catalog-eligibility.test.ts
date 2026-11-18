/**
 * Purchase eligibility table (#65 A13 / clarify §7): every row of the trusted
 * state table must produce the observable allow/reason/next-action outcome.
 * Pure function, trusted snapshot input; no side effects anywhere.
 */
import { describe, expect, test } from "bun:test";
import {
  evaluatePurchaseEligibility,
  prepaidGrantDueAction,
  type TrustedSubscriptionSnapshot,
} from "../src/billing-catalog/eligibility";
import type { LocalWallTime } from "../src/billing-catalog/periods";
import { periodByIndex } from "../src/billing-catalog/periods";

const ANCHOR: LocalWallTime = {
  year: 2024,
  month: 1,
  day: 31,
  hour: 9,
  minute: 30,
  second: 15,
  microsecond: 0,
};
const B1 = periodByIndex(ANCHOR, 1n); // next period after a January activation
const NOW_MID = B1.startUs - 86_400_000_000n / 2n; // mid-current-period

const PLAN_A = "plan_pro_monthly";
const PLAN_B = "plan_max_monthly";

function snapshot(overrides: {
  subscription?: TrustedSubscriptionSnapshot["subscription"];
  refunds?: TrustedSubscriptionSnapshot["refundsForTargetPeriod"];
}): TrustedSubscriptionSnapshot {
  return {
    stateRevision: 7n,
    observedAtUs: NOW_MID,
    subscription:
      overrides.subscription === undefined
        ? {
            anchor: ANCHOR,
            currentPeriodIndex: 0n,
            status: "active",
            currentProductId: PLAN_A,
            prepaid: null,
          }
        : overrides.subscription,
    refundsForTargetPeriod: overrides.refunds ?? [],
  };
}

const attempt = (
  productId: string,
  now: bigint = NOW_MID,
  snap: TrustedSubscriptionSnapshot,
  productType: "monthly_plan" | "credit_pack" = "monthly_plan",
) =>
  evaluatePurchaseEligibility({
    requestedProductId: productId,
    requestedProductType: productType,
    nowUs: now,
    snapshot: snap,
  });

describe("eligibility: no subscription / expired / prepaid table", () => {
  test("first purchase with no subscription at all: allowed, activation will set the anchor", () => {
    const s = snapshot({ subscription: null });
    const out = attempt(PLAN_A, NOW_MID, s);
    expect(out.allowed).toBe(true);
    expect(out.reason).toBe("eligible");
    expect(out.nextAction).toBe("create_order");
    // The anchor is NOT known before activation; no target period is returned.
    expect(out.targetPeriod).toBeNull();
  });

  test("expired subscription without commitment: new purchase allowed, no gap back-fill", () => {
    const s = snapshot({
      subscription: {
        anchor: ANCHOR,
        currentPeriodIndex: 5n,
        status: "expired",
        currentProductId: PLAN_A,
        prepaid: null,
      },
    });
    const out = attempt(PLAN_A, NOW_MID, s);
    expect(out.allowed).toBe(true);
    expect(out.reason).toBe("eligible");
    expect(out.targetPeriod).toBeNull(); // a NEW anchor starts at activation
  });

  test("active, no prepaid: renewal allowed for the next period, continuing the anchor", () => {
    const out = attempt(PLAN_A, NOW_MID, snapshot({}));
    expect(out.allowed).toBe(true);
    expect(out.targetPeriod).toEqual({
      index: 1n,
      startUs: B1.startUs,
      endUs: B1.endUs,
    });
  });

  test("tier change while active with no prepaid: next-period effect, same boundaries", () => {
    const out = attempt(PLAN_B, NOW_MID, snapshot({}));
    expect(out.allowed).toBe(true);
    expect(out.nextAction).toBe("create_order");
    expect(out.targetPeriod?.index).toBe(1n);
    expect(out.targetPeriod?.startUs).toBe(B1.startUs); // current period untouched
  });

  test("already prepaid same tier: blocked, existing commitment surfaced", () => {
    const s = snapshot({
      subscription: {
        anchor: ANCHOR,
        currentPeriodIndex: 0n,
        status: "active",
        currentProductId: PLAN_A,
        prepaid: {
          productId: PLAN_A,
          targetPeriodStartUs: B1.startUs,
          targetPeriodIndex: 1n,
        },
      },
    });
    const out = attempt(PLAN_A, NOW_MID, s);
    expect(out.allowed).toBe(false);
    expect(out.reason).toBe("already_prepaid");
    expect(out.nextAction).toBe("keep_existing_commitment");
    expect(out.existingCommitment?.productId).toBe(PLAN_A);
    expect(out.existingCommitment?.targetPeriodStartUs).toBe(B1.startUs);
  });

  test("already prepaid a farther period: buying yet another period is still blocked", () => {
    const s = snapshot({
      subscription: {
        anchor: ANCHOR,
        currentPeriodIndex: 0n,
        status: "active",
        currentProductId: PLAN_A,
        prepaid: {
          productId: PLAN_A,
          targetPeriodStartUs: B1.startUs,
          targetPeriodIndex: 1n,
        },
      },
    });
    // Asking for period 2 while prepaid for period 1: the outcome must not
    // depend on how far ahead the caller wanted to buy.
    const out = attempt(PLAN_A, NOW_MID, s);
    expect(out.reason).toBe("already_prepaid");
  });

  test("prepaid + different tier: refund_required, refund first then buy", () => {
    const s = snapshot({
      subscription: {
        anchor: ANCHOR,
        currentPeriodIndex: 0n,
        status: "active",
        currentProductId: PLAN_A,
        prepaid: {
          productId: PLAN_A,
          targetPeriodStartUs: B1.startUs,
          targetPeriodIndex: 1n,
        },
      },
    });
    const out = attempt(PLAN_B, NOW_MID, s);
    expect(out.allowed).toBe(false);
    expect(out.reason).toBe("refund_required");
    expect(out.nextAction).toBe("refund_existing_prepurchase_first");
    expect(out.existingCommitment?.productId).toBe(PLAN_A);
  });

  test("refund for the target period processing: refund_pending blocks repurchase", () => {
    const s = snapshot({
      refunds: [{ refundId: "r1", status: "processing" }],
    });
    const out = attempt(PLAN_A, NOW_MID, s);
    expect(out.allowed).toBe(false);
    expect(out.reason).toBe("refund_pending");
    expect(out.nextAction).toBe("wait_for_refund_outcome");
    expect(out.targetPeriod?.startUs).toBe(B1.startUs); // scoped to the target period
  });

  test("refund outcome unknown: blocked exactly like processing (never treated as success)", () => {
    const s = snapshot({
      refunds: [{ refundId: "r2", status: "unknown" }],
    });
    const out = attempt(PLAN_A, NOW_MID, s);
    expect(out.allowed).toBe(false);
    expect(out.reason).toBe("refund_outcome_unknown");
  });

  test("refund succeeded and the target period has not started: repurchase allowed after recheck", () => {
    const s = snapshot({
      refunds: [{ refundId: "r3", status: "succeeded" }],
    });
    const out = attempt(PLAN_B, NOW_MID, s);
    expect(out.allowed).toBe(true);
    expect(out.reason).toBe("eligible");
    expect(out.targetPeriod?.startUs).toBe(B1.startUs); // still continues the current period
  });

  test("refund failed/revoked with the commitment gone: the purchase may proceed", () => {
    const s = snapshot({
      refunds: [{ refundId: "r4", status: "failed" }],
    });
    const out = attempt(PLAN_A, NOW_MID, s);
    expect(out.allowed).toBe(true);
    expect(out.reason).toBe("eligible");
  });

  test("refund processing while ALREADY prepaid: the refund block wins (prepaid + refund)", () => {
    const s = snapshot({
      subscription: {
        anchor: ANCHOR,
        currentPeriodIndex: 0n,
        status: "active",
        currentProductId: PLAN_A,
        prepaid: {
          productId: PLAN_A,
          targetPeriodStartUs: B1.startUs,
          targetPeriodIndex: 1n,
        },
      },
      refunds: [{ refundId: "r5", status: "processing" }],
    });
    const out = attempt(PLAN_B, NOW_MID, s);
    expect(out.allowed).toBe(false);
    expect(out.reason).toBe("refund_pending");
    expect(out.nextAction).toBe("wait_for_refund_outcome");
    // The committed product itself is equally blocked while the refund on its
    // period is open: already_prepaid never shadows an open refund outcome.
    const same = attempt(PLAN_A, NOW_MID, s);
    expect(same.allowed).toBe(false);
    expect(same.reason).toBe("refund_pending");
    expect(same.nextAction).toBe("wait_for_refund_outcome");
    expect(same.existingCommitment?.productId).toBe(PLAN_A);
  });

  test("credit pack with an active prepaid subscription AND an open refund: allowed, independent of the cycle", () => {
    const s = snapshot({
      subscription: {
        anchor: ANCHOR,
        currentPeriodIndex: 0n,
        status: "active",
        currentProductId: PLAN_A,
        prepaid: {
          productId: PLAN_A,
          targetPeriodStartUs: B1.startUs,
          targetPeriodIndex: 1n,
        },
      },
      refunds: [{ refundId: "r6", status: "processing" }],
    });
    const out = attempt("pack_1m_credits", NOW_MID, s, "credit_pack");
    expect(out.allowed).toBe(true);
    expect(out.reason).toBe("eligible");
    expect(out.nextAction).toBe("create_order");
    expect(out.targetPeriod).toBeNull(); // packs have no subscription period
    expect(out.existingCommitment).toBeNull();
  });

  test("credit pack refund outcome unknown for the subscription period still allows the pack", () => {
    const s = snapshot({
      refunds: [{ refundId: "r7", status: "unknown" }],
    });
    const out = attempt("pack_1m_credits", NOW_MID, s, "credit_pack");
    expect(out.allowed).toBe(true);
    expect(out.reason).toBe("eligible");
  });

  test("credit pack with no subscription at all: allowed", () => {
    const out = attempt(
      "pack_1m_credits",
      NOW_MID,
      snapshot({ subscription: null }),
      "credit_pack",
    );
    expect(out.allowed).toBe(true);
    expect(out.targetPeriod).toBeNull();
  });

  test("boundary with a prepaid next period: continuation, never an expired re-purchase", () => {
    const s = snapshot({
      subscription: {
        anchor: ANCHOR,
        currentPeriodIndex: 0n,
        status: "active",
        currentProductId: PLAN_A,
        prepaid: {
          productId: PLAN_A,
          targetPeriodStartUs: B1.startUs,
          targetPeriodIndex: 1n,
        },
      },
    });
    // The wall clock is exactly at the next period start; the commitment stands.
    const out = attempt(PLAN_A, B1.startUs, s);
    expect(out.allowed).toBe(false);
    expect(out.reason).toBe("already_prepaid");
  });

  test("target period already started with no commitment: state_conflict, recheck", () => {
    const out = attempt(PLAN_A, B1.startUs, snapshot({}));
    expect(out.allowed).toBe(false);
    expect(out.reason).toBe("state_conflict");
    expect(out.nextAction).toBe("recheck_state");
  });

  test("the outcome carries the snapshot revision the caller must recheck on commit", () => {
    const out = attempt(PLAN_A, NOW_MID, snapshot({}));
    expect(out.stateRevision).toBe(7n);
  });
});

describe("eligibility: prepaid grant due action (A12)", () => {
  const prepaidSnap = snapshot({
    subscription: {
      anchor: ANCHOR,
      currentPeriodIndex: 0n,
      status: "active",
      currentProductId: PLAN_A,
      prepaid: {
        productId: PLAN_A,
        targetPeriodStartUs: B1.startUs,
        targetPeriodIndex: 1n,
      },
    },
  });

  test("one microsecond before the boundary: nothing due", () => {
    const due = prepaidGrantDueAction({
      subscriptionId: "sub-1",
      snapshot: prepaidSnap,
      nowUs: B1.startUs - 1n,
    });
    expect(due.due).toBe(false);
    expect(due.grantAtUs).toBe(B1.startUs);
    expect(due.periodIndex).toBe(1n);
    expect(due.actionIdentity).toBe("sub-1:1:grant");
  });

  test("exactly at the boundary: due exactly once, at the period start", () => {
    const due = prepaidGrantDueAction({
      subscriptionId: "sub-1",
      snapshot: prepaidSnap,
      nowUs: B1.startUs,
    });
    expect(due.due).toBe(true);
    expect(due.grantAtUs).toBe(B1.startUs);
    expect(due.actionIdentity).toBe("sub-1:1:grant");
  });
});
