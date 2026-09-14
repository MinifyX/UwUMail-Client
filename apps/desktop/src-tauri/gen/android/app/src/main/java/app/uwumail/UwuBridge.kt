package app.uwumail

import android.app.Application
import org.json.JSONObject
import java.lang.ref.WeakReference

/**
 * Everything Rust asks Android for. Called from any thread with a method name
 * and JSON; answers with a string (often JSON) or null.
 */
object UwuBridge {
    private lateinit var app: Application

    @Volatile
    private var activity = WeakReference<MainActivity>(null)

    fun init(application: Application) {
        app = application
    }

    fun attach(mainActivity: MainActivity?) {
        activity = WeakReference(mainActivity)
    }

    @JvmStatic
    fun call(method: String, payload: String): String? {
        val args = if (payload.isEmpty()) JSONObject() else JSONObject(payload)
        return when (method) {
            "secretSet" -> {
                Secrets.set(app, args.getString("account"), args.getString("value"))
                null
            }
            "secretGet" -> Secrets.get(app, args.getString("account"))
            "secretDelete" -> {
                Secrets.delete(app, args.getString("account"))
                null
            }
            "notifyMail" -> {
                Notifications.showMail(app, args)
                null
            }
            "clearMailNotifications" -> {
                Notifications.clearMail(app)
                null
            }
            "openUrl" -> {
                Files.openUrl(app, args.getString("url"))
                null
            }
            "openFile" -> {
                Files.open(app, args.getString("path"), args.getString("filename"), args.getString("mimeType"))
                null
            }
            "saveToDownloads" ->
                Files.saveToDownloads(app, args.getString("path"), args.getString("filename"), args.getString("mimeType"))
            "installApk" -> {
                Files.installApk(app, args.getString("path"))
                null
            }
            "setPrefs" -> {
                Prefs.update(app, args)
                MailWatchService.sync(app)
                null
            }
            "offlineDays" -> Prefs.offlineDays(app).toString()
            "setSystemBars" -> {
                activity.get()?.setSystemBars(args.getBoolean("dark"), args.getString("background"))
                null
            }
            "requestNotifications" -> {
                activity.get()?.requestNotificationPermission()
                null
            }
            "uiReady" -> {
                activity.get()?.uiReady()
                null
            }
            "watchSettings" -> {
                Notifications.openWatchSettings(app)
                null
            }
            "confirm" -> {
                val window = activity.get() ?: return "false"
                window.confirm(args.getString("title"), args.getString("message"), args.getString("ok"), args.getString("cancel"))
                    .toString()
            }
            else -> throw IllegalArgumentException("Unknown call $method")
        }
    }
}
