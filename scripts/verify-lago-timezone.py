"""Exercise historical event reconciliation on an isolated disposable Lago instance.

Requires LAGO_VERIFY_API_KEY, LAGO_VERIFY_OUTPUT_DIR, LAGO_VERIFY_CONTAINER.
The container must be the official local all-in-one fixture, never a shared DB.
Uses public REST APIs except historical billing, which invokes BillSubscriptionJob
with an explicit timestamp through Rails runner; it does not change the clock.
"""

import json
import os
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from decimal import Decimal
from pathlib import Path

BASE = os.environ.get('LAGO_VERIFY_API_URL', 'http://127.0.0.1:19031/api/v1')
KEY = os.environ['LAGO_VERIFY_API_KEY']
CONTAINER = os.environ['LAGO_VERIFY_CONTAINER']
OUT = Path(os.environ['LAGO_VERIFY_OUTPUT_DIR'])
OUT.mkdir(parents=True, exist_ok=True)
evidence = []

def epoch(value):
    return int(datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp())

def call(method, path, payload=None, allow_error=False):
    request = urllib.request.Request(BASE + path, method=method,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            status, body = response.status, json.load(response)
    except urllib.error.HTTPError as error:
        status, body = error.code, json.load(error)
    evidence.append({'method': method, 'path': path, 'request': payload, 'status': status, 'response': body})
    (OUT / 'api-responses.json').write_text(json.dumps(evidence, indent=2) + '\n')
    if status >= 400 and not allow_error:
        raise RuntimeError(f'{method} {path}: {status} {body}')
    return status, body

def event(identifier, timestamp, units):
    return {'event': {'transaction_id': identifier, 'external_subscription_id': 'timezone_subscription',
        'code': 'timezone_microcredits', 'timestamp': epoch(timestamp), 'properties': {'microcredits': units}}}

def scan(start, end):
    rows, pages = {}, []
    page = 1
    while True:
        params = {'external_subscription_id': 'timezone_subscription', 'code': 'timezone_microcredits',
                  'timestamp_from': start, 'timestamp_to': end, 'page': page, 'per_page': 2}
        _, result = call('GET', '/events?' + urllib.parse.urlencode(params))
        pages.append(result['meta'])
        for row in result['events']:
            rows[row['transaction_id']] = row
        next_page = result['meta']['next_page']
        if next_page is None:
            break
        assert next_page > page, result
        page = next_page
    kept = {key: row for key, row in rows.items() if epoch(start) <= epoch(row['timestamp']) < epoch(end)}
    total = sum(Decimal(str(row['properties']['microcredits'])) for row in kept.values())
    return {'raw_ids': sorted(rows), 'half_open_ids': sorted(kept), 'sum_microcredits': str(total), 'pages': pages}

_, metric = call('POST', '/billable_metrics', {'billable_metric': {'name': 'Timezone microcredits',
    'code': 'timezone_microcredits', 'aggregation_type': 'sum_agg', 'field_name': 'microcredits'}})
call('POST', '/customers', {'customer': {'external_id': 'timezone_customer', 'name': 'Disposable timezone fixture', 'currency': 'CNY'}})
call('POST', '/plans', {'plan': {'name': 'Timezone zero price', 'code': 'timezone_plan', 'interval': 'monthly',
    'amount_cents': 0, 'amount_currency': 'CNY', 'pay_in_advance': False,
    'charges': [{'billable_metric_id': metric['billable_metric']['lago_id'], 'charge_model': 'standard',
                 'pay_in_advance': False, 'properties': {'amount': '0'}}]}})
_, subscription = call('POST', '/subscriptions', {'subscription': {'external_customer_id': 'timezone_customer',
    'plan_code': 'timezone_plan', 'external_id': 'timezone_subscription', 'billing_time': 'calendar',
    'subscription_at': '2024-01-01T00:00:00Z'}})
assert epoch(subscription['subscription']['started_at']) == epoch('2024-01-01T00:00:00Z'), subscription

# OpenBot original anchor: Jan 31 00:00 Asia/Shanghai; leap-Feb clamp then Mar 31.
A, B, C = '2024-01-30T16:00:00Z', '2024-02-28T16:00:00Z', '2024-03-30T16:00:00Z'
fixtures = [
    ('before_start', '2024-01-30T15:59:59Z', 1),
    ('at_start', A, 2),
    ('step_before_boundary', '2024-02-28T15:59:59Z', 3),
    ('step_at_boundary', B, 5),
    ('leap_day', '2024-02-29T04:00:00Z', 7),
    ('before_march_end', '2024-03-30T15:59:59Z', 11),
    ('at_march_end', C, 13),
]
for identifier, timestamp, units in fixtures:
    call('POST', '/events', event(identifier, timestamp, units))
first_before, second_before = scan(A, B), scan(B, C)
assert first_before['raw_ids'] == ['at_start', 'step_at_boundary', 'step_before_boundary'], first_before
assert first_before['half_open_ids'] == ['at_start', 'step_before_boundary'], first_before
assert first_before['sum_microcredits'] == '5', first_before
assert second_before['half_open_ids'] == ['before_march_end', 'leap_day', 'step_at_boundary'], second_before
assert second_before['sum_microcredits'] == '23', second_before
assert len(first_before['pages']) == 2 and len(second_before['pages']) == 2

# Run the existing billing job at a historical timestamp to finalize a February UTC invoice.
ruby = '''require "time"; s = Subscription.find_by!(external_id: "timezone_subscription");
raise "unexpected premium license" if License.premium?;
BillSubscriptionJob.perform_now([s], Time.iso8601("2024-03-01T00:00:00Z").to_i, invoicing_reason: :subscription_periodic);
puts({premium: License.premium?, billing_timestamp: "2024-03-01T00:00:00Z"}.to_json)'''
command = 'set -a; source /data/.env; set +a; bundle exec rails runner "$1"'
runner = subprocess.run(['docker', 'exec', '-w', '/app/api', CONTAINER, 'bash', '-c', command, 'verify', ruby],
    text=True, capture_output=True)
if runner.returncode:
    raise RuntimeError('Historical billing failed; inspect the disposable container locally')
license_result = json.loads(runner.stdout.splitlines()[-1])
(OUT / 'historical-billing.json').write_text(json.dumps({'invocation': ruby, 'result': license_result}, indent=2) + '\n')

_, listing = call('GET', '/invoices?external_customer_id=timezone_customer')
invoice_id = next(invoice['lago_id'] for invoice in listing['invoices'] if invoice['issuing_date'] == '2024-03-01')
_, invoice_before = call('GET', '/invoices/' + invoice_id)
invoice = invoice_before['invoice']
assert invoice['status'] == 'finalized', invoice
assert invoice['total_amount_cents'] == 0 and invoice['total_due_amount_cents'] == 0, invoice
assert next(Decimal(fee['units']) for fee in invoice['fees'] if fee['item']['code'] == 'timezone_microcredits') == 15

late = event('late_february', '2024-02-15T04:00:00Z', 17)
call('POST', '/events', late)
duplicate_status, duplicate = call('POST', '/events', late, allow_error=True)
assert duplicate_status == 422 and 'value_already_exist' in json.dumps(duplicate), duplicate
first_after, second_after = scan(A, B), scan(B, C)
assert first_after['sum_microcredits'] == '22', first_after
assert second_after['sum_microcredits'] == '23', second_after
utc_february_after = scan('2024-02-01T00:00:00Z', '2024-03-01T00:00:00Z')
assert utc_february_after['sum_microcredits'] == '32', utc_february_after
time.sleep(3)
_, invoice_after = call('GET', '/invoices/' + invoice_id)

def invoice_values(body):
    invoice = body['invoice']
    return {'status': invoice['status'], 'total_amount_cents': invoice['total_amount_cents'],
        'total_due_amount_cents': invoice['total_due_amount_cents'],
        'fees': [{'code': fee['item']['code'], 'units': fee['units'], 'from_date': fee['from_date'],
                 'to_date': fee['to_date'], 'amount_cents': fee['amount_cents']} for fee in invoice['fees']]}

assert invoice_values(invoice_before) == invoice_values(invoice_after)
summary = {'status': 'passed', 'community_timezone': 'UTC', 'premium': False,
    'method': 'REST historical events and subscription; normal BillSubscriptionJob with explicit historical timestamp; no global clock change',
    'beijing_periods_utc': [[A, B], [B, C]], 'first_before': first_before, 'second_before': second_before,
    'first_after_late_event': first_after, 'second_after_late_event': second_after,
    'duplicate_late_event_status': duplicate_status, 'finalized_invoice_before_and_after': invoice_values(invoice_after),
    'utc_february_raw_after_late_event': utc_february_after,
    'limits': ['Pagination tested with quiescent fixtures; concurrent insertion requires overlapping rescan and ID deduplication.',
               'Lago uses inclusive timestamp bounds; client explicitly removes upper bound for half-open windows.',
               'Historical UTC invoice is not an OpenBot Beijing billing period.',
               'Fixtures use whole seconds; API subsecond timestamp fidelity is not tested.',
               'Invoice non-mutation observed after three seconds; this does not prove all future jobs can never change it.']}
(OUT / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(summary, indent=2))
