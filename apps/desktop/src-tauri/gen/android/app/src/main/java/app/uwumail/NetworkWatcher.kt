package app.uwumail

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.util.Log
import java.util.concurrent.atomic.AtomicBoolean

/** Reconnects right away when the phone switches networks, instead of waiting for a timeout. */
object NetworkWatcher {
    private val started = AtomicBoolean(false)

    fun start(context: Context) {
        if (!started.compareAndSet(false, true)) return
        val manager = context.getSystemService(ConnectivityManager::class.java)
        val first = AtomicBoolean(true)
        manager.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                // The first callback only reports the network UwUMail started with.
                if (first.getAndSet(false)) return
                try {
                    UwuNative.call("networkAvailable", "{}")
                } catch (error: Exception) {
                    Log.w("UwUMail", "Couldn't reconnect", error)
                }
            }
        })
    }
}
