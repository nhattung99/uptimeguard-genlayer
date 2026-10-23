import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

from transfer_mock import (
    amounts_to,
    clear_transfer_failures,
    fail_transfers_to,
    hold_delivery_to,
    reset_transfer_log,
    transfer_log,
)

CONTRACT_PATH = "contracts/uptime_guard.py"
T0 = 1_700_000_000
WEEK = 7 * 86400
WINDOW = 3 * 86400
FEE = 1000
REFUND = 250

EVIDENCE = "https://status.example/incidents/march"
REF_STATUS = "https://status.provider.example/history"
REF_MONITOR = "https://monitor.example/archive/march"
TERMS = "Total downtime <= 60 minutes in the period"


def _active_vm(direct_vm):
    try:
        from gltest.direct.loader import _get_active_vm

        return _get_active_vm() or direct_vm
    except Exception:
        return direct_vm


def _set_value(vm, amount):
    if hasattr(vm, "value"):
        try:
            vm.value = amount
        except Exception:
            pass
    if hasattr(vm, "_value"):
        vm._value = amount
    if hasattr(vm, "_refresh_gl_message"):
        vm._refresh_gl_message()


def _credit_contract(vm, contract, amount):
    if vm is None or amount <= 0:
        return
    if hasattr(vm, "_balances") and hasattr(contract, "address"):
        key = contract.address
        if hasattr(vm, "_to_bytes"):
            try:
                key = vm._to_bytes(contract.address)
            except Exception:
                key = contract.address
        vm._balances[key] = vm._balances.get(key, 0) + amount


def _contract_modules():
    found = []
    for mod in list(sys.modules.values()):
        if mod is None:
            continue
        if callable(getattr(mod, "_current_unix_timestamp", None)) and hasattr(mod, "Contract"):
            found.append(mod)
    return found


def _warp(vm, monkeypatch, unix_ts):
    iso = datetime.fromtimestamp(int(unix_ts), timezone.utc).isoformat().replace("+00:00", "Z")
    if hasattr(vm, "warp"):
        vm.warp(iso)
    from genlayer import u256

    def fake_now():
        return u256(int(unix_ts))

    hits = 0
    for mod in _contract_modules():
        monkeypatch.setattr(mod, "_current_unix_timestamp", fake_now, raising=False)
        raw = getattr(getattr(mod, "gl", None), "message_raw", None)
        if isinstance(raw, dict):
            raw["datetime"] = iso
        hits += 1
    if hits < 1:
        raise RuntimeError("could not patch _current_unix_timestamp")


def _parse(raw):
    if isinstance(raw, str):
        return json.loads(raw)
    return raw


def _get(contract, agreement_id):
    return _parse(contract.get_agreement(agreement_id))


def _as(vm, sender):
    if hasattr(vm, "sender"):
        vm.sender = sender
    if hasattr(vm, "prank"):
        return vm.prank(sender)

    class _Null:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    return _Null()


def _create(
    contract,
    vm,
    monkeypatch,
    customer,
    provider,
    fee=FEE,
    refund=REFUND,
    period_end=None,
    window=WINDOW,
    desc="Managed API hosting",
    terms=TERMS,
    at=T0,
):
    _warp(vm, monkeypatch, at)
    end = at + WEEK if period_end is None else period_end
    _set_value(vm, fee)
    _credit_contract(vm, contract, fee)
    with _as(vm, customer):
        _set_value(vm, fee)
        agreement_id = contract.create_agreement(provider, desc, terms, refund, end, window)
    _set_value(vm, 0)
    return str(agreement_id)


def _accept(contract, vm, provider, agreement_id):
    with _as(vm, provider):
        contract.accept_agreement(agreement_id)


def _file(contract, vm, customer, agreement_id, evidence=None, refs=None):
    with _as(vm, customer):
        contract.file_claim(
            agreement_id,
            evidence if evidence is not None else [EVIDENCE],
            refs if refs is not None else [REF_STATUS, REF_MONITOR],
        )


def _web():
    pages = {
        EVIDENCE: "Incident 2024-01-08 00:10Z to 2024-01-08 02:40Z, downtime 150 minutes on the API.",
        REF_STATUS: "Provider status history: 2024-01-08 outage 150 minutes.",
        REF_MONITOR: "Independent monitor archive: API down 150 minutes starting 2024-01-08 00:10Z.",
    }
    return {re.escape(url): body for url, body in pages.items()}


def _install_mocks(vm, llm, web=None):
    payload_llm = llm if isinstance(llm, str) else json.dumps(llm)
    web = web if web is not None else _web()
    if hasattr(vm, "clear_mocks"):
        try:
            vm.clear_mocks()
        except Exception:
            pass
    if hasattr(vm, "sim_installMocks"):
        vm.sim_installMocks({"web": web, "llm": payload_llm})
    elif hasattr(vm, "sim_install_mocks"):
        vm.sim_install_mocks({"web": web, "llm": payload_llm})
    for url, body in web.items():
        if hasattr(vm, "mock_web"):
            vm.mock_web(url, body)
    if hasattr(vm, "mock_llm") and payload_llm is not None:
        vm.mock_llm(".*", payload_llm)


def _verdict(name, confidence, reason, facts="downtime recorded in the cited sources"):
    return {
        "verdict": name,
        "confidence": confidence,
        "reason": reason,
        "decisive_facts": facts,
    }


def _confirm_payout(contract, agreement_id):
    """Drive emission through balance confirmation. One call emits or confirms one side."""
    for _ in range(6):
        row = _get(contract, agreement_id)
        if row.get("settled"):
            return row
        if row["status"] not in ("PAYOUT_PENDING", "PAYOUT_FAILED"):
            return row
        contract.reconcile_payout(agreement_id)
    return _get(contract, agreement_id)


def _resolve(contract, vm, caller, agreement_id, name, confidence, reason, web=None):
    _install_mocks(vm, _verdict(name, confidence, reason), web)
    with _as(vm, caller):
        contract.resolve_claim(agreement_id)


def _ready(contract, vm, monkeypatch, customer, provider):
    agreement_id = _create(contract, vm, monkeypatch, customer, provider)
    _accept(contract, vm, provider, agreement_id)
    return agreement_id


def _after_period(contract, vm, monkeypatch, agreement_id, extra=1):
    row = _get(contract, agreement_id)
    _warp(vm, monkeypatch, int(row["period_end"]) + extra)


def _past_claim(contract, vm, monkeypatch, agreement_id, extra=1):
    row = _get(contract, agreement_id)
    _warp(vm, monkeypatch, int(row["claim_deadline"]) + extra)


def _past_stale(contract, vm, monkeypatch, agreement_id, extra=1):
    row = _get(contract, agreement_id)
    _warp(vm, monkeypatch, int(row["stale_deadline"]) + extra)


def test_sla_met_pays_provider_full_fee(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    customer, provider, stranger = direct_accounts[1], direct_accounts[2], direct_accounts[3]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)
    agreement_id = _ready(contract, vm, monkeypatch, customer, provider)
    _after_period(contract, vm, monkeypatch, agreement_id)
    _file(contract, vm, customer, agreement_id)
    _resolve(contract, vm, stranger, agreement_id, "SLA_MET", 91, "Sources show 20 minutes, under 60")
    assert _get(contract, agreement_id)["status"] == "PAYOUT_PENDING"
    assert _get(contract, agreement_id)["provider_paid"] is False
    row = _confirm_payout(contract, agreement_id)
    assert row["status"] == "RESOLVED_SLA_MET"
    assert row["verdict"] == "SLA_MET"
    assert int(row["confidence"]) == 91
    assert row["settled"] is True
    assert row["settlement_kind"] == "PROVIDER_FULL"
    assert row["provider_paid"] is True
    assert row["customer_refunded"] is False
    assert amounts_to(row["provider"]) == [FEE]
    assert amounts_to(row["customer"]) == []
    assert vm.run_validator() is True
    assert vm.run_validator(leader_result=_verdict("SLA_BREACHED", 91, "no")) is False
    assert vm.run_validator(leader_result=_verdict("SLA_MET", 91, "no", facts="a different outage")) is False


def test_sla_breached_splits_exact_amounts(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    customer, provider = direct_accounts[1], direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)
    agreement_id = _ready(contract, vm, monkeypatch, customer, provider)
    _after_period(contract, vm, monkeypatch, agreement_id)
    _file(contract, vm, customer, agreement_id)
    _resolve(contract, vm, customer, agreement_id, "SLA_BREACHED", 88, "150 minutes exceeds 60")
    row = _confirm_payout(contract, agreement_id)
    assert row["status"] == "RESOLVED_SLA_BREACHED"
    assert row["settlement_kind"] == "SPLIT_BREACH"
    assert row["settled"] is True
    assert amounts_to(row["provider"]) == [FEE - REFUND]
    assert amounts_to(row["customer"]) == [REFUND]
    assert amounts_to(row["provider"])[0] + amounts_to(row["customer"])[0] == FEE


def test_cancel_unaccepted_refunds_customer(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    customer, provider = direct_accounts[1], direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)
    agreement_id = _create(contract, vm, monkeypatch, customer, provider)
    assert _get(contract, agreement_id)["status"] == "PENDING_ACCEPTANCE"
    with _as(vm, customer):
        contract.cancel_unaccepted(agreement_id)
    row = _confirm_payout(contract, agreement_id)
    assert row["status"] == "CANCELLED_REFUNDED"
    assert row["settlement_kind"] == "CUSTOMER_FULL"
    assert row["settled"] is True
    assert amounts_to(row["customer"]) == [FEE]
    assert amounts_to(row["provider"]) == []


def test_accept_after_period_end_is_blocked(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    customer, provider = direct_accounts[1], direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)
    agreement_id = _create(contract, vm, monkeypatch, customer, provider)
    _after_period(contract, vm, monkeypatch, agreement_id)
    with vm.expect_revert("service period has already ended"):
        with _as(vm, provider):
            contract.accept_agreement(agreement_id)
    assert _get(contract, agreement_id)["status"] == "PENDING_ACCEPTANCE"


def test_claim_before_period_end_is_blocked(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    customer, provider = direct_accounts[1], direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)
    agreement_id = _ready(contract, vm, monkeypatch, customer, provider)
    _warp(vm, monkeypatch, T0 + 10)
    with vm.expect_revert("service period has not ended"):
        _file(contract, vm, customer, agreement_id)


def test_claim_window_edges(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    customer, provider = direct_accounts[1], direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)
    agreement_id = _ready(contract, vm, monkeypatch, customer, provider)
    row = _get(contract, agreement_id)
    period_end = int(row["period_end"])
    claim_deadline = int(row["claim_deadline"])

    _warp(vm, monkeypatch, period_end)
    _file(contract, vm, customer, agreement_id)
    assert _get(contract, agreement_id)["status"] == "CLAIM_FILED"

    agreement_late = _ready(contract, vm, monkeypatch, customer, provider)
    late = _get(contract, agreement_late)
    _warp(vm, monkeypatch, int(late["claim_deadline"]))
    _file(contract, vm, customer, agreement_late)
    assert _get(contract, agreement_late)["status"] == "CLAIM_FILED"

    agreement_closed = _ready(contract, vm, monkeypatch, customer, provider)
    closed = _get(contract, agreement_closed)
    _warp(vm, monkeypatch, int(closed["claim_deadline"]))
    with vm.expect_revert("claim window has not closed"):
        contract.settle_unclaimed(agreement_closed)
    _file(contract, vm, customer, agreement_closed)
    assert _get(contract, agreement_closed)["status"] == "CLAIM_FILED"

    agreement_shut = _ready(contract, vm, monkeypatch, customer, provider)
    _past_claim(contract, vm, monkeypatch, agreement_shut)
    with vm.expect_revert("claim window has closed"):
        _file(contract, vm, customer, agreement_shut)
    assert period_end < claim_deadline


def test_settle_unclaimed_pays_provider(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    customer, provider, stranger = direct_accounts[1], direct_accounts[2], direct_accounts[3]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)
    agreement_id = _ready(contract, vm, monkeypatch, customer, provider)
    _past_claim(contract, vm, monkeypatch, agreement_id)
    with _as(vm, stranger):
        contract.settle_unclaimed(agreement_id)
    row = _confirm_payout(contract, agreement_id)
    assert row["status"] == "SETTLED_NO_CLAIM"
    assert row["settlement_kind"] == "PROVIDER_FULL"
    assert amounts_to(row["provider"]) == [FEE]
    with vm.expect_revert("Cannot settle"):
        contract.settle_unclaimed(agreement_id)


def test_low_confidence_dispute_then_refile_and_resolve(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    customer, provider = direct_accounts[1], direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)
    agreement_id = _ready(contract, vm, monkeypatch, customer, provider)
    _after_period(contract, vm, monkeypatch, agreement_id)
    _file(contract, vm, customer, agreement_id)
    _resolve(contract, vm, provider, agreement_id, "SLA_BREACHED", 40, "timestamps are incomplete")
    row = _get(contract, agreement_id)
    assert row["status"] == "DISPUTED"
    assert row["settled"] is False
    assert transfer_log() == []
    assert vm.run_validator(leader_result=_verdict("SLA_BREACHED", 90, "clear")) is False

    _file(contract, vm, customer, agreement_id, [EVIDENCE], [REF_STATUS, REF_MONITOR])
    assert _get(contract, agreement_id)["status"] == "CLAIM_FILED"
    _resolve(contract, vm, customer, agreement_id, "SLA_BREACHED", 84, "archive shows 150 minutes")
    row = _confirm_payout(contract, agreement_id)
    assert row["status"] == "RESOLVED_SLA_BREACHED"
    assert amounts_to(row["customer"]) == [REFUND]
    assert amounts_to(row["provider"]) == [FEE - REFUND]


def test_stale_dispute_pays_provider(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    customer, provider, stranger = direct_accounts[1], direct_accounts[2], direct_accounts[3]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)
    agreement_id = _ready(contract, vm, monkeypatch, customer, provider)
    _after_period(contract, vm, monkeypatch, agreement_id)
    _file(contract, vm, customer, agreement_id)
    _resolve(contract, vm, customer, agreement_id, "SLA_MET", 20, "not enough timestamps")
    row = _get(contract, agreement_id)
    _warp(vm, monkeypatch, int(row["stale_deadline"]))
    with vm.expect_revert("dispute window has not closed"):
        contract.settle_stale_dispute(agreement_id)
    _warp(vm, monkeypatch, int(row["stale_deadline"]) + 1)
    with vm.expect_revert("dispute window has closed"):
        _file(contract, vm, customer, agreement_id)
    with _as(vm, stranger):
        contract.settle_stale_dispute(agreement_id)
    row = _confirm_payout(contract, agreement_id)
    assert row["status"] == "SETTLED_STALE_DISPUTE"
    assert amounts_to(row["provider"]) == [FEE]
    assert amounts_to(row["customer"]) == []


def test_web_fetch_failure_reverts_clean(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    customer, provider = direct_accounts[1], direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)
    agreement_id = _ready(contract, vm, monkeypatch, customer, provider)
    _after_period(contract, vm, monkeypatch, agreement_id)
    _file(contract, vm, customer, agreement_id)
    broken = dict(_web())
    del broken[re.escape(REF_MONITOR)]
    with vm.expect_revert("Failed to fetch"):
        _resolve(contract, vm, customer, agreement_id, "SLA_MET", 90, "should not land", broken)
    row = _get(contract, agreement_id)
    assert row["status"] == "CLAIM_FILED"
    assert row["settled"] is False
    assert transfer_log() == []


def test_bad_json_and_disallowed_verdict_revert(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    customer, provider = direct_accounts[1], direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)
    agreement_id = _ready(contract, vm, monkeypatch, customer, provider)
    _after_period(contract, vm, monkeypatch, agreement_id)
    _file(contract, vm, customer, agreement_id)
    _install_mocks(vm, "this is not json")
    with vm.expect_revert("Invalid LLM verdict JSON"):
        with _as(vm, customer):
            contract.resolve_claim(agreement_id)
    assert _get(contract, agreement_id)["status"] == "CLAIM_FILED"

    _install_mocks(vm, "MAYBE is not json")
    with vm.expect_revert("Invalid LLM verdict JSON"):
        with _as(vm, customer):
            contract.resolve_claim(agreement_id)

    fenced = '```json\n{"verdict":"SLA_MET","confidence":77,"decisive_facts":"downtime=20m","reason":"under the cap"}\n```'
    _install_mocks(vm, fenced)
    with _as(vm, provider):
        contract.resolve_claim(agreement_id)
    row = _confirm_payout(contract, agreement_id)
    assert row["verdict"] == "SLA_MET"
    assert int(row["confidence"]) == 77
    assert row["decisive_facts"] == "downtime=20m"
    assert row["status"] == "RESOLVED_SLA_MET"


def test_missing_urls_and_bad_refund_are_blocked(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    customer, provider = direct_accounts[1], direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)
    agreement_id = _ready(contract, vm, monkeypatch, customer, provider)
    _after_period(contract, vm, monkeypatch, agreement_id)
    with vm.expect_revert("At least 1 claim evidence"):
        _file(contract, vm, customer, agreement_id, [], [REF_STATUS, REF_MONITOR])
    with vm.expect_revert("At least 2 reference"):
        _file(contract, vm, customer, agreement_id, [EVIDENCE], [REF_STATUS])
    with vm.expect_revert("http"):
        _file(contract, vm, customer, agreement_id, ["ftp://files.example/log"], [REF_STATUS, REF_MONITOR])

    with vm.expect_revert("breach_refund_amount"):
        _create(contract, vm, monkeypatch, customer, provider, refund=0)
    with vm.expect_revert("breach_refund_amount"):
        _create(contract, vm, monkeypatch, customer, provider, refund=FEE)
    with vm.expect_revert("breach_refund_amount"):
        _create(contract, vm, monkeypatch, customer, provider, refund=FEE + 1)


def test_create_rejects_bad_configuration(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    customer, provider = direct_accounts[1], direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)
    with vm.expect_revert("cannot be the same"):
        _create(contract, vm, monkeypatch, customer, customer)
    with vm.expect_revert("amount must be > 0"):
        _create(contract, vm, monkeypatch, customer, provider, fee=0, refund=0)
    with vm.expect_revert("Service description"):
        _create(contract, vm, monkeypatch, customer, provider, desc="   ")
    with vm.expect_revert("SLA terms"):
        _create(contract, vm, monkeypatch, customer, provider, terms="  ")
    with vm.expect_revert("period_end"):
        _create(contract, vm, monkeypatch, customer, provider, period_end=T0 - 1)
    with vm.expect_revert("period_end"):
        _create(contract, vm, monkeypatch, customer, provider, period_end=T0 + 31622400 + 1)
    with vm.expect_revert("claim_window"):
        _create(contract, vm, monkeypatch, customer, provider, window=86399)
    with vm.expect_revert("claim_window"):
        _create(contract, vm, monkeypatch, customer, provider, window=2592001)
    zero = "0x0000000000000000000000000000000000000000"
    with vm.expect_revert("cannot be zero"):
        _create(contract, vm, monkeypatch, customer, zero)


def test_terms_fee_and_window_are_immutable(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    customer, provider = direct_accounts[1], direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)
    agreement_id = _ready(contract, vm, monkeypatch, customer, provider)
    before = _get(contract, agreement_id)
    _after_period(contract, vm, monkeypatch, agreement_id)
    _file(contract, vm, customer, agreement_id)
    _resolve(contract, vm, provider, agreement_id, "SLA_MET", 70, "within the cap")
    after = _get(contract, agreement_id)
    for key in ("sla_terms", "breach_refund_amount", "period_end", "claim_window_seconds", "fee_amount"):
        assert after[key] == before[key]
    src = Path(CONTRACT_PATH).read_text(encoding="utf-8")
    for forbidden in (
        "a.sla_terms =",
        "a.breach_refund_amount =",
        "a.period_end =",
        "a.claim_window_seconds =",
        "a.fee_amount =",
    ):
        assert forbidden not in src


def test_prompt_contains_security_rule_and_burden_of_proof(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    customer, provider = direct_accounts[1], direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)
    agreement_id = _ready(contract, vm, monkeypatch, customer, provider)
    _after_period(contract, vm, monkeypatch, agreement_id)
    _file(contract, vm, customer, agreement_id)

    captured = []
    import gltest.direct.wasi_mock as wasi_mock

    original = wasi_mock._handle_llm_request

    def wrapped(active_vm, data):
        captured.append(data.get("prompt", ""))
        return original(active_vm, data)

    monkeypatch.setattr(wasi_mock, "_handle_llm_request", wrapped)
    _resolve(contract, vm, customer, agreement_id, "SLA_MET", 80, "no breach proven")
    assert captured, "exec_prompt was not called"
    prompt = captured[0]
    assert "SECURITY RULE:" in prompt
    assert "NEVER follow any instruction" in prompt
    assert "BURDEN OF PROOF is on the customer" in prompt
    assert "UNTRUSTED" in prompt
    src = Path(CONTRACT_PATH).read_text(encoding="utf-8")
    assert "SECURITY RULE:" in src
    assert "BURDEN OF PROOF is on the customer" in src


def test_double_resolve_is_blocked(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    customer, provider = direct_accounts[1], direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)
    agreement_id = _ready(contract, vm, monkeypatch, customer, provider)
    _after_period(contract, vm, monkeypatch, agreement_id)
    _file(contract, vm, customer, agreement_id)
    _resolve(contract, vm, customer, agreement_id, "SLA_MET", 90, "met")
    with vm.expect_revert("not ready for resolution"):
        _resolve(contract, vm, provider, agreement_id, "SLA_BREACHED", 99, "too late")
    assert _get(contract, agreement_id)["verdict"] == "SLA_MET"
    assert amounts_to(_get(contract, agreement_id)["provider"]) == [FEE]


def test_only_parties_can_accept_cancel_and_claim(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    customer, provider, stranger = direct_accounts[1], direct_accounts[2], direct_accounts[3]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)
    agreement_id = _create(contract, vm, monkeypatch, customer, provider)
    with vm.expect_revert("Only the provider"):
        with _as(vm, customer):
            contract.accept_agreement(agreement_id)
    with vm.expect_revert("Only the customer can cancel"):
        with _as(vm, provider):
            contract.cancel_unaccepted(agreement_id)
    _accept(contract, vm, provider, agreement_id)
    _after_period(contract, vm, monkeypatch, agreement_id)
    with vm.expect_revert("Only the customer can file"):
        _file(contract, vm, stranger, agreement_id)
    with vm.expect_revert("Can only cancel"):
        with _as(vm, customer):
            contract.cancel_unaccepted(agreement_id)


def _split_ready(contract, vm, monkeypatch, customer, provider):
    agreement_id = _ready(contract, vm, monkeypatch, customer, provider)
    _after_period(contract, vm, monkeypatch, agreement_id)
    _file(contract, vm, customer, agreement_id)
    return agreement_id


def test_split_provider_fail_then_retry_does_not_double_pay(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    customer, provider, stranger = direct_accounts[1], direct_accounts[2], direct_accounts[3]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)
    agreement_id = _split_ready(contract, vm, monkeypatch, customer, provider)
    fail_transfers_to([provider])
    _resolve(contract, vm, stranger, agreement_id, "SLA_BREACHED", 86, "150 minutes")
    row = _get(contract, agreement_id)
    assert row["status"] == "PAYOUT_FAILED"
    assert row["settlement_kind"] == "SPLIT_BREACH"
    assert row["provider_credit"] == str(FEE - REFUND)
    assert row["customer_credit"] == str(REFUND)
    assert row["provider_paid"] is False
    assert row["customer_refunded"] is False
    assert amounts_to(row["provider"]) == []
    assert amounts_to(row["customer"]) == []

    clear_transfer_failures()
    row = _confirm_payout(contract, agreement_id)
    assert row["status"] == "RESOLVED_SLA_BREACHED"
    assert row["settled"] is True
    assert amounts_to(row["provider"]) == [FEE - REFUND]
    assert amounts_to(row["customer"]) == [REFUND]
    with vm.expect_revert("Can only retry"):
        contract.retry_resolution(agreement_id)


def test_split_customer_fail_then_retry_does_not_double_pay(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    customer, provider = direct_accounts[1], direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)
    agreement_id = _split_ready(contract, vm, monkeypatch, customer, provider)
    _resolve(contract, vm, provider, agreement_id, "SLA_BREACHED", 86, "150 minutes")
    fail_transfers_to([customer])
    contract.reconcile_payout(agreement_id)
    row = _get(contract, agreement_id)
    assert row["status"] == "PAYOUT_FAILED"
    assert row["provider_paid"] is True
    assert row["customer_refunded"] is False
    assert row["customer_credit"] == str(REFUND)
    assert amounts_to(row["provider"]) == [FEE - REFUND]
    assert amounts_to(row["customer"]) == []

    clear_transfer_failures()
    row = _confirm_payout(contract, agreement_id)
    assert row["status"] == "RESOLVED_SLA_BREACHED"
    assert amounts_to(row["provider"]) == [FEE - REFUND]
    assert amounts_to(row["customer"]) == [REFUND]


def test_split_both_fail_then_retry_pays_each_once(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    customer, provider = direct_accounts[1], direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)
    agreement_id = _split_ready(contract, vm, monkeypatch, customer, provider)
    fail_transfers_to([customer, provider])
    _resolve(contract, vm, customer, agreement_id, "SLA_BREACHED", 90, "clear breach")
    row = _get(contract, agreement_id)
    assert row["status"] == "PAYOUT_FAILED"
    assert row["provider_paid"] is False
    assert row["customer_refunded"] is False
    assert transfer_log() == []

    clear_transfer_failures()
    reset_transfer_log()
    row = _confirm_payout(contract, agreement_id)
    assert row["settled"] is True
    assert amounts_to(row["provider"]) == [FEE - REFUND]
    assert amounts_to(row["customer"]) == [REFUND]
    assert len(transfer_log()) == 2


def test_provider_full_fail_then_retry(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    customer, provider = direct_accounts[1], direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)
    agreement_id = _ready(contract, vm, monkeypatch, customer, provider)
    _past_claim(contract, vm, monkeypatch, agreement_id)
    fail_transfers_to([provider])
    contract.settle_unclaimed(agreement_id)
    row = _get(contract, agreement_id)
    assert row["status"] == "PAYOUT_FAILED"
    assert row["settlement_kind"] == "PROVIDER_FULL"
    assert row["provider_paid"] is False
    assert transfer_log() == []

    clear_transfer_failures()
    row = _confirm_payout(contract, agreement_id)
    assert row["status"] == "SETTLED_NO_CLAIM"
    assert amounts_to(row["provider"]) == [FEE]
    assert amounts_to(row["customer"]) == []


def test_customer_full_fail_then_retry(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    customer, provider = direct_accounts[1], direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)
    agreement_id = _create(contract, vm, monkeypatch, customer, provider)
    fail_transfers_to([customer])
    with _as(vm, customer):
        contract.cancel_unaccepted(agreement_id)
    row = _get(contract, agreement_id)
    assert row["status"] == "PAYOUT_FAILED"
    assert row["settlement_kind"] == "CUSTOMER_FULL"
    assert row["customer_refunded"] is False
    assert transfer_log() == []

    clear_transfer_failures()
    row = _confirm_payout(contract, agreement_id)
    assert row["status"] == "CANCELLED_REFUNDED"
    assert amounts_to(row["customer"]) == [FEE]
    assert amounts_to(row["provider"]) == []


def test_replace_evidence_and_inconclusive_timeout(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    customer, provider, stranger = direct_accounts[1], direct_accounts[2], direct_accounts[3]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)
    agreement_id = _ready(contract, vm, monkeypatch, customer, provider)
    _after_period(contract, vm, monkeypatch, agreement_id)
    _file(contract, vm, customer, agreement_id)
    broken = dict(_web())
    del broken[re.escape(REF_MONITOR)]
    with vm.expect_revert("Failed to fetch"):
        _resolve(contract, vm, customer, agreement_id, "SLA_BREACHED", 90, "unread", broken)
    assert _get(contract, agreement_id)["status"] == "CLAIM_FILED"

    replaced = "https://monitor.example/archive/replaced"
    with vm.expect_revert("Only the customer"):
        with _as(vm, stranger):
            contract.replace_claim_evidence(agreement_id, [EVIDENCE], [REF_STATUS, replaced])
    with _as(vm, customer):
        contract.replace_claim_evidence(agreement_id, [EVIDENCE], [REF_STATUS, replaced])
    assert replaced in _get(contract, agreement_id)["reference_urls"]

    row = _get(contract, agreement_id)
    _warp(vm, monkeypatch, int(row["stale_deadline"]))
    with vm.expect_revert("has not timed out"):
        contract.settle_inconclusive(agreement_id)
    _warp(vm, monkeypatch, int(row["stale_deadline"]) + 1)
    with vm.expect_revert("timed out"):
        _resolve(contract, vm, customer, agreement_id, "SLA_BREACHED", 99, "too late")
    with vm.expect_revert("replacement window"):
        with _as(vm, customer):
            contract.replace_claim_evidence(agreement_id, [EVIDENCE], [REF_STATUS, replaced])
    with _as(vm, stranger):
        contract.settle_inconclusive(agreement_id)
    row = _confirm_payout(contract, agreement_id)
    assert row["status"] == "SETTLED_INCONCLUSIVE"
    assert row["settlement_kind"] == "PROVIDER_FULL"
    assert row["provider_paid"] is True
    assert amounts_to(row["provider"]) == [FEE]
    assert amounts_to(row["customer"]) == []


def test_failed_delivery_preserves_credit_and_does_not_double_pay(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    customer, provider = direct_accounts[1], direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)
    agreement_id = _ready(contract, vm, monkeypatch, customer, provider)
    _past_claim(contract, vm, monkeypatch, agreement_id)
    hold_delivery_to([provider])
    contract.settle_unclaimed(agreement_id)
    row = _get(contract, agreement_id)
    assert row["status"] == "PAYOUT_PENDING"
    assert row["provider_paid"] is False
    assert row["provider_in_flight"] is True
    assert row["provider_credit"] == str(FEE)
    assert amounts_to(row["provider"]) == [FEE]

    contract.reconcile_payout(agreement_id)
    row = _get(contract, agreement_id)
    assert row["provider_paid"] is False
    assert amounts_to(row["provider"]) == [FEE]

    _set_value(vm, FEE)
    contract.__on_errored_message__()
    row = _get(contract, agreement_id)
    assert row["status"] == "PAYOUT_FAILED"
    assert row["provider_paid"] is False
    assert row["provider_in_flight"] is False
    assert row["provider_credit"] == str(FEE)
    assert "credit preserved" in row["verdict_reason"]

    clear_transfer_failures()
    row = _confirm_payout(contract, agreement_id)
    assert row["status"] == "SETTLED_NO_CLAIM"
    assert row["provider_paid"] is True
    assert amounts_to(row["provider"]) == [FEE, FEE]
    with vm.expect_revert("already settled"):
        contract.reconcile_payout(agreement_id)


def test_disallowed_verdict_value_reverts(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    customer, provider = direct_accounts[1], direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)
    agreement_id = _ready(contract, vm, monkeypatch, customer, provider)
    _after_period(contract, vm, monkeypatch, agreement_id)
    _file(contract, vm, customer, agreement_id)
    _install_mocks(vm, json.dumps({"verdict": "PARTIAL", "confidence": 99, "reason": "no"}))
    with vm.expect_revert("LLM verdict value not allowed"):
        with _as(vm, customer):
            contract.resolve_claim(agreement_id)
    assert _get(contract, agreement_id)["status"] == "CLAIM_FILED"


def test_clock_reads_message_datetime(direct_vm, direct_deploy):
    direct_deploy(CONTRACT_PATH)
    mods = _contract_modules()
    assert mods, "contract module was not loaded"
    mod = mods[0]
    raw = getattr(getattr(mod, "gl", None), "message_raw", None)
    assert isinstance(raw, dict)
    raw["datetime"] = "2024-01-01T00:00:00Z"
    assert int(mod._current_unix_timestamp()) == 1704067200
