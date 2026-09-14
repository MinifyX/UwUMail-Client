package app.uwumail

import android.content.Context

/** The Rust side (crates/uwumail-android). */
object UwuNative {
    init {
        System.loadLibrary("uwumail_desktop_lib")
    }

    /** Connects the bridge and starts the mail engine for this process. */
    @JvmStatic
    external fun start(context: Context, dataDir: String, cacheDir: String)

    /** Method name plus JSON, answered with JSON or null. Throws on errors. */
    @JvmStatic
    external fun call(method: String, payload: String): String?
}
