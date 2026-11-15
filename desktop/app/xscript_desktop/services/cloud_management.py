"""Named desktop management operations. No arbitrary URLs or HTTP methods cross the bridge."""
from __future__ import annotations

import re
from urllib.parse import quote
from typing import Any

from .backend_client import BackendClient, BackendError, account
from .secrets import redact

# resource: API path, minimum role; writes are explicitly listed below.
RESOURCES = {
    'trends': ('/stats/daily', 'viewer'), 'devices': ('/devices', 'viewer'),
    'scripts': ('/scripts', 'viewer'), 'notices': ('/app-notices', 'viewer'),
    'updates': ('/app-updates', 'viewer'), 'keys': ('/device-keys', 'admin'),
    'cards': ('/cards', 'operator'), 'batches': ('/cards/batches', 'operator'),
    'cardStats': ('/cards/stats', 'operator'), 'bans': ('/cards/bans', 'operator'),
    'workers': ('/pack/workers', 'admin'), 'audit': ('/audit', 'admin'),
    'users': ('/users', 'admin'), 'resellers': ('/resellers', 'admin'),
    'balances': ('/resellers/balances', 'admin'), 'settings': ('/settings', 'admin'),
    'maintenance': ('/maintenance', 'admin'), 'account': ('/auth/me', 'viewer'),
    'builds': ('/pack/jobs', 'viewer'),
    'tokens': ('/auth/tokens', 'viewer'), 'ai': ('/ai/status', 'viewer'),
}
WRITES = {
    ('tokens', 'delete'): ('DELETE', '/{id}', 'viewer'),
    ('devices', 'update'): ('PATCH', '/{id}', 'operator'),
    ('devices', 'delete'): ('DELETE', '/{id}', 'admin'),
    ('devices', 'group'): ('POST', '/batch-group', 'operator'),
    ('scripts', 'create'): ('POST', '', 'operator'),
    ('scripts', 'update'): ('PATCH', '/{id}', 'operator'),
    ('scripts', 'delete'): ('DELETE', '/{id}', 'admin'),
    ('scripts', 'publish'): ('POST', '/{id}/publish', 'admin'),
    ('scripts', 'unpublish'): ('POST', '/{id}/unpublish', 'admin'),
    ('scripts', 'deleteVersion'): ('DELETE', '/{id}/versions/{child}', 'admin'),
    ('notices', 'create'): ('POST', '', 'operator'),
    ('notices', 'update'): ('PATCH', '/{id}', 'operator'),
    ('notices', 'delete'): ('DELETE', '/{id}', 'operator'),
    ('updates', 'update'): ('PUT', '/{id}', 'admin'),
    ('updates', 'delete'): ('DELETE', '/{id}', 'admin'),
    ('keys', 'create'): ('POST', '', 'admin'),
    ('keys', 'revoke'): ('POST', '/{id}/revoke', 'admin'),
    ('keys', 'delete'): ('DELETE', '/{id}', 'admin'),
    ('workers', 'enable'): ('POST', '/{id}/enable', 'admin'),
    ('workers', 'disable'): ('POST', '/{id}/disable', 'admin'),
    ('ai', 'generate'): ('POST', '/script', 'operator'),
    ('ai', 'save'): ('POST', '/save', 'operator'),
}
READS = {
    ('devices', 'detail'): '/{id}', ('scripts', 'detail'): '/{id}',
    ('scripts', 'versions'): '/{id}/versions', ('scripts', 'source'): '/{id}/versions/{child}/source',
    ('resellers', 'ledger'): '/{id}/ledger', ('resellers', 'prices'): '/{id}/prices',
}
LEVEL = {'viewer': 0, 'operator': 1, 'admin': 2}


def identifier(value: Any) -> str:
    text = str(value)
    if not text or len(text) > 200 or not re.fullmatch(r'[A-Za-z0-9_.:@-]+', text) or text in {'.', '..'}:
        raise BackendError('backend.bad_params', 'Invalid management identifier')
    return quote(text, safe='')


def clean(value: Any, token: str) -> Any:
    if isinstance(value, str):
        return redact(value, token)
    if isinstance(value, list):
        return [clean(item, token) for item in value]
    if isinstance(value, dict):
        return {key: clean(item, token) for key, item in value.items()
                if key.lower() not in {'password', 'secret', 'api_key', 'password_hash', 'token_hash'}}
    return value


async def request(client: BackendClient, resource: str, action: str = 'list', *, item: Any = '', child: Any = '',
                  body: dict | None = None, query: dict | None = None) -> Any:
    if resource not in RESOURCES:
        raise BackendError('backend.bad_params', 'Unknown management resource')
    path, role = RESOURCES[resource]
    method, suffix = 'GET', ''
    if action != 'list':
        if (resource, action) in READS:
            suffix = READS[resource, action]
        elif (resource, action) in WRITES:
            method, suffix, role = WRITES[resource, action]
        else:
            raise BackendError('backend.bad_params', 'Unsupported management operation')
    if LEVEL.get((await client.me()).get('role'), -1) < LEVEL[role]:
        raise BackendError('backend.forbidden', 'Insufficient role', status=403)
    if resource == 'ai' and action in {'generate', 'save'}:
        path = '/ai'
    if resource == 'scripts' and action == 'source':
        path, suffix = '/ai', '/source/{id}/{child}'
        if not account(await client.me())['canOperate']:
            raise BackendError('backend.forbidden', 'Insufficient role', status=403)
    if '{id}' in suffix:
        suffix = suffix.replace('{id}', identifier(item))
    if '{child}' in suffix:
        suffix = suffix.replace('{child}', identifier(child))
    if query and (len(query) > 20 or any(not re.fullmatch(r'[A-Za-z_]+', k) for k in query)):
        raise BackendError('backend.bad_params', 'Invalid filters')
    if resource == 'tokens' and action == 'delete':
        tokens = await client.get('/auth/tokens')
        if any(str(row.get('id')) == str(item) and row.get('current') for row in tokens.get('items', [])):
            raise BackendError('backend.bad_params', 'Cannot revoke the active desktop token')
    result = await client.request(method, path + suffix, params=query, json=body if method != 'GET' else None)
    return clean(result, client._token)
