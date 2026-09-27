package app.uwumail

import android.app.job.JobInfo
import android.app.job.JobScheduler
import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import org.unifiedpush.android.connector.UnifiedPush
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

/**
 * New mail through UnifiedPush for JMAP accounts. A distributor app (ntfy, NextPush, Sunup, …)
 * keeps the one connection; the mail server posts to it through a JMAP push subscription (Web
 * Push, encrypted for this phone), and the connector hands the decrypted message to
 * [UwuPushService]. Accounts without that (IMAP, or a server that doesn't announce a Web Push key)
 * keep using [MailWatchService]; it stops once every account gets its mail through the distributor.
 *
 * Each account is its own UnifiedPush instance, named by its id. [PushRenewJob] renews the
 * subscriptions about twice a day, so they don't end while nothing wakes UwUMail.
 */
object Push {
    private const val TAG = "UwUMail"

    /** A push message keeps the phone awake this long at most for its sync. */
    private const val MESSAGE_WAKE_MS = 30_000L

    /** The connector reports UwUMail's own unregistering back; within this it isn't news. */
    private const val OWN_UNREGISTER_MS = 60_000L

    private const val RENEW_JOB_ID = 7_301

    /** Subscriptions last a week on the server; renewing is due about once a day. */
    private const val RENEW_EVERY_MS = 12 * 60 * 60 * 1000L

    /** Registration work, one step at a time and never on the main thread. */
    private val worker = Executors.newSingleThreadExecutor { runnable -> Thread(runnable, "uwumail-push") }

    /** Steps queued or running on [worker], so the settings can say that UwUMail is still at it. */
    private val queued = AtomicInteger(0)

    /** Accounts UwUMail unregistered itself, with when. */
    private val leaving = ConcurrentHashMap<String, Long>()

    private fun later(step: () -> Unit) {
        queued.incrementAndGet()
        worker.execute {
            try {
                step()
            } catch (error: Exception) {
                Log.w(TAG, "UnifiedPush step failed", error)
            } finally {
                queued.decrementAndGet()
            }
        }
    }

    /** Distributor apps on the phone, by package name. */
    fun distributors(context: Context): List<String> = UnifiedPush.getDistributors(context)

    /** The distributor to use: the one picked in the settings, or the only one there is. */
    private fun chosenDistributor(context: Context, available: List<String> = distributors(context)): String? =
        Prefs.pushDistributor(context)?.takeIf { it in available } ?: available.singleOrNull()

    /** Instant mail is wanted, UnifiedPush is switched on and there is a distributor for it. */
    fun active(context: Context): Boolean =
        Prefs.backgroundPush(context) && Prefs.unifiedPush(context) && chosenDistributor(context) != null

    /** How many accounts get new mail through the distributor (see the Rust side). */
    private fun overview(): JSONObject? =
        try {
            UwuNative.call("pushOverview", "{}")?.let { JSONObject(it) }
        } catch (error: Exception) {
            Log.w(TAG, "Couldn't read the push overview", error)
            null
        }

    /** Whether UwUMail still has to stay connected itself for instant mail. */
    fun watchNeeded(context: Context): Boolean {
        if (!active(context)) return true
        return overview()?.optBoolean("coversAll", false) != true
    }

    /** Registers the accounts with the distributor again, or undoes that when it's off. Any thread. */
    fun refresh(context: Context) {
        val app = context.applicationContext
        later { update(app) }
    }

    /** The engine reported a change: register again, or only look whether the mail service is still needed. */
    fun changed(context: Context, reregister: Boolean) {
        val app = context.applicationContext
        later {
            if (reregister) update(app) else MailWatchService.sync(app)
        }
    }

    /** From the settings: switch UnifiedPush on or off, with the distributor picked there. */
    fun configure(context: Context, enabled: Boolean, distributor: String?) {
        val app = context.applicationContext
        val previous = chosenDistributor(app)
        Prefs.setUnifiedPush(app, enabled, distributor?.takeIf { it in distributors(app) })
        later {
            // Another distributor gets new endpoints; the registrations with the old one end first.
            if (previous != null && previous != chosenDistributor(app)) stopAll(app)
            update(app)
        }
    }

    /** From [PushRenewJob]: renews the subscriptions, and tries again where registering failed. Blocks. */
    fun renew(context: Context) {
        val app = context.applicationContext
        if (!active(app)) return
        try {
            UwuNative.call("pushMaintain", "{}")
        } catch (error: Exception) {
            Log.w(TAG, "Couldn't renew the push subscriptions", error)
        }
        if (Prefs.pushFailures(app).length() > 0) refresh(app)
    }

    private fun update(context: Context) {
        try {
            if (active(context)) {
                registerAll(context)
                scheduleRenewal(context)
            } else {
                stopAll(context)
                cancelRenewal(context)
            }
        } catch (error: Exception) {
            Log.w(TAG, "UnifiedPush setup failed", error)
        }
        MailWatchService.sync(context)
    }

    private fun registerAll(context: Context) {
        val distributor = chosenDistributor(context) ?: return
        if (UnifiedPush.getSavedDistributor(context) != distributor) UnifiedPush.saveDistributor(context, distributor)
        val answer = JSONObject(UwuNative.call("pushTargets", "{}") ?: return)
        val targets = answer.getJSONArray("targets")
        val unreachable = strings(answer.getJSONArray("unreachable"))
        val registered = Prefs.pushInstances(context)
        val wanted = mutableSetOf<String>()
        for (index in 0 until targets.length()) {
            val target = targets.getJSONObject(index)
            val account = target.getString("accountId")
            wanted += account
            register(context, account, target.getString("email"), target.getString("vapidKey"))
        }
        // Accounts that went away, left JMAP or whose server stopped offering push.
        for (account in registered - wanted - unreachable) unregister(context, account)
        Prefs.setPushInstances(context, wanted + registered.intersect(unreachable))
    }

    private fun register(context: Context, account: String, email: String, vapid: String) {
        // The distributor may show this to say who a registration is for.
        val label = "UwUMail · $email"
        leaving.remove(account)
        try {
            UnifiedPush.register(context, account, label, vapid)
        } catch (error: UnifiedPush.VapidNotValidException) {
            Log.w(TAG, "The mail server's push key isn't usable, registering without it")
            UnifiedPush.register(context, account, label, null)
        }
    }

    /** Ends an account's registration and its subscription on the mail server. Worker thread only. */
    private fun unregister(context: Context, account: String) {
        leaving[account] = SystemClock.elapsedRealtime()
        UnifiedPush.unregister(context, account)
        forget(context, account)
    }

    /** Ends every registration, e.g. when UnifiedPush is switched off. Worker thread only. */
    private fun stopAll(context: Context) {
        val accounts = Prefs.pushInstances(context)
        if (accounts.isEmpty() && UnifiedPush.getSavedDistributor(context) == null) return
        for (account in accounts) unregister(context, account)
        UnifiedPush.removeDistributor(context)
        Prefs.setPushInstances(context, emptySet())
    }

    /** Asks the mail server to stop pushing for the account. Worker thread only. */
    private fun forget(context: Context, account: String) {
        Prefs.setPushFailure(context, account, null)
        Prefs.setPushInstances(context, Prefs.pushInstances(context) - account)
        try {
            UwuNative.call("pushUnsubscribe", JSONObject().put("accountId", account).toString())
        } catch (error: Exception) {
            Log.w(TAG, "Couldn't end the push subscription", error)
        }
    }

    private fun scheduleRenewal(context: Context) {
        val scheduler = context.getSystemService(JobScheduler::class.java) ?: return
        if (scheduler.getPendingJob(RENEW_JOB_ID) != null) return
        val job = JobInfo.Builder(RENEW_JOB_ID, ComponentName(context, PushRenewJob::class.java))
            .setPeriodic(RENEW_EVERY_MS)
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .setPersisted(true)
            .build()
        if (scheduler.schedule(job) != JobScheduler.RESULT_SUCCESS) Log.w(TAG, "Couldn't plan renewing the push subscriptions")
    }

    private fun cancelRenewal(context: Context) {
        context.getSystemService(JobScheduler::class.java)?.cancel(RENEW_JOB_ID)
    }

    /** The distributor gave an account an endpoint: the mail server subscribes to it. */
    fun newEndpoint(context: Context, account: String, url: String, publicKey: String?, auth: String?) {
        val app = context.applicationContext
        later {
            if (!active(app)) {
                unregister(app, account)
                return@later
            }
            if (publicKey == null || auth == null) {
                // Without keys the server would push in plain text, which anyone could fake.
                Log.w(TAG, "The distributor gave no Web Push keys")
                Prefs.setPushFailure(app, account, "KEYS")
                return@later
            }
            try {
                val payload = JSONObject()
                    .put("accountId", account)
                    .put("installId", Prefs.pushInstallId(app))
                    .put("url", url)
                    .put("p256dh", publicKey)
                    .put("auth", auth)
                UwuNative.call("pushEndpoint", payload.toString())
                Prefs.setPushFailure(app, account, null)
                Prefs.setPushInstances(app, Prefs.pushInstances(app) + account)
            } catch (error: Exception) {
                Log.w(TAG, "The mail server didn't take the push address", error)
                Prefs.setPushFailure(app, account, "SERVER")
            }
            MailWatchService.sync(app)
        }
    }

    /**
     * A push message for an account, decrypted by the connector. The sync runs on its own thread
     * and keeps the phone awake until it's done, so the new mail notification comes right away.
     */
    fun message(context: Context, account: String, content: ByteArray, decrypted: Boolean) {
        if (!decrypted) {
            // The server encrypts everything for this phone; anything else didn't come from it.
            Log.w(TAG, "Ignored a push message that wasn't encrypted for UwUMail")
            return
        }
        val app = context.applicationContext
        val body = String(content, Charsets.UTF_8)
        val power = app.getSystemService(PowerManager::class.java)
        val awake = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "UwUMail:push")
        awake.acquire(MESSAGE_WAKE_MS)
        thread(name = "uwumail-push-message") {
            try {
                UwuNative.call("pushMessage", JSONObject().put("accountId", account).put("body", body).toString())
            } catch (error: Exception) {
                Log.w(TAG, "Couldn't handle a push message", error)
            } finally {
                if (awake.isHeld) awake.release()
            }
        }
    }

    /** The distributor refused or ended an account's registration. */
    fun lost(context: Context, account: String, reason: String?) {
        if (reason == null) {
            val since = leaving.remove(account)
            if (since != null && SystemClock.elapsedRealtime() - since < OWN_UNREGISTER_MS) return
        }
        val app = context.applicationContext
        later {
            forget(app, account)
            if (reason != null) Prefs.setPushFailure(app, account, reason)
            MailWatchService.sync(app)
        }
    }

    /** What the settings show. */
    fun status(context: Context): JSONObject {
        val available = distributors(context)
        val chosen = chosenDistributor(context, available)
        val list = JSONArray()
        for (distributor in available) {
            list.put(JSONObject().put("id", distributor).put("name", appName(context, distributor)))
        }
        val summary = overview()
        val accounts = summary?.optJSONObject("overview")?.let { overview ->
            // Registered accounts whose endpoint hasn't come yet count as waiting, not as without push.
            val active = overview.optInt("active")
            var waiting = overview.optInt("waiting")
            var other = overview.optInt("other")
            val early = (Prefs.pushInstances(context).size - active - waiting).coerceIn(0, other)
            waiting += early
            other -= early
            JSONObject().put("active", active).put("waiting", waiting).put("other", other)
        }
        val on = Prefs.backgroundPush(context) && Prefs.unifiedPush(context) && chosen != null
        return JSONObject()
            .put("distributors", list)
            .put("distributor", chosen ?: JSONObject.NULL)
            .put("enabled", Prefs.unifiedPush(context))
            .put("active", on)
            .put("accounts", accounts ?: JSONObject.NULL)
            .put("working", queued.get() > 0)
            .put("failed", Prefs.pushFailures(context).length())
            .put("watchNeeded", !on || summary?.optBoolean("coversAll", false) != true)
    }

    private fun appName(context: Context, packageName: String): String =
        try {
            val info = context.packageManager.getApplicationInfo(packageName, 0)
            context.packageManager.getApplicationLabel(info).toString()
        } catch (error: PackageManager.NameNotFoundException) {
            packageName
        }

    private fun strings(array: JSONArray): Set<String> = (0 until array.length()).map { array.getString(it) }.toSet()
}
