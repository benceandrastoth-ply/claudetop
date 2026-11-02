package app.claudetop;

import android.annotation.SuppressLint;
import android.content.Context;
import android.content.Intent;
import android.graphics.PixelFormat;
import android.hardware.input.InputManager;
import android.os.Build;
import android.provider.Settings;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.FrameLayout;

/**
 * The little Claude floating over other apps, along the bottom of the screen.
 *
 * Two windows: a strip the width of the screen that shows Claude but lets every touch through
 * (Android only lets touches pass through a see-through enough overlay, hence the alpha), and a
 * small invisible window that follows Claude and hands its touches to the strip.
 */
final class Overlay implements ClaudeWeb.Host, Hub.Listener {
    private static final int STRIP_DP = 340; // room above Claude for the session list
    private static final int TOUCH_PAD_DP = 6;

    private final Context context;
    private final WindowManager wm;
    private final Prefs prefs;
    private final float density;
    private ClaudeWeb claude;
    private FrameLayout strip;
    private View touch;
    private WindowManager.LayoutParams touchParams;
    private boolean shown;

    Overlay(Context context, Prefs prefs) {
        this.context = context;
        this.prefs = prefs;
        this.wm = (WindowManager) context.getSystemService(Context.WINDOW_SERVICE);
        this.density = context.getResources().getDisplayMetrics().density;
    }

    static boolean allowed(Context c) {
        return Settings.canDrawOverlays(c);
    }

    boolean isShown() {
        return shown;
    }

    @SuppressLint("ClickableViewAccessibility")
    void show() {
        if (shown || !allowed(context)) return;
        shown = true;
        claude = new ClaudeWeb(context, prefs, true, this);

        strip = new FrameLayout(context);
        strip.addView(claude.web, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        WindowManager.LayoutParams sp = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.MATCH_PARENT, Math.round(STRIP_DP * density),
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                        | WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
                PixelFormat.TRANSLUCENT);
        sp.gravity = Gravity.BOTTOM | Gravity.START;
        sp.setTitle("claudetop");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            // Android 12+ blocks touches through overlays more opaque than this.
            InputManager im = (InputManager) context.getSystemService(Context.INPUT_SERVICE);
            sp.alpha = Math.min(1f, im.getMaximumObscuringOpacityForTouch());
        }
        wm.addView(strip, sp);

        touch = new View(context);
        touch.setOnTouchListener((v, e) -> forward(e));
        touchParams = new WindowManager.LayoutParams(
                1, 1,
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
                PixelFormat.TRANSPARENT);
        touchParams.gravity = Gravity.TOP | Gravity.START;
        touchParams.setTitle("claudetop touch");
        wm.addView(touch, touchParams);

        Hub.add(this);
        onAppVisible();
    }

    void hide() {
        if (!shown) return;
        shown = false;
        Hub.remove(this);
        try { wm.removeView(touch); } catch (Exception ignored) {}
        try { wm.removeView(strip); } catch (Exception ignored) {}
        claude.destroy();
        claude = null;
        strip = null;
        touch = null;
    }

    /** The app's own screen has its own Claude: step aside while it's open. */
    @Override
    public void onAppVisible() {
        if (!shown) return;
        int v = Hub.appVisible ? View.GONE : View.VISIBLE;
        strip.setVisibility(v);
        touch.setVisibility(v);
    }

    // A touch on Claude: the same touch, in the strip's coordinates.
    private boolean forward(MotionEvent e) {
        if (strip == null) return false;
        int[] at = new int[2];
        claude.web.getLocationOnScreen(at);
        MotionEvent copy = MotionEvent.obtain(e);
        copy.setLocation(e.getRawX() - at[0], e.getRawY() - at[1]);
        claude.web.dispatchTouchEvent(copy);
        copy.recycle();
        return true;
    }

    // The page says where Claude is (in dp, within the strip): put the touch window over it.
    @Override
    public void onClaudeRect(float x, float y, float w, float h) {
        if (!shown || touch == null) return;
        int[] at = new int[2];
        claude.web.getLocationOnScreen(at);
        float pad = TOUCH_PAD_DP * density;
        int left = Math.round(at[0] + x * density - pad);
        int top = Math.round(at[1] + y * density - pad);
        int width = Math.round(w * density + 2 * pad);
        int height = Math.round(h * density + 2 * pad);
        // Window positions are relative to the area overlays may use, not the whole screen.
        int[] origin = new int[2];
        touch.getLocationOnScreen(origin);
        int baseX = origin[0] - touchParams.x, baseY = origin[1] - touchParams.y;
        left -= baseX;
        top -= baseY;
        if (Math.abs(left - touchParams.x) < 2 && Math.abs(top - touchParams.y) < 2
                && width == touchParams.width && height == touchParams.height) return;
        touchParams.x = left;
        touchParams.y = top;
        touchParams.width = width;
        touchParams.height = height;
        try { wm.updateViewLayout(touch, touchParams); } catch (Exception ignored) {}
    }

    @Override
    public void onMenu() {
        Intent i = new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(i);
    }
}
