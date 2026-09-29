package app.uwumail

import android.content.Context
import android.graphics.BitmapFactory
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import java.util.concurrent.TimeUnit

/**
 * The text in a mail's pictures (e.g. the date on a poster) for mailboxes whose server doesn't read
 * them, with ML Kit's Latin-script recognizer from Google Play services: the model comes with Play
 * services, not with UwUMail. Without Play services the feature stays off. Called from Rust on a
 * background thread, never the main one.
 */
object PictureText {
    /** Longer sides are halved until they fit; ML Kit needs no more for text. */
    private const val MAX_SIDE = 3000
    private const val TIMEOUT_SECONDS = 20L

    private val recognizer by lazy { TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS) }

    fun available(context: Context): Boolean =
        GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(context) == ConnectionResult.SUCCESS

    /** The recognized lines of the picture in the file, one per line. */
    fun read(path: String): String {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(path, bounds)
        require(bounds.outWidth > 0 && bounds.outHeight > 0) { "Not a picture" }
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / sample > MAX_SIDE) sample *= 2
        val bitmap = BitmapFactory.decodeFile(path, BitmapFactory.Options().apply { inSampleSize = sample })
            ?: throw IllegalArgumentException("Not a picture")
        try {
            val text = Tasks.await(recognizer.process(InputImage.fromBitmap(bitmap, 0)), TIMEOUT_SECONDS, TimeUnit.SECONDS)
            return text.textBlocks.flatMap { it.lines }.joinToString("\n") { it.text }
        } finally {
            bitmap.recycle()
        }
    }
}
