"""Private hot-update storage: exercise SDK boundaries without cloud credentials."""
from dataclasses import replace
from unittest.mock import Mock, patch

import pytest

from xscript_server.update_storage import UpdateStorage, StorageError, download_url


def config(provider="oss"):
    return UpdateStorage(provider=provider, bucket="test-bucket", region="cn-hangzhou",
                         endpoint="https://oss-cn-hangzhou.aliyuncs.com" if provider == "oss" else "",
                         access_key="test-id", secret_key="test-secret")


def test_local_and_validation(tmp_path):
    assert download_url(UpdateStorage(), tmp_path / "missing", "") is None
    assert "test-secret" not in repr(config())
    for changes in ({"provider": "unknown"}, {"url_seconds": 0}, {"secret_key": ""},
                    {"endpoint": "http://example.com"}, {"prefix": "../escape"}):
        with pytest.raises(ValueError):
            replace(config(), **changes)
    with pytest.raises(ValueError):
        config().object_key("../escape")


@pytest.mark.parametrize("provider", ["oss", "cos"])
@pytest.mark.parametrize("exists", [True, False])
def test_upload_and_sign(tmp_path, provider, exists):
    bundle = tmp_path / "bundle.zip"
    bundle.write_bytes(b"bundle")
    cfg = config(provider)
    digest = "a" * 64
    key = cfg.object_key(digest)
    signed = "https://bucket.example.com/object?signature=test"
    client = Mock()
    if provider == "oss":
        oss2 = pytest.importorskip("oss2")
        factory = "oss2.Bucket"
        client.head_object.return_value.content_length = 6
        if not exists:
            client.head_object.side_effect = oss2.exceptions.NoSuchKey(404, {}, b"", {})
        client.sign_url.return_value = signed
    else:
        pytest.importorskip("qcloud_cos")
        from qcloud_cos.cos_exception import CosServiceError
        factory = "qcloud_cos.CosS3Client"
        client.head_object.return_value = {"Content-Length": "6"}
        if not exists:
            client.head_object.side_effect = CosServiceError("HEAD", {}, 404)
        client.get_presigned_download_url.return_value = signed
    with patch(factory, return_value=client):
        assert download_url(cfg, bundle, digest) == signed
    if provider == "oss":
        assert client.put_object_from_file.call_count == (0 if exists else 1)
        client.sign_url.assert_called_once_with("GET", key, 300, slash_safe=True)
    else:
        assert client.put_object.call_count == (0 if exists else 1)
        client.get_presigned_download_url.assert_called_once_with(Bucket=cfg.bucket, Key=key, Expired=300)


def test_errors_do_not_expose_credentials(tmp_path):
    for outcome in (RuntimeError("test-secret"), "http://insecure.example.com/bundle"):
        with patch("xscript_server.update_storage._oss_url", side_effect=outcome if isinstance(outcome, Exception) else None,
                   return_value=outcome):
            with pytest.raises(StorageError) as err:
                download_url(config(), tmp_path / "bundle.zip", "a" * 64)
            assert "test-secret" not in str(err.value)
