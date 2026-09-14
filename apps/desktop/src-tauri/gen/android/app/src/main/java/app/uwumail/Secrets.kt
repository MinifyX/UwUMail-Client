package app.uwumail

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Passwords and refresh tokens. They are encrypted with an AES key that lives
 * in the Android Keystore (hardware-backed where the phone supports it) and
 * only the encrypted form is stored in UwUMail's private preferences.
 */
object Secrets {
    private const val KEY_ALIAS = "uwumail-secrets"
    private const val PREFS = "uwumail.secrets"
    private const val IV_LENGTH = 12

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    @Synchronized
    fun set(context: Context, account: String, value: String) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val sealed = cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        check(prefs(context).edit().putString(account, Base64.encodeToString(sealed, Base64.NO_WRAP)).commit()) {
            "Couldn't save the password"
        }
    }

    /** Null when nothing is saved or the key is gone (then UwUMail asks for the password again). */
    @Synchronized
    fun get(context: Context, account: String): String? {
        val stored = prefs(context).getString(account, null) ?: return null
        return try {
            val sealed = Base64.decode(stored, Base64.NO_WRAP)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, sealed, 0, IV_LENGTH))
            String(cipher.doFinal(sealed, IV_LENGTH, sealed.size - IV_LENGTH), Charsets.UTF_8)
        } catch (error: Exception) {
            Log.w("UwUMail", "Couldn't decrypt a saved password", error)
            null
        }
    }

    @Synchronized
    fun delete(context: Context, account: String) {
        prefs(context).edit().remove(account).commit()
    }
}
