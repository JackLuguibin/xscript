"""Bounded native flow documents. Paths are chosen by the shell, never by web content."""
from __future__ import annotations

import os
import tempfile
from pathlib import Path

MAX_BYTES = 3 * 1024 * 1024  # bridge JSON envelope remains below its 4 MiB limit


def write_document(path: str, content: str) -> None:
    if len(content.encode('utf-8')) > MAX_BYTES:
        raise ValueError('Flow document exceeds 3 MiB')
    target = Path(path)
    fd, temporary = tempfile.mkstemp(dir=target.parent, prefix='.xscript-flow-')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8', newline='') as stream:
            stream.write(content)
        os.replace(temporary, target)
    finally:
        Path(temporary).unlink(missing_ok=True)


def read_document(path: str) -> str:
    with Path(path).open('rb') as stream:
        data = stream.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError('Flow document exceeds 3 MiB')
    return data.decode('utf-8')
