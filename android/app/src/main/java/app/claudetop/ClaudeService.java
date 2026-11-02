package app.claudetop;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.ConnectivityManager;
import android.net.Network;
import android.os.Build;
import android.os.IBinder;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/**
 * Runs while a PC is paired: follows it, shows the floating Claude, and sends a notification
 * when Claude Code needs you or is done (unless you're at the PC looking at it).
 */
public final class ClaudeService extends Service implements Hub.Listener {
    private static final String CH_RUNNING = "running";
    private static final String CH_ALERTS = "alerts";
    private static final int ID_RUNNING = 1;

    private Prefs prefs;
    private PcLink link;
    private Overlay overlay;
    private NotificationManager nm;
    private ConnectivityManager.NetworkCallback netCallback;
    private final Map<String, String> lastStates = new HashMap<>();
    private boolean haveSnapshot;

    static void start(Context c) {
        Prefs p = new Prefs(c);
        if (!p.paired()) return;
        try {
            c.startForegroundService(new Intent(c, ClaudeService.class));
        } catch (Exception ignored) {
            // Not allowed from the background right now; the app starts it when opened.
        }
    }

    static void stop(Context c) {
        c.stopService(new Intent(c, ClaudeService.class));
    }


    @Override
    public void onCreate() {
        super.onCreate();
        prefs = new Prefs(this);
        nm = getSystemService(NotificationManager.class);
        createChannels(this);
        goForeground();
        link = new PcLink(prefs);
        link.start();
        overlay = new Overlay(this, prefs);
        Hub.add(this);
        // Back on Wi-Fi: reconnect now instead of waiting out the back-off.
        ConnectivityManager cm = getSystemService(ConnectivityManager.class);
        netCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                link.kick();
            }
        };
        try { cm.registerDefaultNetworkCallback(netCallback); } catch (Exception ignored) {}
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (!prefs.paired()) {
            stopSelf();
            return START_NOT_STICKY;
        }
        goForeground();
        link.start();
        if (prefs.overlay() && Overlay.allowed(this)) overlay.show();
        else overlay.hide();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        Hub.remove(this);
        link.stop();
        overlay.hide();
        try { getSystemService(ConnectivityManager.class).unregisterNetworkCallback(netCallback); } catch (Exception ignored) {}
        Hub.setLink(Hub.Link.NOT_PAIRED, null);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    static void createChannels(Context c) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        NotificationChannel running = new NotificationChannel(CH_RUNNING, "Connection to your PC", NotificationManager.IMPORTANCE_MIN);
        running.setDescription("Shown while claudetop follows your PC");
        running.setShowBadge(false);
        nm.createNotificationChannel(running);
        NotificationChannel alerts = new NotificationChannel(CH_ALERTS, "Claude Code", NotificationManager.IMPORTANCE_HIGH);
        alerts.setDescription("When Claude Code needs you or is done");
        nm.createNotificationChannel(alerts);
    }

    private PendingIntent openApp() {
        Intent i = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(this, 0, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private Notification runningNotification() {
        String text = Hub.linkDetail.isEmpty() ? "Following " + prefs.pcName() : Hub.linkDetail;
        return new Notification.Builder(this, CH_RUNNING)
                .setSmallIcon(R.drawable.ic_notify)
                .setContentTitle(statusLine())
                .setContentText(text)
                .setContentIntent(openApp())
                .setOngoing(true)
                .setShowWhen(false)
                .build();
    }

    private void goForeground() {
        Notification n = runningNotification();
        if (Build.VERSION.SDK_INT >= 34) startForeground(ID_RUNNING, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(ID_RUNNING, n);
    }

    // ---- Hub ----
    @Override
    public void onLink() {
        nm.notify(ID_RUNNING, runningNotification());
        if (Hub.link == Hub.Link.FORGOTTEN) {
            prefs.unpair();
            stopSelf();
        }
    }

    @Override
    public void onState() {
        nm.notify(ID_RUNNING, runningNotification());
        checkAlerts();
    }

    @Override
    public void onSettings() {
        if (prefs.overlay() && Overlay.allowed(this)) overlay.show();
        else overlay.hide();
    }

    private String statusLine() {
        if (Hub.link != Hub.Link.CONNECTED) return "claudetop";
        String best = "resting";
        long now = System.currentTimeMillis();
        for (int i = 0; i < Hub.sessions.length(); i++) {
            JSONObject s = Hub.sessions.optJSONObject(i);
            if (s == null) continue;
            String st = s.optString("state");
            boolean fresh = now - s.optLong("at") < 30 * 60 * 1000L;
            if (fresh && st.equals("waiting")) return "Claude needs you";
            if (fresh && st.equals("working")) best = "working";
        }
        return best.equals("working") ? "Claude is working…" : "Claude is resting";
    }

    // ---- notifications ----
    private static String project(JSONObject s) {
        String cwd = s.optString("cwd", "");
        String[] parts = cwd.split("[\\\\/]");
        for (int i = parts.length - 1; i >= 0; i--) if (!parts[i].isEmpty()) return parts[i];
        return "Claude Code";
    }

    /** Is the window in front on the PC the one this session runs in? (Like the page's isFocused.) */
    private static boolean lookingAt(JSONObject s, JSONObject focus) {
        if (focus.optBoolean("available", true) == false) return false;
        int pid = focus.optInt("pid");
        JSONArray chain = s.optJSONArray("chain");
        if (chain != null && pid > 0) {
            for (int i = 0; i < chain.length(); i++) {
                String entry = chain.optString(i);
                int colon = entry.indexOf(':');
                try {
                    if (Integer.parseInt(colon > 0 ? entry.substring(0, colon) : entry) == pid) return true;
                } catch (NumberFormatException ignored) {}
            }
        }
        // The PC only sends titles that look like Claude Code's.
        return !focus.optString("title").isEmpty();
    }

    private void checkAlerts() {
        JSONArray sessions = Hub.sessions;
        long now = System.currentTimeMillis();
        Set<String> alive = new HashSet<>();
        for (int i = 0; i < sessions.length(); i++) {
            JSONObject s = sessions.optJSONObject(i);
            if (s == null) continue;
            String id = s.optString("id");
            String state = s.optString("state");
            alive.add(id);
            // Looking at it on the PC: that finish has been seen, here too.
            if (lookingAt(s, Hub.focus)) Hub.markSeen(new JSONArray().put(s));
            String before = lastStates.put(id, state);
            if (state.equals(before)) continue;
            int nid = 1000 + (id.hashCode() & 0xffff);
            if (!state.equals("waiting") && "waiting".equals(before)) nm.cancel(nid);
            // The first snapshot after connecting is just how things are, not news.
            if (!haveSnapshot || !prefs.notifications()) continue;
            if (now - s.optLong("at") > 5 * 60 * 1000L) continue;
            if (lookingAt(s, Hub.focus)) continue;
            String title, text;
            switch (state) {
                case "waiting":
                    title = "Claude needs you";
                    text = project(s) + " is waiting for a permission or an answer.";
                    break;
                case "done":
                    title = "Done! ✓";
                    text = project(s) + " finished.";
                    break;
                case "nocredit":
                    title = "Out of credits 🪫";
                    text = project(s) + " hit a usage limit.";
                    break;
                case "error":
                    title = "Something went wrong";
                    text = project(s) + " stopped with an error.";
                    break;
                default:
                    continue;
            }
            nm.notify(nid, new Notification.Builder(this, CH_ALERTS)
                    .setSmallIcon(R.drawable.ic_notify)
                    .setColor(0xFFD97757)
                    .setContentTitle(title)
                    .setContentText(text)
                    .setSubText(prefs.pcName())
                    .setContentIntent(openApp())
                    .setAutoCancel(true)
                    .setCategory(state.equals("waiting") ? Notification.CATEGORY_REMINDER : Notification.CATEGORY_STATUS)
                    .build());
        }
        lastStates.keySet().retainAll(alive);
        if (Hub.link == Hub.Link.CONNECTED) haveSnapshot = true;
    }
}
