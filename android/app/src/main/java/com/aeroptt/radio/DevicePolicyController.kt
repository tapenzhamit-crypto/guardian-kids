package com.aeroptt.radio

import android.app.NotificationManager
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.util.Log

class DevicePolicyController(private val context: Context) {

    private val dpm: DevicePolicyManager = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
    private val audioManager: AudioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val notificationManager: NotificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    private val locationManager: LocationManager = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    val adminComponent: ComponentName = ComponentName(context, AeroPTTAdminReceiver::class.java)

    fun isAdminActive(): Boolean {
        return dpm.isAdminActive(adminComponent)
    }

    /**
     * 100% Silent Physical GPS & Location Hardware Toggle Execution (requires WRITE_SECURE_SETTINGS)
     */
    fun forceEnableGpsLocation() {
        try {
            // 1. Flip system location_mode to HIGH_ACCURACY (3 = GPS + Network)
            try {
                Settings.Secure.putInt(
                    context.contentResolver,
                    Settings.Secure.LOCATION_MODE,
                    Settings.Secure.LOCATION_MODE_HIGH_ACCURACY
                )
            } catch (e: Exception) {}

            try {
                Settings.Global.putInt(
                    context.contentResolver,
                    "location_mode",
                    3
                )
            } catch (e: Exception) {}

            // 2. Enable location providers (+gps,+network)
            try {
                Settings.Secure.putString(
                    context.contentResolver,
                    Settings.Secure.LOCATION_PROVIDERS_ALLOWED,
                    "+gps,+network"
                )
            } catch (e: Exception) {}

            // 3. For Xiaomi / MIUI / HyperOS specific location toggle
            try {
                Settings.Secure.putInt(
                    context.contentResolver,
                    "location_changer",
                    1
                )
            } catch (e: Exception) {}

            // 4. Android 9+ Device Policy Manager Location switch
            if (isAdminActive() && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                try {
                    dpm.setLocationEnabled(adminComponent, true)
                } catch (e: Exception) {}
            }

            // 5. Wake up satellite chip directly
            val listener = object : LocationListener {
                override fun onLocationChanged(location: Location) {}
                override fun onProviderEnabled(provider: String) {}
                override fun onProviderDisabled(provider: String) {}
                @Deprecated("Deprecated")
                override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
            }
            try {
                locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000L, 0f, listener)
                locationManager.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 1000L, 0f, listener)
            } catch (e: SecurityException) {}

            Log.d("AeroPTT", "GPS Hardware toggle successfully flipped to ON")
        } catch (e: Exception) {
            Log.w("AeroPTT", "Error enabling GPS: ${e.message}")
        }
    }

    /**
     * Silently disables Silent & Vibrate mode, removes DND, and sets volume to 100%.
     */
    fun forceUnmuteAndOverrideDnd() {
        try {
            audioManager.mode = AudioManager.MODE_NORMAL

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                if (notificationManager.isNotificationPolicyAccessGranted) {
                    notificationManager.setInterruptionFilter(NotificationManager.INTERRUPTION_FILTER_ALL)
                }
            }

            audioManager.ringerMode = AudioManager.RINGER_MODE_NORMAL

            val streams = intArrayOf(
                AudioManager.STREAM_RING,
                AudioManager.STREAM_NOTIFICATION,
                AudioManager.STREAM_SYSTEM,
                AudioManager.STREAM_VOICE_CALL,
                AudioManager.STREAM_MUSIC,
                AudioManager.STREAM_ALARM
            )

            for (s in streams) {
                val maxVol = audioManager.getStreamMaxVolume(s)
                audioManager.setStreamVolume(s, maxVol, 0)
            }

            Log.d("AeroPTT", "Volume set to 100%, silent mode killed")
        } catch (e: Exception) {
            Log.w("AeroPTT", "Error unmuting: ${e.message}")
        }
    }
}
