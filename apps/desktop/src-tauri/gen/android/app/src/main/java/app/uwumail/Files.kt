package app.uwumail

import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Environment
import android.provider.MediaStore
import android.provider.Settings
import android.webkit.MimeTypeMap
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File

/** Attachments, links and updates: handing files to other apps and to Android. */
object Files {
    private fun authority(context: Context) = "${context.packageName}.fileprovider"

    fun openUrl(context: Context, url: String) {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
    }

    private const val PACKAGE_ARCHIVE = "application/vnd.android.package-archive"

    /** App packages; UwUMail never hands these from a mail to the installer. */
    private val PACKAGE_EXTENSIONS = setOf("apk", "apks", "apkm", "xapk", "aab")

    private fun extensionOf(name: String) = name.substringAfterLast('.', "").lowercase()

    /**
     * The type another app sees. It follows the file name, never only what the mail claims:
     * otherwise an app package named "invoice.pdf" would be offered to the installer.
     */
    private fun typeFor(filename: String, claimed: String): String {
        val byName = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extensionOf(filename))
        return when {
            byName != null -> byName
            claimed.isBlank() || claimed.equals(PACKAGE_ARCHIVE, ignoreCase = true) -> "application/octet-stream"
            else -> claimed
        }
    }

    /**
     * Opens a file with another app. The attachment cache is private, so the
     * file is copied into the shared part of the cache first.
     */
    fun open(context: Context, path: String, filename: String, mimeType: String) {
        val name = safeName(filename)
        val type = typeFor(name, mimeType)
        check(extensionOf(name) !in PACKAGE_EXTENSIONS && type != PACKAGE_ARCHIVE) {
            "App packages from mails can't be opened"
        }
        val folder = File(context.cacheDir, "open").apply { mkdirs() }
        folder.listFiles()?.forEach { it.delete() }
        val copy = File(folder, name)
        File(path).copyTo(copy, overwrite = true)
        val uri = FileProvider.getUriForFile(context, authority(context), copy)
        val view = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, type)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        val chooser = Intent.createChooser(view, filename).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            context.startActivity(chooser)
        } catch (error: ActivityNotFoundException) {
            throw IllegalStateException("No app on this phone can open $filename")
        }
    }

    /** Saves into Downloads/UwUMail and answers `{"location": "Download/UwUMail/…"}`. */
    fun saveToDownloads(context: Context, path: String, filename: String, mimeType: String): String {
        val folder = "${Environment.DIRECTORY_DOWNLOADS}/UwUMail"
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, safeName(filename))
            put(MediaStore.Downloads.MIME_TYPE, typeFor(safeName(filename), mimeType))
            put(MediaStore.Downloads.RELATIVE_PATH, folder)
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val resolver = context.contentResolver
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
            ?: throw IllegalStateException("Couldn't create the file in Downloads")
        resolver.openOutputStream(uri).use { output ->
            requireNotNull(output) { "Couldn't write to Downloads" }
            File(path).inputStream().use { it.copyTo(output) }
        }
        resolver.update(uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
        // MediaStore may rename duplicates ("name (1).pdf"), so report the real name.
        val saved = resolver.query(uri, arrayOf(MediaStore.Downloads.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) cursor.getString(0) else null
        } ?: filename
        return JSONObject().put("location", "$folder/$saved").toString()
    }

    /** Hands a downloaded update to Android's installer. */
    fun installApk(context: Context, path: String) {
        if (!context.packageManager.canRequestPackageInstalls()) {
            // Android asks once whether UwUMail may install updates.
            context.startActivity(
                Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
            return
        }
        val uri = FileProvider.getUriForFile(context, authority(context), File(path))
        context.startActivity(
            Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK),
        )
    }

    /** A plain file name: no folders, no control characters, never "." or "..". */
    fun safeName(name: String): String =
        name.replace(Regex("[\\\\/:*?\"<>|\\u0000-\\u001f\\u007f]"), "_")
            .trim()
            .take(120)
            .takeUnless { it.isEmpty() || it.all { char -> char == '.' } }
            ?: "attachment"
}
