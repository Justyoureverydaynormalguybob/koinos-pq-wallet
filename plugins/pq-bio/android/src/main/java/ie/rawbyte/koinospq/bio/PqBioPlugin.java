package ie.rawbyte.koinospq.bio;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import androidx.annotation.NonNull;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.spec.MGF1ParameterSpec;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.spec.OAEPParameterSpec;
import javax.crypto.spec.PSource;

/**
 * A 32-byte key the keystore hands over only to a strong biometric that passes. The key itself is
 * encrypted under an RSA-2048 key in the AndroidKeyStore that requires user authentication (class 3,
 * BIOMETRIC_STRONG) for every private-key use and is permanently invalidated when a fingerprint or face
 * is enrolled or removed. The encryption (public key) needs no prompt, so turning biometrics on asks
 * nothing; the decryption runs only inside the BiometricPrompt's CryptoObject, so the OS, not this
 * code, decides whether the finger passed. Errors say "cancelled", "invalidated" or "failed".
 */
@CapacitorPlugin(name = "PqBio")
public class PqBioPlugin extends Plugin {
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String ALIAS = "ie.rawbyte.koinospq.kwk";
    private static final String PREFS = "pq-bio";
    private static final String ITEM = "wrapped";
    private static final String TRANSFORM = "RSA/ECB/OAEPWithSHA-256AndMGF1Padding";
    /** The keystore implements OAEP with MGF1-SHA1 whatever the digest; say so on both sides. */
    private static final OAEPParameterSpec OAEP = new OAEPParameterSpec("SHA-256", "MGF1", MGF1ParameterSpec.SHA1, PSource.PSpecified.DEFAULT);

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static final String PROBE = "pq-bio-probe";

    /**
     * Strong biometric available AND accepted by the keystore. BiometricManager can say "strong biometric
     * enrolled" (an OEM face unlock, say) while the keystore refuses to create a per-use biometric key
     * ("At least one biometric must be enrolled to create keys requiring user authentication for every
     * use"), seen on a ColorOS phone with face unlock and no fingerprint. So the answer comes from a trial
     * key under a probe alias, deleted at once. `reason` is "enrol" for that case.
     */
    @PluginMethod
    public void available(PluginCall call) {
        JSObject o = new JSObject();
        int r = BiometricManager.from(getContext()).canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG);
        if (r != BiometricManager.BIOMETRIC_SUCCESS) {
            o.put("available", false);
            o.put("reason", r == BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED ? "enrol" : "unavailable");
            call.resolve(o);
            return;
        }
        try {
            KeyGenerator g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
            KeyGenParameterSpec.Builder b = new KeyGenParameterSpec.Builder(PROBE, KeyProperties.PURPOSE_ENCRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setUserAuthenticationRequired(true)
                .setInvalidatedByBiometricEnrollment(true);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                b.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG);
            } else {
                b.setUserAuthenticationValidityDurationSeconds(-1);
            }
            g.init(b.build());
            g.generateKey();
            o.put("available", true);
        } catch (IllegalStateException e) {
            o.put("available", false);
            o.put("reason", "enrol");
        } catch (Exception e) {
            o.put("available", false);
            o.put("reason", "unavailable: " + e.getMessage());
        } finally {
            try {
                keyStore().deleteEntry(PROBE);
            } catch (Exception ignored) {
            }
        }
        call.resolve(o);
    }

    private void createKey() throws Exception {
        KeyPairGenerator g = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_RSA, KEYSTORE);
        KeyGenParameterSpec.Builder b = new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_DECRYPT)
            .setKeySize(2048)
            .setDigests(KeyProperties.DIGEST_SHA256, KeyProperties.DIGEST_SHA1)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_RSA_OAEP)
            .setUserAuthenticationRequired(true)
            .setInvalidatedByBiometricEnrollment(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            b.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG); // every use, biometric only
        } else {
            b.setUserAuthenticationValidityDurationSeconds(-1);
        }
        g.initialize(b.build());
        g.generateKeyPair();
    }

    private KeyStore keyStore() throws Exception {
        KeyStore ks = KeyStore.getInstance(KEYSTORE);
        ks.load(null);
        return ks;
    }

    private void deleteKey() {
        try {
            keyStore().deleteEntry(ALIAS);
        } catch (Exception ignored) {
        }
        prefs().edit().remove(ITEM).apply();
    }

    @PluginMethod
    public void set(PluginCall call) {
        String hex = call.getString("hex");
        if (hex == null || !hex.matches("[0-9a-f]{64}")) {
            call.reject("failed: bad key");
            return;
        }
        try {
            deleteKey();
            createKey();
            PublicKey pub = keyStore().getCertificate(ALIAS).getPublicKey();
            Cipher c = Cipher.getInstance(TRANSFORM);
            c.init(Cipher.ENCRYPT_MODE, pub, OAEP);
            byte[] ct = c.doFinal(hexToBytes(hex));
            prefs().edit().putString(ITEM, Base64.encodeToString(ct, Base64.NO_WRAP)).apply();
            call.resolve();
        } catch (IllegalStateException e) {
            deleteKey();
            call.reject("enrol"); // the keystore has no strong biometric it accepts (see available())
        } catch (Exception e) {
            deleteKey();
            call.reject("failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        deleteKey();
        call.resolve();
    }

    @PluginMethod
    public void get(PluginCall call) {
        final String stored = prefs().getString(ITEM, null);
        if (stored == null) {
            JSObject o = new JSObject();
            o.put("hex", (String) null);
            call.resolve(o);
            return;
        }
        final Cipher cipher;
        try {
            PrivateKey priv = (PrivateKey) keyStore().getKey(ALIAS, null);
            if (priv == null) {
                deleteKey();
                call.reject("invalidated");
                return;
            }
            cipher = Cipher.getInstance(TRANSFORM);
            cipher.init(Cipher.DECRYPT_MODE, priv, OAEP);
        } catch (KeyPermanentlyInvalidatedException e) {
            deleteKey(); // a new finger or face was enrolled: the key is dead by design
            call.reject("invalidated");
            return;
        } catch (Exception e) {
            call.reject("failed: " + e.getMessage());
            return;
        }
        final String title = call.getString("title", "Sparán");
        final String reason = call.getString("reason", "Unlock the wallet");
        final String cancel = call.getString("cancel", "Use passphrase");
        final byte[] ct = Base64.decode(stored, Base64.NO_WRAP);
        getActivity().runOnUiThread(() -> {
            FragmentActivity activity = (FragmentActivity) getActivity();
            BiometricPrompt.PromptInfo info = new BiometricPrompt.PromptInfo.Builder()
                .setTitle(title)
                .setSubtitle(reason)
                .setNegativeButtonText(cancel)
                .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
                .setConfirmationRequired(false)
                .build();
            BiometricPrompt prompt = new BiometricPrompt(activity, ContextCompat.getMainExecutor(getContext()), new BiometricPrompt.AuthenticationCallback() {
                @Override
                public void onAuthenticationSucceeded(@NonNull BiometricPrompt.AuthenticationResult result) {
                    try {
                        Cipher c = result.getCryptoObject() == null ? null : result.getCryptoObject().getCipher();
                        if (c == null) throw new IllegalStateException("no crypto object");
                        byte[] pt = c.doFinal(ct);
                        JSObject o = new JSObject();
                        o.put("hex", bytesToHex(pt));
                        java.util.Arrays.fill(pt, (byte) 0);
                        call.resolve(o);
                    } catch (Exception e) {
                        call.reject("failed: " + e.getMessage());
                    }
                }

                @Override
                public void onAuthenticationError(int code, @NonNull CharSequence msg) {
                    if (code == BiometricPrompt.ERROR_NEGATIVE_BUTTON || code == BiometricPrompt.ERROR_USER_CANCELED || code == BiometricPrompt.ERROR_CANCELED) {
                        call.reject("cancelled");
                    } else {
                        call.reject("failed: " + msg);
                    }
                }
            });
            prompt.authenticate(info, new BiometricPrompt.CryptoObject(cipher));
        });
    }

    private static byte[] hexToBytes(String s) {
        byte[] out = new byte[s.length() / 2];
        for (int i = 0; i < out.length; i++) out[i] = (byte) Integer.parseInt(s.substring(2 * i, 2 * i + 2), 16);
        return out;
    }

    private static String bytesToHex(byte[] b) {
        StringBuilder sb = new StringBuilder(b.length * 2);
        for (byte x : b) sb.append(String.format("%02x", x));
        return sb.toString();
    }
}
