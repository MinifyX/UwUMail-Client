package app.uwumail

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import kotlin.concurrent.thread

/** "Mark as read" and "Archive" on a mail notification. */
class NotificationActionReceiver : BroadcastReceiver() {
    companion object {
        const val EXTRA_ACTION = "action"
        const val EXTRA_MESSAGE_IDS = "messageIds"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.getStringExtra(EXTRA_ACTION) ?: return
        val ids = intent.getStringArrayExtra(EXTRA_MESSAGE_IDS) ?: return
        Notifications.cancel(context, ids)
        val payload = JSONObject().put("action", action).put("messageIds", JSONArray(ids.toList())).toString()
        // Rust waits until the server knows (a few seconds at most), so keep the process alive meanwhile.
        val pending = goAsync()
        thread(name = "uwumail-notification-action") {
            try {
                UwuNative.call("notificationAction", payload)
            } catch (error: Exception) {
                Log.w("UwUMail", "Notification action failed", error)
            } finally {
                pending.finish()
            }
        }
    }
}
