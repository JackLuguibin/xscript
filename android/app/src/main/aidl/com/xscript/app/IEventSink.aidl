package com.xscript.app;

// Implemented in the :script process. The main process pushes subscribed events
// (keys, touches, notifications, toasts, accessibility events) as JSON. The binder also
// serves as the run's death token: the main process links to it to detect crashes.
interface IEventSink {
    oneway void onEvent(String json);
}
