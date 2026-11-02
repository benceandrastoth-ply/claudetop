package app.claudetop;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.Color;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.util.Arrays;
import java.util.List;

/**
 * A WebView running the desktop app's little Claude (assets/claude, copied from ../src at build
 * time), with android-shim.js standing in for Electron. It follows the Hub.
 */
final class ClaudeWeb implements Hub.Listener {
    static final List<String> HATS = Arrays.asList(
            "none", "hard", "propeller", "miner", "cowboy", "wizard", "pirate", "astronaut", "ninja", "crown", "chef", "agent47");

    interface Host {
        /** Where Claude is, in page pixels (dp): x, y, width, height. */
        default void onClaudeRect(float x, float y, float w, float h) {}
        /** Long-press on Claude. */
        default void onMenu() {}
    }

    private static final String ORIGIN = "https://appassets.androidplatform.net/";

    final WebView web;
    private final Prefs prefs;
    private final boolean soundsAllowed;
    private final Host host;
    private boolean ready;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    ClaudeWeb(Context context, Prefs prefs, boolean soundsAllowed, Host host) {
        this.prefs = prefs;
        this.soundsAllowed = soundsAllowed;
        this.host = host;
        web = new WebView(context);
        web.setBackgroundColor(Color.TRANSPARENT);
        web.setVerticalScrollBarEnabled(false);
        web.setHorizontalScrollBarEnabled(false);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.setHapticFeedbackEnabled(false);
        web.setLongClickable(false);
        web.setOnLongClickListener(v -> true); // no text selection
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false); // the jingles
        s.setTextZoom(100); // the bubbles are laid out in px
        s.setSupportZoom(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        final Context app = context.getApplicationContext();
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (!url.startsWith(ORIGIN)) return new WebResourceResponse("text/plain", "utf-8", null);
                String path = request.getUrl().getPath();
                if (path == null) return null;
                path = path.substring(1);
                try {
                    InputStream in = app.getAssets().open(path);
                    return new WebResourceResponse(mime(path), "utf-8", in);
                } catch (Exception e) {
                    return new WebResourceResponse("text/plain", "utf-8", 404, "Not found", null, null);
                }
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return true; // the page never navigates anywhere
            }
        });
        web.addJavascriptInterface(new Bridge(), "ClaudetopAndroid");
        web.loadUrl(ORIGIN + "claude/index.html");
        Hub.add(this);
    }

    private static String mime(String path) {
        if (path.endsWith(".html")) return "text/html";
        if (path.endsWith(".js")) return "application/javascript";
        if (path.endsWith(".css")) return "text/css";
        if (path.endsWith(".svg")) return "image/svg+xml";
        return "application/octet-stream";
    }

    void destroy() {
        Hub.remove(this);
        web.destroy();
    }

    // ---- Hub -> page ----
    @Override
    public void onState() {
        pushState();
    }

    @Override
    public void onSettings() {
        pushConfig();
    }

    private void emit(String event, String json) {
        if (!ready) return;
        web.evaluateJavascript("window.__claudetop&&__claudetop.emit('" + event + "'," + json + ")", null);
    }

    private void pushConfig() {
        try {
            JSONObject c = new JSONObject()
                    .put("mode", "walk")
                    .put("fixedX", JSONObject.NULL)
                    .put("lastX", prefs.lastX() >= 0 ? prefs.lastX() : JSONObject.NULL)
                    .put("hat", prefs.hat())
                    .put("sounds", soundsAllowed && prefs.sounds())
                    .put("soundsSnoozedUntil", 0)
                    .put("dnd", false)
                    .put("dndCalls", false)
                    .put("micInUse", false)
                    .put("seasonal", true)
                    .put("panicWhenDone", false)
                    .put("roam", false)
                    .put("dance", "off")
                    .put("tv", false)
                    .put("jealous", false)
                    .put("hitmanAuto", false)
                    .put("hitmanRunning", false)
                    .put("gameMode", false)
                    .put("lockIn", false)
                    .put("displayId", JSONObject.NULL)
                    .put("birthday", JSONObject.NULL)
                    .put("preview", Hub.preview != null ? Hub.preview : JSONObject.NULL);
            emit("config", c.toString());
        } catch (Exception ignored) {}
    }

    private String lastPreview = null;

    private void pushState() {
        // A preview lives in the config.
        String p = Hub.preview;
        if (p == null ? lastPreview != null : !p.equals(lastPreview)) {
            lastPreview = p;
            pushConfig();
        }
        JSONArray sessions = Hub.shownSessions();
        emit("focus", Hub.shownFocus().toString());
        emit("sessions", sessions.toString());
    }

    // ---- page -> app ----
    private final class Bridge {
        @JavascriptInterface
        public void ready() {
            Hub.main.post(() -> {
                ready = true;
                lastPreview = Hub.preview;
                pushConfig();
                pushState();
            });
        }

        @JavascriptInterface
        public void claudeRect(String json) {
            try {
                JSONArray rects = new JSONArray(json);
                if (rects.length() == 0) return;
                JSONObject r = rects.getJSONObject(0);
                float x = (float) r.getDouble("x"), y = (float) r.getDouble("y");
                float w = (float) r.getDouble("w"), h = (float) r.getDouble("h");
                Hub.main.post(() -> host.onClaudeRect(x, y, w, h));
            } catch (Exception ignored) {}
        }

        @JavascriptInterface
        public void setLastX(double x) {
            prefs.lastX((float) x);
        }

        @JavascriptInterface
        public void cycleHat(int step) {
            Hub.main.post(() -> {
                int i = Math.max(0, HATS.indexOf(prefs.hat()));
                prefs.hat(HATS.get((i + (step > 0 ? 1 : -1) + HATS.size()) % HATS.size()));
                Hub.settingsChanged();
            });
        }

        @JavascriptInterface
        public void jumpTo() {
            Hub.main.post(Hub::seen);
        }

        @JavascriptInterface
        public void showMenu() {
            Hub.main.post(host::onMenu);
        }
    }
}
