"""Address-scoped emit_transfer spy for partial payout failures.

gltest routes gl.get_contract_at(eoa) to _EOAProxy. Tests replace emit_transfer
so a chosen recipient raises, while the other recipient is recorded once.
"""

_FAIL_ADDRS = set()
_HOLD_ADDRS = set()
_LOG = []


def _norm(addr) -> str:
    if addr is None:
        return ""
    if hasattr(addr, "as_hex"):
        try:
            hx = str(addr.as_hex).lower()
            if not hx.startswith("0x"):
                hx = "0x" + hx
            return hx
        except Exception:
            pass
    if isinstance(addr, (bytes, bytearray)):
        return "0x" + bytes(addr).hex()
    s = str(addr).strip().lower()
    if "0x" in s:
        i = s.find("0x")
        return s[i:i + 42]
    return s


def reset_transfer_log():
    global _LOG
    _LOG = []


def clear_transfer_failures():
    _FAIL_ADDRS.clear()
    _HOLD_ADDRS.clear()


def fail_transfers_to(addresses):
    _FAIL_ADDRS.clear()
    for addr in addresses:
        _FAIL_ADDRS.add(_norm(addr))


def hold_delivery_to(addresses):
    """Emission succeeds, but the recipient balance does not increase."""
    _HOLD_ADDRS.clear()
    for addr in addresses:
        _HOLD_ADDRS.add(_norm(addr))


def transfer_log():
    return list(_LOG)


def amounts_to(addr):
    key = _norm(addr)
    return [amount for dest, amount in _LOG if dest == key]


def install_transfer_spy(monkeypatch):
    import gltest.direct.loader as loader

    def emit_transfer(self, value=None, **kwargs):
        amount = value if value is not None else kwargs.get("value", 0)
        amount = int(amount)
        dest = _norm(self.address)
        if dest in _FAIL_ADDRS:
            raise Exception("Simulated native transfer execution failure")
        _LOG.append((dest, amount))
        if dest in _HOLD_ADDRS:
            return self
        try:
            from gltest.direct import wasi_mock

            active = wasi_mock.get_vm()
            if amount and hasattr(active, "_balances"):
                key = active._to_bytes(self.address)
                active._balances[key] = active._balances.get(key, 0) + amount
        except Exception:
            pass
        return self

    def balance(self):
        from gltest.direct import wasi_mock

        active = wasi_mock.get_vm()
        if active is None or not hasattr(active, "_balances"):
            return 0
        key = active._to_bytes(self.address)
        return int(active._balances.get(key, 0))

    monkeypatch.setattr(loader._EOAProxy, "emit_transfer", emit_transfer)
    monkeypatch.setattr(loader._EOAProxy, "balance", property(balance), raising=False)
