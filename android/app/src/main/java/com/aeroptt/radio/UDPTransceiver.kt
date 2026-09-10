package com.aeroptt.radio

import android.content.Context
import android.net.wifi.WifiManager
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import kotlin.concurrent.thread

/**
 * High-Speed UDP Multicast & Broadcast Transceiver for Direct Phone-to-Phone P2P Radio
 */
class UDPTransceiver(private val context: Context, private val webView: WebView) {

    private val PORT = 8888
    private var socket: DatagramSocket? = null
    private var isRunning = false
    private var multicastLock: WifiManager.MulticastLock? = null
    private val mainHandler = Handler(Looper.getMainLooper())

    fun start() {
        if (isRunning) return
        isRunning = true

        try {
            // Acquire Wi-Fi Multicast Lock so Android allows receiving local broadcast packets
            val wifiManager = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            multicastLock = wifiManager.createMulticastLock("AeroPTT_MulticastLock").apply {
                setReferenceCounted(true)
                acquire()
            }

            socket = DatagramSocket(PORT).apply {
                broadcast = true
                reuseAddress = true
            }

            // Start background receiver loop
            thread(name = "UDP-Receiver-Thread") {
                val buffer = ByteArray(65535)
                while (isRunning) {
                    try {
                        val packet = DatagramPacket(buffer, buffer.size)
                        socket?.receive(packet)

                        val length = packet.length
                        if (length > 0) {
                            val dataCopy = buffer.copyOf(length)
                            val base64Str = Base64.encodeToString(dataCopy, Base64.NO_WRAP)

                            // Dispatch to WebView JavaScript engine
                            mainHandler.post {
                                webView.evaluateJavascript(
                                    "if(window.radioNetwork && window.radioNetwork.onNativeUdpPacket) window.radioNetwork.onNativeUdpPacket('$base64Str');",
                                    null
                                )
                            }
                        }
                    } catch (e: Exception) {
                        if (!isRunning) break
                    }
                }
            }
            Log.d("AeroPTT", "UDP Broadcast Transceiver started on port $PORT")
        } catch (e: Exception) {
            Log.e("AeroPTT", "Failed to start UDP socket: ${e.message}")
        }
    }

    @JavascriptInterface
    fun sendBroadcast(base64Data: String) {
        thread {
            try {
                val bytes = Base64.decode(base64Data, Base64.DEFAULT)
                val broadcastAddress = InetAddress.getByName("255.255.255.255")
                val packet = DatagramPacket(bytes, bytes.size, broadcastAddress, PORT)
                socket?.send(packet)
            } catch (e: Exception) {
                Log.w("AeroPTT", "UDP Send error: ${e.message}")
            }
        }
    }

    fun pauseMulticast() {
        try {
            if (multicastLock?.isHeld == true) {
                multicastLock?.release()
                Log.d("AeroPTT", "MulticastLock released for deep sleep")
            }
        } catch (e: Exception) {}
    }

    fun resumeMulticast() {
        try {
            if (multicastLock?.isHeld == false && isRunning) {
                multicastLock?.acquire()
                Log.d("AeroPTT", "MulticastLock acquired on resume")
            }
        } catch (e: Exception) {}
    }

    fun stop() {
        isRunning = false
        try {
            socket?.close()
            if (multicastLock?.isHeld == true) {
                multicastLock?.release()
            }
        } catch (e: Exception) {}
    }
}
