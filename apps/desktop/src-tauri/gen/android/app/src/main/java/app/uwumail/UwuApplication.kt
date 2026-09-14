package app.uwumail

import android.app.Application

/**
 * Starts the mail engine together with the process, before any window. That
 * way it also runs when Android starts UwUMail for the background service, a
 * notification button or after a reboot.
 */
class UwuApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        UwuBridge.init(this)
        Notifications.createChannels(this)
        UwuNative.start(this, dataDir.absolutePath, cacheDir.absolutePath)
        NetworkWatcher.start(this)
    }
}
