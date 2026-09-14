package app.uwumail

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Reconnects for new mail after a reboot or an update, without opening a window. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED -> MailWatchService.start(context)
        }
    }
}
