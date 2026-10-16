"""Bind paid calls to a verified account and a durable operation in the Node ledger."""
import os
from contextlib import contextmanager
from contextvars import ContextVar

from credits import CreditError, configured_credits

_scope = ContextVar('mix_cost_scope', default=None)


@contextmanager
def billing_scope(owner, scope, legacy=False):
    enabled = os.environ.get('MIX_API_COST_ENABLED') == '1'
    client = configured_credits() if enabled and not legacy else None
    if enabled and not legacy and client is None:
        raise CreditError('混剪费用服务尚未连接，暂停模型调用。')
    token = _scope.set((client, owner, scope) if client else False)
    try:
        yield
    finally:
        try:
            if client:
                client.close_scope(owner, scope)
        finally:
            _scope.reset(token)


def paid_post(url, payload, call_key=None):
    scope = _scope.get()
    if scope:
        client, owner, operation = scope
        return (client.provider(owner, operation, url, payload, call_key=call_key)
                if call_key else client.provider(owner, operation, url, payload))
    if scope is None and os.environ.get('MIX_API_COST_ENABLED') == '1':
        raise CreditError('模型调用缺少账号费用上下文，尚未发送请求。')
    return None


def metering_enabled():
    return bool(_scope.get())


def reject_result(url, payload):
    scope = _scope.get()
    if scope:
        client, owner, operation = scope
        client.reject_result(owner, operation, url, payload)
