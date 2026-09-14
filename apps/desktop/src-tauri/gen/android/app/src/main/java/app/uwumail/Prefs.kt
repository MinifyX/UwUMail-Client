package app.uwumail

import android.content.Context
import android.content.res.Configuration
import org.json.JSONObject
import java.util.Locale

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
        }.apply()
    }

    /** Days of mail kept complete on the phone; 0 keeps everything. */
    fun offlineDays(context: Context) = prefs(context).getInt("offlineDays", 90)

    /** Stay connected in the background for instant new mail (on by default). */
    fun backgroundPush(context: Context) = prefs(context).getBoolean("backgroundPush", true)

    fun playful(context: Context) = prefs(context).getString("tone", "playful") == "playful"

    /** A context whose resources follow UwUMail's language setting instead of the phone's. */
    fun localized(context: Context): Context {
        val language = prefs(context).getString("language", "system")
        if (language != "de" && language != "en") return context
        val config = Configuration(context.resources.configuration)
        config.setLocale(Locale.forLanguageTag(language))
        return context.createConfigurationContext(config)
    }
}
