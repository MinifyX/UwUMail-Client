package app.uwumail

import android.app.Application
import android.util.Log

/**
 * Starts the mail engine together with the process, before any window. That
 * way it also runs when Android starts UwUMail for the background service, a
 * notification button or after a reboot.
 */
class UwuApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        // The relaunch helper lives in its own short process and must not run a second engine.
        if (Application.getProcessName().endsWith(":relaunch")) return
        UwuBridge.init(this)
        Notifications.createChannels(this)
        try {
            UwuNative.start(this, UwuBridge::class.java, dataDir.absolutePath, cacheDir.absolutePath)
        } catch (error: Throwable) {
            Log.e("UwUMail", "The mail engine didn't start", error)
            throw error
        } finally {
            Log.i("UwUMail", "Start: " + runCatching { UwuNative.call("status", "{}") }.getOrElse { it.toString() })
        }
        NetworkWatcher.start(this)
    }
}
