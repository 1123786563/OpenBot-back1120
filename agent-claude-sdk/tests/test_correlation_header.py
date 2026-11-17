"""The server's billing correlation ID reaches every model request Claude Code sends.

The server sends `forwardedProps.openbotCorrelationId` on a run whose model requests are billed
per call, and the gateway refuses any request that presents no live reservation under
`x-openbot-correlation-id`. What this harness controls is the one leg between it and the gateway:
the ID must come off the forwarded props and onto the headers Claude Code sends, which it does
through `ANTHROPIC_CUSTOM_HEADERS` on the process the SDK starts. So that is what is checked,
built from the adapter's real options; whether the gateway honoured the reservation is the
end-to-end run this ticket exists for, not a claim these tests make.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.adapter import (  # noqa: E402
    CUSTOM_HEADERS_ENV,
    OpenBotClaudeAgentAdapter,
    run_correlation,
    with_correlation_header,
)
from test_model_choice import run_input  # noqa: E402  (the shape the server sends)


def options_for(forwarded_props, model_only=False):
    adapter = OpenBotClaudeAgentAdapter(name="correlation", model_only=model_only)
    return adapter.build_options(run_input(forwarded_props), "thread")


def test_the_servers_id_reaches_claude_codes_headers():
    options = options_for({"openbotCorrelationId": "0f0e1d2c-3b4a-5968-7789-aabbccddeeff"})

    header = options.env.get(CUSTOM_HEADERS_ENV)
    assert header == "x-openbot-correlation-id: 0f0e1d2c-3b4a-5968-7789-aabbccddeeff"


@pytest.mark.parametrize("model_only", [True, False])
def test_a_run_without_an_id_sends_no_header(model_only):
    # The server strips a browser-supplied ID and sends none for unbilled runs; the harness then
    # invents none, and the gateway is left to refuse what carries no reservation.
    for props in [{}, {"openbotCorrelationId": ""}, {"openbotCorrelationId": 5}, None]:
        options = options_for(props, model_only=model_only)
        assert options.env.get(CUSTOM_HEADERS_ENV) is None


def test_headers_a_deployment_already_set_are_kept():
    env = with_correlation_header(
        {CUSTOM_HEADERS_ENV: "x-deployment: yes"},
        {"openbotCorrelationId": "corr-1"},
    )

    assert env[CUSTOM_HEADERS_ENV] == "x-deployment: yes\nx-openbot-correlation-id: corr-1"


def test_an_id_is_read_only_from_the_servers_prop():
    assert run_correlation({"openbotCorrelationId": " corr-2 "}) == "corr-2"
    assert run_correlation({"openbotCorrelationId": None}) is None
    assert run_correlation(None) is None
    # Not the model endpoint's business: it drops the forwarded props before options are built.
    options = options_for({"openbotCorrelationId": "corr-3"}, model_only=True)
    assert options.env.get(CUSTOM_HEADERS_ENV) is None
