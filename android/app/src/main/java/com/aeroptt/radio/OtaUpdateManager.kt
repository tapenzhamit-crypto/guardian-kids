package com.aeroptt.radio

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import androidx.core.content.FileProvider
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

class OtaUpdateManager(private val context: Context) {

    private val client = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .followRedirects(true)
        .followSslRedirects(true)
        .build()

    interface OtaCallback {
        fun onUpdateAvailable(versionName: String, versionCode: Int, changelog: String, apkUrl: String)
        fun onNoUpdateAvailable(currentVersion: String)
        fun onDownloadProgress(progressPercent: Int, downloadedBytes: Long, totalBytes: Long)
        fun onDownloadComplete(apkFile: File)
        fun onError(error: String)
    }

    fun getCurrentVersionCode(): Int {
        return try {
            val pInfo = context.packageManager.getPackageInfo(context.packageName, 0)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                pInfo.longVersionCode.toInt()
            } else {
                @Suppress("DEPRECATION")
                pInfo.versionCode
            }
        } catch (e: Exception) {
            1
        }
    }

    fun getCurrentVersionName(): String {
        return try {
            val pInfo = context.packageManager.getPackageInfo(context.packageName, 0)
            pInfo.versionName ?: "1.0.0"
        } catch (e: Exception) {
            "1.0.0"
        }
    }

    fun checkForUpdates(manifestUrl: String, callback: OtaCallback) {
        thread(name = "OTA-Check-Thread") {
            val cleanUrl = manifestUrl.trim()
            try {
                // If the user entered a direct APK link:
                if (cleanUrl.endsWith(".apk", ignoreCase = true) || cleanUrl.contains(".apk?")) {
                    callback.onUpdateAvailable(
                        "Прямое обновление APK",
                        getCurrentVersionCode() + 1,
                        "Загрузка и установка APK по прямой ссылке",
                        cleanUrl
                    )
                    return@thread
                }

                val request = Request.Builder()
                    .url(cleanUrl)
                    .header("Cache-Control", "no-cache")
                    .header("User-Agent", "AeroPTT-Guardian-OTA")
                    .build()

                client.newCall(request).execute().use { response ->
                    if (!response.isSuccessful) {
                        callback.onError("Ошибка сервера обновлений: HTTP ${response.code} (${response.message})")
                        return@thread
                    }

                    val contentType = response.header("Content-Type", "")?.lowercase() ?: ""
                    if (contentType.contains("android.package-archive") || contentType.contains("application/octet-stream")) {
                        callback.onUpdateAvailable(
                            "Новая версия (APK)",
                            getCurrentVersionCode() + 1,
                            "Установка полученного APK файла",
                            cleanUrl
                        )
                        return@thread
                    }

                    val body = response.body?.string() ?: ""
                    try {
                        val json = JSONObject(body)
                        val remoteCode = json.optInt("versionCode", 1)
                        val remoteName = json.optString("versionName", "1.0.0")
                        val apkUrl = json.optString("apkUrl", "")
                        val changelog = json.optString("changelog", "Улучшения стабильности и безопасности")

                        val currentCode = getCurrentVersionCode()
                        if (remoteCode > currentCode && apkUrl.isNotEmpty()) {
                            callback.onUpdateAvailable(remoteName, remoteCode, changelog, apkUrl)
                        } else {
                            callback.onNoUpdateAvailable("${getCurrentVersionName()} (сборка $currentCode)")
                        }
                    } catch (e: Exception) {
                        callback.onError("Ответ сервера не является JSON-манифестом обновлений: ${body.take(120)}")
                    }
                }
            } catch (e: Exception) {
                Log.e("OTA", "Check update error: ${e.message}")
                callback.onError("Сбой проверки (проверьте URL или подключение): ${e.message}")
            }
        }
    }

    fun downloadAndInstallApk(apkUrl: String, callback: OtaCallback) {
        thread(name = "OTA-Download-Thread") {
            val cleanUrl = apkUrl.trim()
            try {
                val request = Request.Builder()
                    .url(cleanUrl)
                    .header("User-Agent", "AeroPTT-Guardian-OTA")
                    .build()

                client.newCall(request).execute().use { response ->
                    if (!response.isSuccessful) {
                        callback.onError("Ошибка загрузки APK: HTTP ${response.code} (${response.message})")
                        return@thread
                    }

                    val body = response.body ?: throw Exception("Пустой ответ сервера")
                    val totalBytes = body.contentLength()

                    val updateDir = File(context.cacheDir, "updates")
                    if (!updateDir.exists()) updateDir.mkdirs()
                    val apkFile = File(updateDir, "guardian_update.apk")
                    if (apkFile.exists()) apkFile.delete()

                    var inputStream: InputStream? = null
                    var outputStream: FileOutputStream? = null

                    try {
                        inputStream = body.byteStream()
                        outputStream = FileOutputStream(apkFile)

                        val buffer = ByteArray(16384)
                        var bytesRead: Int
                        var totalRead = 0L
                        var lastProgress = -1

                        while (inputStream.read(buffer).also { bytesRead = it } != -1) {
                            outputStream.write(buffer, 0, bytesRead)
                            totalRead += bytesRead

                            val progress = if (totalBytes > 0) {
                                ((totalRead * 100) / totalBytes).toInt()
                            } else {
                                -1
                            }

                            if (progress != lastProgress) {
                                lastProgress = progress
                                callback.onDownloadProgress(progress, totalRead, totalBytes)
                            }
                        }

                        outputStream.flush()

                        // Verify downloaded APK version before launching installer
                        try {
                            val pm = context.packageManager
                            val archiveInfo = pm.getPackageArchiveInfo(apkFile.absolutePath, 0)
                            if (archiveInfo != null) {
                                val apkCode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                                    archiveInfo.longVersionCode.toInt()
                                } else {
                                    archiveInfo.versionCode
                                }
                                val currentCode = getCurrentVersionCode()
                                if (apkCode <= currentCode) {
                                    Log.d("OTA", "Downloaded APK code $apkCode <= current $currentCode, already up to date")
                                    callback.onNoUpdateAvailable("${getCurrentVersionName()} (сборка $currentCode)")
                                    try { apkFile.delete() } catch (e: Exception) {}
                                    return@thread
                                }
                            }
                        } catch (e: Exception) {
                            Log.w("OTA", "Check archive info error: ${e.message}")
                        }

                        callback.onDownloadComplete(apkFile)
                        installApk(apkFile)
                    } finally {
                        try { inputStream?.close() } catch (e: Exception) {}
                        try { outputStream?.close() } catch (e: Exception) {}
                    }
                }
            } catch (e: Exception) {
                Log.e("OTA", "Download error: ${e.message}")
                callback.onError("Ошибка загрузки файла: ${e.message}")
            }
        }
    }

    fun installApk(apkFile: File) {
        try {
            if (!apkFile.exists() || apkFile.length() == 0L) {
                Log.e("OTA", "Downloaded APK is empty or does not exist")
                android.os.Handler(android.os.Looper.getMainLooper()).post {
                    android.widget.Toast.makeText(context, "Ошибка: Скачанный файл пуст", android.widget.Toast.LENGTH_LONG).show()
                }
                return
            }

            val prefs = context.getSharedPreferences("AeroPTTPrefs", Context.MODE_PRIVATE)

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                if (!context.packageManager.canRequestPackageInstalls()) {
                    prefs.edit().putString("pending_install_apk_path", apkFile.absolutePath).apply()
                    val settingsIntent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES).apply {
                        data = Uri.parse("package:${context.packageName}")
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    context.startActivity(settingsIntent)
                    return
                }
            }

            // Unknown sources already granted: clear pending flag so onResume won't loop!
            prefs.edit().remove("pending_install_apk_path").apply()

            startSystemInstallIntent(apkFile)
        } catch (e: Exception) {
            Log.e("OTA", "Install error: ${e.message}")
            android.os.Handler(android.os.Looper.getMainLooper()).post {
                android.widget.Toast.makeText(context, "Ошибка установки: ${e.message}", android.widget.Toast.LENGTH_LONG).show()
            }
        }
    }

    fun cleanupOldApks() {
        try {
            val cacheDir = context.cacheDir
            cacheDir.listFiles { f -> f.extension.equals("apk", ignoreCase = true) }?.forEach { f ->
                f.delete()
            }
        } catch (e: Exception) {}
    }

    private fun startSystemInstallIntent(apkFile: File) {
        try {
            val apkUri = FileProvider.getUriForFile(
                context,
                "${context.packageName}.fileprovider",
                apkFile
            )

            val installIntent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(apkUri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }

            context.startActivity(installIntent)
            Log.d("OTA", "Installer launched successfully for $apkFile")
        } catch (e: Exception) {
            Log.e("OTA", "startSystemInstallIntent error: ${e.message}")
            android.os.Handler(android.os.Looper.getMainLooper()).post {
                android.widget.Toast.makeText(context, "Ошибка запуска установки: ${e.message}", android.widget.Toast.LENGTH_LONG).show()
            }
        }
    }
}
