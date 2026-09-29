package com.xscript.app.a11y

import android.accessibilityservice.AccessibilityService
import android.graphics.Rect
import android.os.Build
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import org.json.JSONArray
import org.json.JSONObject

/**
 * Serialises the accessibility tree.
 *
 * `path` is the index path through the *real* tree ("root/child/child"), so actions can
 * re-find a node even when mode 0 prunes uninteresting siblings from the output.
 *
 * mode bits: 1 = keep every node (no pruning), 2 = drop system / IME windows.
 */
object NodeDumper {
    const val MODE_FULL = 1
    const val MODE_NO_SYSTEM = 2

    data class Root(val node: AccessibilityNodeInfo, val windowType: Int)

    fun collectRoots(svc: AccessibilityService, mode: Int, ownPackage: String): List<Root> {
        val list = mutableListOf<Root>()
        try {
            svc.windows?.forEach { window ->
                val root = window.root ?: return@forEach
                val pkg = root.packageName?.toString().orEmpty()
                val type = window.type
                val ownOverlay = pkg == ownPackage && type != AccessibilityWindowInfo.TYPE_APPLICATION
                val system = type == AccessibilityWindowInfo.TYPE_SYSTEM ||
                    type == AccessibilityWindowInfo.TYPE_INPUT_METHOD ||
                    pkg == "com.android.systemui"
                if (ownOverlay || (mode and MODE_NO_SYSTEM != 0 && system)) {
                    root.recycleCompat()
                } else {
                    list.add(Root(root, type))
                }
            }
        } catch (_: Exception) {
        }
        if (list.isEmpty()) {
            svc.rootInActiveWindow?.let { list.add(Root(it, AccessibilityWindowInfo.TYPE_APPLICATION)) }
        }
        return list
    }

    fun dump(roots: List<Root>, mode: Int, width: Int, height: Int): JSONObject {
        val arr = JSONArray()
        roots.forEachIndexed { index, root ->
            dumpNode(root.node, "$index", "", 0, mode)?.let { arr.put(it) }
        }
        return JSONObject()
            .put("mode", mode)
            .put("source", "accessibility")
            .put("width", width)
            .put("height", height)
            .put("roots", arr)
    }

    fun findByPath(roots: List<Root>, path: String): AccessibilityNodeInfo? {
        val parts = path.split('/')
        val rootIndex = parts.firstOrNull()?.toIntOrNull() ?: return null
        val root = roots.getOrNull(rootIndex)?.node ?: return null
        var current: AccessibilityNodeInfo = AccessibilityNodeInfo.obtain(root)
        for (i in 1 until parts.size) {
            val idx = parts[i].toIntOrNull() ?: return null.also { current.recycleCompat() }
            val child = if (idx in 0 until current.childCount) current.getChild(idx) else null
            current.recycleCompat()
            current = child ?: return null
        }
        return current
    }

    fun firstEditable(root: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        if (root.isEditable) return AccessibilityNodeInfo.obtain(root)
        for (i in 0 until root.childCount) {
            val child = root.getChild(i) ?: continue
            val found = try {
                firstEditable(child)
            } finally {
                child.recycleCompat()
            }
            if (found != null) return found
        }
        return null
    }

    private fun dumpNode(
        node: AccessibilityNodeInfo,
        path: String,
        parentClassPath: String,
        depth: Int,
        mode: Int,
    ): JSONObject? {
        val cls = node.className?.toString().orEmpty()
        val classPath = parentClassPath + "/" + cls.substringAfterLast('.')
        val children = JSONArray()
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            try {
                dumpNode(child, "$path/$i", classPath, depth + 1, mode)?.let { children.put(it) }
            } finally {
                child.recycleCompat()
            }
        }
        if (mode and MODE_FULL == 0 && !isInteresting(node) && children.length() == 0) {
            return null
        }
        val rect = Rect()
        node.getBoundsInScreen(rect)
        val obj = JSONObject()
            .put("path", path)
            .put("id", node.viewIdResourceName ?: "")
            .put("text", node.text?.toString() ?: "")
            .put("desc", node.contentDescription?.toString() ?: "")
            .put("type", cls)
            .put("package", node.packageName?.toString() ?: "")
            .put("classPath", classPath)
            .put("depth", depth)
            .put("childCount", node.childCount)
            .put(
                "rect",
                JSONObject()
                    .put("l", rect.left)
                    .put("t", rect.top)
                    .put("r", rect.right)
                    .put("b", rect.bottom),
            )
            .put("clickable", node.isClickable)
            .put("editable", node.isEditable)
            .put("enabled", node.isEnabled)
            .put("visible", node.isVisibleToUser)
        if (Build.VERSION.SDK_INT >= 26) {
            node.hintText?.toString()?.takeIf { it.isNotEmpty() }?.let { obj.put("hint", it) }
        }
        if (Build.VERSION.SDK_INT >= 24 && node.drawingOrder != 0) obj.put("drawingOrder", node.drawingOrder)
        if (node.inputType != 0) obj.put("inputType", node.inputType)
        if (node.maxTextLength > 0) obj.put("maxTextLength", node.maxTextLength)
        putTrue(obj, "longClickable", node.isLongClickable)
        putTrue(obj, "checkable", node.isCheckable)
        putTrue(obj, "checked", node.isChecked)
        putTrue(obj, "focusable", node.isFocusable)
        putTrue(obj, "focused", node.isFocused)
        putTrue(obj, "scrollable", node.isScrollable)
        putTrue(obj, "selected", node.isSelected)
        putTrue(obj, "dismissable", node.isDismissable)
        putTrue(obj, "password", node.isPassword)
        obj.put("children", children)
        return obj
    }

    private fun putTrue(obj: JSONObject, key: String, value: Boolean) {
        if (value) obj.put(key, true)
    }

    private fun isInteresting(node: AccessibilityNodeInfo): Boolean {
        if (node.isClickable || node.isEditable || node.isScrollable || node.isCheckable) return true
        if (!node.text.isNullOrBlank()) return true
        if (!node.contentDescription.isNullOrBlank()) return true
        if (!node.viewIdResourceName.isNullOrBlank()) return true
        return false
    }
}

@Suppress("DEPRECATION")
fun AccessibilityNodeInfo.recycleCompat() {
    // recycle() is a no-op from API 33; below that it returns the node to the pool.
    if (Build.VERSION.SDK_INT < 33) {
        try {
            recycle()
        } catch (_: Exception) {
        }
    }
}
