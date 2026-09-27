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
