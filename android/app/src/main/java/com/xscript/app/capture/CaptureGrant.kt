package com.xscript.app.capture

/**
 * Remembers whether the user granted system screen recording (MediaProjection) and notices
 * when that grant goes away without the user asking: the system stopped the projection, or
 * the process started again (reboot, app killed) and the one-time token is gone.
 */
class CaptureGrant(private val store: Store) {
    interface Store {
        var wasGranted: Boolean
    }

    @Volatile
    var lost: Boolean = false
        private set

    fun onGranted() {
        store.wasGranted = true
        lost = false
    }

    /** The app itself stopped capture (e.g. before a new grant): not a loss. */
    fun onAppStopped() {
        store.wasGranted = false
        lost = false
    }

    /** The system stopped the projection. Returns true when this is a new loss to report. */
    fun onSystemStopped(): Boolean = markLost()

    /** Process start: a grant from before cannot have survived. Returns true when it was lost. */
    fun onProcessStart(grantedNow: Boolean): Boolean = if (grantedNow) false else markLost()

    private fun markLost(): Boolean {
        if (!store.wasGranted || lost) return false
        lost = true
        return true
    }
}
