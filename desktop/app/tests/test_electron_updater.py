from pathlib import Path

import pytest

from xscript_desktop.services.electron_updater import ElectronUpdateService, electron_install
from xscript_desktop.services.updater import nsis_install_script


def test_electron_paths_and_nsis_arguments(tmp_path):
    exe = tmp_path / 'XScript.app/Contents/MacOS/XScript'
    assert electron_install(exe, 'darwin') == tmp_path / 'XScript.app'
    assert electron_install(tmp_path / 'sidecar/xscript-service', 'darwin') is None
    assert electron_install(tmp_path / 'XScript.exe', 'win32') == tmp_path
    script = nsis_install_script(tmp_path / 'setup.exe', tmp_path / 'App', 1234, [], tmp_path / 'log')
    assert 'PID eq 1234' in script
    assert '/S /D=' in script
    assert '/VERYSILENT' not in script
    assert '/DIR=' not in script


def test_electron_waits_for_shell_not_sidecar(tmp_path, monkeypatch):
    from xscript_desktop.services.updater import UpdateService
    captured = {}
    monkeypatch.setattr(UpdateService, 'prepare_install', lambda self, **kw: captured.update(kw))
    updater = ElectronUpdateService('0.6.0', lambda: tmp_path, executable=tmp_path / 'XScript.app/Contents/MacOS/XScript', parent_pid=1234, platform='darwin')
    updater.prepare_install()
    assert captured['pid'] == 1234


@pytest.mark.asyncio
async def test_unsaved_changes_block_electron_install(tmp_path):
    from xscript_desktop.context import AppContext
    from xscript_desktop.rpc import RpcError
    ctx = AppContext(data_dir=tmp_path)
    try:
        ctx.unsaved = True
        with pytest.raises(RpcError) as error:
            await ctx.install_update()
        assert error.value.code == 'update.unsaved'
    finally:
        await ctx.shutdown()


def test_nsis_paths_escape_batch_expansion(tmp_path):
    script = nsis_install_script(Path('C:/100%/setup.exe'), Path('C:/Apps & Tools'), 123, ["--data-dir", "C:/测试/用户"], tmp_path / 'log')
    assert '100%%' in script
    assert 'Apps ^& Tools' in script
    assert '"--data-dir" "C:/测试/用户"' in script
    assert 'chcp 65001' in script
    with pytest.raises(Exception, match='unsupported installer path'):
        nsis_install_script(Path('bad\npath'), tmp_path, 123, [], tmp_path)
