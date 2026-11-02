package app.claudetop;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Back after a restart or an update: keep following the PC. */
public final class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        ClaudeService.start(context);
    }
}
