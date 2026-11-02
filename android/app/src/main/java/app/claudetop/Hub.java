package app.claudetop;

import android.os.Handler;
import android.os.Looper;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * What's going on, for everything in the app: the PC's sessions, the connection, and the bits
 * of config that aren't saved. Only touched on the main thread.
 */
final class Hub {
    enum Link { NOT_PAIRED, CONNECTING, CONNECTED, OFFLINE, FORGOTTEN }

    interface Listener {
        /** sessions, focus, preview or acknowledgement changed */
        default void onState() {}
        /** the connection changed */
        default void onLink() {}
        /** a setting changed (hat, sounds...) */
        default void onSettings() {}
        /** whether the app's own screen is in front */
        default void onAppVisible() {}
    }

    static final Handler main = new Handler(Looper.getMainLooper());
    private static final List<Listener> listeners = new ArrayList<>();

    static JSONArray sessions = new JSONArray();
    static JSONObject focus = new JSONObject();
    static Link link = Link.NOT_PAIRED;
    static String linkDetail = "";
    static String preview = null; // "working", "waiting"... or null to follow the PC
    static boolean appVisible = false;

    /** Until then you've "looked" at Claude Code: a tap on Claude counts as seeing a "done". */
    static long seenUntil = 0;
    static final long SEEN_MS = 8000;

    static void add(Listener l) { if (!listeners.contains(l)) listeners.add(l); }
    static void remove(Listener l) { listeners.remove(l); }

    private static void each(java.util.function.Consumer<Listener> fn) {
        for (Listener l : new ArrayList<>(listeners)) fn.accept(l);
    }

    static void setSnapshot(JSONArray s, JSONObject f) {
        sessions = s;
        focus = f;
        each(Listener::onState);
    }

    static void setLink(Link l, String detail) {
        link = l;
        linkDetail = detail == null ? "" : detail;
        each(Listener::onLink);
    }

    static void setPreview(String state) {
        preview = state;
        each(Listener::onState);
    }

    static void settingsChanged() { each(Listener::onSettings); }

    static void setAppVisible(boolean visible) {
        appVisible = visible;
        each(Listener::onAppVisible);
    }

    /**
     * Finishes you've already seen (session id + time), so a Claude that starts later (the app
     * opening, the overlay coming back) doesn't shout "Done!" about them again.
     */
    private static final java.util.Set<String> seenFinishes = new java.util.HashSet<>();

    private static String key(JSONObject s) {
        return s.optString("id") + "@" + s.optLong("at");
    }

    /** Mark these sessions' finishes as seen. */
    static void markSeen(JSONArray list) {
        for (int i = 0; i < list.length(); i++) {
            JSONObject s = list.optJSONObject(i);
            if (s == null) continue;
            String st = s.optString("state");
            if (st.equals("done") || st.equals("error")) seenFinishes.add(key(s));
        }
    }

    /** Tapped Claude: you've seen it. */
    static void seen() {
        seenUntil = System.currentTimeMillis() + SEEN_MS;
        each(Listener::onState);
        main.postDelayed(() -> {
            markSeen(sessions);
            each(Listener::onState);
        }, SEEN_MS + 50);
    }

    /** The sessions the page sees: finishes you've seen count as idle. */
    static JSONArray shownSessions() {
        if (seenFinishes.isEmpty()) return sessions;
        JSONArray out = new JSONArray();
        for (int i = 0; i < sessions.length(); i++) {
            JSONObject s = sessions.optJSONObject(i);
            if (s != null && seenFinishes.contains(key(s))) {
                try {
                    s = new JSONObject(s.toString()).put("state", "idle");
                } catch (Exception ignored) {}
            }
            out.put(s);
        }
        return out;
    }

    /** The focus the page sees: the PC's, or "can't tell" (counts as looking) right after a tap. */
    static JSONObject shownFocus() {
        if (System.currentTimeMillis() < seenUntil) {
            try {
                return new JSONObject().put("pid", 0).put("name", "").put("title", "").put("available", false);
            } catch (Exception e) {
                return new JSONObject();
            }
        }
        return focus;
    }
}
