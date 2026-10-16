package com.xscript.app.plugin

import java.lang.reflect.Constructor
import java.lang.reflect.Executable
import java.lang.reflect.Method
import java.lang.reflect.Modifier

/**
 * Reflection for `plug.load_apk`: picks a constructor/method overload for the arguments Python passed (Chaquopy hands
 * Python ints as Long, floats as Double) and coerces them. Free of android.* so the JVM tests cover it.
 */
object Reflect {
    private val BOX: Map<Class<*>, Class<*>> = mapOf(
        java.lang.Boolean.TYPE to java.lang.Boolean::class.java, java.lang.Byte.TYPE to java.lang.Byte::class.java,
        java.lang.Short.TYPE to java.lang.Short::class.java, java.lang.Character.TYPE to java.lang.Character::class.java,
        java.lang.Integer.TYPE to java.lang.Integer::class.java, java.lang.Long.TYPE to java.lang.Long::class.java,
        java.lang.Float.TYPE to java.lang.Float::class.java, java.lang.Double.TYPE to java.lang.Double::class.java,
    )

    private object NoMatch

    /** [v] converted for a parameter of type [t], or [NoMatch]. Integers narrow only when the value fits. */
    private fun coerce(v: Any?, t: Class<*>): Any? {
        val target = BOX[t] ?: t
        if (v == null) return if (t.isPrimitive) NoMatch else null
        if (target.isInstance(v)) return v
        if (v is Number && v !is Float && v !is Double) {
            val n = v.toLong()
            return when (target) {
                java.lang.Integer::class.java -> if (n in Int.MIN_VALUE..Int.MAX_VALUE) n.toInt() else NoMatch
                java.lang.Long::class.java -> n
                java.lang.Short::class.java -> if (n in Short.MIN_VALUE..Short.MAX_VALUE) n.toShort() else NoMatch
                java.lang.Byte::class.java -> if (n in Byte.MIN_VALUE..Byte.MAX_VALUE) n.toByte() else NoMatch
                java.lang.Double::class.java -> n.toDouble()
                java.lang.Float::class.java -> n.toFloat()
                else -> NoMatch
            }
        }
        if (v is Number) {
            return when (target) {
                java.lang.Double::class.java -> v.toDouble()
                java.lang.Float::class.java -> v.toFloat()
                else -> NoMatch
            }
        }
        if (v is String && target == java.lang.Character::class.java && v.length == 1) return v[0]
        return NoMatch
    }

    /** Lower is better: exact type matches beat conversions. */
    private fun score(params: Array<Class<*>>, args: Array<out Any?>): Pair<Int, Array<Any?>>? {
        if (params.size != args.size) return null
        var cost = 0
        val out = arrayOfNulls<Any?>(args.size)
        for (i in params.indices) {
            val c = coerce(args[i], params[i])
            if (c === NoMatch) return null
            val exact = args[i] == null || (BOX[params[i]] ?: params[i]) == args[i]!!.javaClass
            if (!exact) {
                val t = BOX[params[i]] ?: params[i]
                val intToFloat = args[i] is Number && args[i] !is Float && args[i] !is Double &&
                    (t == java.lang.Double::class.java || t == java.lang.Float::class.java)
                cost += if (intToFloat) 2 else 1
            }
            out[i] = c
        }
        return cost to out
    }

    private fun <T : Executable> best(cands: List<T>, args: Array<out Any?>, what: String): Pair<T, Array<Any?>> {
        val ranked = cands.mapNotNull { e -> score(e.parameterTypes, args)?.let { Triple(e, it.first, it.second) } }.sortedBy { it.second }
        val top = ranked.firstOrNull() ?: throw NoSuchMethodException("no $what accepts (${args.joinToString { it?.javaClass?.simpleName ?: "null" }})")
        return top.first to top.third
    }

    fun newInstance(cls: Class<*>, args: Array<out Any?>): Any {
        val (c, a) = best(cls.constructors.toList(), args, "constructor of ${cls.name}")
        return (c as Constructor<*>).newInstance(*a)
    }

    /** Instance call when [target] is non-null, static call on [cls] otherwise. */
    fun invoke(cls: Class<*>, target: Any?, name: String, args: Array<out Any?>): Any? {
        val ms = cls.methods.filter { it.name == name && (target != null || Modifier.isStatic(it.modifiers)) }
        if (ms.isEmpty()) throw NoSuchMethodException("${cls.name}.$name")
        val (m, a) = best(ms, args, "overload of ${cls.name}.$name")
        return try {
            (m as Method).invoke(target, *a)
        } catch (e: java.lang.reflect.InvocationTargetException) {
            throw e.targetException ?: e
        }
    }

    fun getField(cls: Class<*>, target: Any?, name: String): Any? = cls.getField(name).get(target)

    fun setField(cls: Class<*>, target: Any?, name: String, value: Any?) {
        val f = cls.getField(name)
        val c = coerce(value, f.type)
        require(c !== NoMatch) { "cannot assign ${value?.javaClass?.simpleName} to ${f.type.simpleName} ${cls.name}.$name" }
        f.set(target, c)
    }
}
