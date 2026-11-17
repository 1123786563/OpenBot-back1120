"""Verify zero-price metering against a fresh, disposable Lago organization.

Requires LAGO_VERIFY_API_KEY and LAGO_VERIFY_OUTPUT_DIR. The default API is
localhost:19031. This creates fixture resources and terminates its subscription;
never point it at a merchant organization or an existing shared test database.
"""

import json, os, time, urllib.request, urllib.error
from decimal import Decimal
from pathlib import Path

BASE = os.environ.get('LAGO_VERIFY_API_URL', 'http://127.0.0.1:19031/api/v1')
KEY = os.environ['LAGO_VERIFY_API_KEY']
OUT = Path(os.environ['LAGO_VERIFY_OUTPUT_DIR'])
OUT.mkdir(parents=True, exist_ok=True)
evidence = []

def call(method, path, payload=None, allow_error=False):
    request = urllib.request.Request(BASE + path, method=method,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            status, body = response.status, json.load(response)
    except urllib.error.HTTPError as error:
        status, body = error.code, json.load(error)
    evidence.append({'method': method, 'path': path, 'request': payload, 'status': status, 'response': body})
    (OUT / 'api-evidence.json').write_text(json.dumps(evidence, indent=2))
    if status >= 400 and not allow_error:
        raise RuntimeError(f'{method} {path}: {status} {body}')
    return status, body

metrics = []
for code, field in [('verify_tokens', 'tokens'), ('verify_microcredits', 'microcredits')]:
    _, body = call('POST', '/billable_metrics', {'billable_metric': {
        'name': code, 'code': code, 'aggregation_type': 'sum_agg', 'field_name': field}})
    metrics.append((code, body['billable_metric']['lago_id']))
call('POST', '/customers', {'customer': {'external_id': 'verify_customer', 'name': 'Disposable verification', 'currency': 'CNY', 'timezone': 'Asia/Shanghai'}})
call('POST', '/plans', {'plan': {'name': 'Zero price verification', 'code': 'verify_plan',
    'interval': 'monthly', 'amount_cents': 0, 'amount_currency': 'CNY', 'pay_in_advance': False,
    'charges': [{'billable_metric_id': metric_id, 'code': code, 'charge_model': 'standard',
                 'pay_in_advance': False, 'properties': {'amount': '0'}} for code, metric_id in metrics]}})
call('POST', '/subscriptions', {'subscription': {'external_customer_id': 'verify_customer',
    'plan_code': 'verify_plan', 'external_id': 'verify_subscription', 'billing_time': 'anniversary'}})

events = [
    {'transaction_id': 'verify_tokens_1', 'code': 'verify_tokens', 'properties': {'tokens': 17}},
    {'transaction_id': 'verify_microcredits_1', 'code': 'verify_microcredits', 'properties': {'microcredits': 123}},
    {'transaction_id': 'verify_microcredits_2', 'code': 'verify_microcredits', 'properties': {'microcredits': 1000000}},
]
for event in events:
    event['external_subscription_id'] = 'verify_subscription'
    call('POST', '/events', {'event': event})

usage_path = '/customers/verify_customer/current_usage?external_subscription_id=verify_subscription&apply_taxes=false'
def get_matching_usage():
    for attempt in range(30):
        _, body = call('GET', usage_path)
        usage = body['customer_usage']
        units = {charge['billable_metric']['code']: Decimal(str(charge['units'])) for charge in usage['charges_usage']}
        if units == {'verify_tokens': Decimal(17), 'verify_microcredits': Decimal(1000123)}:
            assert Decimal(str(usage['amount_cents'])) == 0, usage
            assert Decimal(str(usage['total_amount_cents'])) == 0, usage
            return usage
        time.sleep(1)
    raise AssertionError(body)

before = get_matching_usage()
duplicate_status, duplicate = call('POST', '/events', {'event': events[1]}, allow_error=True)
assert duplicate_status < 300 or (duplicate_status == 422 and 'value_already_exist' in json.dumps(duplicate)), duplicate
time.sleep(2)
after = get_matching_usage()
call('DELETE', '/subscriptions/verify_subscription?on_termination_invoice=generate')

invoices = []
for attempt in range(30):
    _, body = call('GET', '/invoices?external_customer_id=verify_customer')
    invoices = body['invoices']
    if invoices:
        break
    time.sleep(1)
assert invoices, 'No termination invoice materialized'
for invoice in invoices:
    invoice_id = invoice['lago_id']
    if invoice.get('status') == 'draft':
        call('PUT', '/invoices/' + invoice_id + '/finalize')
    _, body = call('GET', '/invoices/' + invoice_id)
    final = body['invoice']
    assert Decimal(str(final['total_amount_cents'])) == 0, final
    assert Decimal(str(final['total_due_amount_cents'])) == 0, final
    assert final['status'] == 'finalized', final
    fee_units = {fee['item']['code']: Decimal(str(fee['units'])) for fee in final['fees'] if fee.get('item', {}).get('type') == 'charge'}
    assert fee_units == {'verify_tokens': Decimal(17), 'verify_microcredits': Decimal(1000123)}, final

summary = {'status': 'passed', 'units': {'tokens': 17, 'microcredits': 1000123},
    'amount_cents': 0, 'duplicate_status': duplicate_status, 'invoice_count': len(invoices),
    'requested_timezone': 'Asia/Shanghai',
    'actual_timezone': final['customer']['applicable_timezone'],
    'timezone_applied': final['customer']['applicable_timezone'] == 'Asia/Shanghai',
    'note': 'License.premium? must be checked separately in the running container.'}
(OUT / 'summary.json').write_text(json.dumps(summary, indent=2))
print(json.dumps(summary))
