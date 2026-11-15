"""Management capability boundaries and native flow file round-trips."""
import json
from unittest.mock import AsyncMock

import pytest

from xscript_desktop.context import AppContext
from xscript_desktop.services import cloud_management as management
from xscript_desktop.services.backend_client import BackendError
from xscript_desktop.services.flow_files import MAX_BYTES, read_document, write_document


def test_flow_file_bounds_and_atomic_replacement(tmp_path):
    target = tmp_path / 'sample.xflow'
    write_document(str(target), '流程 α')
    assert read_document(str(target)) == '流程 α'
    with pytest.raises(ValueError): write_document(str(target), 'x' * (MAX_BYTES + 1))
    assert read_document(str(target)) == '流程 α'
    target.write_bytes(b'x' * (MAX_BYTES + 1))
    with pytest.raises(ValueError): read_document(str(target))
    assert not list(tmp_path.glob('.xscript-flow-*'))


@pytest.mark.parametrize('resource', list(management.RESOURCES))
async def test_management_reads_have_fixed_routes(resource):
    client = AsyncMock()
    client._token = 'xsk_secret'
    client.me.return_value = {'role': 'admin'}
    client.request.return_value = {'items': [{'name': 'xsk_secret', 'password_hash': 'never'}]}
    result = await management.request(client, resource)
    assert client.request.call_args.args[:2] == ('GET', management.RESOURCES[resource][0])
    assert 'xsk_secret' not in json.dumps(result) and 'never' not in json.dumps(result)


@pytest.mark.parametrize('resource,action', list(management.WRITES))
async def test_management_writes_and_role_checks(resource, action):
    client = AsyncMock()
    client._token = 'xsk_secret'
    client.me.return_value = {'role': 'admin'}
    client.get.return_value = {'items': []}
    client.request.return_value = {'ok': True}
    await management.request(client, resource, action, item='12', child='3', body={'name': 'test'})
    assert client.request.call_count == 1
    client.request.reset_mock()
    client.me.return_value = {'role': 'reseller'}
    with pytest.raises(BackendError): await management.request(client, resource, action, item='12', child='3')
    client.request.assert_not_called()


async def test_management_rejects_unknown_routes_traversal_and_current_token():
    client = AsyncMock()
    client._token = 'xsk_secret'
    client.me.return_value = {'role': 'admin'}
    for resource, action, item in [('unknown', 'list', ''), ('scripts', 'arbitrary', ''), ('scripts', 'detail', '../auth')]:
        with pytest.raises(BackendError): await management.request(client, resource, action, item=item)
    client.get.return_value = {'items': [{'id': 2, 'current': True}]}
    with pytest.raises(BackendError): await management.request(client, 'tokens', 'delete', item=2)
    client.request.assert_not_called()


async def test_native_flow_rpc_roundtrip_and_cancel(tmp_path):
    ctx = AppContext(data_dir=tmp_path)
    target = tmp_path / 'sample.xflow'
    ctx.save_file = AsyncMock(return_value=str(target))
    ctx.open_file = AsyncMock(return_value=str(target))
    async def rpc(method, **params):
        return json.loads(await ctx.dispatcher.handle(json.dumps({'id': 1, 'method': method, 'params': params})))
    try:
        layout = {'xflowLayout': 1, 'nodes': {}, 'viewport': {'x': 0, 'y': 0, 'zoom': 1}}
        saved = await rpc('flow.saveDocument', name='sample.xflow', content='flow sample\n', layout=layout)
        assert saved['ok'], saved
        handle = saved['result']['handle']
        await rpc('flow.saveDocument', name='sample.xflow', content='flow revised\n', handle=handle)
        ctx.save_file.assert_awaited_once()
        opened = await rpc('flow.openDocument')
        assert opened['result']['content'] == 'flow revised\n'
        assert opened['result']['layout'] == layout
        ctx.open_file.return_value = None
        assert (await rpc('flow.openDocument'))['result']['cancelled']
        assert not (await rpc('flow.saveDocument', name='../escape.xflow', content='x'))['ok']
    finally:
        await ctx.shutdown()
