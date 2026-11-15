"""In-process backend business services. No listening socket, remote URL or login is involved."""
from __future__ import annotations

import asyncio
import secrets
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx

from .backend_client import BackendError, _detail


class LocalAdmin:
    def __init__(self, data_dir: Path) -> None:
        self.data_dir = data_dir
        self._lock = asyncio.Lock()
        self.app = None
        self.http = None
        self._lifespan = None
        self.operations: dict[str, dict] = {}

    async def start(self) -> None:
        async with self._lock:
            if self.app is not None:
                return
            from xscript_server.app import create_app
            from xscript_server.config import Config
            from xscript_server.deps import Principal, current_user
            from xscript_server.models import User
            from xscript_server.security import hash_password
            from sqlalchemy import select

            config = Config.load(data_dir=self.data_dir)
            config.web_dir = None
            config.database_url = ""  # Always use the desktop database, even if a remote-server environment is present.
            if config.pack_script and not config.pack_script.is_file():
                config.pack_script = None
            app = await asyncio.to_thread(create_app, config)
            with app.state.ctx.db.session() as session:
                owner = session.scalar(select(User).where(User.username == '__desktop_owner__'))
                if owner is None:
                    owner = User(username='__desktop_owner__', password_hash=hash_password(secrets.token_urlsafe(48)), role='admin')
                    session.add(owner)
                    session.commit()
                owner_id = owner.id

            # Only this private ASGI transport sees the override. This app is never mounted on a network server.
            def local_owner():
                return Principal(owner_id, '__desktop_owner__', 'admin', 'web', 0)

            app.dependency_overrides[current_user] = local_owner
            lifespan = app.router.lifespan_context(app)
            try:
                await lifespan.__aenter__()
                self._build_catalog(app.openapi())
                self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://desktop.local', timeout=120)
            except BaseException:
                await lifespan.__aexit__(None, None, None)
                raise
            self._lifespan = lifespan
            self.app = app

    def _build_catalog(self, schema: dict) -> None:
        definitions = schema.get('components', {}).get('schemas', {})

        def resolve(value: dict, depth=0) -> dict:
            if depth > 12:
                return {'type': 'object'}
            if '$ref' in value:
                return resolve(definitions.get(value['$ref'].split('/')[-1], {}), depth + 1)
            if 'anyOf' in value:
                options = [v for v in value['anyOf'] if v.get('type') != 'null']
                return {**resolve(options[0], depth + 1), **{k: v for k, v in value.items() if k != 'anyOf'}} if options else {'type': 'string'}
            return {k: ({n: resolve(v, depth + 1) for n, v in item.items()} if k == 'properties' else resolve(item, depth + 1) if k == 'items' and isinstance(item, dict) else item) for k, item in value.items()}

        for path, methods in schema['paths'].items():
            if not path.startswith('/api/') or path.startswith(('/api/pack-worker/', '/api/reseller/')) or path in {'/api/auth/login', '/api/auth/logout', '/api/health'}:
                continue
            for method, operation in methods.items():
                if method not in {'get', 'post', 'put', 'patch', 'delete'}:
                    continue
                content = operation.get('requestBody', {}).get('content', {})
                media = next(iter(content), '')
                body = resolve(content[media].get('schema', {})) if media else {}
                parameters = [{**p, 'schema': resolve(p.get('schema', {}))} for p in operation.get('parameters', [])]
                key = f'{method.upper()} {path}'
                self.operations[key] = {'id': key, 'method': method.upper(), 'path': path,
                    'group': path.split('/')[2], 'title': operation.get('summary', operation.get('operationId', key)),
                    'parameters': parameters, 'body': body, 'media': media}

    async def catalog(self) -> dict:
        await self.start()
        return {'operations': list(self.operations.values()), 'local': True}

    async def execute(self, operation: str, parameters: dict | None = None, body: dict | None = None,
                      files: dict | None = None) -> httpx.Response:
        await self.start()
        spec = self.operations.get(operation)
        if spec is None:
            raise BackendError('backend.bad_params', 'Unknown local administration operation')
        parameters = parameters or {}
        path = spec['path']
        query = {}
        for parameter in spec['parameters']:
            name = parameter['name']
            value = parameters.get(name)
            if parameter['in'] == 'path':
                if value is None or not str(value) or str(value) in {'.', '..'} or any(c in str(value) for c in '/\\\0'):
                    raise BackendError('backend.bad_params', 'Invalid identifier: ' + name)
                path = path.replace('{' + name + '}', quote(str(value), safe=''))
            elif parameter['in'] == 'query' and value is not None:
                query[name] = value
        kwargs: dict[str, Any] = {'params': query}
        if spec['media'].startswith('multipart/'):
            kwargs.update(files=files or {}, data={k: str(v) for k, v in (body or {}).items()})
        elif spec['media']:
            kwargs['json'] = body or {}
        response = await self.http.request(spec['method'], path, **kwargs)
        if response.status_code >= 400:
            raise BackendError('backend.http', _detail(response) or f'Local operation failed ({response.status_code})', status=response.status_code)
        return response

    async def close(self) -> None:
        async with self._lock:
            if self.http:
                await self.http.aclose()
            if self._lifespan:
                await self._lifespan.__aexit__(None, None, None)
            self.app = self.http = self._lifespan = None
