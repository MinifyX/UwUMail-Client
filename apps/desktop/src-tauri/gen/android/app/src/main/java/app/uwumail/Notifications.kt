package app.uwumail

import android.Manifest
import android.app.KeyguardManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

object Notifications {
    const val CHANNEL_MAIL = "mail"
    const val CHANNEL_WATCH = "watch"
    const val WATCH_ID = 1
    private const val TAG_MAIL = "mail"
    private const val PINK = 0xFFFF4D8D.toInt()
    /** A sign-in code notification goes away after this at the latest, earlier when the code expires. */
    private const val CODE_TIMEOUT_MS = 15L * 60 * 1000

    /**
     * Sign-in code notifications that keep their code off a locked phone ("Code on lock screen"
     * off), by notification id. With "show all notification content" Android would show the
     * private version on the lock screen, so the posted notification itself holds no code while
     * the phone is locked: it is posted again with the code on unlock and without it when the
     * screen goes off (security review: code on lock screen).
     */
    private class HeldCode(val account: String, val group: String, val message: JSONObject, val postedAt: Long)

    private val held = ConcurrentHashMap<Int, HeldCode>()
    private var lockWatch: BroadcastReceiver? = null

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
                putExtra(MainActivity.EXTRA_TOKEN, Prefs.launchToken(context))
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

    /** "Copy code" on a sign-in code notification: copies without opening UwUMail. */
    private fun copyIntent(context: Context, id: String, code: String, requestCode: Int): PendingIntent {
        val intent = Intent(context, NotificationActionReceiver::class.java).apply {
            action = "app.uwumail.NOTIFICATION_${NotificationActionReceiver.ACTION_COPY_CODE}"
            putExtra(NotificationActionReceiver.EXTRA_ACTION, NotificationActionReceiver.ACTION_COPY_CODE)
            putExtra(NotificationActionReceiver.EXTRA_MESSAGE_IDS, arrayOf(id))
            putExtra(NotificationActionReceiver.EXTRA_CODE, code)
        }
        return PendingIntent.getBroadcast(context, requestCode, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    /** The lock screen version of a sign-in code: by default only where the code is for. */
    private fun lockedCodeVersion(context: Context, title: String, lockedBody: String): Notification =
        NotificationCompat.Builder(context, CHANNEL_MAIL)
            .setSmallIcon(R.drawable.ic_stat_nyu)
            .setColor(PINK)
            .setContentTitle(title)
            .setContentText(lockedBody)
            .build()

    /** What a secure lock screen shows when the phone hides sensitive content. */
    private fun lockScreenVersion(context: Context, text: Context): Notification =
        NotificationCompat.Builder(context, CHANNEL_MAIL)
            .setSmallIcon(R.drawable.ic_stat_nyu)
            .setColor(PINK)
            .setContentTitle(text.getString(R.string.hidden_mail_title))
            .setContentText(text.getString(R.string.hidden_mail_text))
            .build()

    /**
     * New mail, one notification per message, grouped per mailbox. Silent while UwUMail is on screen.
     * With "Show sender and subject" off it doesn't say who wrote or what about; the lock screen
     * shows the public version unless the system allows private content there.
     */
    fun showMail(context: Context, args: JSONObject) {
        if (MainActivity.visible || !allowed(context)) return
        val accountId = args.getString("accountId")
        // Muted accounts and quiet hours (Settings → Notifications) keep the mail silent.
        if (Prefs.muted(context, accountId) || Prefs.quietNow(context)) return
        val text = Prefs.localized(context)
        val hideContent = !Prefs.showContent(context)
        val account = args.optString("accountEmail", "")
        val group = "mail:$accountId"
        val manager = NotificationManagerCompat.from(context)
        val messages = args.getJSONArray("messages")

        val now = System.currentTimeMillis()
        for (index in 0 until messages.length()) {
            postMessage(context, text, account, group, messages.getJSONObject(index), hideContent, reveal = null, postedAt = now)
        }

        val inGroup = context.getSystemService(NotificationManager::class.java).activeNotifications
            .filter { it.tag == TAG_MAIL && it.notification.group == group && it.notification.flags and Notification.FLAG_GROUP_SUMMARY == 0 }
        if (inGroup.size > 1) {
            val summary = NotificationCompat.Builder(context, CHANNEL_MAIL)
                .setSmallIcon(R.drawable.ic_stat_nyu)
                .setColor(PINK)
                .setContentTitle(text.resources.getQuantityString(R.plurals.new_mail, inGroup.size, inGroup.size))
                .setSubText(account)
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                .setPublicVersion(lockScreenVersion(context, text))
                .setGroup(group)
                .setGroupSummary(true)
                .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
                .setAutoCancel(true)
                .setContentIntent(openIntent(context, group.hashCode()))
                .build()
            manager.notify(TAG_MAIL, group.hashCode(), summary)
        }
    }

    /**
     * One mail's notification. `reveal` says whether a sign-in code may be in it: null decides by
     * whether the phone is locked right now; a repost (`reveal` set) doesn't alert again.
     */
    private fun postMessage(
        context: Context,
        text: Context,
        account: String,
        group: String,
        message: JSONObject,
        hideContent: Boolean,
        reveal: Boolean?,
        postedAt: Long,
    ) {
        if (!allowed(context)) return
        val manager = NotificationManagerCompat.from(context)
        val id = message.getString("id")
        val code = id.hashCode()
        val archive = NotificationCompat.Action.Builder(
            0,
            text.getString(R.string.action_archive),
            actionIntent(context, "archive", listOf(id), code + 2),
        )
            // Archiving from the lock screen asks to unlock the phone first; "read" doesn't.
            .setAuthenticationRequired(true)
            .build()
        val builder = NotificationCompat.Builder(context, CHANNEL_MAIL)
            .setSmallIcon(R.drawable.ic_stat_nyu)
            .setColor(PINK)
            .setSubText(account)
            .setCategory(NotificationCompat.CATEGORY_EMAIL)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(lockScreenVersion(context, text))
            .setGroup(group)
            .setAutoCancel(true)
            .setWhen(postedAt)
            .setOnlyAlertOnce(reveal != null)
            .setContentIntent(openIntent(context, code, message.getString("threadId"), id))
            .addAction(0, text.getString(R.string.action_read), actionIntent(context, "read", listOf(id), code + 1))
            .addAction(archive)
        // A sign-in code the server found (only there with "Show sender and subject" on):
        // the code instead of the subject, and the lock screen only where it is for.
        val signIn = message.optJSONObject("code")
        if (signIn != null && !hideContent) {
            val timeout = codeTimeout(signIn)
            if (timeout <= 0) {
                held.remove(code)
                manager.cancel(TAG_MAIL, code)
                return
            }
            val title = signIn.getString("title")
            val lockedBody = signIn.getString("lockedBody")
            // "Code on lock screen" off: no code in the notification while the phone is locked.
            val guarded = !signIn.optBoolean("onLockScreen", false)
            val showCode = !guarded || (reveal ?: !locked(context))
            builder
                .setContentTitle(title)
                .setContentText(if (showCode) signIn.getString("body") else lockedBody)
                .setPublicVersion(lockedCodeVersion(context, title, lockedBody))
                .setTimeoutAfter(timeout)
            val copy = signIn.optString("copy").takeIf { !signIn.isNull("copy") && it.isNotEmpty() }
            if (copy != null && showCode) {
                // Copying asks to unlock the phone first (Android 12 and later; a no-op before).
                val copyAction = NotificationCompat.Action.Builder(
                    0,
                    signIn.optString("copyLabel").ifEmpty { "Copy code" },
                    copyIntent(context, id, copy, code + 3),
                )
                    .setAuthenticationRequired(true)
                    .build()
                // First, so it shows even where only one button fits.
                builder.clearActions()
                    .addAction(copyAction)
                    .addAction(0, text.getString(R.string.action_read), actionIntent(context, "read", listOf(id), code + 1))
                    .addAction(archive)
            }
            if (guarded) {
                held[code] = HeldCode(account, group, message, postedAt)
                watchLock(context)
            }
        } else if (hideContent) {
            builder
                .setContentTitle(text.getString(R.string.hidden_mail_title))
                .setContentText(text.getString(R.string.hidden_mail_text))
        } else {
            val subject = message.optString("subject").ifEmpty { text.getString(R.string.no_subject) }
            builder
                .setContentTitle(message.getString("from"))
                .setContentText(subject)
                .setStyle(NotificationCompat.BigTextStyle().bigText("$subject\n${message.optString("snippet")}"))
        }
        manager.notify(TAG_MAIL, code, builder.build())
    }

    /** How long a code notification stays: until the code expires, 15 minutes at most; 0 once expired. */
    private fun codeTimeout(signIn: JSONObject): Long {
        if (signIn.isNull("expiresAt") || !signIn.has("expiresAt")) return CODE_TIMEOUT_MS
        val left = signIn.getLong("expiresAt") * 1000 - System.currentTimeMillis()
        return left.coerceAtMost(CODE_TIMEOUT_MS).coerceAtLeast(0)
    }

    /** Whether the phone shows its lock screen; locked when Android won't say. */
    private fun locked(context: Context): Boolean =
        context.getSystemService(KeyguardManager::class.java)?.isKeyguardLocked ?: true

    /**
     * Listens for the screen going off and the phone being unlocked while a held code is shown.
     * These broadcasts only reach receivers registered at run time, never the manifest.
     */
    @Synchronized
    private fun watchLock(context: Context) {
        if (lockWatch != null) return
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                when (intent.action) {
                    // The keyguard may lock a little later; hide the code right away.
                    Intent.ACTION_SCREEN_OFF -> repostHeld(context, reveal = false)
                    // Without a keyguard (or before it locked) there may be no USER_PRESENT.
                    Intent.ACTION_SCREEN_ON -> if (!locked(context)) repostHeld(context, reveal = true)
                    Intent.ACTION_USER_PRESENT -> repostHeld(context, reveal = true)
                }
            }
        }
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_OFF)
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_USER_PRESENT)
        }
        // System broadcasts still arrive at a receiver that isn't exported.
        ContextCompat.registerReceiver(context.applicationContext, receiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
        lockWatch = receiver
    }

    /** Stops listening once no held code is left. */
    @Synchronized
    private fun unwatchLock(context: Context) {
        if (held.isNotEmpty()) return
        val receiver = lockWatch ?: return
        lockWatch = null
        runCatching { context.applicationContext.unregisterReceiver(receiver) }
    }

    /** Posts the held codes that are still shown again, with or without the code. */
    private fun repostHeld(context: Context, reveal: Boolean) {
        val active = context.getSystemService(NotificationManager::class.java).activeNotifications
            .filter { it.tag == TAG_MAIL }
            .map { it.id }
            .toSet()
        val text = Prefs.localized(context)
        val hideContent = !Prefs.showContent(context)
        for ((id, entry) in held) {
            if (id !in active || hideContent) {
                // Dismissed, timed out or opened meanwhile, or the settings changed: leave it be.
                held.remove(id)
                continue
            }
            postMessage(
                context, text, entry.account, entry.group, entry.message,
                hideContent = false, reveal = reveal, postedAt = entry.postedAt,
            )
        }
        unwatchLock(context)
    }

    /** Called when UwUMail comes on screen. */
    fun clearMail(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.activeNotifications.filter { it.tag == TAG_MAIL }.forEach { manager.cancel(it.tag, it.id) }
        held.clear()
        unwatchLock(context)
    }

    fun cancel(context: Context, messageIds: Array<String>) {
        val manager = context.getSystemService(NotificationManager::class.java)
        messageIds.forEach {
            manager.cancel(TAG_MAIL, it.hashCode())
            held.remove(it.hashCode())
        }
        unwatchLock(context)
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
