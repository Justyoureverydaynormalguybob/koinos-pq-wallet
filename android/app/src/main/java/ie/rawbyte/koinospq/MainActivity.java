package ie.rawbyte.koinospq;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    // Screenshot / screen-recording blocking (FLAG_SECURE) is no longer set here for the whole app.
    // The wallet switches it on from JavaScript (PqBrowser.setSecure) while the 24 words are on
    // screen, and all the time when the "Block screenshots" setting is on.
}
