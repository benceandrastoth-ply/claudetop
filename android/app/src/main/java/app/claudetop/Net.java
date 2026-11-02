package app.claudetop;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Finding PCs running claudetop on the Wi-Fi, and pairing with one. Blocking: call off the main thread. */
final class Net {
    static final int HTTP_PORT = 47047;
    static final int DISCOVERY_PORT = 47048;

    static final class Pc {
        final String id, name, host;
        final int port;
        final boolean pairing;

        Pc(String id, String name, String host, int port, boolean pairing) {
            this.id = id;
            this.name = name;
            this.host = host;
            this.port = port;
            this.pairing = pairing;
        }
    }

    /** Ask the whole network "claudetop?" and collect who answers within the time. */
    static List<Pc> discover(int waitMs) {
        Map<String, Pc> found = new LinkedHashMap<>();
        try (DatagramSocket socket = new DatagramSocket()) {
            socket.setBroadcast(true);
            byte[] ask = "claudetop?".getBytes(StandardCharsets.UTF_8);
            for (InetAddress to : broadcastAddresses()) {
                try {
                    socket.send(new DatagramPacket(ask, ask.length, to, DISCOVERY_PORT));
                } catch (Exception ignored) {}
            }
            long end = System.currentTimeMillis() + waitMs;
            byte[] buf = new byte[2048];
            while (true) {
                long left = end - System.currentTimeMillis();
                if (left <= 0) break;
                socket.setSoTimeout((int) left);
                DatagramPacket packet = new DatagramPacket(buf, buf.length);
                try {
                    socket.receive(packet);
                } catch (SocketTimeoutException e) {
                    break;
                }
                try {
                    JSONObject o = new JSONObject(new String(packet.getData(), 0, packet.getLength(), StandardCharsets.UTF_8));
                    if (!"claudetop".equals(o.optString("app"))) continue;
                    String id = o.optString("id");
                    found.put(id, new Pc(id, o.optString("name", "PC"), packet.getAddress().getHostAddress(),
                            o.optInt("port", HTTP_PORT), o.optBoolean("pairing")));
                } catch (Exception ignored) {}
            }
        } catch (Exception ignored) {}
        return new ArrayList<>(found.values());
    }

    private static List<InetAddress> broadcastAddresses() {
        List<InetAddress> out = new ArrayList<>();
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InterfaceAddress a : ni.getInterfaceAddresses()) {
                    if (a.getBroadcast() != null) out.add(a.getBroadcast());
                }
            }
        } catch (Exception ignored) {}
        try {
            out.add(InetAddress.getByName("255.255.255.255"));
        } catch (Exception ignored) {}
        return out;
    }

    /** A PC typed in by hand: is claudetop there? */
    static Pc hello(String host, int port) throws Exception {
        JSONObject o = new JSONObject(request("GET", host, port, "/hello", null, null));
        if (!"claudetop".equals(o.optString("app"))) throw new Exception("That isn't claudetop.");
        return new Pc(o.optString("id"), o.optString("name", host), host, port, o.optBoolean("pairing"));
    }

    static final class PairError extends Exception {
        PairError(String m) { super(m); }
    }

    /** Pair with the code shown on the PC; returns { token, id, name }. */
    static JSONObject pair(String host, int port, String code, String phoneName) throws Exception {
        JSONObject body = new JSONObject().put("code", code).put("name", phoneName);
        HttpURLConnection c = open(host, port, "/pair", null);
        c.setRequestMethod("POST");
        c.setDoOutput(true);
        c.setRequestProperty("Content-Type", "application/json");
        try (OutputStream out = c.getOutputStream()) {
            out.write(body.toString().getBytes(StandardCharsets.UTF_8));
        }
        int status = c.getResponseCode();
        String text = read(status < 400 ? c.getInputStream() : c.getErrorStream());
        c.disconnect();
        if (status == 200) return new JSONObject(text);
        String error = "";
        try { error = new JSONObject(text).optString("error"); } catch (Exception ignored) {}
        switch (error) {
            case "wrong-code": throw new PairError("That code isn't right. Check the one on your PC.");
            case "too-many-tries": throw new PairError("Too many wrong codes. Open \"Pair a phone…\" on the PC again.");
            case "not-pairing": throw new PairError("On the PC, open claudetop's menu → Android phone → Pair a phone… first.");
            default: throw new PairError("The PC said no (" + status + ").");
        }
    }

    static HttpURLConnection open(String host, int port, String path, String token) throws Exception {
        String h = host.contains(":") ? "[" + host + "]" : host;
        HttpURLConnection c = (HttpURLConnection) new URL("http://" + h + ":" + port + path).openConnection();
        c.setConnectTimeout(4000);
        c.setReadTimeout(6000);
        c.setUseCaches(false);
        if (token != null) c.setRequestProperty("Authorization", "Bearer " + token);
        return c;
    }

    private static String request(String method, String host, int port, String path, String token, String body) throws Exception {
        HttpURLConnection c = open(host, port, path, token);
        c.setRequestMethod(method);
        int status = c.getResponseCode();
        String text = read(status < 400 ? c.getInputStream() : c.getErrorStream());
        c.disconnect();
        if (status >= 400) throw new Exception("HTTP " + status);
        return text;
    }

    static String read(InputStream in) throws Exception {
        if (in == null) return "";
        try (InputStream s = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = s.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString("UTF-8");
        }
    }
}
