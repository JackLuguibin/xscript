package com.xscript.app.link

import android.view.ContextThemeWrapper
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import android.app.Activity
import android.content.Intent
import android.os.Bundle
import com.xscript.app.BuildConfig
import com.xscript.app.R
import com.xscript.app.project.ProjectStore
import com.xscript.app.runtime.DapTransport
import com.xscript.app.runtime.ScriptService
import com.xscript.app.runtime.ScriptSupervisor
import com.xscript.app.settings.Settings
import com.xscript.app.ui.ProjectActivity
import com.xscript.app.ui.UiKit

/**
 * Entry for `xscript://run?name=…` / `open` / `stop` and the AScript aliases (`ascript://run?local=…`);
 * packaged apps: `<application id>://…` and `<last id segment>://…`.
 * Transparent: it either toasts, asks for confirmation or starts the script, then finishes.
 */
class SchemeActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        handle(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    private fun handle(intent: Intent) {
        val link = SchemeLink.parse(intent.dataString, schemes(), if (BuildConfig.PACKAGED) BuildConfig.PACK_PROJECT else "")
        when (SchemeLink.decide(link, Settings.schemeMode)) {
            "refuse" -> done(if (link is SchemeLink.Invalid) link.reason else "链接启动已关闭，可在首页「链接启动」里开启")
            "run" -> execute(link)
            else -> confirm(link as SchemeLink.Run)
        }
    }

    private fun confirm(link: SchemeLink.Run) {
        val from = referrer?.host?.takeIf { it.isNotBlank() }?.let { "\n来自：$it" } ?: ""
        // The activity is translucent (no theme of its own to show); the dialog uses the app's Material 3 theme.
        MaterialAlertDialogBuilder(ContextThemeWrapper(this, R.style.Theme_Xscript))
            .setTitle("运行小程序")
            .setMessage("有链接请求运行「${link.project}」。$from\n只运行你信任来源的链接。")
            .setPositiveButton("运行") { _, _ -> execute(link) }
            .setNegativeButton("取消") { _, _ -> finish() }
            .setOnCancelListener { finish() }
            .show()
    }

    private fun execute(link: SchemeLink) {
        when (link) {
            is SchemeLink.Stop -> {
                DapTransport.disconnect()
                ScriptService.stop(this)
                done("已请求停止当前任务")
            }
            is SchemeLink.Run -> {
                if (!ProjectStore(this).exists(link.project)) return done("工程不存在: ${link.project}")
                if (ScriptSupervisor.isBusy(this)) return done("已有脚本在运行，请先停止")
                Settings.lastProject = link.project
                DapTransport.disconnect()
                val refusal = ScriptService.run(this, link.project, params = link.params)
                done(refusal ?: "已启动 ${link.project}")
            }
            is SchemeLink.Open -> {
                if (BuildConfig.PACKAGED) {
                    packageManager.getLaunchIntentForPackage(packageName)?.let { startActivity(it) }
                } else {
                    if (!ProjectStore(this).exists(link.project)) return done("工程不存在: ${link.project}")
                    startActivity(Intent(this, ProjectActivity::class.java).putExtra(ProjectActivity.EXTRA_NAME, link.project))
                }
                finish()
            }
            is SchemeLink.Invalid -> done(link.reason)
        }
    }

    private fun done(text: String) {
        UiKit.toast(this, text, long = true)
        finish()
    }

    private fun schemes() =
        if (BuildConfig.PACKAGED) SchemeLink.packedSchemes(BuildConfig.APPLICATION_ID) else SchemeLink.MAIN_SCHEMES
}
