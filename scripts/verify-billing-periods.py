"""Executable design checks, not the production OpenBot billing implementation."""

import calendar
import json
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

BEIJING = ZoneInfo("Asia/Shanghai")


def boundary(anchor, month_offset):
    month_index = anchor.year * 12 + anchor.month - 1 + month_offset
    year, month_zero = divmod(month_index, 12)
    month = month_zero + 1
    return anchor.replace(
        year=year, month=month,
        day=min(anchor.day, calendar.monthrange(year, month)[1]),
    )


def belongs(instant, start, end):
    return start <= instant < end


def main():
    cases = [
        ("2024-01-31T00:00:00", ["2024-01-31", "2024-02-29", "2024-03-31"]),
        ("2025-01-31T00:00:00", ["2025-01-31", "2025-02-28", "2025-03-31"]),
        ("2024-08-31T09:30:00", ["2024-08-31", "2024-09-30", "2024-10-31"]),
        ("2024-12-31T09:30:00", ["2024-12-31", "2025-01-31", "2025-02-28"]),
    ]
    results = []
    for raw, expected in cases:
        anchor = datetime.fromisoformat(raw).replace(tzinfo=BEIJING)
        dates = [boundary(anchor, n) for n in range(3)]
        assert [value.date().isoformat() for value in dates] == expected
        assert all(value.time() == anchor.time() for value in dates)
        results.append({"anchor": anchor.isoformat(), "boundaries": [d.isoformat() for d in dates]})

    anchor = datetime(2024, 1, 31, tzinfo=BEIJING)
    start, split, end = [boundary(anchor, n).astimezone(timezone.utc) for n in range(3)]
    assert split.isoformat() == "2024-02-28T16:00:00+00:00"
    events = [
        ("before", datetime.fromisoformat("2024-02-28T15:59:59.999999+00:00"), 123),
        ("exact", split, 1000000),
        ("after", datetime.fromisoformat("2024-02-28T16:00:00.000001+00:00"), 7),
    ]
    old = [event for event in events if belongs(event[1], start, split)]
    new = [event for event in events if belongs(event[1], split, end)]
    assert [e[0] for e in old] == ["before"]
    assert [e[0] for e in new] == ["exact", "after"]
    assert sum(e[2] for e in old + new) == 1000130
    assert len({e[0] for e in old + new}) == len(events)

    # A step can settle after expiry while retaining the original reserved lot.
    reservation = {"lot_period": "old", "reserved": 200}
    settlement = {"occurred_at": split, "used": 123, "source_period": reservation["lot_period"]}
    assert belongs(settlement["occurred_at"], split, end)
    assert settlement["source_period"] == "old"
    expired_remainder = reservation["reserved"] - settlement["used"]
    assert expired_remainder == 77

    print(json.dumps({
        "status": "passed", "scope": "design oracle, not production ledger",
        "calendar_cases": results, "split_utc": split.isoformat(),
        "old_period_microcredits": 123, "new_period_microcredits": 1000007,
        "cross_period_step": {"source_period": "old", "settled_after_boundary": True,
                              "used": 123, "expired_remainder": expired_remainder},
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
