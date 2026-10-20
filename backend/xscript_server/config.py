"""Runtime configuration. Everything the server writes lives under one data directory."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

PKG_DIR = Path(__file__).resolve().parent
BACKEND_DIR = PKG_DIR.parent
DEFAULT_WEB_DIR = BACKEND_DIR / "web" / "dist"
DEFAULT_PACK_SCRIPT = BACKEND_DIR / "xscript_pack.py"


@dataclass
class Config:
    data_dir: Path
    web_dir: Path | None = DEFAULT_WEB_DIR
    session_hours: float = 12.0
    scheduler_interval: float = 15.0
    maintenance_interval: float = 60.0
    # How often changed device status / cloud.send() data is written (always on disconnect too).
    status_flush_interval: float = 15.0
    pack_script: Path | None = DEFAULT_PACK_SCRIPT
    # Release signing for pack jobs. Passwords stay in the environment, never in the database.
    keystore: str = ""
    key_alias: str = "key0"
    store_pass: str = ""
    key_pass: str = ""
    # XSCRIPT_DATABASE_URL: PostgreSQL (postgresql://user:pass@host:5432/db). "" = SQLite in the data dir.
    database_url: str = ""
    # XSCRIPT_PACK_MODE: "local" (default) builds here, one job at a time; "remote" leaves jobs in the
    # database for separate 打包机 (`python -m xscript_server pack-worker`) to claim.
    pack_mode: str = "local"

    @classmethod
    def load(cls, data_dir: str | os.PathLike | None = None, web_dir: str | None = None) -> "Config":
        data = Path(data_dir or os.environ.get("XSCRIPT_DATA") or "xscript-data").expanduser().resolve()
        web = web_dir or os.environ.get("XSCRIPT_WEB_DIR")
        return cls(
            data_dir=data,
            web_dir=Path(web).resolve() if web else DEFAULT_WEB_DIR,
            session_hours=float(os.environ.get("XSCRIPT_SESSION_HOURS", "12")),
            # XSCRIPT_PACK=off: images without the Android toolchain (APK 打包 shows as unavailable).
            pack_script=None if os.environ.get("XSCRIPT_PACK", "").lower() in ("off", "0", "false") else DEFAULT_PACK_SCRIPT,
            keystore=os.environ.get("XSCRIPT_KEYSTORE", ""),
            key_alias=os.environ.get("XSCRIPT_KEY_ALIAS", "key0"),
            store_pass=os.environ.get("XSCRIPT_STORE_PASS", ""),
            key_pass=os.environ.get("XSCRIPT_KEY_PASS", ""),
            database_url=os.environ.get("XSCRIPT_DATABASE_URL", "").strip(),
            pack_mode="remote" if os.environ.get("XSCRIPT_PACK_MODE", "").strip().lower() == "remote" else "local",
        )

    @property
    def db_path(self) -> Path:
        """The SQLite file (only used when database_url is empty)."""
        return self.data_dir / "xscript.db"

    @property
    def db_url(self) -> str:
        """What Database() opens: the PostgreSQL URL, else the SQLite file path."""
        return self.database_url or str(self.db_path)

    @property
    def key_path(self) -> Path:
        return self.data_dir / "keys" / "private.pem"

    @property
    def pack_dir(self) -> Path:
        return self.data_dir / "pack"

    @property
    def scripts_dir(self) -> Path:
        return self.data_dir / "scripts"

    @property
    def backup_dir(self) -> Path:
        return self.data_dir / "backups"

    @property
    def release_signing(self) -> bool:
        return bool(self.keystore and self.store_pass and Path(self.keystore).is_file())

    def ensure_dirs(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        os.chmod(self.data_dir, 0o700)
        self.pack_dir.mkdir(exist_ok=True)
        self.scripts_dir.mkdir(exist_ok=True)
