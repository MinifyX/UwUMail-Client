package app.uwumail

import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.PersistableBundle
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import kotlin.concurrent.thread

/** "Mark as read", "Archive" and "Copy code" on a mail notification. */
class NotificationActionReceiver : BroadcastReceiver() {
    companion object {
        const val EXTRA_ACTION = "action"
        const val EXTRA_MESSAGE_IDS = "messageIds"
        const val EXTRA_CODE = "code"
        const val ACTION_COPY_CODE = "copy-code"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.getStringExtra(EXTRA_ACTION) ?: return
        val ids = intent.getStringArrayExtra(EXTRA_MESSAGE_IDS) ?: return
        Notifications.cancel(context, ids)
        if (action == ACTION_COPY_CODE) {
            copyCode(context, intent.getStringExtra(EXTRA_CODE) ?: return)
            return
        }
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

    /** Copies a sign-in code, marked sensitive so keyboards and the clipboard preview hide it. */
    private fun copyCode(context: Context, code: String) {
        val clip = ClipData.newPlainText("UwUMail", code)
        clip.description.extras = PersistableBundle().apply {
            if (Build.VERSION.SDK_INT >= 33) {
                putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true)
            } else {
                putBoolean("android.content.extra.IS_SENSITIVE", true)
            }
        }
        context.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(clip)
    }
}
