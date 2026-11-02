package app.claudetop;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.text.InputFilter;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.AdapterView;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.CompoundButton;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.Spinner;
import android.widget.Switch;
import android.widget.TextView;

import org.json.JSONObject;

import java.util.List;

/** The app's own screen: the little Claude, pairing with a PC, and the settings. */
public final class MainActivity extends Activity implements Hub.Listener {
    private static final int BG = 0xFF1F1E1D;
    private static final int CARD = 0xFF2B2A28;
    private static final int TEXT = 0xFFF0EEE6;
    private static final int MUTED = 0xFFA8A49A;
    private static final int ACCENT = 0xFFD97757;

    private static final String[][] HAT_NAMES = {
            {"none", "No hat"}, {"hard", "Hard hat"}, {"propeller", "Propeller beanie"},
            {"miner", "Miner hat (digs)"}, {"cowboy", "Cowboy hat (rides a horse)"},
            {"wizard", "Wizard hat (teleports)"}, {"pirate", "Pirate hat (sails a boat)"},
            {"astronaut", "Astronaut helmet"}, {"ninja", "Ninja headband (dashes)"},
            {"crown", "Crown"}, {"chef", "Chef hat (rolls on a meatball)"}, {"agent47", "Agent 47"},
    };
    private static final String[][] PREVIEWS = {
            {null, "Live (follow Claude Code)"}, {"working", "Working"}, {"waiting", "Needs you"},
            {"done", "Done"}, {"nocredit", "Out of credits"}, {"recharged", "Tokens are back"}, {"resting", "Resting"},
    };

    private Prefs prefs;
    private ClaudeWeb claude;
    private TextView status;
    private LinearLayout pairBox;
    private Switch overlaySwitch;
    private Spinner hatSpinner;
    private boolean searching;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        prefs = new Prefs(this);
        ClaudeService.createChannels(this);
        getWindow().setStatusBarColor(BG);
        getWindow().setNavigationBarColor(BG);

        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(BG);
        scroll.setFillViewport(true);
        LinearLayout page = new LinearLayout(this);
        page.setOrientation(LinearLayout.VERTICAL);
        page.setPadding(0, 0, 0, dp(24));
        scroll.addView(page);
        // Keep clear of the status and navigation bars (edge to edge on new Androids).
        scroll.setOnApplyWindowInsetsListener((v, insets) -> {
            v.setPadding(0, insets.getSystemWindowInsetTop(), 0, insets.getSystemWindowInsetBottom());
            return insets;
        });

        // The stage: Claude walks along its floor.
        FrameLayout stage = new FrameLayout(this);
        stage.setBackground(stageBackground());
        claude = new ClaudeWeb(this, prefs, false, new ClaudeWeb.Host() {});
        stage.addView(claude.web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        page.addView(stage, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(260)));

        LinearLayout body = new LinearLayout(this);
        body.setOrientation(LinearLayout.VERTICAL);
        body.setPadding(dp(20), dp(16), dp(20), 0);
        page.addView(body);

        TextView title = text("claudetop", 26, TEXT);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        body.addView(title);
        status = text("", 15, MUTED);
        status.setPadding(0, dp(4), 0, dp(12));
        body.addView(status);

        pairBox = card();
        body.addView(pairBox);

        LinearLayout settings = card();
        body.addView(settings);
        settings.addView(heading("Settings"));

        overlaySwitch = toggle(settings, "Float over other apps", "Claude walks along the bottom of your screen.", prefs.overlay(), (b, on) -> {
            prefs.overlay(on);
            if (on && !Overlay.allowed(this)) askOverlay();
            Hub.settingsChanged();
        });
        toggle(settings, "Notifications", "When Claude Code needs you or is done, unless you're at the PC looking at it.", prefs.notifications(), (b, on) -> {
            prefs.notifications(on);
            if (on) askNotifications();
        });
        toggle(settings, "8-bit sounds", "The little jingles, from the floating Claude.", prefs.sounds(), (b, on) -> {
            prefs.sounds(on);
            Hub.settingsChanged();
        });

        settings.addView(label("Hat"));
        hatSpinner = spinner(settings, names(HAT_NAMES), indexOf(HAT_NAMES, prefs.hat()), (i) -> {
            if (HAT_NAMES[i][0].equals(prefs.hat())) return;
            prefs.hat(HAT_NAMES[i][0]);
            Hub.settingsChanged();
        });
        settings.addView(label("Preview a state"));
        spinner(settings, names(PREVIEWS), indexOf(PREVIEWS, Hub.preview), (i) -> {
            String p = PREVIEWS[i][0];
            if (p == null ? Hub.preview != null : !p.equals(Hub.preview)) Hub.setPreview(p);
        });

        TextView help = text("Tap Claude after it says \"Done\" to tell it you've seen it, double-tap to pet it, "
                + "hold to see your sessions, drag or fling it around. Hold the floating Claude to get back here.", 13, MUTED);
        help.setPadding(dp(4), dp(16), dp(4), 0);
        body.addView(help);
        TextView version = text("Version " + versionName(), 12, MUTED);
        version.setPadding(dp(4), dp(8), dp(4), 0);
        body.addView(version);

        setContentView(scroll);
        Hub.add(this);
        renderPairing();
        ClaudeService.start(this);
    }

    @Override
    protected void onResume() {
        super.onResume();
        Hub.setAppVisible(true);
        // Back from the overlay settings screen?
        if (prefs.overlay() && !Overlay.allowed(this)) overlaySwitch.setChecked(false);
        Hub.settingsChanged();
        renderPairing();
    }

    @Override
    protected void onPause() {
        Hub.setAppVisible(false);
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        Hub.remove(this);
        claude.destroy();
        super.onDestroy();
    }

    // ---- Hub ----
    @Override
    public void onLink() {
        renderPairing();
    }

    @Override
    public void onSettings() {
        int i = indexOf(HAT_NAMES, prefs.hat());
        if (hatSpinner.getSelectedItemPosition() != i) hatSpinner.setSelection(i);
    }

    // ---- pairing ----
    private void renderPairing() {
        pairBox.removeAllViews();
        if (prefs.paired()) {
            status.setText(Hub.linkDetail.isEmpty() ? "Paired with " + prefs.pcName() : Hub.linkDetail);
            pairBox.addView(heading("Your PC"));
            pairBox.addView(text("Following " + prefs.pcName() + " (" + prefs.host() + ")", 15, TEXT));
            Button unpair = button("Unpair", false);
            unpair.setOnClickListener(v -> new AlertDialog.Builder(this)
                    .setMessage("Stop following " + prefs.pcName() + "?")
                    .setPositiveButton("Unpair", (d, w) -> {
                        prefs.unpair();
                        ClaudeService.stop(this);
                        Hub.setSnapshot(new org.json.JSONArray(), new JSONObject());
                        Hub.setLink(Hub.Link.NOT_PAIRED, null);
                        renderPairing();
                    })
                    .setNegativeButton("Cancel", null)
                    .show());
            pairBox.addView(unpair);
            return;
        }
        status.setText(Hub.link == Hub.Link.FORGOTTEN ? Hub.linkDetail : "Not paired with a PC yet");
        pairBox.addView(heading("Pair with your PC"));
        pairBox.addView(text("On the PC, right-click the little Claude (or its tray icon) → Android phone → "
                + "Pair a phone… Then pick the PC here and type in the code it shows. "
                + "Phone and PC need to be on the same Wi-Fi.", 15, TEXT));
        Button find = button(searching ? "Looking…" : "Look for my PC", true);
        find.setEnabled(!searching);
        find.setOnClickListener(v -> search());
        pairBox.addView(find);
        Button manual = button("Type in the address", false);
        manual.setOnClickListener(v -> askAddress());
        pairBox.addView(manual);
    }

    private void search() {
        askLocalNetwork();
        searching = true;
        renderPairing();
        ProgressBar spin = new ProgressBar(this);
        pairBox.addView(spin);
        new Thread(() -> {
            List<Net.Pc> pcs = Net.discover(2000);
            runOnUiThread(() -> {
                searching = false;
                renderPairing();
                if (pcs.isEmpty()) {
                    pairBox.addView(text("No PC answered. Is claudetop running on it, with \"Pair a phone…\" open? "
                            + "If Windows asked about the firewall, allow private networks. "
                            + "Or type in the address the PC shows.", 14, MUTED));
                    return;
                }
                for (Net.Pc pc : pcs) {
                    Button b = button(pc.name + "  ·  " + pc.host, true);
                    b.setOnClickListener(v -> askCode(pc));
                    pairBox.addView(b);
                }
            });
        }).start();
    }

    private void askAddress() {
        EditText input = new EditText(this);
        input.setHint("192.168.1.20:47047");
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        new AlertDialog.Builder(this)
                .setTitle("PC address")
                .setMessage("The address the PC shows in its \"Pair a phone\" window.")
                .setView(padded(input))
                .setPositiveButton("Next", (d, w) -> {
                    String s = input.getText().toString().trim().replaceFirst("^https?://", "").replaceAll("/.*$", "");
                    String host = s;
                    int port = Net.HTTP_PORT;
                    int colon = s.lastIndexOf(':');
                    if (colon > 0 && s.indexOf(':') == colon) {
                        host = s.substring(0, colon);
                        try { port = Integer.parseInt(s.substring(colon + 1)); } catch (NumberFormatException ignored) {}
                    }
                    final String h = host;
                    final int p = port;
                    askLocalNetwork();
                    new Thread(() -> {
                        try {
                            Net.Pc pc = Net.hello(h, p);
                            runOnUiThread(() -> askCode(pc));
                        } catch (Exception e) {
                            runOnUiThread(() -> alert("Couldn't reach claudetop at " + h + ":" + p + ". "
                                    + "Check the address, that claudetop is running and that the phone is on the same Wi-Fi."));
                        }
                    }).start();
                })
                .setNegativeButton("Cancel", null)
                .show();
    }

    private void askCode(Net.Pc pc) {
        EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_NUMBER);
        input.setFilters(new InputFilter[]{new InputFilter.LengthFilter(7)});
        input.setTextSize(TypedValue.COMPLEX_UNIT_SP, 26);
        input.setGravity(Gravity.CENTER);
        input.setHint("123456");
        new AlertDialog.Builder(this)
                .setTitle("Pair with " + pc.name)
                .setMessage("Type in the 6-digit code " + pc.name + " shows.")
                .setView(padded(input))
                .setPositiveButton("Pair", (d, w) -> {
                    String code = input.getText().toString().replaceAll("\\D", "");
                    new Thread(() -> {
                        try {
                            JSONObject r = Net.pair(pc.host, pc.port, code, phoneName());
                            prefs.pair(pc.host, pc.port, r.getString("token"), r.optString("id", pc.id), r.optString("name", pc.name));
                            runOnUiThread(() -> {
                                askNotifications();
                                if (prefs.overlay() && !Overlay.allowed(this)) askOverlay();
                                ClaudeService.start(this);
                                renderPairing();
                            });
                        } catch (Net.PairError e) {
                            runOnUiThread(() -> alert(e.getMessage()));
                        } catch (Exception e) {
                            runOnUiThread(() -> alert("Couldn't reach " + pc.name + ". Try again?"));
                        }
                    }).start();
                })
                .setNegativeButton("Cancel", null)
                .show();
    }

    private String phoneName() {
        String name = null;
        try { name = Settings.Global.getString(getContentResolver(), Settings.Global.DEVICE_NAME); } catch (Exception ignored) {}
        return name != null && !name.isEmpty() ? name : Build.MODEL;
    }

    // ---- permissions ----
    private void askNotifications() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
        }
    }

    private void askLocalNetwork() {
        String perm = "android.permission.ACCESS_LOCAL_NETWORK";
        if (Build.VERSION.SDK_INT >= 37 && checkSelfPermission(perm) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{perm}, 2);
        }
    }

    private void askOverlay() {
        new AlertDialog.Builder(this)
                .setTitle("Float over other apps")
                .setMessage("To walk along the bottom of your screen, claudetop needs Android's \"Display over other apps\" permission. "
                        + "Turn it on for claudetop on the next screen.")
                .setPositiveButton("Open settings", (d, w) -> startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                        Uri.parse("package:" + getPackageName()))))
                .setNegativeButton("Not now", (d, w) -> overlaySwitch.setChecked(false))
                .show();
    }

    // ---- little UI helpers ----
    private int dp(float v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    private TextView text(String s, float sp, int color) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color);
        t.setLineSpacing(0, 1.15f);
        return t;
    }

    private TextView heading(String s) {
        TextView t = text(s, 18, TEXT);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setPadding(0, 0, 0, dp(8));
        return t;
    }

    private TextView label(String s) {
        TextView t = text(s, 15, TEXT);
        t.setPadding(0, dp(14), 0, dp(2));
        return t;
    }

    private LinearLayout card() {
        LinearLayout c = new LinearLayout(this);
        c.setOrientation(LinearLayout.VERTICAL);
        c.setPadding(dp(16), dp(16), dp(16), dp(16));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(CARD);
        bg.setCornerRadius(dp(14));
        c.setBackground(bg);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.bottomMargin = dp(14);
        c.setLayoutParams(lp);
        return c;
    }

    private Button button(String s, boolean primary) {
        Button b = new Button(this);
        b.setText(s);
        b.setAllCaps(false);
        b.setTextColor(primary ? Color.WHITE : TEXT);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(primary ? ACCENT : 0xFF3A3936);
        bg.setCornerRadius(dp(10));
        b.setBackground(bg);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(48));
        lp.topMargin = dp(12);
        b.setLayoutParams(lp);
        return b;
    }

    private Switch toggle(LinearLayout parent, String title, String detail, boolean on, CompoundButton.OnCheckedChangeListener l) {
        Switch s = new Switch(this);
        s.setText(title);
        s.setTextColor(TEXT);
        s.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        int[][] states = {{android.R.attr.state_checked}, {}};
        s.setThumbTintList(new android.content.res.ColorStateList(states, new int[]{ACCENT, 0xFFBDB9B0}));
        s.setTrackTintList(new android.content.res.ColorStateList(states, new int[]{0x99D97757, 0xFF55524D}));
        s.setChecked(on);
        s.setOnCheckedChangeListener(l);
        s.setPadding(0, dp(10), 0, 0);
        parent.addView(s);
        TextView d = text(detail, 13, MUTED);
        d.setPadding(0, 0, dp(56), dp(4));
        parent.addView(d);
        return s;
    }

    private interface Pick { void at(int i); }

    private Spinner spinner(LinearLayout parent, String[] items, int selected, Pick pick) {
        Spinner sp = new Spinner(this, Spinner.MODE_DIALOG);
        ArrayAdapter<String> a = new ArrayAdapter<>(this, android.R.layout.simple_spinner_item, items);
        a.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
        sp.setAdapter(a);
        sp.setSelection(Math.max(0, selected));
        sp.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            @Override
            public void onItemSelected(AdapterView<?> p, View v, int i, long id) {
                if (v instanceof TextView) ((TextView) v).setTextColor(TEXT);
                pick.at(i);
            }

            @Override
            public void onNothingSelected(AdapterView<?> p) {}
        });
        parent.addView(sp);
        return sp;
    }

    private static String[] names(String[][] list) {
        String[] out = new String[list.length];
        for (int i = 0; i < list.length; i++) out[i] = list[i][1];
        return out;
    }

    private static int indexOf(String[][] list, String id) {
        for (int i = 0; i < list.length; i++) {
            if (id == null ? list[i][0] == null : id.equals(list[i][0])) return i;
        }
        return 0;
    }

    private View padded(View v) {
        FrameLayout f = new FrameLayout(this);
        f.setPadding(dp(22), dp(8), dp(22), 0);
        f.addView(v);
        return f;
    }

    private void alert(String message) {
        new AlertDialog.Builder(this).setMessage(message).setPositiveButton("OK", null).show();
    }

    private GradientDrawable stageBackground() {
        GradientDrawable g = new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, new int[]{0xFF2E2C2A, 0xFF1F1E1D});
        return g;
    }

    private String versionName() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "?";
        }
    }
}
