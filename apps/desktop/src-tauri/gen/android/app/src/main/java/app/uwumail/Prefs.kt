package app.uwumail

import android.content.Context
import android.content.res.Configuration
import org.json.JSONObject
import java.util.Locale
import java.util.UUID

/** The few UI settings the Android side needs while no window is open. */
object Prefs {
    private const val NAME = "uwumail.prefs"

    private fun prefs(context: Context) = context.getSharedPreferences(NAME, Context.MODE_PRIVATE)

    fun update(context: Context, args: JSONObject) {
        prefs(context).edit().apply {
            if (args.has("language")) putString("language", args.getString("language"))
            if (args.has("tone")) putString("tone", args.getString("tone"))
            if (args.has("backgroundPush")) putBoolean("backgroundPush", args.getBoolean("backgroundPush"))
            if (args.has("offlineDays")) putInt("offlineDays", args.getInt("offlineDays"))
            if (args.has("appLock")) putBoolean("appLock", args.getBoolean("appLock"))
            if (args.has("showContent")) putBoolean("showContent", args.getBoolean("showContent"))
            if (args.has("mutedAccounts")) {
                val ids = args.optJSONArray("mutedAccounts")
                putStringSet("mutedAccounts", (0 until (ids?.length() ?: 0)).map { ids!!.getString(it) }.toSet())
            }
            if (args.has("quietHours")) {
                val quiet = args.optJSONObject("quietHours")
                if (quiet == null) {
                    putInt("quietDays", 0)
                } else {
                    putInt("quietFrom", quiet.optInt("from", 0))
                    putInt("quietTo", quiet.optInt("to", 0))
                    putInt("quietDays", quiet.optInt("days", 0))
                }
            }
        }.apply()
    }

    /** New mail for JMAP accounts through a UnifiedPush distributor (off until chosen in the settings). */
    fun unifiedPush(context: Context) = prefs(context).getBoolean("unifiedPush", false)

    /** The distributor app picked in the settings, if any. */
    fun pushDistributor(context: Context): String? = prefs(context).getString("pushDistributor", null)

    fun setUnifiedPush(context: Context, enabled: Boolean, distributor: String?) {
        prefs(context).edit().apply {
            putBoolean("unifiedPush", enabled)
            if (distributor != null) putString("pushDistributor", distributor)
        }.apply()
    }

    /** Accounts registered with the distributor. */
    fun pushInstances(context: Context): Set<String> = prefs(context).getStringSet("pushInstances", null)?.toSet() ?: emptySet()

    fun setPushInstances(context: Context, accounts: Set<String>) {
        prefs(context).edit().putStringSet("pushInstances", accounts).apply()
    }

    /** Why the distributor refused an account, by account id. */
    fun pushFailures(context: Context): JSONObject =
        prefs(context).getString("pushFailures", null)?.let { runCatching { JSONObject(it) }.getOrNull() } ?: JSONObject()

    @Synchronized
    fun setPushFailure(context: Context, account: String, reason: String?) {
        val failures = pushFailures(context)
        if (reason == null) failures.remove(account) else failures.put(account, reason)
        prefs(context).edit().putString("pushFailures", failures.toString()).apply()
    }

    /**
     * A random value for this installation. Hashed with the account, it names UwUMail's push
     * subscriptions on the mail server (the JMAP deviceClientId).
     */
    @Synchronized
    fun pushInstallId(context: Context): String =
        prefs(context).getString("pushInstallId", null)
            ?: UUID.randomUUID().toString().also { prefs(context).edit().putString("pushInstallId", it).commit() }

    /** Days of mail kept complete on the phone; 0 keeps everything. */
    fun offlineDays(context: Context) = prefs(context).getInt("offlineDays", 90)

    /** Stay connected in the background for instant new mail (on by default). */
    fun backgroundPush(context: Context) = prefs(context).getBoolean("backgroundPush", true)

    /** The app lock is on: notifications leave out what the mail says, Recents shows no preview. */
    fun appLock(context: Context) = prefs(context).getBoolean("appLock", false)

    /** Notifications name sender and subject (Settings → "Show sender and subject", on by default). */
    fun showContent(context: Context) = prefs(context).getBoolean("showContent", true)

    /** Accounts whose new mail doesn't notify (Settings → Notifications, synced as `notify.muted`). */
    fun muted(context: Context, accountId: String) =
        prefs(context).getStringSet("mutedAccounts", null)?.contains(accountId) == true

    /**
     * Whether now lies in the quiet hours: from `quietFrom` to `quietTo` (minutes after midnight)
     * on the days in the `quietDays` bitmask (bit 0 = Sunday). A span past midnight belongs to the
     * day it starts on; the same start and end mean the whole day. Same rules as
     * uwumail_core::notify::QuietHours.
     */
    fun quietNow(context: Context): Boolean {
        val prefs = prefs(context)
        val days = prefs.getInt("quietDays", 0)
        if (days == 0) return false
        val from = prefs.getInt("quietFrom", 0)
        val to = prefs.getInt("quietTo", 0)
        val now = java.util.Calendar.getInstance()
        val day = now.get(java.util.Calendar.DAY_OF_WEEK) - 1 // Calendar.SUNDAY is 1
        val minute = now.get(java.util.Calendar.HOUR_OF_DAY) * 60 + now.get(java.util.Calendar.MINUTE)
        fun listed(d: Int) = days and (1 shl ((d + 7) % 7)) != 0
        return when {
            from == to -> listed(day)
            from < to -> listed(day) && minute >= from && minute < to
            else -> (listed(day) && minute >= from) || (listed(day - 1) && minute < to)
        }
    }

    fun playful(context: Context) = prefs(context).getString("tone", "playful") == "playful"

    /**
     * A random value only UwUMail knows. Its own notifications carry it, so other apps can't
     * send UwUMail to a message of their choosing.
     */
    @Synchronized
    fun launchToken(context: Context): String =
        prefs(context).getString("launchToken", null)
            ?: UUID.randomUUID().toString().also { prefs(context).edit().putString("launchToken", it).commit() }

    /** A context whose resources follow UwUMail's language setting instead of the phone's. */
    fun localized(context: Context): Context {
        val language = prefs(context).getString("language", "system")
        if (language != "de" && language != "en") return context
        val config = Configuration(context.resources.configuration)
        config.setLocale(Locale.forLanguageTag(language))
        return context.createConfigurationContext(config)
    }
}
