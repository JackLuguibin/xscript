package com.xscript.app.project

import com.xscript.app.project.PermissionNeeds.Kind

/**
 * 「一键开启全部」: walks through a project's missing permissions one at a time. Accessibility goes first because on
 * Android 11+ it also makes screen capture available, so the capture step may drop out by itself. Each step is offered
 * once (opened in system settings or skipped); a step that got granted meanwhile is passed over.
 *
 * [save] / [restore] keep a guide going when Android kills the app while the user is in system settings.
 */
class PermissionGuide private constructor(
    private val order: List<Kind>,
    /** The steps this run offers: what was missing when it started. */
    val total: Int,
) {
    constructor(kinds: List<Kind>, isOk: (Kind) -> Boolean) : this(
        kinds.distinct().sortedBy { it.ordinal },
        kinds.distinct().count { !isOk(it) },
    )
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

    /** One line for the activity's saved state: "ACCESSIBILITY,CAPTURE|2|ACCESSIBILITY|". */
    fun save(): String = listOf(
        order.joinToString(",") { it.name },
        total.toString(),
        offered.joinToString(",") { it.name },
        skipped.joinToString(",") { it.name },
    ).joinToString("|")

    companion object {
        /** null for anything [save] did not write (another app version, a damaged bundle). */
        fun restore(state: String?): PermissionGuide? {
            val parts = state?.split("|") ?: return null
            if (parts.size != 4) return null
            fun kinds(s: String): List<Kind>? =
                if (s.isEmpty()) emptyList() else s.split(",").map { n -> Kind.entries.firstOrNull { it.name == n } ?: return null }
            val order = kinds(parts[0])?.takeIf { it.isNotEmpty() } ?: return null
            val total = parts[1].toIntOrNull()?.takeIf { it in 0..order.size } ?: return null
            val offered = kinds(parts[2]) ?: return null
            val skipped = kinds(parts[3]) ?: return null
            if (!order.containsAll(offered) || !offered.containsAll(skipped)) return null
            return PermissionGuide(order, total).also {
                it.offered += offered
                it.skipped += skipped
            }
        }
    }
}
