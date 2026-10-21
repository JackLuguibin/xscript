package com.xscript.pycharm

import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.openapi.extensions.PluginId
import com.intellij.openapi.module.Module
import com.intellij.openapi.roots.ModuleRootManager
import com.intellij.openapi.roots.ModuleRootModificationUtil
import com.intellij.openapi.roots.OrderRootType
import com.intellij.openapi.roots.libraries.Library
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VfsUtilCore
import java.nio.file.Files
import java.nio.file.Path

/**
 * Completion for `xscript.*` / `ascript.*`: the plugin ships the generated .pyi stubs and attaches that folder to the
 * module as a library named [LIBRARY]. Nothing is copied into the user's project; removing the library undoes it.
 */
object Stubs {
    const val LIBRARY = "XScript stubs"
    const val PLUGIN_ID = "com.xscript.ide"

    /** <plugin>/stubs, or null when the plugin was built without them. */
    fun dir(): Path? = PluginManagerCore.getPlugin(PluginId.getId(PLUGIN_ID))?.pluginPath?.resolve("stubs")
        ?.takeIf { Files.isDirectory(it.resolve("xscript")) }

    fun library(module: Module): Library? = ModuleRootManager.getInstance(module).orderEntries
        .filterIsInstance<com.intellij.openapi.roots.LibraryOrderEntry>()
        .firstOrNull { it.libraryName == LIBRARY }?.library

    fun isAttached(module: Module, dir: Path): Boolean {
        val url = VfsUtilCore.pathToUrl(dir.toString())
        return library(module)?.getUrls(OrderRootType.CLASSES)?.contains(url) == true
    }

    /** Adds (or repoints) the module library. Call on the EDT; it takes the write lock itself. */
    fun attach(module: Module, dir: Path) {
        LocalFileSystem.getInstance().refreshAndFindFileByNioFile(dir)
        val url = VfsUtilCore.pathToUrl(dir.toString())
        ModuleRootModificationUtil.updateModel(module) { model ->
            model.moduleLibraryTable.getLibraryByName(LIBRARY)?.let { model.moduleLibraryTable.removeLibrary(it) }
            val lib = model.moduleLibraryTable.createLibrary(LIBRARY)
            val m = lib.modifiableModel
            m.addRoot(url, OrderRootType.CLASSES)
            m.addRoot(url, OrderRootType.SOURCES)
            m.commit()
        }
    }

    fun detach(module: Module) {
        ModuleRootModificationUtil.updateModel(module) { model ->
            model.moduleLibraryTable.getLibraryByName(LIBRARY)?.let { model.moduleLibraryTable.removeLibrary(it) }
        }
    }
}
