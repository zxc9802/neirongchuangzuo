"""Private gateway credits adapter. No prices or identities are accepted from browser bodies."""
import math
import os
from urllib.parse import urlparse

import requests


class CreditError(Exception):
    def __init__(self, message, status=503, code='CREDITS_UNAVAILABLE', uncertain=False):
        super().__init__(message)
        self.status, self.code, self.uncertain = status, code, uncertain


class CreditsClient:
    def __init__(self, url, token):
        parsed = urlparse(url)
        if parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1', 'localhost') or not token:
            raise ValueError('积分回调必须为有凭据的本机 HTTP 服务')
        self.url, self.token = url.rstrip('/'), token

    def call(self, action, owner, task_id=None, units=None):
        body = {'owner': owner}
        if task_id is not None:
            body['taskId'] = task_id
        if units is not None:
            body['units'] = units
        try:
            response = requests.post(self.url + '/' + action,
                headers={'Authorization': 'Bearer ' + self.token}, json=body,
                timeout=(3, 15), allow_redirects=False)
            data = response.json()
        except (requests.RequestException, ValueError):
            raise CreditError('积分状态暂未确认，已保留任务，请稍后继续。', uncertain=True) from None
        if not response.ok:
            raise CreditError(data.get('error', '积分服务暂时不可用'), response.status_code,
                              data.get('code', 'CREDITS_UNAVAILABLE'), response.status_code >= 500)
        return data.get('wallet') if action == 'snapshot' else data.get('reservation')

    def snapshot(self, owner):
        return self.call('snapshot', owner)

    def read(self, owner, task_id):
        return self.call('read', owner, task_id)

    def reserve(self, owner, task_id, units):
        return self.call('reserve', owner, task_id, units)

    def extend(self, owner, task_id, units):
        return self.call('extend', owner, task_id, units)

    def settle(self, owner, task_id, units):
        return self.call('settle', owner, task_id, units)

    def release(self, owner, task_id):
        return self.call('release', owner, task_id)


def configured_credits():
    url = os.environ.get('MIX_CREDITS_URL')
    if not url:
        if os.environ.get('MIX_CREDITS_ENABLED') == '1':
            raise ValueError('混剪积分回调尚未配置，暂停启动')
        return None
    return CreditsClient(url, os.environ.get('MIXER_API_TOKEN', ''))


def estimate_seconds(text):
    # Matches the editor's reading-speed preview; the final fee always uses ffprobe.
    return max(1, math.ceil(len(''.join(str(text).split())) / 4))
