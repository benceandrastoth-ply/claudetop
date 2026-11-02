package app.claudetop;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;
import java.util.List;

/**
 * Keeps following the paired PC's /events stream, reconnecting as needed. If the PC's address
 * changed (a new Wi-Fi lease), it finds it again by its id.
 */
final class PcLink {
    private final Prefs prefs;
    private Thread thread;
    private volatile boolean running;
    private volatile HttpURLConnection current;

    PcLink(Prefs prefs) {
        this.prefs = prefs;
    }

    synchronized void start() {
        if (running) return;
        running = true;
        thread = new Thread(this::loop, "claudetop-link");
        thread.start();
    }

    synchronized void stop() {
        running = false;
        HttpURLConnection c = current;
        if (c != null) c.disconnect();
        if (thread != null) thread.interrupt();
        thread = null;
    }

    /** Drop the connection and try again now (the network changed). */
    void kick() {
        HttpURLConnection c = current;
        if (c != null) c.disconnect();
        Thread t = thread;
        if (t != null) t.interrupt();
    }

    private void status(Hub.Link link, String detail) {
        Hub.main.post(() -> Hub.setLink(link, detail));
    }

    private void loop() {
        int failures = 0;
        while (running) {
            if (!prefs.paired()) {
                status(Hub.Link.NOT_PAIRED, null);
                return;
            }
            if (failures > 0) status(Hub.Link.OFFLINE, "Can't reach " + prefs.pcName() + ". Is it on, with claudetop running?");
            else status(Hub.Link.CONNECTING, "Connecting to " + prefs.pcName() + "…");
            try {
                follow();
                failures = 0;
            } catch (Forgotten e) {
                status(Hub.Link.FORGOTTEN, prefs.pcName() + " doesn't know this phone any more. Pair again.");
                running = false;
                return;
            } catch (Exception e) {
                failures++;
            }
            if (!running) return;
            // Every few failures, look for the PC in case its address changed.
            if (failures % 3 == 0) relocate();
            long wait = Math.min(30000, 1000L * (1 << Math.min(failures, 5)));
            try {
                Thread.sleep(wait);
            } catch (InterruptedException e) {
                // kicked: try right away
            }
        }
    }

    private static final class Forgotten extends Exception {}

    private void follow() throws Exception {
        HttpURLConnection c = Net.open(prefs.host(), prefs.port(), "/events", prefs.token());
        c.setReadTimeout(60000); // the PC pings every 20s
        current = c;
        try {
            int code = c.getResponseCode();
            if (code == 401) throw new Forgotten();
            if (code != 200) throw new Exception("HTTP " + code);
            status(Hub.Link.CONNECTED, "Connected to " + prefs.pcName());
            BufferedReader in = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8));
            StringBuilder data = new StringBuilder();
            String line;
            while (running && (line = in.readLine()) != null) {
                if (line.isEmpty()) {
                    if (data.length() > 0) deliver(data.toString());
                    data.setLength(0);
                } else if (line.startsWith("data:")) {
                    data.append(line.substring(5).trim());
                }
            }
            throw new Exception("closed");
        } finally {
            current = null;
            c.disconnect();
        }
    }

    private void deliver(String json) {
        try {
            JSONObject o = new JSONObject(json);
            JSONArray sessions = o.optJSONArray("sessions");
            JSONObject focus = o.optJSONObject("focus");
            Hub.main.post(() -> Hub.setSnapshot(sessions != null ? sessions : new JSONArray(), focus != null ? focus : new JSONObject()));
        } catch (Exception ignored) {}
    }

    private void relocate() {
        String id = prefs.pcId();
        if (id == null) return;
        List<Net.Pc> pcs = Net.discover(1500);
        for (Net.Pc pc : pcs) {
            if (id.equals(pc.id) && (!pc.host.equals(prefs.host()) || pc.port != prefs.port())) {
                prefs.moveHost(pc.host, pc.port);
                return;
            }
        }
    }
}
