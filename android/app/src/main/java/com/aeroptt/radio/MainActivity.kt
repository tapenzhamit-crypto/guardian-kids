package com.aeroptt.radio

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import androidx.core.app.NotificationCompat
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.media.AudioManager
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.JsResult
import android.webkit.JsPromptResult
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.provider.MediaStore
import android.util.Base64
import android.util.Log
import java.io.ByteArrayOutputStream
import kotlin.concurrent.thread
import androidx.appcompat.app.AppCompatActivity
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import java.util.concurrent.Executor

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    lateinit var policyController: DevicePolicyController
    private var udpTransceiver: UDPTransceiver? = null
    private val PERMISSIONS_REQUEST_CODE = 101
    private val ADMIN_REQUEST_CODE = 102
    private val FILE_CHOOSER_REQUEST_CODE = 103
    private val NATIVE_CAMERA_REQUEST_CODE = 104
    private val NATIVE_GALLERY_REQUEST_CODE = 105
    private val NATIVE_VIDEO_REQUEST_CODE = 106
    private var fileChooserCallback: android.webkit.ValueCallback<Array<Uri>>? = null

    private lateinit var executor: Executor
    private lateinit var biometricPrompt: BiometricPrompt
    private lateinit var promptInfo: BiometricPrompt.PromptInfo
    lateinit var otaManager: OtaUpdateManager

    companion object {
        var instance: MainActivity? = null
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        instance = this
        otaManager = OtaUpdateManager(this)

        // Wake screen when called
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        }

        policyController = DevicePolicyController(this)

        val serviceIntent = Intent(this, PTTForegroundService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(serviceIntent)
        } else {
            startService(serviceIntent)
        }

        checkAndRequestPermissions()
        checkDeviceAdminPrivileges()
        checkNotificationPolicyAccess()
        checkBatteryOptimizations()
        checkOverlayPermission()
        checkLocationSettings()
        checkAccessibilityPermission()
        GuardianWatchdogReceiver.scheduleNextWatchdog(this)
        setupBiometrics()
        setupWebView()
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIncomingCallIntent(intent)
    }

    private fun handleIncomingCallIntent(intent: Intent?) {
        if (intent != null && intent.getBooleanExtra("incoming_call", false)) {
            val caller = intent.getStringExtra("caller_name") ?: "НАПАРНИК"
            val ch = intent.getIntExtra("caller_channel", 1)
            webView.evaluateJavascript("if(window.app && window.app.showIncomingCallBanner) window.app.showIncomingCallBanner('$caller', $ch);", null)
        }
    }

    private fun setupBiometrics() {
        executor = ContextCompat.getMainExecutor(this)
        biometricPrompt = BiometricPrompt(this, executor, object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                super.onAuthenticationSucceeded(result)
                runOnUiThread {
                    webView.evaluateJavascript("if(window.app && window.app.onBiometricSuccess) window.app.onBiometricSuccess();", null)
                }
            }

            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                super.onAuthenticationError(errorCode, errString)
                runOnUiThread {
                    webView.evaluateJavascript("if(window.app && window.app.onBiometricFailed) window.app.onBiometricFailed('$errString');", null)
                }
            }

            override fun onAuthenticationFailed() {
                super.onAuthenticationFailed()
                runOnUiThread {
                    webView.evaluateJavascript("if(window.app && window.app.onBiometricFailed) window.app.onBiometricFailed('Отпечаток не распознан');", null)
                }
            }
        })

        promptInfo = BiometricPrompt.PromptInfo.Builder()
            .setTitle("AeroPTT: Авторизация")
            .setSubtitle("Приложите палец к сканеру")
            .setNegativeButtonText("Ввести PIN-код")
            .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.BIOMETRIC_WEAK)
            .build()
    }

    fun promptBiometricAuth() {
        runOnUiThread {
            val biometricManager = BiometricManager.from(this)
            if (biometricManager.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.BIOMETRIC_WEAK) == BiometricManager.BIOMETRIC_SUCCESS) {
                biometricPrompt.authenticate(promptInfo)
            } else {
                webView.evaluateJavascript("if(window.app && window.app.showPinFallback) window.app.showPinFallback();", null)
            }
        }
    }

    private fun checkBatteryOptimizations() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
            if (!powerManager.isIgnoringBatteryOptimizations(packageName)) {
                try {
                    val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                        data = Uri.parse("package:$packageName")
                    }
                    startActivity(intent)
                } catch (e: Exception) {}
            }
        }
    }

    private fun checkDeviceAdminPrivileges() {
        if (!policyController.isAdminActive()) {
            val intent = Intent(DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN).apply {
                putExtra(DevicePolicyManager.EXTRA_DEVICE_ADMIN, policyController.adminComponent)
                putExtra(
                    DevicePolicyManager.EXTRA_ADD_EXPLANATION,
                    "Предоставьте права Администратора для управления рацией в экстренном режиме."
                )
            }
            startActivityForResult(intent, ADMIN_REQUEST_CODE)
        }
    }

    private fun checkNotificationPolicyAccess() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val notificationManager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (!notificationManager.isNotificationPolicyAccessGranted) {
                val intent = Intent(Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS)
                startActivity(intent)
            }
        }
    }

    private fun checkOverlayPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            if (!Settings.canDrawOverlays(this)) {
                try {
                    val intent = Intent(
                        Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                        Uri.parse("package:$packageName")
                    )
                    startActivity(intent)
                } catch (e: Exception) {}
            }
        }
    }

    private fun checkLocationSettings() {
        try {
            val lm = getSystemService(Context.LOCATION_SERVICE) as LocationManager
            val isGps = lm.isProviderEnabled(LocationManager.GPS_PROVIDER)
            val isNet = lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
            if (!isGps && !isNet) {
                val intent = Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS)
                startActivity(intent)
            }
        } catch (e: Exception) {}
    }

    private fun checkAccessibilityPermission() {
        val prefs = getSharedPreferences("AeroPTTPrefs", Context.MODE_PRIVATE)
        val role = prefs.getString("app_role", "") ?: ""
        val callsign = prefs.getString("my_callsign", "") ?: ""
        val isParent = (role == "admin" || callsign.startsWith("РОДИТЕЛЬ"))
        if (!isParent && !GuardianAccessibilityService.isRunning()) {
            val expected = ComponentName(this, GuardianAccessibilityService::class.java).flattenToString()
            val enabled = Settings.Secure.getString(contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: ""
            if (!enabled.contains(expected) && !enabled.contains(packageName)) {
                android.app.AlertDialog.Builder(this)
                    .setTitle("🛡️ Защита Guardian (Спец. возможности)")
                    .setMessage("Для 100% надежного автозапуска и автоматического включения геолокации без участия ребенка включите службу 'AeroPTT / Guardian' в Спец. возможностях.")
                    .setPositiveButton("Включить") { _, _ ->
                        try {
                            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
                        } catch (e: Exception) {}
                    }
                    .setNegativeButton("Позже", null)
                    .show()
            }
        }
    }

    fun applyPowerSaverUI(enabled: Boolean) {
        try {
            val lp = window.attributes
            if (enabled) {
                lp.screenBrightness = 0.01f
            } else {
                lp.screenBrightness = -1.0f
            }
            window.attributes = lp
            webView.evaluateJavascript(
                "if(window.app && window.app.onPowerSaverToggled) window.app.onPowerSaverToggled($enabled);",
                null
            )
        } catch (e: Exception) {}
    }

    private fun checkAndRequestPermissions() {
        val permissions = mutableListOf(
            Manifest.permission.RECORD_AUDIO,
            Manifest.permission.CAMERA,
            Manifest.permission.INTERNET,
            Manifest.permission.ACCESS_NETWORK_STATE,
            Manifest.permission.ACCESS_WIFI_STATE,
            Manifest.permission.CHANGE_WIFI_MULTICAST_STATE,
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            permissions.add(Manifest.permission.POST_NOTIFICATIONS)
        }

        val needed = permissions.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }

        if (needed.isNotEmpty()) {
            ActivityCompat.requestPermissions(this, needed.toTypedArray(), PERMISSIONS_REQUEST_CODE)
        }
    }

    private fun setupWebView() {
        webView = WebView(this)
        setContentView(webView)

        udpTransceiver = UDPTransceiver(this, webView).apply {
            start()
        }

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            cacheMode = WebSettings.LOAD_DEFAULT
            allowFileAccess = true
            allowContentAccess = true
            setGeolocationEnabled(true)
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            WebView.setWebContentsDebuggingEnabled(true)
        }

        webView.addJavascriptInterface(NativeAppBridge(this), "AndroidNative")

        webView.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(consoleMessage: android.webkit.ConsoleMessage?): Boolean {
                Log.d("WebViewConsole", "${consoleMessage?.message()} -- line ${consoleMessage?.lineNumber()} of ${consoleMessage?.sourceId()}")
                return true
            }

            override fun onPermissionRequest(request: PermissionRequest?) {
                request?.grant(request.resources)
            }

            override fun onJsAlert(view: WebView?, url: String?, message: String?, result: JsResult?): Boolean {
                if (isFinishing || isDestroyed) return false
                androidx.appcompat.app.AlertDialog.Builder(this@MainActivity)
                    .setTitle("Guardian Kids")
                    .setMessage(message ?: "")
                    .setPositiveButton("OK") { _, _ -> result?.confirm() }
                    .setOnCancelListener { result?.cancel() }
                    .show()
                return true
            }

            override fun onJsConfirm(view: WebView?, url: String?, message: String?, result: JsResult?): Boolean {
                if (isFinishing || isDestroyed) return false
                androidx.appcompat.app.AlertDialog.Builder(this@MainActivity)
                    .setTitle("Guardian Kids")
                    .setMessage(message ?: "")
                    .setPositiveButton("Да") { _, _ -> result?.confirm() }
                    .setNegativeButton("Отмена") { _, _ -> result?.cancel() }
                    .setOnCancelListener { result?.cancel() }
                    .show()
                return true
            }

            override fun onJsPrompt(view: WebView?, url: String?, message: String?, defaultValue: String?, result: JsPromptResult?): Boolean {
                if (isFinishing || isDestroyed) return false
                val input = android.widget.EditText(this@MainActivity).apply {
                    setText(defaultValue ?: "")
                    setSelection(text.length)
                }
                androidx.appcompat.app.AlertDialog.Builder(this@MainActivity)
                    .setTitle("Guardian Kids")
                    .setMessage(message ?: "")
                    .setView(input)
                    .setPositiveButton("OK") { _, _ -> result?.confirm(input.text.toString()) }
                    .setNegativeButton("Отмена") { _, _ -> result?.cancel() }
                    .setOnCancelListener { result?.cancel() }
                    .show()
                return true
            }

            override fun onGeolocationPermissionsShowPrompt(
                origin: String?,
                callback: android.webkit.GeolocationPermissions.Callback?
            ) {
                callback?.invoke(origin, true, false)
            }

            override fun onShowFileChooser(
                webView: WebView?,
                filePathCallback: android.webkit.ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?
            ): Boolean {
                fileChooserCallback?.onReceiveValue(null)
                fileChooserCallback = filePathCallback
                try {
                    val intent = fileChooserParams?.createIntent() ?: Intent(Intent.ACTION_GET_CONTENT).apply {
                        type = "image/*"
                    }
                    startActivityForResult(intent, FILE_CHOOSER_REQUEST_CODE)
                    return true
                } catch (e: Exception) {
                    fileChooserCallback = null
                    return false
                }
            }
        }

        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                handleIncomingCallIntent(intent)
            }
        }
        webView.loadUrl("file:///android_asset/public/index.html")
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == FILE_CHOOSER_REQUEST_CODE) {
            val result = WebChromeClient.FileChooserParams.parseResult(resultCode, data)
            fileChooserCallback?.onReceiveValue(result)
            fileChooserCallback = null
        } else if (requestCode == NATIVE_CAMERA_REQUEST_CODE && resultCode == RESULT_OK) {
            try {
                var bitmap: Bitmap? = null
                val prefs = getSharedPreferences("AeroPTTPrefs", Context.MODE_PRIVATE)
                val uriString = prefs.getString("pending_photo_uri", null)
                
                var imageUri = data?.data
                if (imageUri == null && uriString != null) {
                    imageUri = Uri.parse(uriString)
                }

                if (imageUri != null) {
                    bitmap = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                        ImageDecoder.decodeBitmap(ImageDecoder.createSource(contentResolver, imageUri))
                    } else {
                        @Suppress("DEPRECATION")
                        MediaStore.Images.Media.getBitmap(contentResolver, imageUri)
                    }
                } else {
                    bitmap = data?.extras?.get("data") as? Bitmap
                }
                
                prefs.edit().remove("pending_photo_uri").apply()
                if (bitmap != null) {
                    processAndSendBitmap(bitmap)
                }
            } catch (e: Exception) {
                Log.e("Guardian", "Camera result error: ${e.message}")
            }
        } else if (requestCode == NATIVE_GALLERY_REQUEST_CODE && resultCode == RESULT_OK && data?.data != null) {
            try {
                val uri = data.data!!
                val bitmap: Bitmap? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    ImageDecoder.decodeBitmap(ImageDecoder.createSource(contentResolver, uri))
                } else {
                    @Suppress("DEPRECATION")
                    MediaStore.Images.Media.getBitmap(contentResolver, uri)
                }
                if (bitmap != null) {
                    processAndSendBitmap(bitmap)
                }
            } catch (e: Exception) {
                Log.e("Guardian", "Gallery result error: ${e.message}")
            }
        } else if (requestCode == NATIVE_VIDEO_REQUEST_CODE && resultCode == RESULT_OK) {
            try {
                val prefs = getSharedPreferences("AeroPTTPrefs", Context.MODE_PRIVATE)
                val uriString = prefs.getString("pending_video_uri", null)
                var videoUri = data?.data
                if (videoUri == null && uriString != null) {
                    videoUri = Uri.parse(uriString)
                }
                prefs.edit().remove("pending_video_uri").apply()
                if (videoUri != null) {
                    processAndSendVideo(videoUri)
                }
            } catch (e: Exception) {
                Log.e("Guardian", "Video result error: ${e.message}")
            }
        }
    }

    private fun processAndSendBitmap(bitmap: Bitmap) {
        thread {
            try {
                val maxDim = 1280 // High definition HD mobile resolution
                var width = bitmap.width
                var height = bitmap.height
                if (width > maxDim || height > maxDim) {
                    if (width > height) {
                        height = (height * maxDim) / width
                        width = maxDim
                    } else {
                        width = (width * maxDim) / height
                        height = maxDim
                    }
                }
                val scaled = Bitmap.createScaledBitmap(bitmap, width, height, true)
                var quality = 75
                var baos = ByteArrayOutputStream()
                scaled.compress(Bitmap.CompressFormat.JPEG, quality, baos)
                while (baos.size() > 140000 && quality > 35) {
                    quality -= 10
                    baos = ByteArrayOutputStream()
                    scaled.compress(Bitmap.CompressFormat.JPEG, quality, baos)
                }
                val bytes = baos.toByteArray()
                val b64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
                val dataUri = "data:image/jpeg;base64,$b64"

                runOnUiThread {
                    webView.evaluateJavascript(
                        "if(window.app && window.app.onNativePhotoCaptured) window.app.onNativePhotoCaptured('$dataUri');",
                        null
                    )
                }
            } catch (e: Exception) {
                Log.e("Guardian", "Bitmap process error: ${e.message}")
            }
        }
    }

    private fun processAndSendVideo(videoUri: Uri) {
        thread {
            try {
                val inputStream = contentResolver.openInputStream(videoUri) ?: return@thread
                val bytes = inputStream.readBytes()
                inputStream.close()
                val b64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
                val dataUri = "data:video/mp4;base64,$b64"

                val chunkSize = 32768
                val totalChunks = (dataUri.length + chunkSize - 1) / chunkSize
                val videoId = "vnative_" + System.currentTimeMillis()

                runOnUiThread {
                    webView.evaluateJavascript(
                        "if(window.app && window.app.startNativeVideoReceive) window.app.startNativeVideoReceive('$videoId', $totalChunks);",
                        null
                    )
                }

                for (i in 0 until totalChunks) {
                    val start = i * chunkSize
                    val end = minOf(start + chunkSize, dataUri.length)
                    val chunk = dataUri.substring(start, end)
                    Thread.sleep(15)
                    runOnUiThread {
                        webView.evaluateJavascript(
                            "if(window.app && window.app.appendNativeVideoChunk) window.app.appendNativeVideoChunk('$videoId', $i, '$chunk');",
                            null
                        )
                    }
                }
            } catch (e: Exception) {
                Log.e("Guardian", "Video process error: ${e.message}")
            }
        }
    }

    inner class NativeAppBridge(private val activity: MainActivity) {

        @JavascriptInterface
        fun openRealtimeCamera() {
            activity.runOnUiThread {
                try {
                    val intent = Intent(MediaStore.ACTION_IMAGE_CAPTURE)
                    val photoFile = java.io.File(activity.cacheDir, "temp_photo.jpg")
                    val uri = androidx.core.content.FileProvider.getUriForFile(
                        activity,
                        "${activity.packageName}.fileprovider",
                        photoFile
                    )
                    val prefs = activity.getSharedPreferences("AeroPTTPrefs", Context.MODE_PRIVATE)
                    prefs.edit().putString("pending_photo_uri", uri.toString()).apply()
                    intent.putExtra(MediaStore.EXTRA_OUTPUT, uri)
                    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
                    activity.startActivityForResult(intent, NATIVE_CAMERA_REQUEST_CODE)
                } catch (e: Exception) {
                    try {
                        val intent = Intent(Intent.ACTION_GET_CONTENT).apply { type = "image/*" }
                        activity.startActivityForResult(intent, NATIVE_CAMERA_REQUEST_CODE)
                    } catch (e2: Exception) {}
                }
            }
        }

        @JavascriptInterface
        fun openPhotoGallery() {
            activity.runOnUiThread {
                try {
                    val intent = Intent(Intent.ACTION_PICK, MediaStore.Images.Media.EXTERNAL_CONTENT_URI)
                    activity.startActivityForResult(intent, NATIVE_GALLERY_REQUEST_CODE)
                } catch (e: Exception) {
                    try {
                        val intent = Intent(Intent.ACTION_GET_CONTENT).apply { type = "image/*" }
                        activity.startActivityForResult(intent, NATIVE_GALLERY_REQUEST_CODE)
                    } catch (e2: Exception) {}
                }
            }
        }

        @JavascriptInterface
        fun openRealtimeVideo() {
            activity.runOnUiThread {
                try {
                    val intent = Intent(MediaStore.ACTION_VIDEO_CAPTURE)
                    val videoFile = java.io.File(activity.cacheDir, "temp_video.mp4")
                    val uri = androidx.core.content.FileProvider.getUriForFile(
                        activity,
                        "${activity.packageName}.fileprovider",
                        videoFile
                    )
                    val prefs = activity.getSharedPreferences("AeroPTTPrefs", Context.MODE_PRIVATE)
                    prefs.edit().putString("pending_video_uri", uri.toString()).apply()
                    intent.putExtra(MediaStore.EXTRA_OUTPUT, uri)
                    intent.putExtra(MediaStore.EXTRA_VIDEO_QUALITY, 0) // Standard compact quality suitable for instant mobile messaging
                    intent.putExtra(MediaStore.EXTRA_DURATION_LIMIT, 10) // 10 seconds max duration
                    intent.putExtra(MediaStore.EXTRA_SIZE_LIMIT, 2097152L) // 2MB limit
                    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
                    activity.startActivityForResult(intent, NATIVE_VIDEO_REQUEST_CODE)
                } catch (e: Exception) {
                    try {
                        val intent = Intent(Intent.ACTION_GET_CONTENT).apply { type = "video/*" }
                        activity.startActivityForResult(intent, NATIVE_VIDEO_REQUEST_CODE)
                    } catch (e2: Exception) {}
                }
            }
        }

        @JavascriptInterface
        fun setPowerSaverMode(enabled: Boolean) {
            activity.runOnUiThread {
                activity.applyPowerSaverUI(enabled)
            }
            try {
                val intent = Intent(activity, PTTForegroundService::class.java).apply {
                    putExtra("cmd_power_saver", enabled)
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    activity.startForegroundService(intent)
                } else {
                    activity.startService(intent)
                }
            } catch (e: Exception) {}
        }

        @JavascriptInterface
        fun getLatestLocationJson(): String {
            return try {
                val lm = activity.getSystemService(Context.LOCATION_SERVICE) as LocationManager
                val loc = lm.getLastKnownLocation(LocationManager.GPS_PROVIDER)
                    ?: lm.getLastKnownLocation(LocationManager.NETWORK_PROVIDER)
                    ?: lm.getLastKnownLocation(LocationManager.PASSIVE_PROVIDER)
                if (loc != null) {
                    val obj = org.json.JSONObject().apply {
                        put("lat", loc.latitude)
                        put("lng", loc.longitude)
                        put("accuracy", loc.accuracy)
                    }
                    obj.toString()
                } else {
                    "{}"
                }
            } catch (e: Exception) {
                "{}"
            }
        }

        @JavascriptInterface
        fun sendBroadcast(base64Data: String) {
            udpTransceiver?.sendBroadcast(base64Data)
        }

        @JavascriptInterface
        fun getInstalledAppsJson(): String {
            return try {
                val pm = activity.packageManager
                val mainIntent = Intent(Intent.ACTION_MAIN, null).apply {
                    addCategory(Intent.CATEGORY_LAUNCHER)
                }
                val resolveInfos = pm.queryIntentActivities(mainIntent, 0)
                val array = org.json.JSONArray()
                for (info in resolveInfos) {
                    val pkg = info.activityInfo.packageName
                    if (pkg == activity.packageName) continue
                    val label = info.loadLabel(pm).toString()
                    val obj = org.json.JSONObject()
                    obj.put("name", label)
                    obj.put("pkg", pkg)
                    array.put(obj)
                }
                array.toString()
            } catch (e: Exception) {
                "[]"
            }
        }

        @JavascriptInterface
        fun forceEnableGps() {
            activity.runOnUiThread {
                try {
                    GuardianAccessibilityService.requestAutoGpsEnable(activity)
                    activity.policyController.forceEnableGpsLocation()
                } catch (e: Exception) {}
            }
        }

        @JavascriptInterface
        fun startGpsTraining() {}

        @JavascriptInterface
        fun testGpsMacro() {}

        @JavascriptInterface
        fun clearGpsMacro() {}

        @JavascriptInterface
        fun getGpsMacroInfo(): String {
            val obj = org.json.JSONObject()
            obj.put("isCalibrated", false)
            obj.put("stepCount", 0)
            obj.put("x", 0)
            obj.put("y", 0)
            obj.put("isAccessibilityRunning", true)
            return obj.toString()
        }

        @JavascriptInterface
        fun checkAndClearUpdateNotice(): String {
            val prefs = activity.getSharedPreferences("AeroPTTPrefs", Context.MODE_PRIVATE)
            val currentCode = activity.otaManager.getCurrentVersionCode()
            val currentName = activity.otaManager.getCurrentVersionName()
            val lastCode = prefs.getInt("last_known_version_code", -1)
            val justUpdatedFlag = prefs.getBoolean("app_just_updated", false)

            val isUpdated = justUpdatedFlag || (lastCode != -1 && currentCode > lastCode)

            if (isUpdated || lastCode == -1) {
                prefs.edit()
                    .putBoolean("app_just_updated", false)
                    .putInt("last_known_version_code", currentCode)
                    .putString("last_known_version_name", currentName)
                    .apply()
            }

            val obj = org.json.JSONObject()
            obj.put("isJustUpdated", isUpdated)
            obj.put("versionName", currentName)
            obj.put("versionCode", currentCode)
            obj.put("message", "Приложение Guardian Kids успешно обновлено до версии v$currentName!")
            return obj.toString()
        }

        @JavascriptInterface
        fun forceUnmute() {
            activity.runOnUiThread {
                activity.policyController.forceUnmuteAndOverrideDnd()
            }
        }

        @JavascriptInterface
        fun requestBiometric() {
            activity.promptBiometricAuth()
        }

        @JavascriptInterface
        fun setMyCallsign(callsign: String) {
            val prefs = activity.getSharedPreferences("AeroPTTPrefs", Context.MODE_PRIVATE)
            prefs.edit().putString("my_callsign", callsign).apply()
            try {
                val intent = Intent(activity, PTTForegroundService::class.java).apply {
                    putExtra("my_callsign", callsign)
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    activity.startForegroundService(intent)
                } else {
                    activity.startService(intent)
                }
            } catch (e: Exception) {}
        }

        @JavascriptInterface
        fun setAppRole(role: String) {
            val prefs = activity.getSharedPreferences("AeroPTTPrefs", Context.MODE_PRIVATE)
            prefs.edit().putString("app_role", role).apply()
            try {
                val intent = Intent(activity, PTTForegroundService::class.java).apply {
                    putExtra("app_role", role)
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    activity.startForegroundService(intent)
                } else {
                    activity.startService(intent)
                }
            } catch (e: Exception) {}
        }

        @JavascriptInterface
        fun setChildId(childId: String) {
            val prefs = activity.getSharedPreferences("AeroPTTPrefs", Context.MODE_PRIVATE)
            prefs.edit().putString("child_id", childId).apply()
            try {
                val intent = Intent(activity, PTTForegroundService::class.java).apply {
                    putExtra("child_id", childId)
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    activity.startForegroundService(intent)
                } else {
                    activity.startService(intent)
                }
            } catch (e: Exception) {}
        }

        @JavascriptInterface
        fun getBatteryLevel(): Int {
            return try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                    val bm = activity.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
                    val cap = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
                    if (cap > 0) cap else 100
                } else {
                    100
                }
            } catch (e: Exception) {
                100
            }
        }

        @JavascriptInterface
        fun launchPackage(packageName: String): Boolean {
            activity.runOnUiThread {
                try {
                    if (packageName.equals("phone", ignoreCase = true) || packageName.contains("dial", ignoreCase = true)) {
                        val dialIntent = Intent(Intent.ACTION_DIAL).apply {
                            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        }
                        activity.startActivity(dialIntent)
                    } else {
                        val intent = activity.packageManager.getLaunchIntentForPackage(packageName)
                        if (intent != null) {
                            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
                            activity.startActivity(intent)
                        }
                    }
                } catch (e: Exception) {}
            }
            return true
        }

        @JavascriptInterface
        fun setDeviceSilentMode(isSilent: Boolean) {
            activity.runOnUiThread {
                try {
                    val audioManager = activity.getSystemService(Context.AUDIO_SERVICE) as AudioManager
                    val notificationManager = activity.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                    if (isSilent) {
                        try {
                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && notificationManager.isNotificationPolicyAccessGranted) {
                                notificationManager.setInterruptionFilter(NotificationManager.INTERRUPTION_FILTER_PRIORITY)
                                audioManager.ringerMode = AudioManager.RINGER_MODE_SILENT
                            } else {
                                audioManager.ringerMode = AudioManager.RINGER_MODE_VIBRATE
                            }
                        } catch (e: Exception) {
                            try { audioManager.ringerMode = AudioManager.RINGER_MODE_VIBRATE } catch (e2: Exception) {}
                        }
                        audioManager.setStreamVolume(AudioManager.STREAM_RING, 0, 0)
                        audioManager.setStreamVolume(AudioManager.STREAM_NOTIFICATION, 0, 0)
                        audioManager.setStreamVolume(AudioManager.STREAM_MUSIC, 0, 0)
                    } else {
                        try {
                            audioManager.ringerMode = AudioManager.RINGER_MODE_NORMAL
                        } catch (e: Exception) {}
                        val streams = intArrayOf(
                            AudioManager.STREAM_RING,
                            AudioManager.STREAM_NOTIFICATION,
                            AudioManager.STREAM_VOICE_CALL,
                            AudioManager.STREAM_MUSIC,
                            AudioManager.STREAM_ALARM
                        )
                        for (s in streams) {
                            val max = audioManager.getStreamMaxVolume(s)
                            audioManager.setStreamVolume(s, max, 0)
                        }
                    }
                } catch (e: Exception) {}
            }
        }

        @JavascriptInterface
        fun notifyIncomingCall(callerName: String, ch: Int) {
            val serviceIntent = Intent(activity, PTTForegroundService::class.java).apply {
                putExtra("show_incoming_call", true)
                putExtra("caller_name", callerName)
                putExtra("caller_channel", ch)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                activity.startForegroundService(serviceIntent)
            } else {
                activity.startService(serviceIntent)
            }
        }

        @JavascriptInterface
        fun getAppVersionInfo(): String {
            val code = activity.otaManager.getCurrentVersionCode()
            val name = activity.otaManager.getCurrentVersionName()
            val obj = org.json.JSONObject()
            obj.put("versionCode", code)
            obj.put("versionName", name)
            return obj.toString()
        }

        @JavascriptInterface
        fun checkForOtaUpdate(manifestUrl: String) {
            activity.otaManager.checkForUpdates(manifestUrl, object : OtaUpdateManager.OtaCallback {
                override fun onUpdateAvailable(versionName: String, versionCode: Int, changelog: String, apkUrl: String) {
                    activity.runOnUiThread {
                        val safeNotes = changelog.replace("'", "\\'")
                        activity.webView.evaluateJavascript(
                            "if(window.app && window.app.onOtaUpdateAvailable) window.app.onOtaUpdateAvailable('$versionName', $versionCode, '$safeNotes', '$apkUrl');",
                            null
                        )
                    }
                }

                override fun onNoUpdateAvailable(currentVersion: String) {
                    activity.runOnUiThread {
                        activity.webView.evaluateJavascript(
                            "if(window.app && window.app.onOtaNoUpdate) window.app.onOtaNoUpdate('$currentVersion');",
                            null
                        )
                    }
                }

                override fun onDownloadProgress(progressPercent: Int, downloadedBytes: Long, totalBytes: Long) {
                    activity.runOnUiThread {
                        activity.webView.evaluateJavascript(
                            "if(window.app && window.app.onOtaProgress) window.app.onOtaProgress($progressPercent, $downloadedBytes, $totalBytes);",
                            null
                        )
                    }
                }

                override fun onDownloadComplete(apkFile: java.io.File) {
                    activity.runOnUiThread {
                        activity.webView.evaluateJavascript(
                            "if(window.app && window.app.onOtaDownloadComplete) window.app.onOtaDownloadComplete();",
                            null
                        )
                    }
                }

                override fun onError(error: String) {
                    activity.runOnUiThread {
                        val safeErr = error.replace("'", "\\'")
                        activity.webView.evaluateJavascript(
                            "if(window.app && window.app.onOtaError) window.app.onOtaError('$safeErr');",
                            null
                        )
                    }
                }
            })
        }

        @JavascriptInterface
        fun startOtaDownload(apkUrl: String) {
            activity.otaManager.downloadAndInstallApk(apkUrl, object : OtaUpdateManager.OtaCallback {
                override fun onUpdateAvailable(versionName: String, versionCode: Int, changelog: String, apkUrl: String) {}
                override fun onNoUpdateAvailable(currentVersion: String) {}

                override fun onDownloadProgress(progressPercent: Int, downloadedBytes: Long, totalBytes: Long) {
                    activity.runOnUiThread {
                        activity.webView.evaluateJavascript(
                            "if(window.app && window.app.onOtaProgress) window.app.onOtaProgress($progressPercent, $downloadedBytes, $totalBytes);",
                            null
                        )
                    }
                }

                override fun onDownloadComplete(apkFile: java.io.File) {
                    activity.runOnUiThread {
                        activity.webView.evaluateJavascript(
                            "if(window.app && window.app.onOtaDownloadComplete) window.app.onOtaDownloadComplete();",
                            null
                        )
                    }
                }

                override fun onError(error: String) {
                    activity.runOnUiThread {
                        val safeErr = error.replace("'", "\\'")
                        activity.webView.evaluateJavascript(
                            "if(window.app && window.app.onOtaError) window.app.onOtaError('$safeErr');",
                            null
                        )
                    }
                }
            })
        }

        @JavascriptInterface
        fun isUnknownAppSourcesAllowed(): Boolean {
            return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                activity.packageManager.canRequestPackageInstalls()
            } else {
                true
            }
        }

        @JavascriptInterface
        fun requestUnknownAppSourcesPermission() {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                try {
                    val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES).apply {
                        data = Uri.parse("package:${activity.packageName}")
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    activity.startActivity(intent)
                } catch (e: Exception) {}
            }
        }

        @JavascriptInterface
        fun openOemAutostartSettings() {
            activity.runOnUiThread {
                val intents = arrayOf(
                    Intent().setComponent(ComponentName("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity")),
                    Intent().setComponent(ComponentName("com.huawei.systemmanager", "com.huawei.systemmanager.optimize.process.ProtectActivity")),
                    Intent().setComponent(ComponentName("com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity")),
                    Intent().setComponent(ComponentName("com.samsung.android.lool", "com.samsung.android.sm.ui.battery.BatteryActivity")),
                    Intent().setComponent(ComponentName("com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity")),
                    Intent().setComponent(ComponentName("com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"))
                )
                for (intent in intents) {
                    try {
                        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        activity.startActivity(intent)
                        return@runOnUiThread
                    } catch (e: Exception) {}
                }
                try {
                    val appInfoIntent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                        data = Uri.parse("package:${activity.packageName}")
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    activity.startActivity(appInfoIntent)
                } catch (e: Exception) {}
            }
        }

        @JavascriptInterface
        fun isAccessibilityServiceEnabled(): Boolean {
            if (GuardianAccessibilityService.isRunning()) return true
            return try {
                val expected = ComponentName(activity, GuardianAccessibilityService::class.java).flattenToString()
                val enabled = Settings.Secure.getString(
                    activity.contentResolver,
                    Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
                ) ?: ""
                enabled.contains(expected) || enabled.contains(activity.packageName)
            } catch (e: Exception) {
                false
            }
        }

        @JavascriptInterface
        fun openAccessibilitySettings() {
            activity.runOnUiThread {
                try {
                    val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).apply {
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    activity.startActivity(intent)
                } catch (e: Exception) {}
            }
        }

        @JavascriptInterface
        fun openAppDetailsSettings() {
            activity.runOnUiThread {
                try {
                    val appInfoIntent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                        data = Uri.parse("package:${activity.packageName}")
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    activity.startActivity(appInfoIntent)
                } catch (e: Exception) {
                    Log.e("NativeAppBridge", "Cannot open app details: ${e.message}")
                }
            }
        }

        @JavascriptInterface
        fun canAuthenticateBiometric(): Boolean {
            return try {
                val bm = androidx.biometric.BiometricManager.from(activity)
                bm.canAuthenticate(androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG or androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK) == androidx.biometric.BiometricManager.BIOMETRIC_SUCCESS
            } catch (e: Exception) {
                false
            }
        }

        @JavascriptInterface
        fun showSystemNotification(title: String, message: String, isHighPriority: Boolean) {
            activity.runOnUiThread {
                try {
                    val nm = activity.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                    val channelId = "guardian_events_channel"
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        val importance = if (isHighPriority) NotificationManager.IMPORTANCE_HIGH else NotificationManager.IMPORTANCE_DEFAULT
                        val channel = NotificationChannel(channelId, "События и геозоны Guardian", importance).apply {
                            description = "Уведомления о перемещении ребенка и геозонах"
                            enableVibration(true)
                        }
                        nm.createNotificationChannel(channel)
                    }

                    val launchIntent = Intent(activity, MainActivity::class.java).apply {
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
                    }
                    val pendingIntent = PendingIntent.getActivity(
                        activity,
                        (System.currentTimeMillis() % 10000).toInt(),
                        launchIntent,
                        PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0)
                    )

                    val notif = NotificationCompat.Builder(activity, channelId)
                        .setContentTitle(title)
                        .setContentText(message)
                        .setStyle(NotificationCompat.BigTextStyle().bigText(message))
                        .setSmallIcon(android.R.drawable.ic_menu_compass)
                        .setContentIntent(pendingIntent)
                        .setAutoCancel(true)
                        .setPriority(if (isHighPriority) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT)
                        .setVibrate(longArrayOf(0, 250, 100, 250))
                        .build()

                    nm.notify((System.currentTimeMillis() % 10000).toInt(), notif)
                } catch (e: Exception) {
                    Log.e("Guardian", "showSystemNotification error: ${e.message}")
                }
            }
        }

        @JavascriptInterface
        fun saveGpsTapCoordinates(x: Float, y: Float) {
            val prefs = activity.getSharedPreferences("AeroPTTPrefs", Context.MODE_PRIVATE)
            prefs.edit().putFloat("gps_tap_x", x).putFloat("gps_tap_y", y).apply()
        }

        @JavascriptInterface
        fun setVolumePercent(percent: Int) {
            activity.runOnUiThread {
                try {
                    val am = activity.getSystemService(Context.AUDIO_SERVICE) as AudioManager
                    val streams = intArrayOf(AudioManager.STREAM_VOICE_CALL, AudioManager.STREAM_MUSIC, AudioManager.STREAM_RING)
                    for (s in streams) {
                        val max = am.getStreamMaxVolume(s)
                        val target = ((max * percent) / 100).coerceIn(0, max)
                        am.setStreamVolume(s, target, 0)
                    }
                } catch (e: Exception) {}
            }
        }
    }

    override fun onPause() {
        super.onPause()
        try {
            webView.onPause()
            webView.pauseTimers()
            udpTransceiver?.pauseMulticast()
        } catch (e: Exception) {}
    }

    override fun onResume() {
        super.onResume()
        try {
            webView.onResume()
            webView.resumeTimers()
            udpTransceiver?.resumeMulticast()

            val prefs = getSharedPreferences("AeroPTTPrefs", Context.MODE_PRIVATE)
            val pendingApkPath = prefs.getString("pending_install_apk_path", null)
            if (!pendingApkPath.isNullOrEmpty()) {
                val file = java.io.File(pendingApkPath)
                if (file.exists() && file.length() > 0) {
                    val allowed = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) packageManager.canRequestPackageInstalls() else true
                    if (allowed) {
                        prefs.edit().remove("pending_install_apk_path").apply()
                        otaManager.installApk(file)
                    }
                } else {
                    prefs.edit().remove("pending_install_apk_path").apply()
                }
            } else {
                otaManager.cleanupOldApks()
            }
        } catch (e: Exception) {}
    }

    override fun onDestroy() {
        udpTransceiver?.stop()
        super.onDestroy()
    }

    override fun onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack()
        } else {
            // Keep app in memory & background, do not destroy process!
            moveTaskToBack(true)
        }
    }
}
