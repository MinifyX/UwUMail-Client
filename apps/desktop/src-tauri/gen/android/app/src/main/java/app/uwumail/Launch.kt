package app.uwumail

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import kotlin.concurrent.thread

/** Turns intents (shares, mailto: links, tapped notifications) into UwUMail launch actions. */
object Launch {
    fun handle(context: Context, intent: Intent?) {
        intent ?: return
        val action = intent.action ?: return
        when {
            action == MainActivity.ACTION_OPEN_MESSAGE -> {
                val threadId = intent.getStringExtra(MainActivity.EXTRA_THREAD_ID) ?: return
                val messageId = intent.getStringExtra(MainActivity.EXTRA_MESSAGE_ID) ?: return
                report(JSONObject().put("kind", "open").put("threadId", threadId).put("messageId", messageId))
            }
            (action == Intent.ACTION_VIEW || action == Intent.ACTION_SENDTO) && intent.data?.scheme == "mailto" ->
                report(JSONObject().put("kind", "mailto").put("url", intent.dataString))
            action == Intent.ACTION_SEND || action == Intent.ACTION_SEND_MULTIPLE -> {
                val uris = streams(intent)
                val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT)
                val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()
                val app = context.applicationContext
                // Copying can take a moment for big videos, so not on the main thread.
                thread(name = "uwumail-share") {
                    val files = JSONArray()
                    uris.forEach { uri -> copy(app, uri)?.let { files.put(it) } }
                    report(JSONObject().put("kind", "share").put("subject", subject).put("text", text).put("files", files))
                }
            }
            else -> return
        }
        // Handled once, not again when Android recreates the window.
        intent.action = Intent.ACTION_MAIN
    }

    private fun report(payload: JSONObject) {
        try {
            UwuNative.call("launch", payload.toString())
        } catch (error: Exception) {
            Log.w("UwUMail", "Couldn't hand over the launch action", error)
        }
    }

    @Suppress("DEPRECATION")
    private fun streams(intent: Intent): List<Uri> = when (intent.action) {
        Intent.ACTION_SEND -> listOfNotNull(intent.getParcelableExtra(Intent.EXTRA_STREAM) as? Uri)
        else -> intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM).orEmpty()
    }

    /** Copies a shared file into the cache, where the engine can read it. */
    private fun copy(context: Context, uri: Uri): JSONObject? = try {
        val resolver = context.contentResolver
        var name = uri.lastPathSegment ?: "attachment"
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst() && !cursor.isNull(0)) name = cursor.getString(0)
        }
        val folder = File(context.cacheDir, "shared/${UUID.randomUUID()}").apply { mkdirs() }
        val target = File(folder, Files.safeName(name))
        resolver.openInputStream(uri).use { input ->
            requireNotNull(input) { "Nothing to read" }
            target.outputStream().use { input.copyTo(it) }
        }
        JSONObject()
            .put("path", target.absolutePath)
            .put("filename", target.name)
            .put("mimeType", resolver.getType(uri) ?: "application/octet-stream")
            .put("size", target.length())
    } catch (error: Exception) {
        Log.w("UwUMail", "Couldn't read a shared file", error)
        null
    }
}
