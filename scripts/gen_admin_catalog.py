#!/usr/bin/env python3
"""Regenerate the browser demo's native administration forms from shared business routes.

Run with desktop/app/.venv/bin/python scripts/gen_admin_catalog.py.
"""
import asyncio
import json
from pathlib import Path
import tempfile

from xscript_desktop.services.local_admin import LocalAdmin


async def main():
    with tempfile.TemporaryDirectory() as directory:
        service = LocalAdmin(Path(directory))
        try:
            catalog = await service.catalog()
            target = Path(__file__).resolve().parents[1] / 'desktop/frontend/src/generated/admin-catalog.json'
            target.write_text(json.dumps(catalog, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
            print(f'Generated {len(catalog["operations"])} native operations')
        finally:
            await service.close()


if __name__ == '__main__':
    asyncio.run(main())
