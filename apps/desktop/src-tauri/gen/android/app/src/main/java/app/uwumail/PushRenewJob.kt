package app.uwumail

import android.app.job.JobParameters
import android.app.job.JobService
import kotlin.concurrent.thread

/**
 * Renews the JMAP push subscriptions about twice a day (see [Push]). The server ends one after a
 * week without renewal, and a phone that gets no mail and isn't opened wouldn't renew it otherwise.
 */
class PushRenewJob : JobService() {
    override fun onStartJob(params: JobParameters): Boolean {
        thread(name = "uwumail-push-renew") {
            try {
                Push.renew(this)
            } finally {
                jobFinished(params, false)
            }
        }
        return true
    }

    // Whatever wasn't renewed is renewed next time; the subscriptions last a week.
    override fun onStopJob(params: JobParameters): Boolean = false
}
