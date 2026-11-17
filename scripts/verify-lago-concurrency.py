"""Disposable Lago REST verification: pagination drift, duplicate races, precision.

Requires LAGO_VERIFY_API_KEY and LAGO_VERIFY_OUTPUT_DIR; optional
LAGO_VERIFY_API_URL defaults to localhost:19031/api/v1. Use a fresh organization.
All timestamps supplied as decimal-second strings to avoid binary float rounding.
"""

import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

BASE = os.environ.get('LAGO_VERIFY_API_URL', 'http://127.0.0.1:19031/api/v1')
KEY = os.environ['LAGO_VERIFY_API_KEY']
OUT = Path(os.environ['LAGO_VERIFY_OUTPUT_DIR'])
OUT.mkdir(parents=True, exist_ok=True)
evidence, evidence_lock = [], threading.Lock()

def call(method, path, payload=None, allow_error=False):
    req = urllib.request.Request(BASE + path, method=method,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            status, body = response.status, json.load(response)
    except urllib.error.HTTPError as error:
        status, body = error.code, json.load(error)
    with evidence_lock:
        evidence.append({'method': method, 'path': path, 'request': payload, 'status': status, 'response': body})
        (OUT / 'api-responses.json').write_text(json.dumps(evidence, indent=2) + '\n')
    if status >= 400 and not allow_error:
        raise RuntimeError(f'{method} {path}: {status} {body}')
    return status, body

def iso(us):
    seconds, micros = divmod(us, 1_000_000)
    return datetime.fromtimestamp(seconds, timezone.utc).replace(microsecond=micros).isoformat(timespec='microseconds').replace('+00:00', 'Z')

def send(identifier, microseconds, code='concurrent_usage', units=1):
    payload = {'event': {'transaction_id': identifier, 'external_subscription_id': 'concurrent_subscription',
        'code': code, 'timestamp': str(Decimal(microseconds) / 1_000_000),
        'properties': {'units': units, 'occurrence_us': microseconds}}}
    return call('POST', '/events', payload, allow_error=True)

def page(code, start, end, number, size=2):
    params = {'external_subscription_id': 'concurrent_subscription', 'code': code,
        'timestamp_from': iso(start), 'timestamp_to': iso(end), 'page': number, 'per_page': size}
    return call('GET', '/events?' + urllib.parse.urlencode(params))[1]

def scan(code, start, end, size=2):
    collected, number = [], 1
    while True:
        result = page(code, start, end, number, size)
        collected.extend(result['events'])
        if result['meta']['next_page'] is None:
            return collected
        number = result['meta']['next_page']

def ids(rows):
    return [row['transaction_id'] for row in rows]

metric_ids = []
for code in ['concurrent_usage', 'precision_usage']:
    _, response = call('POST', '/billable_metrics', {'billable_metric': {
        'name': code, 'code': code, 'aggregation_type': 'sum_agg', 'field_name': 'units'}})
    metric_ids.append(response['billable_metric']['lago_id'])
call('POST', '/customers', {'customer': {'external_id': 'concurrent_customer', 'name': 'Disposable concurrency fixture', 'currency': 'CNY'}})
call('POST', '/plans', {'plan': {'name': 'Zero price concurrency', 'code': 'concurrent_plan', 'interval': 'monthly',
    'amount_cents': 0, 'amount_currency': 'CNY', 'pay_in_advance': False,
    'charges': [{'billable_metric_id': mid, 'charge_model': 'standard', 'properties': {'amount': '0'}} for mid in metric_ids]}})
call('POST', '/subscriptions', {'subscription': {'external_customer_id': 'concurrent_customer',
    'plan_code': 'concurrent_plan', 'external_id': 'concurrent_subscription', 'subscription_at': '2024-01-01T00:00:00Z'}})

# Beijing leap-Feb boundary, 2024-02-29 00:00 +08:00.
B = 1709136000 * 1_000_000
for second in [10, 20, 30, 40]:
    assert send(f'page_{second}', B + second * 1_000_000)[0] == 200
first = page('concurrent_usage', B, B + 60_000_000, 1)
assert ids(first['events']) == ['page_40', 'page_30'], first
assert send('inserted_35', B + 35_000_000)[0] == 200
drift_rows = first['events']
number = first['meta']['next_page']
while number is not None:
    result = page('concurrent_usage', B, B + 60_000_000, number)
    drift_rows.extend(result['events'])
    number = result['meta']['next_page']
assert ids(drift_rows).count('page_30') == 2, ids(drift_rows)
assert 'inserted_35' not in ids(drift_rows), ids(drift_rows)
rescan = scan('concurrent_usage', B, B + 60_000_000)
deduplicated = {row['transaction_id']: row for row in drift_rows + rescan}
expected_ids = {f'page_{second}' for second in [10, 20, 30, 40]} | {'inserted_35'}
assert set(deduplicated) == expected_ids
assert sum(row['properties']['units'] for row in deduplicated.values()) == 5

barrier = threading.Barrier(8)
def racing_send(index):
    barrier.wait(timeout=10)
    return index // 2, send(f'race_{index // 2}', B + 50_000_000)
with ThreadPoolExecutor(max_workers=8) as pool:
    races = list(pool.map(racing_send, range(8)))
race_statuses = {str(i): sorted(result[0] for j, result in races if j == i) for i in range(4)}
assert all(statuses == [200, 422] for statuses in race_statuses.values()), race_statuses
assert all('value_already_exist' in json.dumps(body) for _, (status, body) in races if status == 422)
all_rows = scan('concurrent_usage', B, B + 60_000_000)
assert len(all_rows) == 9 and len(set(ids(all_rows))) == 9

offsets = {'minus_ms': -1000, 'minus_us': -1, 'at_boundary': 0, 'plus_us': 1, 'plus_ms': 1000}
precision_gets = {}
for identifier, offset in offsets.items():
    assert send(identifier, B + offset, 'precision_usage')[0] == 200
    _, response = call('GET', '/events/' + identifier)
    row = response['event']
    assert row['properties']['occurrence_us'] == B + offset, row
    precision_gets[identifier] = {'timestamp': row['timestamp'], 'occurrence_us': row['properties']['occurrence_us']}

exact_micro_window = scan('precision_usage', B, B + 1, 10)
assert set(ids(exact_micro_window)) == {'at_boundary', 'plus_us'}, exact_micro_window
before_micro_window = scan('precision_usage', B - 1, B, 10)
assert set(ids(before_micro_window)) == {'minus_us', 'at_boundary'}, before_micro_window
# Padded query plus integer source timestamp supports a true half-open 1us window.
padded = scan('precision_usage', B - 1_000_000, B + 1_000_001, 2)
precise_half_open = [row for row in padded if B <= row['properties']['occurrence_us'] < B + 1]
assert ids(precise_half_open) == ['at_boundary']
serialized_collision = precision_gets['at_boundary']['timestamp'] == precision_gets['plus_us']['timestamp']
assert serialized_collision, precision_gets

summary = {'status': 'passed', 'boundary_utc': iso(B),
    'pagination': {'first_pass_ids': ids(drift_rows), 'missed_insert': 'inserted_35', 'repeated_id': 'page_30',
        'rescan_ids': ids(rescan), 'deduplicated_total_units': 5},
    'concurrent_duplicate_statuses': race_statuses, 'unique_event_count_after_races': 9,
    'precision_get_responses': precision_gets, 'inclusive_one_microsecond_query_ids': ids(exact_micro_window),
    'inclusive_previous_microsecond_query_ids': ids(before_micro_window),
    'serializer_collapses_microsecond_distinction': serialized_collision,
    'padded_query_integer_property_half_open_ids': ids(precise_half_open),
    'limits': ['PostgreSQL community deployment only; no ClickHouse verification.',
               'One controlled page insertion and eight concurrent sends; not a sustained-load benchmark.',
               'Production rescans need durable per-transaction matching and an independently known expected event set.',
               'occurrence_us is supplied by OpenBot and must be validated there; Lago only preserves the property.']}
(OUT / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(summary, indent=2))
