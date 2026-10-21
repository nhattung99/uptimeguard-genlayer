import pytest

from transfer_mock import clear_transfer_failures, install_transfer_spy, reset_transfer_log


@pytest.fixture(autouse=True)
def _uptime_transfer_spy(monkeypatch):
    install_transfer_spy(monkeypatch)
    reset_transfer_log()
    clear_transfer_failures()
    yield
    clear_transfer_failures()
    reset_transfer_log()
