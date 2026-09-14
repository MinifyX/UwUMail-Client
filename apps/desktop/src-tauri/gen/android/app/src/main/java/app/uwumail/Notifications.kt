package app.uwumail

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject

object Notifications {
    const val CHANNEL_MAIL = "mail"
    const val CHANNEL_WATCH = "watch"
    const val WATCH_ID = 1
    private const val TAG_MAIL = "mail"
    private const val PINK = 0xFFFF4D8D.toInt()

    fun createChannels(context: Context) {
        val text = Prefs.localized(context)
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_MAIL, text.getString(R.string.channel_mail), NotificationManager.IMPORTANCE_HIGH),
        )
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_WATCH, text.getString(R.string.channel_watch), NotificationManager.IMPORTANCE_MIN).apply {
                description = text.getString(R.string.channel_watch_description)
                setShowBadge(false)
            },
        )
    }

    private fun allowed(context: Context) =
        Build.VERSION.SDK_INT < 33 ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    /** Opens UwUMail, optionally at a message. */
    private fun openIntent(context: Context, requestCode: Int, threadId: String? = null, messageId: String? = null): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            if (threadId != null && messageId != null) {
                action = MainActivity.ACTION_OPEN_MESSAGE
                putExtra(MainActivity.EXTRA_THREAD_ID, threadId)
                putExtra(MainActivity.EXTRA_MESSAGE_ID, messageId)
            }
        }
        return PendingIntent.getActivity(context, requestCode, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    private fun actionIntent(context: Context, action: String, ids: List<String>, requestCode: Int): PendingIntent {
        val intent = Intent(context, NotificationActionReceiver::class.java).apply {
            this.action = "app.uwumail.NOTIFICATION_$action"
            putExtra(NotificationActionReceiver.EXTRA_ACTION, action)
            putExtra(NotificationActionReceiver.EXTRA_MESSAGE_IDS, ids.toTypedArray())
        }
        return PendingIntent.getBroadcast(context, requestCode, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    /** New mail, one notification per message, grouped per mailbox. Silent while UwUMail is on screen. */
    fun showMail(context: Context, args: JSONObject) {
        if (MainActivity.visible || !allowed(context)) return
        val text = Prefs.localized(context)
        val accountId = args.getString("accountId")
        val account = args.optString("accountEmail", "")
        val group = "mail:$accountId"
        val manager = NotificationManagerCompat.from(context)
        val messages = args.getJSONArray("messages")

        for (index in 0 until messages.length()) {
            val message = messages.getJSONObject(index)
            val id = message.getString("id")
            val subject = message.optString("subject").ifEmpty { text.getString(R.string.no_subject) }
            val code = id.hashCode()
            val notification = NotificationCompat.Builder(context, CHANNEL_MAIL)
                .setSmallIcon(R.drawable.ic_stat_nyu)
                .setColor(PINK)
                .setContentTitle(message.getString("from"))
                .setContentText(subject)
                .setStyle(NotificationCompat.BigTextStyle().bigText("$subject\n${message.optString("snippet")}"))
                .setSubText(account)
                .setCategory(NotificationCompat.CATEGORY_EMAIL)
                .setGroup(group)
                .setAutoCancel(true)
                .setContentIntent(openIntent(context, code, message.getString("threadId"), id))
                .addAction(0, text.getString(R.string.action_read), actionIntent(context, "read", listOf(id), code + 1))
                .addAction(0, text.getString(R.string.action_archive), actionIntent(context, "archive", listOf(id), code + 2))
                .build()
            manager.notify(TAG_MAIL, code, notification)
        }

        val inGroup = context.getSystemService(NotificationManager::class.java).activeNotifications
            .filter { it.tag == TAG_MAIL && it.notification.group == group && it.notification.flags and Notification.FLAG_GROUP_SUMMARY == 0 }
        if (inGroup.size > 1) {
            val summary = NotificationCompat.Builder(context, CHANNEL_MAIL)
                .setSmallIcon(R.drawable.ic_stat_nyu)
                .setColor(PINK)
                .setContentTitle(text.resources.getQuantityString(R.plurals.new_mail, inGroup.size, inGroup.size))
                .setSubText(account)
                .setGroup(group)
                .setGroupSummary(true)
                .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
                .setAutoCancel(true)
                .setContentIntent(openIntent(context, group.hashCode()))
                .build()
            manager.notify(TAG_MAIL, group.hashCode(), summary)
        }
    }

    /** Called when UwUMail comes on screen. */
    fun clearMail(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.activeNotifications.filter { it.tag == TAG_MAIL }.forEach { manager.cancel(it.tag, it.id) }
    }

    fun cancel(context: Context, messageIds: Array<String>) {
        val manager = context.getSystemService(NotificationManager::class.java)
        messageIds.forEach { manager.cancel(TAG_MAIL, it.hashCode()) }
        // Drop summaries that have nothing left to summarize.
        val active = manager.activeNotifications.filter { it.tag == TAG_MAIL }
        active.filter { it.notification.flags and Notification.FLAG_GROUP_SUMMARY != 0 }.forEach { summary ->
            val children = active.count {
                it.notification.group == summary.notification.group && it.notification.flags and Notification.FLAG_GROUP_SUMMARY == 0
            }
            if (children < 2) manager.cancel(summary.tag, summary.id)
        }
    }

    /** The quiet, lasting notification of the background service. */
    fun watch(context: Context): Notification {
        val text = Prefs.localized(context)
        val playful = Prefs.playful(context)
        return NotificationCompat.Builder(context, CHANNEL_WATCH)
            .setSmallIcon(R.drawable.ic_stat_nyu)
            .setColor(PINK)
            .setContentTitle(text.getString(if (playful) R.string.watch_title_playful else R.string.watch_title_neutral))
            .setContentText(text.getString(R.string.watch_text))
            .setOngoing(true)
            .setSilent(true)
            .setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_DEFERRED)
            .setContentIntent(openIntent(context, WATCH_ID))
            .addAction(
                0,
                text.getString(R.string.action_hide),
                PendingIntent.getActivity(
                    context,
                    WATCH_ID + 1,
                    watchSettingsIntent(context),
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                ),
            )
            .build()
    }

    private fun watchSettingsIntent(context: Context) = Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS).apply {
        putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
        putExtra(Settings.EXTRA_CHANNEL_ID, CHANNEL_WATCH)
        flags = Intent.FLAG_ACTIVITY_NEW_TASK
    }

    /** Android's settings for the lasting notification, where it can be hidden. */
    fun openWatchSettings(context: Context) {
        context.startActivity(watchSettingsIntent(context))
    }
}
