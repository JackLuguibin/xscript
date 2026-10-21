package com.xscript.app.project

import com.xscript.app.project.PermissionNeeds.Kind

/**
 * 「一键开启全部」: walks through a project's missing permissions one at a time. Accessibility goes first because on
 * Android 11+ it also makes screen capture available, so the capture step may drop out by itself. Each step is offered
 * once (opened in system settings or skipped); a step that got granted meanwhile is passed over.
 */
class PermissionGuide(kinds: List<Kind>, isOk: (Kind) -> Boolean) {
    private val order: List<Kind> = kinds.distinct().sortedBy { it.ordinal }
    /** The steps this run offers: what was missing when it started. */
    val total: Int = order.count { !isOk(it) }
    private val offered = LinkedHashSet<Kind>()
    private val skipped = LinkedHashSet<Kind>()

    /** Next permission to offer, or null when the guide is finished. */
    fun next(isOk: (Kind) -> Boolean): Kind? = order.firstOrNull { it !in offered && !isOk(it) }

    /** 1-based number of the step [kind] is shown as ("第 2/3 步"). */
    fun stepNumber(): Int = (offered.size + 1).coerceAtMost(total.coerceAtLeast(1))

    /** The user went to the settings screen for [kind]. */
    fun opened(kind: Kind) {
        offered += kind
    }

    fun skip(kind: Kind) {
        offered += kind
        skipped += kind
    }

    /** What is still missing at the end, skipped ones included. */
    fun remaining(isOk: (Kind) -> Boolean): List<Kind> = order.filter { !isOk(it) }

    fun skipped(): List<Kind> = skipped.toList()
}
