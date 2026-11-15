"""Local business services work without cloud credentials, sockets or a browser."""
import json

import pytest

from xscript_desktop.context import AppContext
from xscript_desktop.services.backend_client import BackendError
from xscript_desktop.services.local_admin import LocalAdmin


async def test_local_catalog_and_persistent_script_crud(tmp_path):
    service = LocalAdmin(tmp_path / 'admin')
    try:
        catalog = await service.catalog()
        assert catalog['local'] is True
        groups = {operation['group'] for operation in catalog['operations']}
        assert {'cards', 'users', 'resellers', 'maintenance', 'settings', 'scripts', 'pack'} <= groups
        created = await service.execute('POST /api/scripts', body={'name': 'local', 'project_name': 'local'})
        assert created.status_code == 200
        script_id = created.json()['id']
        await service.execute('PATCH /api/scripts/{script_id}', {'script_id': script_id}, {'description': 'saved locally'})
    finally:
        await service.close()
    reopened = LocalAdmin(tmp_path / 'admin')
    try:
        rows = (await reopened.execute('GET /api/scripts')).json()['items']
        assert rows[0]['description'] == 'saved locally'
        await reopened.execute('DELETE /api/scripts/{script_id}', {'script_id': script_id})
        assert not (await reopened.execute('GET /api/scripts')).json()['items']
        with pytest.raises(BackendError):
            await reopened.execute('GET https://evil.example')
        with pytest.raises(BackendError):
            await reopened.execute('GET /api/scripts/{script_id}', {'script_id': '../users'})
    finally:
        await reopened.close()


async def test_local_rpc_never_requires_cloud_connection(tmp_path):
    ctx = AppContext(data_dir=tmp_path)
    async def rpc(method, **params):
        return json.loads(await ctx.dispatcher.handle(json.dumps({'id': 1, 'method': method, 'params': params})))
    try:
        assert (await rpc('cloud.status'))['result']['state'] == 'not_configured'
        catalog = await rpc('admin.catalog')
        assert catalog['ok'], catalog
        result = await rpc('admin.execute', operation='GET /api/settings')
        assert result['ok'], result
        assert result['result']['database'] == 'sqlite'
        assert (tmp_path / 'administration' / 'xscript.db').is_file()
        assert not (await rpc('admin.execute', operation='POST /api/unknown'))['ok']
    finally:
        await ctx.shutdown()


async def test_cards_users_settings_backup_and_file_download(tmp_path):
    service = LocalAdmin(tmp_path / 'admin')
    try:
        created = (await service.execute('POST /api/cards/batches', body={'count': 2, 'days': 30})).json()
        assert len(created['cards']) == 2
        assert len((await service.execute('GET /api/cards')).json()['items']) == 2
        user = (await service.execute('POST /api/users', body={'username': 'operator', 'password': 'Local-test-password-123', 'role': 'operator'})).json()
        await service.execute('PATCH /api/users/{user_id}', {'user_id': user['id']}, {'disabled': True})
        assert any(row['id'] == user['id'] and row['disabled'] for row in (await service.execute('GET /api/users')).json()['items'])
        await service.execute('PUT /api/settings', body={'site_name': 'Local desktop'})
        assert (await service.execute('GET /api/settings')).json()['site_name'] == 'Local desktop'
        backup = (await service.execute('POST /api/maintenance/backup')).json()
        assert backup
        exported = await service.execute('GET /api/cards/export')
        assert exported.content
        operations = (await service.catalog())['operations']
        assert not any(operation['group'] in {'pack-worker', 'reseller', 'health'} for operation in operations)
    finally:
        await service.close()


async def test_demo_catalog_matches_local_business_routes(tmp_path):
    from pathlib import Path
    service = LocalAdmin(tmp_path / 'admin')
    try:
        catalog = await service.catalog()
        snapshot = Path(__file__).resolve().parents[2] / 'frontend/src/generated/admin-catalog.json'
        assert catalog == json.loads(snapshot.read_text())
    finally:
        await service.close()
