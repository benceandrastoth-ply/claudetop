package app.claudetop;

import android.content.Context;
import android.content.SharedPreferences;

/** Everything the app remembers: the paired PC and the settings. */
final class Prefs {
    private final SharedPreferences p;

    Prefs(Context c) {
        p = c.getApplicationContext().getSharedPreferences("claudetop", Context.MODE_PRIVATE);
    }

    // ---- the paired PC ----
    String host() { return p.getString("host", null); }
    int port() { return p.getInt("port", 47047); }
    String token() { return p.getString("token", null); }
    String pcId() { return p.getString("pcId", null); }
    String pcName() { return p.getString("pcName", "your PC"); }
    boolean paired() { return token() != null && host() != null; }

    void pair(String host, int port, String token, String pcId, String pcName) {
        p.edit().putString("host", host).putInt("port", port).putString("token", token)
                .putString("pcId", pcId).putString("pcName", pcName).apply();
    }

    void moveHost(String host, int port) {
        p.edit().putString("host", host).putInt("port", port).apply();
    }

    void unpair() {
        p.edit().remove("host").remove("token").remove("pcId").remove("pcName").apply();
    }

    // ---- settings ----
    boolean overlay() { return p.getBoolean("overlay", true); }
    void overlay(boolean on) { p.edit().putBoolean("overlay", on).apply(); }

    boolean notifications() { return p.getBoolean("notify", true); }
    void notifications(boolean on) { p.edit().putBoolean("notify", on).apply(); }

    /** The 8-bit jingles from the floating Claude (notifications have their own sound). */
    boolean sounds() { return p.getBoolean("sounds", false); }
    void sounds(boolean on) { p.edit().putBoolean("sounds", on).apply(); }

    String hat() { return p.getString("hat", "none"); }
    void hat(String hat) { p.edit().putString("hat", hat).apply(); }

    float lastX() { return p.getFloat("lastX", -1); }
    void lastX(float x) { p.edit().putFloat("lastX", x).apply(); }
}
