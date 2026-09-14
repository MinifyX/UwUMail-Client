package app.uwumail

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * Keeps the UwUMail process, and with it the engine's IMAP IDLE and JMAP push
 * connections, alive while no window is open. Android requires the lasting,
 * quiet notification for that.
 */
class MailWatchService : Service() {
    companion object {
        fun start(context: Context) {
            if (!Prefs.backgroundPush(context)) return
            try {
                ContextCompat.startForegroundService(context, Intent(context, MailWatchService::class.java))
            } catch (error: Exception) {
                // Android refuses while UwUMail is in the background; it starts with the next window.
                Log.w("UwUMail", "Couldn't start the mail service", error)
            }
        }

        fun sync(context: Context) {
            if (Prefs.backgroundPush(context)) start(context) else context.stopService(Intent(context, MailWatchService::class.java))
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!Prefs.backgroundPush(this)) {
            stopSelf()
            return START_NOT_STICKY
        }
        val type = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0
        try {
            ServiceCompat.startForeground(this, Notifications.WATCH_ID, Notifications.watch(this), type)
        } catch (error: Exception) {
            Log.w("UwUMail", "Couldn't keep the mail service in the foreground", error)
            stopSelf()
            return START_NOT_STICKY
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
