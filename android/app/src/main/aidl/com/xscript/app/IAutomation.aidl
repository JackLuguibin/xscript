package com.xscript.app;

import com.xscript.app.IEventSink;

// Main-process automation surface. The :script process binds this so a crashed or
// killed script never takes the accessibility service or capture session with it.
// Large payloads (UI tree JSON, raw frames) travel through pipes to stay under the
// 1 MB binder transaction limit.
interface IAutomation {
    ParcelFileDescriptor dumpTree(int mode);
    boolean click(int x, int y, int durMs);
    boolean swipe(int x1, int y1, int x2, int y2, int durMs);
    boolean gesture(String strokesJson);
    boolean touch(int action, int x, int y, int durMs);
    boolean nodeAction(String path, String action, String arg);
    boolean inputText(String text);
    boolean globalAction(String name);
    boolean isAccessibilityOn();
    String captureToFile(String path);
    ParcelFileDescriptor captureFrame(int left, int top, int right, int bottom);
    String control(String op, String arg);
    // Called once per run by the :script process. The main process watches the sink's
    // binder for death (crash / kill) and delivers subscribed events through it.
    void attachScript(String project, IEventSink sink);
}
