package com.aeroptt.radio

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.SystemClock
import android.util.Log

class GuardianWatchdogReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent?) {
        Log.d("GuardianWatchdog", "Watchdog event received: ${intent?.action}")

        val prefs = context.getSharedPreferences("AeroPTTPrefs", Context.MODE_PRIVATE)
        val role = prefs.getString("app_role", "")
        val childId = prefs.getString("child_id", "")
        val myCallsign = prefs.getString("my_callsign", "")

        if (Intent.ACTION_MY_PACKAGE_REPLACED == intent?.action) {
            Log.d("GuardianWatchdog", "Application update detected (MY_PACKAGE_REPLACED)!")
            prefs.edit()
                .putBoolean("app_just_updated", true)
                .putLong("update_timestamp", System.currentTimeMillis())
                .apply()
        }

        val serviceIntent = Intent(context, PTTForegroundService::class.java).apply {
            putExtra("force_foreground", true)
            if (Intent.ACTION_MY_PACKAGE_REPLACED == intent?.action) {
                putExtra("app_just_updated", true)
            }
            if (!role.isNullOrEmpty()) putExtra("app_role", role)
            if (!childId.isNullOrEmpty()) putExtra("child_id", childId)
            if (!myCallsign.isNullOrEmpty()) putExtra("my_callsign", myCallsign)
        }

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(serviceIntent)
            } else {
                context.startService(serviceIntent)
            }
        } catch (e: Exception) {
            Log.e("GuardianWatchdog", "Service startup error: ${e.message}")
        }

        // Schedule next repeating heartbeat
        scheduleNextWatchdog(context)
    }

    companion object {
        const val ACTION_HEARTBEAT = "com.aeroptt.radio.WATCHDOG_HEARTBEAT"
        const val ACTION_RESTART_NOW = "com.aeroptt.radio.ACTION_RESTART_NOW"

        fun triggerImmediateRestart(context: Context) {
            try {
                val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
                val intent = Intent(context, GuardianWatchdogReceiver::class.java).apply {
                    action = ACTION_RESTART_NOW
                }
                val pendingIntent = PendingIntent.getBroadcast(
                    context,
                    998,
                    intent,
                    PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0)
                )

                val triggerAt = SystemClock.elapsedRealtime() + 250L
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    alarmManager.setExactAndAllowWhileIdle(
                        AlarmManager.ELAPSED_REALTIME_WAKEUP,
                        triggerAt,
                        pendingIntent
                    )
                } else {
                    alarmManager.set(
                        AlarmManager.ELAPSED_REALTIME_WAKEUP,
                        triggerAt,
                        pendingIntent
                    )
                }
            } catch (e: Exception) {
                Log.e("GuardianWatchdog", "Immediate restart error: ${e.message}")
            }
        }

        fun scheduleNextWatchdog(context: Context) {
            try {
                val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
                val intent = Intent(context, GuardianWatchdogReceiver::class.java).apply {
                    action = ACTION_HEARTBEAT
                }
                val pendingIntent = PendingIntent.getBroadcast(
                    context,
                    999,
                    intent,
                    PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0)
                )

                // Trigger watchdog every 60 seconds
                val triggerAt = SystemClock.elapsedRealtime() + (60 * 1000L)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    alarmManager.setExactAndAllowWhileIdle(
                        AlarmManager.ELAPSED_REALTIME_WAKEUP,
                        triggerAt,
                        pendingIntent
                    )
                } else {
                    alarmManager.set(
                        AlarmManager.ELAPSED_REALTIME_WAKEUP,
                        triggerAt,
                        pendingIntent
                    )
                }
            } catch (e: Exception) {
                Log.e("GuardianWatchdog", "Schedule watchdog error: ${e.message}")
            }
        }
    }
}
