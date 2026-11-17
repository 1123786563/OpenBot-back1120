"""Persistent transaction reference model; NOT the production OpenBot ledger.

Uses only a temporary SQLite database. Prints reproducible assertions as JSON.
It does not connect to Lago, OpenBot, payment providers, or existing databases.
"""

import json
import sqlite3
import tempfile
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path


class Ledger:
    def __init__(self, path):
        self.path = path

    @contextmanager
    def transaction(self):
        connection = sqlite3.connect(self.path, timeout=20)
        connection.row_factory = sqlite3.Row
        try:
            connection.execute("BEGIN IMMEDIATE")
            yield connection
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()

    def initialize(self):
        with sqlite3.connect(self.path) as c:
            c.executescript("""
                CREATE TABLE lots (
                    id TEXT PRIMARY KEY, expires INTEGER, initial INTEGER NOT NULL,
                    available INTEGER NOT NULL CHECK(available >= 0),
                    held INTEGER NOT NULL DEFAULT 0 CHECK(held >= 0),
                    consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed >= 0),
                    expired INTEGER NOT NULL DEFAULT 0 CHECK(expired >= 0),
                    CHECK(initial = available + held + consumed + expired)
                );
                CREATE TABLE reservations (
                    id TEXT PRIMARY KEY, amount INTEGER NOT NULL, deadline INTEGER NOT NULL,
                    state TEXT NOT NULL, actual INTEGER
                );
                CREATE TABLE allocations (
                    reservation TEXT NOT NULL, lot TEXT NOT NULL, amount INTEGER NOT NULL,
                    PRIMARY KEY(reservation, lot)
                );
                CREATE TABLE outbox (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
                CREATE TABLE adjustments (
                    account TEXT NOT NULL, event TEXT NOT NULL, kind TEXT NOT NULL,
                    payload TEXT NOT NULL, PRIMARY KEY(account, event, kind)
                );
            """)

    def grant(self, lot, amount, expires=None):
        with self.transaction() as c:
            c.execute("INSERT INTO lots(id, expires, initial, available) VALUES(?,?,?,?)",
                      (lot, expires, amount, amount))

    @staticmethod
    def expire(c, now):
        c.execute("UPDATE lots SET expired=expired+available, available=0 WHERE expires<=?", (now,))

    def reserve(self, key, amount, now, deadline):
        assert amount > 0 and deadline > now
        with self.transaction() as c:
            previous = c.execute("SELECT * FROM reservations WHERE id=?", (key,)).fetchone()
            if previous:
                if (previous['amount'], previous['deadline']) != (amount, deadline):
                    raise ValueError("reservation identity conflict")
                return False
            self.expire(c, now)
            lots = c.execute("SELECT * FROM lots ORDER BY expires IS NULL, expires, id").fetchall()
            if sum(lot['available'] for lot in lots) < amount:
                raise ValueError("insufficient credit")
            c.execute("INSERT INTO reservations VALUES(?,?,?,'held',NULL)", (key, amount, deadline))
            remaining = amount
            for lot in lots:
                held = min(remaining, lot['available'])
                if held:
                    c.execute("UPDATE lots SET available=available-?, held=held+? WHERE id=?",
                              (held, held, lot['id']))
                    c.execute("INSERT INTO allocations VALUES(?,?,?)", (key, lot['id'], held))
                    remaining -= held
            return True

    @staticmethod
    def distribute(c, key, actual, now):
        rows = c.execute("""SELECT a.amount, l.id, l.expires FROM allocations a
            JOIN lots l ON l.id=a.lot WHERE a.reservation=?
            ORDER BY l.expires IS NULL, l.expires, l.id""", (key,)).fetchall()
        remaining = actual
        for row in rows:
            used = min(remaining, row['amount'])
            unused = row['amount'] - used
            expired = unused if row['expires'] is not None and row['expires'] <= now else 0
            c.execute("""UPDATE lots SET held=held-?, consumed=consumed+?,
                available=available+?, expired=expired+? WHERE id=?""",
                      (row['amount'], used, unused - expired, expired, row['id']))
            remaining -= used
        assert remaining == 0

    def release_unknown(self, key, now):
        with self.transaction() as c:
            row = c.execute("SELECT * FROM reservations WHERE id=?", (key,)).fetchone()
            if row['state'] != 'held':
                return False
            if now < row['deadline']:
                raise ValueError("deadline not reached")
            self.expire(c, now)
            self.distribute(c, key, 0, now)
            c.execute("UPDATE reservations SET state='released' WHERE id=?", (key,))
            return True

    def settle(self, key, actual, now, fail_before_commit=False):
        with self.transaction() as c:
            row = c.execute("SELECT * FROM reservations WHERE id=?", (key,)).fetchone()
            if row['actual'] is not None:
                if row['actual'] != actual:
                    raise ValueError("settlement identity conflict")
                return False
            if not 0 <= actual <= row['amount']:
                raise ValueError("actual exceeds reservation")
            self.expire(c, now)
            timed_out = row['state'] == 'held' and now >= row['deadline']
            if timed_out:
                self.distribute(c, key, 0, now)
            payer = 'platform' if row['state'] == 'released' or timed_out else 'user'
            if payer == 'user':
                self.distribute(c, key, actual, now)
            c.execute("UPDATE reservations SET state='settled', actual=? WHERE id=?", (actual, key))
            c.execute("INSERT INTO outbox VALUES(?,?)", ('settlement:' + key, json.dumps({'actual': actual, 'payer': payer})))
            if fail_before_commit:
                raise RuntimeError("simulated crash before commit")
            return True

    def adjust(self, account, event, kind, period, amount, fail_before_commit=False):
        payload = json.dumps({'period': period, 'amount': amount}, sort_keys=True)
        with self.transaction() as c:
            previous = c.execute("SELECT payload FROM adjustments WHERE account=? AND event=? AND kind=?",
                                 (account, event, kind)).fetchone()
            if previous:
                if previous['payload'] != payload:
                    raise ValueError("adjustment identity conflict")
                return False
            c.execute("INSERT INTO adjustments VALUES(?,?,?,?)", (account, event, kind, payload))
            c.execute("INSERT INTO outbox VALUES(?,?)", ('adjustment:' + json.dumps([account, event, kind]), payload))
            if fail_before_commit:
                raise RuntimeError('simulated adjustment crash before commit')
            return True

    def snapshot(self):
        with self.transaction() as c:
            return {table: [dict(row) for row in c.execute('SELECT * FROM ' + table)]
                    for table in ('lots', 'reservations', 'outbox', 'adjustments')}


def rejected(action):
    try:
        action()
    except ValueError:
        return
    raise AssertionError('expected conflict or insufficient credit')


def main():
    results = {}
    with tempfile.TemporaryDirectory(prefix='openbot-ledger-model-') as directory:
        ledger = Ledger(Path(directory) / 'ledger.sqlite')
        ledger.initialize()
        ledger.grant('old-cycle', 100, expires=100)
        ledger.grant('pack', 100)
        ledger.reserve('step', 150, now=99, deadline=86500)
        before = ledger.snapshot()
        try:
            ledger.settle('step', 120, now=101, fail_before_commit=True)
        except RuntimeError:
            pass
        assert ledger.snapshot() == before
        # Independent connections race, then reopen the persisted database.
        with ThreadPoolExecutor(max_workers=8) as pool:
            committed = list(pool.map(lambda _: ledger.settle('step', 120, now=101), range(16)))
        assert sum(committed) == 1
        ledger = Ledger(ledger.path)
        state = ledger.snapshot()
        lots = {lot['id']: lot for lot in state['lots']}
        assert lots['old-cycle']['consumed'] == 100 and lots['old-cycle']['available'] == 0
        assert lots['pack']['consumed'] == 20 and lots['pack']['available'] == 80
        assert len(state['outbox']) == 1
        rejected(lambda: ledger.settle('step', 121, now=101))
        results['cross_cycle_multilot'] = {'old_consumed': 100, 'pack_consumed': 20,
            'pack_available': 80, 'parallel_retries': 16, 'commits': sum(committed),
            'outbox_records': 1, 'crash_rollback': True, 'conflict_rejected': True}

        before_adjustment = ledger.snapshot()
        try:
            ledger.adjust('a', 'late-event', 'late-usage', 'old', 17, fail_before_commit=True)
        except RuntimeError:
            pass
        assert ledger.snapshot() == before_adjustment
        with ThreadPoolExecutor(max_workers=8) as pool:
            writes = list(pool.map(lambda _: ledger.adjust('a', 'late-event', 'late-usage', 'old', 17), range(16)))
        assert sum(writes) == 1 and len(ledger.snapshot()['adjustments']) == 1
        assert len(ledger.snapshot()['outbox']) == 2
        assert not Ledger(ledger.path).adjust('a', 'late-event', 'late-usage', 'old', 17)
        rejected(lambda: ledger.adjust('a', 'late-event', 'late-usage', 'new', 17))
        rejected(lambda: ledger.adjust('a', 'late-event', 'late-usage', 'old', 18))
        results['adjustments'] = {'parallel_retries': 16, 'records': 1, 'delta': 17,
                                  'restart_retry_noop': True, 'changed_period_or_amount_rejected': True,
                                  'atomic_outbox_records': 1, 'crash_rollback': True}

        # Competing reservations cannot both spend the remaining 80 credits.
        def compete(key):
            try:
                return ledger.reserve(key, 60, now=102, deadline=200)
            except ValueError:
                return False
        with ThreadPoolExecutor(max_workers=2) as pool:
            winners = list(pool.map(compete, ['race-a', 'race-b']))
        assert sum(winners) == 1
        winner = ['race-a', 'race-b'][winners.index(True)]
        assert ledger.release_unknown(winner, now=200)
        assert ledger.settle(winner, 50, now=201)
        state = ledger.snapshot()
        assert {lot['id']: lot for lot in state['lots']}['pack']['available'] == 80
        assert json.loads(state['outbox'][-1]['payload'])['payer'] == 'platform'
        results['overspend_and_timeout'] = {'competing_reservations': 2, 'accepted': 1,
            'late_cost_payer': 'platform', 'pack_available_after_late_result': 80}

        expiry = Ledger(Path(directory) / 'expiry.sqlite')
        expiry.initialize()
        expiry.grant('old', 100, expires=100)
        expiry.reserve('expiry-step', 80, now=99, deadline=86500)
        expiry.settle('expiry-step', 60, now=101)
        lot = expiry.snapshot()['lots'][0]
        assert (lot['consumed'], lot['expired'], lot['available'], lot['held']) == (60, 40, 0, 0)
        rejected(lambda: expiry.reserve('next-step', 1, now=102, deadline=200))
        results['expired_remainder'] = {'consumed': 60, 'expired': 40, 'available': 0,
                                         'next_step_rejected': True}

        deadline = Ledger(Path(directory) / 'deadline.sqlite')
        deadline.initialize()
        deadline.grant('pack', 100)
        deadline.reserve('unknown', 80, now=0, deadline=86400)
        rejected(lambda: deadline.release_unknown('unknown', now=86399))
        with ThreadPoolExecutor(max_workers=2) as pool:
            release = pool.submit(deadline.release_unknown, 'unknown', 86400)
            settle = pool.submit(deadline.settle, 'unknown', 60, 86400)
            release.result()
            assert settle.result()
        state = deadline.snapshot()
        assert state['lots'][0]['available'] == 100 and state['lots'][0]['consumed'] == 0
        assert len(state['outbox']) == 1 and json.loads(state['outbox'][0]['payload'])['payer'] == 'platform'
        results['deadline_race'] = {'release_and_settle_at_24h': True, 'available': 100,
                                    'payer': 'platform', 'premature_release_rejected': True}

    print(json.dumps({'status': 'passed', 'scope': 'SQLite transactional reference model, not production',
                      'results': results}, indent=2))


if __name__ == '__main__':
    main()
