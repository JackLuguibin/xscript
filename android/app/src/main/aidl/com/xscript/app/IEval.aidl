package com.xscript.app;

// Served by EvalService in the :eval process. The main process calls run() with a
// deadline and kills the process when it passes, since running Python cannot be
// interrupted in place.
interface IEval {
    // JSON object: {"ok": bool, "result": str, "error": str}
    String run(String code);
    int pid();
}
