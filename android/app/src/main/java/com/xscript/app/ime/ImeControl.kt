package com.xscript.app.ime

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import com.xscript.app.XscriptApp
import com.xscript.app.root.RootShell
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * Main-process side of `action.Ime` (reached through MainControl "ime_*"). Typing needs XScript 输入法 to be the current
 * IME with an editor focused ([active]); switching to it needs it enabled in system settings, then root (`ime set`) does it
 * silently, otherwise the system picker is shown. The IME that was current before is remembered and [restore]d.
 */
object ImeControl {
    private val ctx: Context get() = XscriptApp.instance
    private val main = Handler(Looper.getMainLooper())
    @Volatile private var previous: String? = null

    val id: String get() = ComponentName(ctx, XscriptIme::class.java).flattenToShortString()

    private fun secure(key: String): String? = Settings.Secure.getString(ctx.contentResolver, key)
    fun enabled(): Boolean = ImeIds.isEnabled(secure(Settings.Secure.ENABLED_INPUT_METHODS), id)
    fun selected(): Boolean = ImeIds.same(secure(Settings.Secure.DEFAULT_INPUT_METHOD), id)
    fun active(): Boolean = selected() && XscriptIme.instance?.inputActive == true

    fun status(): JSONObject = JSONObject().put("id", id).put("enabled", enabled()).put("selected", selected())
        .put("active", active()).put("previous", previous ?: JSONObject.NULL)

    private fun <T> onMain(block: () -> T): T {
        if (Looper.myLooper() == Looper.getMainLooper()) return block()
        val ref = AtomicReference<Result<T>>()
        val l = CountDownLatch(1)
        main.post { ref.set(runCatching(block)); l.countDown() }
        if (!l.await(5, TimeUnit.SECONDS)) throw IllegalStateException("IME call timed out")
        return ref.get().getOrThrow()
    }

    private fun ime(): XscriptIme = XscriptIme.instance?.takeIf { active() }
        ?: throw IllegalStateException("XScript 输入法 is not active (action.Ime.switch() first, and focus an input field)")

    fun commit(text: String) = onMain { ime().commit(text) }
    fun delete(before: Int, after: Int) = onMain { ime().delete(before.coerceAtLeast(0), after.coerceAtLeast(0)) }
    fun clear() = onMain { ime().clear() }
    fun enter() = onMain { ime().enter() }
    fun key(code: Int) = onMain { ime().key(code) }

    /** Replace the field's text (the semantics of action.input when the IME types instead of accessibility). */
    fun setText(text: String): Boolean = onMain { val i = ime(); i.clear(); text.isEmpty() || i.commit(text) }

    /** Make XScript 输入法 current. Returns status plus "switched"; without root the system picker is shown instead. */
    fun switch(): JSONObject {
        if (selected()) return status().put("switched", true)
        val cur = secure(Settings.Secure.DEFAULT_INPUT_METHOD)
        if (RootShell.known() == true) {
            if (!ImeIds.same(cur, id)) previous = cur
            ImeIds.rootSwitch(id, RootShell::quote).forEach { RootShell.exec(it) }
            if (selected()) return status().put("switched", true)
        }
        if (!enabled()) {
            ctx.startActivity(Intent(Settings.ACTION_INPUT_METHOD_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            return status().put("switched", false).put("hint", "enable XScript 输入法 in the system keyboard settings first")
        }
        if (!ImeIds.same(cur, id)) previous = cur
        onMain { (ctx.getSystemService(Context.INPUT_METHOD_SERVICE) as android.view.inputmethod.InputMethodManager).showInputMethodPicker() }
        return status().put("switched", false).put("hint", "choose XScript 输入法 in the picker")
    }

    /** Switch back to the IME that was current before [switch]. */
    fun restore(): JSONObject {
        val prev = previous ?: return status().put("restored", false)
        var ok = false
        if (selected()) ok = onMain { XscriptIme.instance?.switchTo(prev) ?: false }
        if (!ok && RootShell.known() == true) ok = RootShell.exec("ime set " + RootShell.quote(prev)).ok
        if (ok) previous = null
        return status().put("restored", ok)
    }
}
