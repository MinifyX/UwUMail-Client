package app.uwumail

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.os.Process
import java.io.File

/** Starts UwUMail in a fresh process (see `MainActivity.onCreate`). */
object Relaunch {
    const val EXTRA_PID = "app.uwumail.relaunch.pid"
    const val EXTRA_INTENT = "app.uwumail.relaunch.intent"

    fun restart(activity: Activity, original: Intent?) {
        val next = Intent(activity, MainActivity::class.java).apply {
            if (original != null) {
                action = original.action
                data = original.data
                type = original.type
                original.extras?.let { putExtras(it) }
                clipData = original.clipData
                addFlags(original.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
        }
        activity.startActivity(
            Intent(activity, RelaunchActivity::class.java)
                .putExtra(EXTRA_PID, Process.myPid())
                .putExtra(EXTRA_INTENT, next)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
        activity.finish()
        Runtime.getRuntime().exit(0)
    }
}

/** Runs in its own tiny process: waits for the old UwUMail to be gone, then opens the new one. */
class RelaunchActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val pid = intent.getIntExtra(Relaunch.EXTRA_PID, -1)
        if (pid > 0) {
            Process.killProcess(pid)
            val deadline = System.currentTimeMillis() + 2000
            while (File("/proc/$pid").exists() && System.currentTimeMillis() < deadline) Thread.sleep(20)
        }
        @Suppress("DEPRECATION")
        val next = intent.getParcelableExtra<Intent>(Relaunch.EXTRA_INTENT)
            ?: Intent(this, MainActivity::class.java)
        startActivity(next.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        finish()
        Runtime.getRuntime().exit(0)
    }
}
