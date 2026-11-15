"""Private object storage for hot-update bundles; sources and manifests stay on the server."""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit


class StorageError(RuntimeError):
    pass


@dataclass(frozen=True)
class UpdateStorage:
    provider: str = "local"
    bucket: str = ""
    region: str = ""
    endpoint: str = ""
    prefix: str = "xscript/updates"
    access_key: str = field(default="", repr=False)
    secret_key: str = field(default="", repr=False)
    token: str = field(default="", repr=False)
    url_seconds: int = 300

    def __post_init__(self):
        if self.provider not in {"local", "oss", "cos"}:
            raise ValueError("XSCRIPT_UPDATE_STORAGE must be local, oss or cos")
        if not 60 <= self.url_seconds <= 3600:
            raise ValueError("XSCRIPT_UPDATE_URL_SECONDS must be between 60 and 3600")
        if self.provider == "local":
            return
        if not all((self.bucket, self.region, self.access_key, self.secret_key)):
            raise ValueError("Object storage requires bucket, region, access key and secret key")
        if not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,253}", self.bucket):
            raise ValueError("Invalid object storage bucket")
        if not re.fullmatch(r"[a-z0-9-]+", self.region):
            raise ValueError("Invalid object storage region")
        if self.prefix and (not re.fullmatch(r"[A-Za-z0-9/_-]+", self.prefix) or
                            any(p in {"", ".", ".."} for p in self.prefix.split("/"))):
            raise ValueError("Invalid object storage key prefix")
        if self.provider == "oss":
            u = urlsplit(self.endpoint)
            if (u.scheme != "https" or not u.hostname or u.username or u.password or
                    u.query or u.fragment or u.path not in {"", "/"}):
                raise ValueError("OSS endpoint must be an HTTPS origin")
        elif self.endpoint:
            raise ValueError("COS uses XSCRIPT_UPDATE_REGION; leave XSCRIPT_UPDATE_ENDPOINT empty")

    @classmethod
    def load(cls) -> "UpdateStorage":
        return cls(
            provider=os.environ.get("XSCRIPT_UPDATE_STORAGE", "local").strip().lower(),
            bucket=os.environ.get("XSCRIPT_UPDATE_BUCKET", "").strip(),
            region=os.environ.get("XSCRIPT_UPDATE_REGION", "").strip(),
            endpoint=os.environ.get("XSCRIPT_UPDATE_ENDPOINT", "").strip(),
            prefix=os.environ.get("XSCRIPT_UPDATE_PREFIX", "xscript/updates").strip().strip("/"),
            access_key=os.environ.get("XSCRIPT_UPDATE_ACCESS_KEY", "").strip(),
            secret_key=os.environ.get("XSCRIPT_UPDATE_SECRET_KEY", "").strip(),
            token=os.environ.get("XSCRIPT_UPDATE_TOKEN", "").strip(),
            url_seconds=int(os.environ.get("XSCRIPT_UPDATE_URL_SECONDS", "300")),
        )

    def object_key(self, digest: str) -> str:
        if not re.fullmatch(r"[a-f0-9]{64}", digest):
            raise ValueError("Invalid bundle SHA-256")
        return "/".join(p for p in (self.prefix, digest + ".zip") if p)


def download_url(config: UpdateStorage, path: Path, digest: str) -> str | None:
    """Upload the exact device bundle if missing, then sign a short-lived private GET URL.

    Digest keys distinguish protected/plain bundles and avoid overwriting a URL already issued.
    No SDK is loaded for the default local storage mode. Do not expose SDK exception messages:
    they can contain signed request URLs, account identifiers or temporary credentials.
    """
    if config.provider == "local":
        return None
    try:
        key = config.object_key(digest)
        if config.provider == "oss":
            url = _oss_url(config, path, key)
        else:
            url = _cos_url(config, path, key)
        parsed = urlsplit(url)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
            raise StorageError("Object storage did not return an HTTPS download URL")
        return url
    except ImportError:
        raise StorageError("Install xscript-server[object-storage] to use OSS/COS hot updates") from None
    except StorageError:
        raise
    except Exception:
        raise StorageError("Object storage request failed; check credentials, bucket, region and permissions") from None


def _oss_url(config: UpdateStorage, path: Path, key: str) -> str:
    import oss2
    from oss2.credentials import StaticCredentialsProvider

    auth = oss2.ProviderAuthV4(StaticCredentialsProvider(config.access_key, config.secret_key, config.token or None))
    bucket = oss2.Bucket(auth, config.endpoint, config.bucket, region=config.region, connect_timeout=10)
    try:
        meta = bucket.head_object(key)
        exists = meta.content_length == path.stat().st_size
    except oss2.exceptions.NoSuchKey:
        exists = False
    if not exists:
        bucket.put_object_from_file(key, str(path), headers={"Content-Type": "application/zip", "x-oss-object-acl": "private"})
    return bucket.sign_url("GET", key, config.url_seconds, slash_safe=True)


def _cos_url(config: UpdateStorage, path: Path, key: str) -> str:
    from qcloud_cos import CosConfig, CosS3Client
    from qcloud_cos.cos_exception import CosServiceError

    client = CosS3Client(CosConfig(Region=config.region, SecretId=config.access_key, SecretKey=config.secret_key,
                                  Token=config.token or None, Scheme="https", Timeout=10))
    try:
        meta = client.head_object(Bucket=config.bucket, Key=key)
        exists = int(meta.get("Content-Length", -1)) == path.stat().st_size
    except CosServiceError as e:
        if e.get_status_code() != 404:
            raise
        exists = False
    if not exists:
        with path.open("rb") as src:
            client.put_object(Bucket=config.bucket, Key=key, Body=src, ContentType="application/zip", ACL="private")
    return client.get_presigned_download_url(Bucket=config.bucket, Key=key, Expired=config.url_seconds)
