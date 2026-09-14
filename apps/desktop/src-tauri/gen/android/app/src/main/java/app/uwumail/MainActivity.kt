package app.uwumail

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AlertDialog
import androidx.activity.enableEdgeToEdge
import androidx.core.content.ContextCompat
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicBoolean

class MainActivity : TauriActivity() {
    companion object {
        const val ACTION_OPEN_MESSAGE = "app.uwumail.OPEN_MESSAGE"
        const val EXTRA_THREAD_ID = "threadId"
        const val EXTRA_MESSAGE_ID = "messageId"
        private const val SPLASH_AT_MOST_MS = 4000L

        /** Whether a window was already created in this process. */
        private var hosted = false

        /** Whether UwUMail is on screen (then new mail doesn't ring). */
        @Volatile
        var visible = false
            private set
    }

    @Volatile
    private var uiReady = false

    @SuppressLint("MissingSuperCall")
    override fun onCreate(savedInstanceState: Bundle?) {
        if (hosted) {
            // Android closed the window while the mail service kept the process
            // running. The web view can't be attached to a new window, so start
            // UwUMail fresh; the service comes back with it. The process ends
            // inside restart(), before the window would need super.onCreate.
            Relaunch.restart(this, intent)
            return
        }
        hosted = true

        installSplashScreen().setKeepOnScreenCondition { !uiReady }
        Handler(Looper.getMainLooper()).postDelayed({ uiReady = true }, SPLASH_AT_MOST_MS)
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        UwuBridge.attach(this)

        // Keep the web view between the status bar, the navigation bar and the keyboard.
        val content = findViewById<View>(android.R.id.content)
        ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime(),
            )
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }

        // Back on the first screen puts UwUMail in the background instead of closing it.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                moveTaskToBack(true)
            }
        })

        Launch.handle(this, intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        Launch.handle(this, intent)
    }

    override fun onResume() {
        super.onResume()
        visible = true
        UwuBridge.attach(this)
        Notifications.clearMail(this)
        MailWatchService.start(this)
    }

    override fun onPause() {
        visible = false
        super.onPause()
    }

    override fun onDestroy() {
        visible = false
        UwuBridge.attach(null)
        super.onDestroy()
    }

    /** The UI has drawn its first screen: let the splash go. */
    fun uiReady() {
        uiReady = true
    }

    /** Colors the areas behind the status and navigation bars like the app. */
    fun setSystemBars(dark: Boolean, background: String) {
        runOnUiThread {
            val color = try {
                Color.parseColor(background)
            } catch (error: IllegalArgumentException) {
                if (dark) Color.BLACK else Color.WHITE
            }
            window.decorView.setBackgroundColor(color)
            findViewById<View>(android.R.id.content).setBackgroundColor(color)
            WindowCompat.getInsetsController(window, window.decorView).apply {
                isAppearanceLightStatusBars = !dark
                isAppearanceLightNavigationBars = !dark
            }
        }
    }

    fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < 33) return
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        runOnUiThread { requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1) }
    }

    /** A native yes/no dialog. Blocks the calling (background) thread until it's answered. */
    fun confirm(title: String, message: String, ok: String, cancel: String): Boolean {
        val answer = AtomicBoolean(false)
        val done = CountDownLatch(1)
        runOnUiThread {
            AlertDialog.Builder(this)
                .setTitle(title)
                .setMessage(message)
                .setPositiveButton(ok) { _, _ -> answer.set(true) }
                .setNegativeButton(cancel, null)
                .setOnDismissListener { done.countDown() }
                .show()
        }
        done.await()
        return answer.get()
    }
}
