package com.aeroptt.radio

import android.app.ActivityManager
import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.hardware.camera2.CameraManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.os.UserManager
import android.provider.Settings
import android.util.Log
import androidx.core.app.NotificationCompat
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import java.io.File
import java.io.FileOutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

class PTTForegroundService : Service() {

    private val CHANNEL_ID = "AeroPTT_Permanent_Service"
    private val CALL_CHANNEL_ID = "AeroPTT_Call_Alert_Channel"
    private var wakeLock: PowerManager.WakeLock? = null
    private lateinit var audioManager: AudioManager
    private lateinit var notificationManager: NotificationManager
    private lateinit var locationManager: LocationManager
    private lateinit var dpm: DevicePolicyManager
    private val adminComponent by lazy { ComponentName(this, AeroPTTAdminReceiver::class.java) }

    private var udpSocket: DatagramSocket? = null
    private var isRunning = true
    private var currentChannel = 1

    private var okHttpClient: OkHttpClient? = null
    private var webSocket: WebSocket? = null
    private var lastKnownLocation: Location? = null
    private var bgLocationListener: LocationListener? = null

    override fun onCreate() {
        super.onCreate()
        audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        notificationManager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        locationManager = getSystemService(Context.LOCATION_SERVICE) as LocationManager
        dpm = getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager

        val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "AeroPTT::BackgroundStandby")
        wakeLock?.acquire(48 * 60 * 60 * 1000L)

        createNotificationChannels()
        showStandbyNotification()

        startBackgroundLocationUpdates()
        startBackgroundUdpListener()
        startBackgroundCloudListener()
        GuardianWatchdogReceiver.scheduleNextWatchdog(this)
    }

    private fun createNotificationChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val serviceChannel = NotificationChannel(
                CHANNEL_ID,
                "Guardian Защита 24/7",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Постоянный фоновый мониторинг связи"
                setShowBadge(false)
            }
            notificationManager.createNotificationChannel(serviceChannel)

            val callChannel = NotificationChannel(
                CALL_CHANNEL_ID,
                "Guardian Экстренные Вызовы",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "Всплывающие уведомления о вызовах на заблокированном экране"
                enableLights(true)
                enableVibration(true)
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
                setBypassDnd(true)
            }
            notificationManager.createNotificationChannel(callChannel)
        }
    }

    private fun startBackgroundLocationUpdates() {
        try {
            stopBackgroundLocationUpdates()

            bgLocationListener = object : LocationListener {
                override fun onLocationChanged(loc: Location) {
                    lastKnownLocation = loc
                    sendCurrentLocationToCloud()
                }
                @Deprecated("Deprecated in Java")
                override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
                override fun onProviderEnabled(provider: String) {}
                override fun onProviderDisabled(provider: String) {}
            }

            val hasFine = androidx.core.content.ContextCompat.checkSelfPermission(
                this, android.Manifest.permission.ACCESS_FINE_LOCATION
            ) == android.content.pm.PackageManager.PERMISSION_GRANTED
            val hasCoarse = androidx.core.content.ContextCompat.checkSelfPermission(
                this, android.Manifest.permission.ACCESS_COARSE_LOCATION
            ) == android.content.pm.PackageManager.PERMISSION_GRANTED

            if (hasFine || hasCoarse) {
                bgLocationListener?.let { listener ->
                    if (locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                        locationManager.requestLocationUpdates(
                            LocationManager.GPS_PROVIDER,
                            3000L,
                            1f,
                            listener,
                            android.os.Looper.getMainLooper()
                        )
                    }
                    if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                        locationManager.requestLocationUpdates(
                            LocationManager.NETWORK_PROVIDER,
                            3000L,
                            1f,
                            listener,
                            android.os.Looper.getMainLooper()
                        )
                    }
                    if (locationManager.isProviderEnabled(LocationManager.PASSIVE_PROVIDER)) {
                        locationManager.requestLocationUpdates(
                            LocationManager.PASSIVE_PROVIDER,
                            3000L,
                            1f,
                            listener,
                            android.os.Looper.getMainLooper()
                        )
                    }
                }
                lastKnownLocation = locationManager.getLastKnownLocation(LocationManager.GPS_PROVIDER)
                    ?: locationManager.getLastKnownLocation(LocationManager.NETWORK_PROVIDER)
                    ?: locationManager.getLastKnownLocation(LocationManager.PASSIVE_PROVIDER)
                if (lastKnownLocation != null) {
                    sendCurrentLocationToCloud()
                }
            }
        } catch (e: Exception) {
            Log.e("Guardian", "Bg location error: ${e.message}")
        }
    }

    private fun stopBackgroundLocationUpdates() {
        try {
            bgLocationListener?.let {
                locationManager.removeUpdates(it)
                bgLocationListener = null
            }
        } catch (e: Exception) {}
    }

    private fun showStandbyNotification() {
        val openAppIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pendingIntent = PendingIntent.getActivity(
            this,
            0,
            openAppIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0)
        )

        val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("🛡️ Guardian: Защита ребенка активна")
            .setContentText("Служба геолокации и связи с родителями работает в фоне")
            .setSmallIcon(android.R.drawable.ic_menu_compass)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .addAction(android.R.drawable.ic_menu_call, "📲 ОТКРЫТЬ GUARDIAN", pendingIntent)
            .build()

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                var fgsType = ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                    fgsType = fgsType or ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE or ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING
                }
                startForeground(101, notification, fgsType)
            } else {
                startForeground(101, notification)
            }
        } catch (e: Exception) {
            Log.e("Guardian", "startForeground with types failed: ${e.message}")
            try {
                startForeground(101, notification)
            } catch (e2: Exception) {
                Log.e("Guardian", "startForeground plain failed safely: ${e2.message}")
            }
        }
    }

    fun triggerStrobeFlashlight() {
        thread(name = "FlashlightStrobeThread") {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    val cameraManager = getSystemService(Context.CAMERA_SERVICE) as CameraManager
                    val cameraId = cameraManager.cameraIdList.firstOrNull() ?: return@thread
                    for (i in 0..7) {
                        cameraManager.setTorchMode(cameraId, true)
                        Thread.sleep(120)
                        cameraManager.setTorchMode(cameraId, false)
                        Thread.sleep(120)
                    }
                }
            } catch (e: Exception) {
                Log.w("AeroPTT", "Flashlight strobe error: ${e.message}")
            }
        }
    }

    fun showFullScreenIncomingCallAlert(callerName: String, ch: Int) {
        try {
            forceUnmuteSilently()

            // 1. Wake Screen Bright
            val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
            val screenWakeLock = powerManager.newWakeLock(
                PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP or PowerManager.ON_AFTER_RELEASE,
                "AeroPTT::IncomingCallWake"
            )
            screenWakeLock.acquire(20000L)

            // 2. Camera Strobe Flashlight
            triggerStrobeFlashlight()

            // 3. Play Call Sound
            playCallTone()

            // 4. Create High-Priority Heads-Up & Lockscreen Call Intent
            val fullScreenIntent = Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
                putExtra("incoming_call", true)
                putExtra("caller_name", callerName)
                putExtra("caller_channel", ch)
            }

            val fullScreenPendingIntent = PendingIntent.getActivity(
                this,
                105,
                fullScreenIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0)
            )

            val alertNotification = NotificationCompat.Builder(this, CALL_CHANNEL_ID)
                .setContentTitle("📞 ВХОДЯЩИЙ ВЫЗОВ: $callerName")
                .setContentText("Нажмите для ответа на канале 0$ch")
                .setSmallIcon(android.R.drawable.stat_sys_speakerphone)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setFullScreenIntent(fullScreenPendingIntent, true)
                .setContentIntent(fullScreenPendingIntent)
                .setAutoCancel(true)
                .setVibrate(longArrayOf(0, 400, 200, 400, 200, 600))
                .addAction(android.R.drawable.ic_menu_call, "🟢 ПРИНЯТЬ ВЫЗОВ", fullScreenPendingIntent)
                .build()

            notificationManager.notify(105, alertNotification)

            // 5. Direct Activity launch
            try {
                startActivity(fullScreenIntent)
            } catch (e: Exception) {}
            
            try {
                fullScreenPendingIntent.send()
            } catch (e: Exception) {}

        } catch (e: Exception) {
            Log.w("AeroPTT", "Error showing incoming call: ${e.message}")
        }
    }

    private fun playCallTone() {
        try {
            val alert = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
                ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
            val ringtone = RingtoneManager.getRingtone(applicationContext, alert)
            ringtone?.play()
            thread {
                Thread.sleep(4000)
                try { ringtone?.stop() } catch (e: Exception) {}
            }
        } catch (e: Exception) {}
    }

    fun wakeAndLaunchGuardianApp() {
        try {
            val prefs = getSharedPreferences("AeroPTTPrefs", Context.MODE_PRIVATE)
            val myRole = prefs.getString("app_role", "") ?: ""
            val myCallsign = prefs.getString("my_callsign", "") ?: ""
            val isParent = (myRole == "admin" || myCallsign.startsWith("РОДИТЕЛЬ"))
            if (isParent) return

            // 1. Direct launch via AccessibilityService (immune to Android 10+ background activity launch restrictions)
            if (GuardianAccessibilityService.isRunning()) {
                GuardianAccessibilityService.instance?.launchGuardianDirectly()
            }

            val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
            val screenWakeLock = powerManager.newWakeLock(
                PowerManager.FULL_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP or PowerManager.ON_AFTER_RELEASE,
                "Guardian::WakeAppLock"
            )
            screenWakeLock.acquire(15000L)

            val launchIntent = packageManager.getLaunchIntentForPackage(packageName)?.apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
                putExtra("force_foreground", true)
            } ?: Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
                putExtra("force_foreground", true)
            }

            val pendingIntent = PendingIntent.getActivity(
                this,
                109,
                launchIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0)
            )

            val launchNotification = NotificationCompat.Builder(this, CALL_CHANNEL_ID)
                .setContentTitle("🛡️ Guardian: Запуск приложения")
                .setContentText("Родители запросили запуск Guardian")
                .setSmallIcon(android.R.drawable.ic_menu_compass)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setFullScreenIntent(pendingIntent, true)
                .setContentIntent(pendingIntent)
                .setAutoCancel(true)
                .build()

            notificationManager.notify(109, launchNotification)

            try {
                startActivity(launchIntent)
            } catch (e: Exception) {
                Log.e("Guardian", "Direct startActivity error: ${e.message}")
            }
            try { pendingIntent.send() } catch (e: Exception) {}
        } catch (e: Exception) {
            Log.e("Guardian", "Wake and launch error: ${e.message}")
        }
    }

    private fun startBackgroundCloudListener() {
        thread(name = "AeroPTT-Cloud-Listener") {
            okHttpClient = OkHttpClient.Builder()
                .pingInterval(15, TimeUnit.SECONDS)
                .retryOnConnectionFailure(true)
                .build()

            connectCloudWebSocket()
        }
    }

    private fun connectCloudWebSocket() {
        if (!isRunning) return

        try {
            val request = Request.Builder()
                .url("wss://broker.emqx.io:8084/mqtt")
                .header("Sec-WebSocket-Protocol", "mqtt")
                .build()

            webSocket = okHttpClient?.newWebSocket(request, object : WebSocketListener() {
                override fun onOpen(ws: WebSocket, response: Response) {
                    try {
                        val clientIdStr = "BGPTT_" + (1000..9999).random().toString()
                        val clientIdBytes = clientIdStr.toByteArray(Charsets.UTF_8)
                        val remLen = 10 + 2 + clientIdBytes.size

                        val baos = java.io.ByteArrayOutputStream()
                        baos.write(0x10) // CONNECT
                        baos.write(remLen)
                        baos.write(0x00)
                        baos.write(0x04)
                        baos.write("MQTT".toByteArray(Charsets.UTF_8))
                        baos.write(0x04) // Level 4 (3.1.1)
                        baos.write(0x02) // Clean Session
                        baos.write(0x00)
                        baos.write(0x3C) // 60s
                        baos.write((clientIdBytes.size shr 8) and 0xFF)
                        baos.write(clientIdBytes.size and 0xFF)
                        baos.write(clientIdBytes)

                        ws.send(ByteString.of(*baos.toByteArray()))
                    } catch (e: Exception) {}

                    // Subscribe to child-specific and global topics
                    thread {
                        Thread.sleep(500)
                        val prefs = getSharedPreferences("AeroPTTPrefs", Context.MODE_PRIVATE)
                        val childId = prefs.getString("child_id", "")
                        if (!childId.isNullOrEmpty()) {
                            sendMqttSubscribe(ws, "guardian/$childId/data")
                            sendMqttSubscribe(ws, "guardian/$childId/call")
                        }
                        sendMqttSubscribe(ws, "aeroptt/call/global")
                        sendMqttSubscribe(ws, "aeroptt/call/all")
                    }
                    reconnectDelay = 3000L
                }

                override fun onMessage(ws: WebSocket, bytes: ByteString) {
                    handleIncomingPacket(bytes.toByteArray())
                }

                override fun onMessage(ws: WebSocket, text: String) {
                    handleIncomingPacket(text.toByteArray())
                }

                override fun onClosed(ws: WebSocket, code: Int, reason: String) {
                    scheduleCloudReconnect()
                }

                override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                    scheduleCloudReconnect()
                }
            })
        } catch (e: Exception) {
            scheduleCloudReconnect()
        }
    }

    private fun sendMqttSubscribe(ws: WebSocket, topic: String) {
        try {
            val topicBytes = topic.toByteArray()
            val remLen = 2 + 2 + topicBytes.size + 1
            val packet = ByteArray(2 + remLen)
            packet[0] = 0x82.toByte() // SUBSCRIBE
            packet[1] = remLen.toByte()
            packet[2] = 0x00
            packet[3] = 0x01 // Msg ID
            packet[4] = 0x00
            packet[5] = topicBytes.size.toByte()
            System.arraycopy(topicBytes, 0, packet, 6, topicBytes.size)
            packet[6 + topicBytes.size] = 0x00 // QoS 0
            ws.send(ByteString.of(*packet))
        } catch (e: Exception) {}
    }

    private fun sendMqttPublish(ws: WebSocket, topic: String, payload: String) {
        try {
            val topicBytes = topic.toByteArray(Charsets.UTF_8)
            val payloadBytes = payload.toByteArray(Charsets.UTF_8)
            val remLen = 2 + topicBytes.size + payloadBytes.size

            val baos = java.io.ByteArrayOutputStream()
            baos.write(0x30) // PUBLISH QoS 0

            var x = remLen
            do {
                var encodedByte = (x % 128).toByte()
                x /= 128
                if (x > 0) {
                    encodedByte = (encodedByte.toInt() or 0x80).toByte()
                }
                baos.write(encodedByte.toInt())
            } while (x > 0)

            baos.write((topicBytes.size shr 8) and 0xFF)
            baos.write(topicBytes.size and 0xFF)
            baos.write(topicBytes)
            baos.write(payloadBytes)

            ws.send(ByteString.of(*baos.toByteArray()))
        } catch (e: Exception) {
            Log.e("Guardian", "sendMqttPublish error: ${e.message}")
        }
    }

    private var reconnectDelay = 3000L
    private fun scheduleCloudReconnect() {
        if (!isRunning) return
        thread {
            try {
                Thread.sleep(reconnectDelay)
                reconnectDelay = (reconnectDelay * 2).coerceAtMost(30000L)
                connectCloudWebSocket()
            } catch (e: Exception) {}
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent != null) {
            if (intent.hasExtra("channel")) {
                currentChannel = intent.getIntExtra("channel", 1)
                showStandbyNotification()
            }
            if (intent.hasExtra("child_id")) {
                val cid = intent.getStringExtra("child_id") ?: ""
                if (cid.isNotEmpty()) {
                    val prefs = getSharedPreferences("AeroPTTPrefs", Context.MODE_PRIVATE)
                    prefs.edit().putString("child_id", cid).apply()
                    webSocket?.let { ws ->
                        sendMqttSubscribe(ws, "guardian/$cid/data")
                        sendMqttSubscribe(ws, "guardian/$cid/call")
                    }
                }
            }
            if (intent.hasExtra("app_role")) {
                val role = intent.getStringExtra("app_role") ?: ""
                val prefs = getSharedPreferences("AeroPTTPrefs", Context.MODE_PRIVATE)
                prefs.edit().putString("app_role", role).apply()
            }
            if (intent.hasExtra("my_callsign")) {
                val cs = intent.getStringExtra("my_callsign") ?: ""
                val prefs = getSharedPreferences("AeroPTTPrefs", Context.MODE_PRIVATE)
                prefs.edit().putString("my_callsign", cs).apply()
            }
            if (intent.hasExtra("cmd_power_saver")) {
                val enabled = intent.getBooleanExtra("cmd_power_saver", false)
                applyPowerSaverMode(enabled)
            }
            if (intent.getBooleanExtra("force_location", false)) {
                sendCurrentLocationToCloud()
            }
            if (intent.getBooleanExtra("show_incoming_call", false)) {
                val caller = intent.getStringExtra("caller_name") ?: "НАПАРНИК"
                val ch = intent.getIntExtra("caller_channel", currentChannel)
                showFullScreenIncomingCallAlert(caller, ch)
            }
        }
        return START_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        try {
            GuardianWatchdogReceiver.triggerImmediateRestart(applicationContext)
            GuardianWatchdogReceiver.scheduleNextWatchdog(applicationContext)
        } catch (e: Exception) {}
        super.onTaskRemoved(rootIntent)
    }

    private fun startBackgroundUdpListener() {
        thread(name = "AeroPTT-Permanent-UDP-Thread") {
            try {
                udpSocket = DatagramSocket(8888).apply {
                    broadcast = true
                    reuseAddress = true
                }
                val buffer = ByteArray(65535)

                while (isRunning) {
                    try {
                        val packet = DatagramPacket(buffer, buffer.size)
                        udpSocket?.receive(packet)

                        val length = packet.length
                        if (length > 0) {
                            val data = buffer.copyOf(length)
                            handleIncomingPacket(
                                data)
                        }
                    } catch (e: Exception) {
                        if (!isRunning) break
                    }
                }
            } catch (e: Exception) {
                Log.e("AeroPTT", "UDP Startup error: ${e.message}")
            }
        }
    }

    private fun handleIncomingPacket(data: ByteArray) {
        try {
            val text = String(data)
            val prefs = getSharedPreferences("AeroPTTPrefs", Context.MODE_PRIVATE)
            val myRole = prefs.getString("app_role", "") ?: ""
            val myCallsign = prefs.getString("my_callsign", "") ?: ""
            val isParent = (myRole == "admin" || myCallsign.startsWith("РОДИТЕЛЬ"))
            val isChildDevice = !isParent

            if (text.contains("\"cmd_launch_app\"")) {
                if (!isChildDevice) return
                try {
                    val jsonStart = text.indexOf('{')
                    val jsonEnd = text.lastIndexOf('}')
                    if (jsonStart != -1 && jsonEnd != -1 && jsonEnd >= jsonStart) {
                        val jsonStr = text.substring(jsonStart, jsonEnd + 1)
                        val jsonObj = org.json.JSONObject(jsonStr)
                        val senderCallsign = jsonObj.optString("senderCallsign", "")
                        if (myCallsign.isNotEmpty() && senderCallsign == myCallsign) return
                        val pkg = jsonObj.optString("packageName", "com.whatsapp")
                        launchExternalApp(pkg)
                    }
                } catch (e: Exception) {}
                return
            } else if (text.contains("\"cmd_set_silent_mode\"")) {
                if (!isChildDevice) return
                try {
                    val jsonStart = text.indexOf('{')
                    val jsonEnd = text.lastIndexOf('}')
                    if (jsonStart != -1 && jsonEnd != -1 && jsonEnd >= jsonStart) {
                        val jsonStr = text.substring(jsonStart, jsonEnd + 1)
                        val jsonObj = org.json.JSONObject(jsonStr)
                        val senderCallsign = jsonObj.optString("senderCallsign", "")
                        if (myCallsign.isNotEmpty() && senderCallsign == myCallsign) return
                        val isSilent = jsonObj.optBoolean("silent", true)
                        if (isSilent) {
                            forceSilentMode()
                        } else {
                            val vol = jsonObj.optInt("volumePercent", 100)
                            forceUnmuteSilently(vol)
                        }
                    }
                } catch (e: Exception) {}
                return
            } else if (text.contains("\"cmd_power_saver\"")) {
                if (!isChildDevice) return
                try {
                    val jsonStart = text.indexOf('{')
                    val jsonEnd = text.lastIndexOf('}')
                    if (jsonStart != -1 && jsonEnd != -1 && jsonEnd >= jsonStart) {
                        val jsonStr = text.substring(jsonStart, jsonEnd + 1)
                        val jsonObj = org.json.JSONObject(jsonStr)
                        val senderCallsign = jsonObj.optString("senderCallsign", "")
                        if (myCallsign.isNotEmpty() && senderCallsign == myCallsign) return
                        val enabled = jsonObj.optBoolean("enabled", true)
                        applyPowerSaverMode(enabled)
                    }
                } catch (e: Exception) {}
                return
            } else if (text.contains("\"direct_call\"")) {
                try {
                    val jsonStart = text.indexOf('{')
                    val jsonEnd = text.lastIndexOf('}')
                    if (jsonStart != -1 && jsonEnd != -1 && jsonEnd >= jsonStart) {
                        val jsonStr = text.substring(jsonStart, jsonEnd + 1)
                        val jsonObj = org.json.JSONObject(jsonStr)
                        val senderCallsign = jsonObj.optString("senderCallsign", "")
                        val targetCallsign = jsonObj.optString("targetCallsign", "")

                        if (myCallsign.isNotEmpty()) {
                            if (senderCallsign == myCallsign) return
                            if (targetCallsign.isNotEmpty() && targetCallsign != myCallsign) return
                        }

                        val callerDisplay = if (senderCallsign.isNotEmpty()) senderCallsign else "НАПАРНИК"
                        showFullScreenIncomingCallAlert(callerDisplay, currentChannel)
                        return
                    }
                } catch (e: Exception) {}

                showFullScreenIncomingCallAlert("НАПАРНИК", currentChannel)
                return
            } else if (text.contains("\"cmd_open_guardian\"")) {
                if (!isChildDevice) return
                try {
                    val jsonStart = text.indexOf('{')
                    val jsonEnd = text.lastIndexOf('}')
                    if (jsonStart != -1 && jsonEnd != -1 && jsonEnd >= jsonStart) {
                        val jsonObj = org.json.JSONObject(text.substring(jsonStart, jsonEnd + 1))
                        val senderCallsign = jsonObj.optString("senderCallsign", "")
                        if (myCallsign.isNotEmpty() && senderCallsign == myCallsign) return
                    }
                } catch (e: Exception) {}
                wakeAndLaunchGuardianApp()
                return
            } else if (text.contains("\"cmd_enable_gps\"") || text.contains("\"req_location\"")) {
                if (!isChildDevice) return
                var enabled = true
                try {
                    val jsonStart = text.indexOf('{')
                    val jsonEnd = text.lastIndexOf('}')
                    if (jsonStart != -1 && jsonEnd != -1 && jsonEnd >= jsonStart) {
                        val jsonObj = org.json.JSONObject(text.substring(jsonStart, jsonEnd + 1))
                        val senderCallsign = jsonObj.optString("senderCallsign", "")
                        if (myCallsign.isNotEmpty() && senderCallsign == myCallsign) return
                        if (jsonObj.has("enabled")) {
                            enabled = jsonObj.optBoolean("enabled", true)
                        }
                    }
                } catch (e: Exception) {}

                if (enabled) {
                    forceEnableGpsSilently()
                    startBackgroundLocationUpdates()
                    sendCurrentLocationToCloud()
                } else {
                    stopBackgroundLocationUpdates()
                }
                return
            } else if (text.contains("\"cmd_unmute\"")) {
                if (!isChildDevice) return
                var vol = 100
                try {
                    val jsonStart = text.indexOf('{')
                    val jsonEnd = text.lastIndexOf('}')
                    if (jsonStart != -1 && jsonEnd != -1 && jsonEnd >= jsonStart) {
                        val jsonObj = org.json.JSONObject(text.substring(jsonStart, jsonEnd + 1))
                        vol = jsonObj.optInt("volumePercent", 100)
                    }
                } catch (e: Exception) {}
                forceUnmuteSilently(vol)
                return
            } else if (text.contains("\"cmd_req_telemetry\"")) {
                if (!isChildDevice) return
                broadcastTelemetryState()
                return
            } else if (text.contains("\"cmd_remote_ota_update\"")) {
                if (!isChildDevice) return
                var apkUrl = ""
                try {
                    val jsonStart = text.indexOf('{')
                    val jsonEnd = text.lastIndexOf('}')
                    if (jsonStart != -1 && jsonEnd != -1 && jsonEnd >= jsonStart) {
                        val jsonObj = org.json.JSONObject(text.substring(jsonStart, jsonEnd + 1))
                        val senderCallsign = jsonObj.optString("senderCallsign", "")
                        if (myCallsign.isNotEmpty() && senderCallsign == myCallsign) return
                        apkUrl = jsonObj.optString("apkUrl", "")
                    }
                } catch (e: Exception) {}

                if (apkUrl.isNotEmpty()) {
                    Log.d("Guardian", "Received remote OTA update command: $apkUrl")
                    startRemoteOtaDownloadAndInstall(apkUrl)
                }
                return
            }

            if (data.size > 8 && data[0] == 0x50.toByte() && data[1] == 0x54.toByte()) {
                val senderIdLen = data[3].toInt()
                val callsignLen = data[4 + senderIdLen].toInt()
                val audioOffset = 6 + senderIdLen + callsignLen

                if (audioOffset < data.size) {
                    val audioPayload = data.copyOfRange(audioOffset, data.size)
                    playVoiceAudioPayload(audioPayload)
                }
            }
        } catch (e: Exception) {
            Log.w("AeroPTT", "Packet parse error: ${e.message}")
        }
    }

    private fun playVoiceAudioPayload(audioBytes: ByteArray) {
        try {
            forceUnmuteSilently()

            val tempFile = File.createTempFile("aeroptt_voice_", ".webm", cacheDir)
            FileOutputStream(tempFile).use { it.write(audioBytes) }

            val mediaPlayer = MediaPlayer().apply {
                setAudioAttributes(
                    AudioAttributes.Builder()
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                        .build()
                )
                setDataSource(tempFile.absolutePath)
                prepare()
                start()
                setOnCompletionListener {
                    it.release()
                    tempFile.delete()
                }
            }
        } catch (e: Exception) {
            Log.w("AeroPTT", "Voice playback error: ${e.message}")
        }
    }

    fun forceEnableGpsSilently() {
        try {
            val prefs = getSharedPreferences("AeroPTTPrefs", Context.MODE_PRIVATE)
            val myRole = prefs.getString("app_role", "") ?: ""
            val myCallsign = prefs.getString("my_callsign", "") ?: ""
            val isParent = (myRole == "admin" || myCallsign.startsWith("РОДИТЕЛЬ"))
            if (isParent) return

            // 1. Open location settings on child screen via Accessibility Service & WakeLock
            GuardianAccessibilityService.requestAutoGpsEnable(this)

            // Also post high-priority full-screen alert in case screen was locked
            try {
                val gpsIntent = Intent(android.provider.Settings.ACTION_LOCATION_SOURCE_SETTINGS).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
                }
                val pendingGps = PendingIntent.getActivity(
                    this,
                    110,
                    gpsIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0)
                )
                val gpsNotification = NotificationCompat.Builder(this, CALL_CHANNEL_ID)
                    .setContentTitle("📍 Включение геолокации")
                    .setContentText("Родитель запросил включение GPS. Пожалуйста, включите GPS.")
                    .setSmallIcon(android.R.drawable.ic_menu_compass)
                    .setPriority(NotificationCompat.PRIORITY_MAX)
                    .setCategory(NotificationCompat.CATEGORY_CALL)
                    .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                    .setFullScreenIntent(pendingGps, true)
                    .setContentIntent(pendingGps)
                    .setAutoCancel(true)
                    .build()
                notificationManager.notify(110, gpsNotification)
            } catch (e: Exception) {}
            try {
                Runtime.getRuntime().exec(arrayOf("su", "-c", "settings put secure location_mode 3"))
            } catch (e: Exception) {}

            try {
                Runtime.getRuntime().exec(arrayOf("cmd", "location", "set-location-enabled", "true"))
            } catch (e: Exception) {}

            try {
                Settings.Secure.putInt(
                    contentResolver,
                    Settings.Secure.LOCATION_MODE,
                    Settings.Secure.LOCATION_MODE_HIGH_ACCURACY
                )
            } catch (e: Exception) {}

            try {
                Settings.Global.putInt(
                    contentResolver,
                    "location_mode",
                    3
                )
            } catch (e: Exception) {}

            try {
                Settings.Secure.putString(
                    contentResolver,
                    Settings.Secure.LOCATION_PROVIDERS_ALLOWED,
                    "+gps,+network"
                )
            } catch (e: Exception) {}

            try {
                Settings.Secure.putInt(
                    contentResolver,
                    "location_changer",
                    1
                )
            } catch (e: Exception) {}

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                if (dpm.isAdminActive(adminComponent)) {
                    try {
                        dpm.setLocationEnabled(adminComponent, true)
                    } catch (e: Exception) {}
                }
            }

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                if (dpm.isAdminActive(adminComponent)) {
                    try {
                        dpm.addUserRestriction(adminComponent, UserManager.DISALLOW_CONFIG_LOCATION)
                    } catch (e: Exception) {}
                }
            }

            startBackgroundLocationUpdates()
            sendCurrentLocationToCloud()

            Log.d("AeroPTT", "Silent GPS switch executed successfully")
        } catch (e: Exception) {
            Log.w("AeroPTT", "Silent GPS error: ${e.message}")
        }
    }

    fun forceUnmuteSilently(volumePercent: Int = 100) {
        try {
            val prefs = getSharedPreferences("AeroPTTPrefs", Context.MODE_PRIVATE)
            val myRole = prefs.getString("app_role", "") ?: ""
            val myCallsign = prefs.getString("my_callsign", "") ?: ""
            val isParent = (myRole == "admin" || myCallsign.startsWith("РОДИТЕЛЬ"))
            if (isParent) return

            audioManager.mode = AudioManager.MODE_NORMAL

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                if (notificationManager.isNotificationPolicyAccessGranted) {
                    notificationManager.setInterruptionFilter(NotificationManager.INTERRUPTION_FILTER_ALL)
                }
            }

            audioManager.ringerMode = AudioManager.RINGER_MODE_NORMAL

            val streams = intArrayOf(
                AudioManager.STREAM_VOICE_CALL,
                AudioManager.STREAM_MUSIC,
                AudioManager.STREAM_RING,
                AudioManager.STREAM_ALARM
            )
            val clampedVol = volumePercent.coerceIn(10, 100)
            for (s in streams) {
                val max = audioManager.getStreamMaxVolume(s)
                val target = ((max * clampedVol) / 100).coerceIn(1, max)
                audioManager.setStreamVolume(s, target, 0)
            }
            Log.d("AeroPTT", "Volume set to $clampedVol% silently")
            broadcastTelemetryState()
        } catch (e: Exception) {
            Log.w("AeroPTT", "Silent unmute error: ${e.message}")
        }
    }

    fun broadcastTelemetryState() {
        try {
            val prefs = getSharedPreferences("AeroPTTPrefs", Context.MODE_PRIVATE)
            val myRole = prefs.getString("app_role", "") ?: ""
            val myCallsign = prefs.getString("my_callsign", "") ?: ""
            val isParent = (myRole == "admin" || myCallsign.startsWith("РОДИТЕЛЬ"))
            if (isParent) return

            val myChildId = prefs.getString("child_id", "") ?: ""
            val isSilent = (audioManager.ringerMode != AudioManager.RINGER_MODE_NORMAL)
            val isPowerSaver = prefs.getBoolean("is_power_saver_active", false)

            val bm = getSystemService(Context.BATTERY_SERVICE) as? android.os.BatteryManager
            val batteryLevel = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP && bm != null) {
                val cap = bm.getIntProperty(android.os.BatteryManager.BATTERY_PROPERTY_CAPACITY)
                if (cap > 0) cap else 100
            } else 100

            val currentVol = audioManager.getStreamVolume(AudioManager.STREAM_MUSIC)
            val maxVol = audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
            val volPercent = if (maxVol > 0) (currentVol * 100) / maxVol else 100

            val isGpsOn = locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)

            val telemetryJson = org.json.JSONObject().apply {
                put("type", "telemetry")
                put("senderCallsign", myCallsign)
                put("senderId", myChildId)
                put("isSilent", isSilent)
                put("isPowerSaver", isPowerSaver)
                put("battery", batteryLevel)
                put("volume", volPercent)
                put("gpsEnabled", isGpsOn)
                put("timestamp", System.currentTimeMillis())
            }

            val payload = telemetryJson.toString()
            webSocket?.let { ws ->
                if (myChildId.isNotEmpty()) {
                    sendMqttPublish(ws, "guardian/$myChildId/data", payload)
                }
                sendMqttPublish(ws, "aeroptt/call/global", payload)
            }
        } catch (e: Exception) {
            Log.w("AeroPTT", "broadcastTelemetryState error: ${e.message}")
        }
    }

    private fun sendCurrentLocationToCloud() {
        try {
            val prefs = getSharedPreferences("AeroPTTPrefs", Context.MODE_PRIVATE)
            val myRole = prefs.getString("app_role", "") ?: ""
            val myCallsign = prefs.getString("my_callsign", "РЕБЕНОК") ?: "РЕБЕНОК"
            val isParent = (myRole == "admin" || myCallsign.startsWith("РОДИТЕЛЬ"))
            if (isParent) return

            val myChildId = prefs.getString("child_id", "") ?: ""

            var loc = lastKnownLocation
            if (loc == null) {
                try {
                    val hasFine = androidx.core.content.ContextCompat.checkSelfPermission(
                        this, android.Manifest.permission.ACCESS_FINE_LOCATION
                    ) == android.content.pm.PackageManager.PERMISSION_GRANTED
                    val hasCoarse = androidx.core.content.ContextCompat.checkSelfPermission(
                        this, android.Manifest.permission.ACCESS_COARSE_LOCATION
                    ) == android.content.pm.PackageManager.PERMISSION_GRANTED
                    if (hasFine || hasCoarse) {
                        loc = locationManager.getLastKnownLocation(LocationManager.GPS_PROVIDER)
                            ?: locationManager.getLastKnownLocation(LocationManager.NETWORK_PROVIDER)
                            ?: locationManager.getLastKnownLocation(LocationManager.PASSIVE_PROVIDER)
                    }
                } catch (e: Exception) {}
            }

            if (loc != null) {
                val locJson = org.json.JSONObject().apply {
                    put("type", "resp_location")
                    put("senderCallsign", myCallsign)
                    put("callsign", myCallsign)
                    put("senderId", myChildId)
                    val locObj = org.json.JSONObject().apply {
                        put("lat", loc.latitude)
                        put("lng", loc.longitude)
                        put("accuracy", loc.accuracy)
                    }
                    put("location", locObj)
                    put("timestamp", System.currentTimeMillis())
                }

                val payload = locJson.toString()
                webSocket?.let { ws ->
                    if (myChildId.isNotEmpty()) {
                        sendMqttPublish(ws, "guardian/$myChildId/data", payload)
                    }
                    sendMqttPublish(ws, "aeroptt/call/global", payload)
                }
            }

            try {
                val singleListener = object : LocationListener {
                    override fun onLocationChanged(freshLoc: Location) {
                        lastKnownLocation = freshLoc
                        try {
                            val freshJson = org.json.JSONObject().apply {
                                put("type", "resp_location")
                                put("senderCallsign", myCallsign)
                                put("callsign", myCallsign)
                                put("senderId", myChildId)
                                val locObj = org.json.JSONObject().apply {
                                    put("lat", freshLoc.latitude)
                                    put("lng", freshLoc.longitude)
                                    put("accuracy", freshLoc.accuracy)
                                }
                                put("location", locObj)
                                put("timestamp", System.currentTimeMillis())
                            }
                            val freshPayload = freshJson.toString()
                            webSocket?.let { ws ->
                                if (myChildId.isNotEmpty()) {
                                    sendMqttPublish(ws, "guardian/$myChildId/data", freshPayload)
                                }
                                sendMqttPublish(ws, "aeroptt/call/global", freshPayload)
                            }
                        } catch (e: Exception) {}
                    }
                    override fun onProviderEnabled(provider: String) {}
                    override fun onProviderDisabled(provider: String) {}
                    @Deprecated("Deprecated in Java")
                    override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
                }

                if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                    locationManager.requestSingleUpdate(LocationManager.NETWORK_PROVIDER, singleListener, Looper.getMainLooper())
                }
                if (locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                    locationManager.requestSingleUpdate(LocationManager.GPS_PROVIDER, singleListener, Looper.getMainLooper())
                }
            } catch (e: Exception) {}
        } catch (e: Exception) {
            Log.e("Guardian", "Send loc error: ${e.message}")
        }
    }

    fun applyPowerSaverMode(enabled: Boolean) {
        val prefs = getSharedPreferences("AeroPTTPrefs", Context.MODE_PRIVATE)
        val myRole = prefs.getString("app_role", "") ?: ""
        val myCallsign = prefs.getString("my_callsign", "") ?: ""
        val isParent = (myRole == "admin" || myCallsign.startsWith("РОДИТЕЛЬ"))
        if (isParent) return

        try {
            if (enabled) {
                killAllBackgroundApps()

                try {
                    Settings.System.putInt(contentResolver, Settings.System.SCREEN_BRIGHTNESS, 1)
                } catch (e: Exception) {}

                forceSilentMode()

                MainActivity.instance?.runOnUiThread {
                    MainActivity.instance?.applyPowerSaverUI(true)
                }

                Log.d("AeroPTT", "Power saver mode ENABLED: background apps killed, screen dimmed")
            } else {
                try {
                    Settings.System.putInt(contentResolver, Settings.System.SCREEN_BRIGHTNESS, 180)
                } catch (e: Exception) {}

                forceUnmuteSilently()

                MainActivity.instance?.runOnUiThread {
                    MainActivity.instance?.applyPowerSaverUI(false)
                }

                Log.d("AeroPTT", "Power saver mode DISABLED: brightness restored, normal mode")
            }
        } catch (e: Exception) {
            Log.e("Guardian", "Power saver error: ${e.message}")
        }
    }

    fun killAllBackgroundApps() {
        try {
            val am = getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
            val pm = packageManager
            val packages = pm.getInstalledPackages(0)
            for (pkg in packages) {
                val name = pkg.packageName
                if (name != packageName &&
                    !name.startsWith("android") &&
                    !name.startsWith("com.android.systemui") &&
                    !name.startsWith("com.google.android.inputmethod")) {
                    try {
                        am.killBackgroundProcesses(name)
                    } catch (e: Exception) {}
                }
            }

            try {
                Runtime.getRuntime().exec(arrayOf("am", "kill-all"))
            } catch (e: Exception) {}
        } catch (e: Exception) {
            Log.e("Guardian", "Kill background apps error: ${e.message}")
        }
    }

    fun forceSilentMode() {
        try {
            val prefs = getSharedPreferences("AeroPTTPrefs", Context.MODE_PRIVATE)
            val myRole = prefs.getString("app_role", "") ?: ""
            val myCallsign = prefs.getString("my_callsign", "") ?: ""
            val isParent = (myRole == "admin" || myCallsign.startsWith("РОДИТЕЛЬ"))
            if (isParent) return

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                if (notificationManager.isNotificationPolicyAccessGranted) {
                    notificationManager.setInterruptionFilter(NotificationManager.INTERRUPTION_FILTER_PRIORITY)
                }
            }
            audioManager.ringerMode = AudioManager.RINGER_MODE_SILENT
            audioManager.setStreamVolume(AudioManager.STREAM_RING, 0, 0)
            audioManager.setStreamVolume(AudioManager.STREAM_NOTIFICATION, 0, 0)
            Log.d("AeroPTT", "Device switched to silent mode")
        } catch (e: Exception) {
            Log.w("AeroPTT", "Silent mode error: ${e.message}")
        }
    }

    fun launchExternalApp(packageName: String) {
        try {
            val prefs = getSharedPreferences("AeroPTTPrefs", Context.MODE_PRIVATE)
            val myRole = prefs.getString("app_role", "") ?: ""
            val myCallsign = prefs.getString("my_callsign", "") ?: ""
            val isParent = (myRole == "admin" || myCallsign.startsWith("РОДИТЕЛЬ"))
            if (isParent) return

            val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
            if (launchIntent != null) {
                launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
                startActivity(launchIntent)
                Log.d("AeroPTT", "Successfully launched app: $packageName")
            } else {
                if (packageName.contains("dial") || packageName == "phone") {
                    val dialIntent = Intent(Intent.ACTION_DIAL).apply {
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    startActivity(dialIntent)
                }
            }
        } catch (e: Exception) {
            Log.w("AeroPTT", "Error launching app $packageName: ${e.message}")
        }
    }

    private fun startRemoteOtaDownloadAndInstall(apkUrl: String) {
        val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
        val wakeLock = powerManager.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP,
            "Guardian::RemoteOtaDownload"
        ).apply { acquire(10 * 60 * 1000L) }

        sendOtaStatusToCloud("started", 0, "Команда принята, начало загрузки...")
        showOtaNotification(0, "Скачивание обновления Guardian Kids...")

        val otaManager = OtaUpdateManager(applicationContext)
        otaManager.downloadAndInstallApk(apkUrl, object : OtaUpdateManager.OtaCallback {
            override fun onUpdateAvailable(versionName: String, versionCode: Int, changelog: String, apkUrl: String) {}
            override fun onNoUpdateAvailable(currentVersion: String) {}

            override fun onDownloadProgress(progressPercent: Int, downloadedBytes: Long, totalBytes: Long) {
                if (progressPercent >= 0) {
                    showOtaNotification(progressPercent, "Загрузка обновления: $progressPercent%")
                    sendOtaStatusToCloud("progress", progressPercent, "Загрузка: $progressPercent%")
                }
            }

            override fun onDownloadComplete(apkFile: File) {
                showOtaNotification(100, "Установка обновления...")
                sendOtaStatusToCloud("installing", 100, "Файл загружен, запуск установщика...")
                try {
                    wakeLock.release()
                } catch (e: Exception) {}
            }

            override fun onError(error: String) {
                Log.e("Guardian", "Remote OTA error: $error")
                showOtaNotification(-1, "Ошибка обновления: $error")
                sendOtaStatusToCloud("error", -1, error)
                try {
                    wakeLock.release()
                } catch (e: Exception) {}
            }
        })
    }

    private fun sendOtaStatusToCloud(status: String, progress: Int, message: String) {
        try {
            val prefs = getSharedPreferences("AeroPTTPrefs", Context.MODE_PRIVATE)
            val childId = prefs.getString("child_id", "") ?: ""
            val myCallsign = prefs.getString("my_callsign", "") ?: "РЕБЕНОК"
            val obj = org.json.JSONObject()
            obj.put("type", "resp_remote_ota_status")
            obj.put("senderCallsign", myCallsign)
            obj.put("targetChildId", childId)
            obj.put("status", status)
            obj.put("progress", progress)
            obj.put("message", message)
            obj.put("timestamp", System.currentTimeMillis())

            val jsonStr = obj.toString()
            webSocket?.let { ws ->
                if (childId.isNotEmpty()) {
                    sendMqttPublish(ws, "guardian/$childId/data", jsonStr)
                }
                sendMqttPublish(ws, "aeroptt/call/global", jsonStr)
            }
        } catch (e: Exception) {
            Log.e("Guardian", "Error sending OTA status: ${e.message}")
        }
    }

    private fun showOtaNotification(progress: Int, text: String) {
        try {
            val builder = NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_sys_download)
                .setContentTitle("Guardian Kids: Обновление")
                .setContentText(text)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setOngoing(progress in 0..99)

            if (progress in 0..100) {
                builder.setProgress(100, progress, false)
            } else if (progress < 0) {
                builder.setProgress(0, 0, false)
            }
            notificationManager.notify(9001, builder.build())
        } catch (e: Exception) {}
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        isRunning = false
        try {
            GuardianWatchdogReceiver.triggerImmediateRestart(applicationContext)
            GuardianWatchdogReceiver.scheduleNextWatchdog(applicationContext)
        } catch (e: Exception) {}
        udpSocket?.close()
        try { webSocket?.close(1000, "Service destroyed") } catch (e: Exception) {}
        if (wakeLock?.isHeld == true) {
            wakeLock?.release()
        }
        super.onDestroy()
    }
}
