package ie.rawbyte.koinospq.browser;

import android.annotation.SuppressLint;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.Collections;
import org.json.JSONObject;

/**
 * An in-app browser for dapps: a second WebView laid over the app's own, between a top and a bottom
 * inset given in CSS pixels, with a script injected at document start (window.kondor and its relay)
 * and a two-way JSON message channel. Only http(s) pages load; every other scheme is dropped. The
 * page never sees the app's WebView, its storage or any key: it only ever posts JSON to the app.
 */
@CapacitorPlugin(name = "PqBrowser")
public class PqBrowserPlugin extends Plugin {
    private WebView view;
    private String script = "";
    private double topCss = 0;
    private double bottomCss = 0;
    private boolean startScriptSupported = false;

    private static boolean isWeb(String url) {
        return url != null && (url.startsWith("https://") || url.startsWith("http://"));
    }

    @PluginMethod
    public void open(PluginCall call) {
        final String url = call.getString("url");
        if (!isWeb(url)) {
            call.reject("only http(s) pages can be opened");
            return;
        }
        script = call.getString("script", "");
        topCss = call.getDouble("top", 0.0);
        bottomCss = call.getDouble("bottom", 0.0);
        getActivity().runOnUiThread(() -> {
            try {
                createView();
                layout();
                view.loadUrl(url);
                call.resolve();
            } catch (Exception e) {
                call.reject("could not open the browser: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void navigate(PluginCall call) {
        final String url = call.getString("url");
        if (!isWeb(url)) {
            call.reject("only http(s) pages can be opened");
            return;
        }
        getActivity().runOnUiThread(() -> {
            if (view != null) view.loadUrl(url);
            call.resolve();
        });
    }

    @PluginMethod
    public void back(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            boolean can = view != null && view.canGoBack();
            if (can) view.goBack();
            JSObject o = new JSObject();
            o.put("canGoBack", can);
            call.resolve(o);
        });
    }

    @PluginMethod
    public void close(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            destroyView();
            call.resolve();
        });
    }

    @PluginMethod
    public void show(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (view != null) view.setVisibility(View.VISIBLE);
            call.resolve();
        });
    }

    @PluginMethod
    public void hide(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (view != null) view.setVisibility(View.INVISIBLE);
            call.resolve();
        });
    }

    @PluginMethod
    public void setFrame(PluginCall call) {
        topCss = call.getDouble("top", topCss);
        bottomCss = call.getDouble("bottom", bottomCss);
        getActivity().runOnUiThread(() -> {
            layout();
            call.resolve();
        });
    }

    /** Hands an answer to the page: window.__pqDeliver(json), defined by the injected script. */
    @PluginMethod
    public void reply(PluginCall call) {
        final String json = call.getString("json", "");
        getActivity().runOnUiThread(() -> {
            if (view != null) view.evaluateJavascript("window.__pqDeliver(" + JSONObject.quote(json) + ")", null);
            call.resolve();
        });
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void createView() {
        destroyView();
        WebView wv = new WebView(getContext());
        WebSettings s = wv.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setSafeBrowsingEnabled(true);
        s.setSupportMultipleWindows(false);
        s.setGeolocationEnabled(false);
        wv.setBackgroundColor(Color.WHITE);
        wv.addJavascriptInterface(new Bridge(), "PqBridge");
        startScriptSupported = WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT);
        if (startScriptSupported) WebViewCompat.addDocumentStartJavaScript(wv, script, Collections.singleton("*"));
        wv.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                return !isWeb(req.getUrl().toString()); // anything but http(s) is dropped
            }

            @Override
            public void onPageStarted(WebView v, String url, Bitmap favicon) {
                if (!startScriptSupported) v.evaluateJavascript(script, null); // late, but before most page code on old WebViews
                notifyNav(v, url);
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                notifyNav(v, url);
            }
        });
        ViewGroup content = getActivity().findViewById(android.R.id.content);
        content.addView(wv, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        view = wv;
    }

    /** Places the view between the insets, measured from the app WebView's own position in the window. */
    private void layout() {
        if (view == null) return;
        float density = getContext().getResources().getDisplayMetrics().density;
        View app = getBridge().getWebView();
        ViewGroup content = getActivity().findViewById(android.R.id.content);
        int[] a = new int[2];
        int[] c = new int[2];
        app.getLocationInWindow(a);
        content.getLocationInWindow(c);
        int offsetY = a[1] - c[1];
        int top = offsetY + Math.round((float) topCss * density);
        int bottom = (content.getHeight() - (offsetY + app.getHeight())) + Math.round((float) bottomCss * density);
        FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) view.getLayoutParams();
        lp.topMargin = Math.max(0, top);
        lp.bottomMargin = Math.max(0, bottom);
        view.setLayoutParams(lp);
    }

    private void destroyView() {
        if (view == null) return;
        ViewGroup parent = (ViewGroup) view.getParent();
        if (parent != null) parent.removeView(view);
        view.removeJavascriptInterface("PqBridge");
        view.loadUrl("about:blank");
        view.destroy();
        view = null;
        notifyListeners("closed", new JSObject());
    }

    private void notifyNav(WebView v, String url) {
        JSObject o = new JSObject();
        o.put("url", url == null ? "" : url);
        o.put("title", v.getTitle() == null ? "" : v.getTitle());
        o.put("canGoBack", v.canGoBack());
        notifyListeners("navigation", o);
    }

    /** What the page may call: one method, one JSON string. */
    private class Bridge {
        @JavascriptInterface
        public void postMessage(String json) {
            JSObject o = new JSObject();
            o.put("json", json == null ? "" : json);
            notifyListeners("message", o);
        }
    }
}
