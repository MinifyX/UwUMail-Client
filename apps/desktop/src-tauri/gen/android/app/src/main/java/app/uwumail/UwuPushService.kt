package app.uwumail

import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage

/**
 * What the UnifiedPush distributor sends, handed over by the connector on the main thread. The
 * instance is the account id (see [Push]); everything that talks to the mail server runs elsewhere.
 */
class UwuPushService : PushService() {
    override fun onNewEndpoint(endpoint: PushEndpoint, instance: String) {
        val keys = endpoint.pubKeySet
        Push.newEndpoint(this, instance, endpoint.url, keys?.pubKey, keys?.auth)
    }

    override fun onMessage(message: PushMessage, instance: String) {
        Push.message(this, instance, message.content, message.decrypted)
    }

    override fun onRegistrationFailed(reason: FailedReason, instance: String) {
        Push.lost(this, instance, reason.name)
    }

    override fun onUnregistered(instance: String) {
        Push.lost(this, instance, null)
    }
}
