# R8 runs on release builds (minify + shrinkResources). The rules below keep what is reached by name at runtime.

# Python (Chaquopy) calls into the app by class and member name: `from com.xscript.app.runtime import Bridge`,
# XscriptApp, plugin.Plugins, and the objects they hand back. The app's own code is small, so keep all of it as is;
# R8 still shrinks and optimizes the libraries, which make up nearly all of the dex.
-keep class com.xscript.app.** { *; }

# WebView bridges (ScriptUi): methods called from JavaScript by name.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# Scripts may use any Java class through Chaquopy's jclass(); names stay readable in stack traces and for that lookup.
-dontobfuscate
-keepattributes SourceFile,LineNumberTable,Signature,InnerClasses,EnclosingMethod,*Annotation*

# ONNX Runtime binds its Java classes from JNI by name.
-keep class ai.onnxruntime.** { *; }

# ML Kit finds its component registrars through manifest <meta-data> and creates them reflectively
# (MlKitContext.initializeIfNeeded, also called by hand in the :script/:eval processes). Without this the
# registrar constructors are stripped and TextRecognition.getClient fails with a NullPointerException.
-keep class * implements com.google.firebase.components.ComponentRegistrar { public <init>(); }
