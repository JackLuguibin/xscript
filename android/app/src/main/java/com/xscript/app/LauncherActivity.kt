package com.xscript.app

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import com.xscript.app.ui.PackActivity

/** Launcher entry: developer home for XScript itself, the app screen for packaged apps. */
class LauncherActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        startActivity(Intent(this, home(this)))
        finish()
    }

    companion object {
        fun home(context: android.content.Context): Class<out Activity> =
            if (BuildConfig.PACKAGED) PackActivity::class.java else MainActivity::class.java
    }
}
