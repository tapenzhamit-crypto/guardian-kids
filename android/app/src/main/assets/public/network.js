/**
 * GUARDIAN - High-Reliability Dual-Network Mesh Layer
 * Multi-broker MQTT over WebSockets + Local Wi-Fi UDP Broadcast + Web BroadcastChannel
 * Auto-reconnecting on Wi-Fi, 4G, 5G, and network transitions.
 */

class RadioNetwork {
  constructor() {
    this.mqttClient = null;
    this.localBroadcast = new BroadcastChannel('guardian_local_bus');

    // Multi-broker fallback list for 100% uptime
    this.brokers = [
      'wss://broker.emqx.io:8084/mqtt',
      'wss://broker.hivemq.com:8884/mqtt'
    ];
    this.currentBrokerIdx = 0;

    let savedId = localStorage.getItem('guardian_client_uuid');
    if (!savedId) {
      savedId = 'G_' + Math.random().toString(36).substring(2, 9).toUpperCase();
      localStorage.setItem('guardian_client_uuid', savedId);
    }
    this.clientId = savedId;

    this.childId = localStorage.getItem('guardian_child_id') || '';
    this.role = localStorage.getItem('guardian_role') || 'admin';
    this.callsign = (this.role === 'admin') ? ('РОДИТЕЛЬ_' + this.childId) : ('РЕБЕНОК_' + this.childId);

    this.peers = new Map();
    this.myBattery = 100;
    this.myLocation = null;

    // Callbacks wired to app
    this.onPeerUpdate = null;
    this.onAudioChunk = null;
    this.onRemoteCommand = null;
    this.onLocationReceived = null;
    this.onPhotoReceived = null;
    this.onSosAlertReceived = null;
    this.onDisplacementAlertReceived = null;
    this.onGeofenceSync = null;
    this.onIncomingCall = null;
    this.isInternetConnected = false;
    this.processedMsgIds = new Set();

    // Watchdog and listeners
    window.addEventListener('online', () => {
      this._connectGlobalMqtt();
    });

    this._setupBroadcastChannel();
    this._startLocationWatcher();
    this._updateBattery();

    // Reconnection watchdog: checks connection every 3 seconds
    setInterval(() => {
      this._updateBattery();
      if (!this.mqttClient || !this.mqttClient.connected) {
        this._connectGlobalMqtt();
      }
    }, 3000);

    // Heartbeat presence broadcast every 2 seconds
    setInterval(() => this.broadcastPresence(false), 2000);
    setInterval(() => this._cleanupPeers(), 6000);
  }

  connectPair(childId, callsign, role) {
    this.childId = childId;
    this.callsign = callsign;
    this.role = role;

    localStorage.setItem('guardian_child_id', childId);
    localStorage.setItem('guardian_role', role);

    if (window.AndroidNative && window.AndroidNative.setChildId) {
      window.AndroidNative.setChildId(childId);
    }

    this._updateBattery();
    this._connectGlobalMqtt();
    this.broadcastPresence(false);
  }

  _updateBattery() {
    if (window.AndroidNative && window.AndroidNative.getBatteryLevel) {
      try {
        const lvl = window.AndroidNative.getBatteryLevel();
        if (lvl > 0 && lvl <= 100) {
          this.myBattery = lvl;
          return;
        }
      } catch (e) {}
    }

    if (navigator.getBattery) {
      navigator.getBattery().then(b => {
        this.myBattery = Math.round(b.level * 100);
      }).catch(() => {});
    }
  }

  _startLocationWatcher() {
    if (navigator.geolocation) {
      navigator.geolocation.watchPosition(
        (pos) => {
          this.myLocation = {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
            heading: pos.coords.heading || 0,
            speed: pos.coords.speed || 0,
            timestamp: Date.now()
          };
          this.broadcastPresence(false);
        },
        (err) => {},
        { enableHighAccuracy: true, maximumAge: 2000, timeout: 6000 }
      );
    }
  }

  _connectGlobalMqtt() {
    if (!window.mqtt || !this.childId) return;

    const brokerUrl = this.brokers[this.currentBrokerIdx % this.brokers.length];

    try {
      if (this.mqttClient) {
        try { this.mqttClient.end(true); } catch(e){}
      }

      this.mqttClient = mqtt.connect(brokerUrl, {
        clientId: 'GUARDIAN_' + this.clientId,
        clean: true,
        connectTimeout: 4000,
        reconnectPeriod: 2000,
        keepalive: 15
      });

      this.mqttClient.on('connect', () => {
        this.isInternetConnected = true;

        // Subscribe to dedicated child-parent channels
        this.mqttClient.subscribe(`guardian/${this.childId}/data`, { qos: 0 });
        this.mqttClient.subscribe(`guardian/${this.childId}/audio`, { qos: 0 });
        this.mqttClient.subscribe(`guardian/${this.childId}/call`, { qos: 0 });
        this.mqttClient.subscribe(`aeroptt/call/global`, { qos: 0 });

        this._updateBattery();
        this.broadcastPresence(false);
      });

      this.mqttClient.on('message', (topic, payload) => {
        const buffer = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
        this._handleData(buffer);
      });

      this.mqttClient.on('close', () => {
        this.isInternetConnected = false;
      });

      this.mqttClient.on('error', () => {
        this.isInternetConnected = false;
        this.currentBrokerIdx++;
      });
    } catch (e) {
      this.currentBrokerIdx++;
    }
  }

  _setupBroadcastChannel() {
    this.localBroadcast.onmessage = (e) => this._handleData(e.data);
  }

  onNativeUdpPacket(base64Str) {
    try {
      const binaryStr = atob(base64Str);
      const len = binaryStr.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      this._handleData(bytes.buffer);
    } catch (e) {}
  }

  _handleData(data) {
    if (typeof data === 'string') {
      try {
        const msg = JSON.parse(data);
        if (msg.senderId === this.clientId) return; // Ignore own echo

        // Message deduplication: drops repeat deliveries instantly
        if (msg.msgId) {
          if (this.processedMsgIds.has(msg.msgId)) return;
          this.processedMsgIds.add(msg.msgId);
          if (this.processedMsgIds.size > 200) {
            const first = this.processedMsgIds.values().next().value;
            this.processedMsgIds.delete(first);
          }
        }

        if (msg.type === 'presence') {
          this.peers.set(msg.senderId, {
            callsign: msg.callsign,
            role: msg.role,
            childId: msg.childId,
            childName: msg.childName,
            childAvatar: msg.childAvatar,
            profileUpdatedAt: msg.profileUpdatedAt || 0,
            battery: msg.battery,
            location: msg.location,
            lastSeen: Date.now()
          });
          if (this.role === 'admin' && msg.role === 'child') {
            if (msg.childName && window.app && window.app.onChildProfileUpdated) {
              window.app.onChildProfileUpdated(msg.childName, msg.childAvatar, msg.profileUpdatedAt || 0);
            }
          }
          if (this.onPeerUpdate) this.onPeerUpdate(this.peers);
          if (msg.location && this.onLocationReceived) {
            this.onLocationReceived(msg.senderId, msg.callsign, msg.location, msg.childName, msg.childAvatar);
          }
        } else if (msg.type === 'voice_ptt') {
          if (window.app && window.app.playVoicePtt) {
            window.app.playVoicePtt(msg.audio, msg.voiceFx || 'normal');
          }
        } else if (msg.type === 'cmd_power_saver') {
          if (this.role === 'child' && msg.senderId !== this.clientId) {
            if (window.AndroidNative && window.AndroidNative.setPowerSaverMode) {
              window.AndroidNative.setPowerSaverMode(msg.enabled);
            }
            if (window.app && window.app.onPowerSaverToggled) {
              window.app.onPowerSaverToggled(msg.enabled);
            }
          }
        } else if (msg.type === 'telemetry') {
          if (window.app && window.app.onTelemetryReceived) {
            window.app.onTelemetryReceived(msg);
          }
        } else if (msg.type === 'child_photo') {
          if (this.onPhotoReceived) {
            this.onPhotoReceived(msg);
          }
        } else if (msg.type === 'child_video') {
          if (this.onVideoReceived) {
            this.onVideoReceived(msg);
          }
        } else if (msg.type === 'child_video_chunk') {
          if (!this._incomingVideoChunks) this._incomingVideoChunks = {};
          if (!this._incomingVideoChunks[msg.videoId]) {
            this._incomingVideoChunks[msg.videoId] = {
              total: msg.total,
              received: 0,
              chunks: new Array(msg.total),
              meta: msg
            };
          }
          const vItem = this._incomingVideoChunks[msg.videoId];
          if (!vItem.chunks[msg.index]) {
            vItem.chunks[msg.index] = msg.chunk;
            vItem.received++;
          }
          if (vItem.received >= vItem.total) {
            const assembledVideo = vItem.chunks.join('');
            delete this._incomingVideoChunks[msg.videoId];
            if (this.onVideoReceived) {
              this.onVideoReceived({
                type: 'child_video',
                senderId: vItem.meta.senderId,
                senderCallsign: vItem.meta.senderCallsign,
                targetCallsign: vItem.meta.targetCallsign,
                video: assembledVideo,
                location: vItem.meta.location,
                timestamp: vItem.meta.timestamp
              });
            }
          }
        } else if (msg.type === 'alert_sos') {
          if (this.onSosAlertReceived) {
            this.onSosAlertReceived(msg);
          }
        } else if (msg.type === 'alert_displacement') {
          if (this.onDisplacementAlertReceived) {
            this.onDisplacementAlertReceived(msg);
          }
        } else if (msg.type === 'cmd_set_geofence') {
          if (this.onGeofenceSync) {
            this.onGeofenceSync(msg);
          }
        } else if (msg.type === 'cmd_set_silent_mode') {
          if (this.role === 'child' && msg.senderId !== this.clientId) {
            if (window.AndroidNative && window.AndroidNative.setDeviceSilentMode) {
              window.AndroidNative.setDeviceSilentMode(msg.silent);
            }
          }
        } else if (msg.type === 'cmd_launch_app') {
          if (this.role === 'child' && msg.senderId !== this.clientId) {
            if (window.AndroidNative && window.AndroidNative.launchPackage) {
              window.AndroidNative.launchPackage(msg.packageName || 'com.whatsapp');
            }
          }
        } else if (msg.type === 'req_installed_apps') {
          if (this.role === 'child' && msg.senderId !== this.clientId) {
            this._sendInstalledApps();
          }
        } else if (msg.type === 'resp_installed_apps') {
          if (this.onInstalledAppsReceived) {
            this.onInstalledAppsReceived(msg.apps || []);
          }
        } else if (msg.type === 'cmd_ambient_listen_start') {
          if (this.role === 'child' && msg.senderId !== this.clientId) {
            if (window.app && window.app.startAmbientAudioStream) {
              window.app.startAmbientAudioStream(msg.senderCallsign);
            }
          }
        } else if (msg.type === 'cmd_ambient_listen_stop') {
          if (this.role === 'child' && msg.senderId !== this.clientId) {
            if (window.app && window.app.stopAmbientAudioStream) {
              window.app.stopAmbientAudioStream();
            }
          }
        } else if (msg.type === 'cmd_enable_gps' || msg.type === 'req_location') {
          if (this.role === 'child' && msg.senderId !== this.clientId) {
            const enabled = (msg.enabled !== undefined) ? msg.enabled : true;
            if (window.AndroidNative && window.AndroidNative.forceEnableGps) {
              window.AndroidNative.forceEnableGps();
            }
            if (enabled) {
              this._respondWithLocation();
            }
          }
        } else if (msg.type === 'resp_location') {
          if (this.onLocationReceived) {
            this.onLocationReceived(msg.senderId, msg.callsign, msg.location);
          }
        } else if (msg.type === 'resp_location_denied') {
          if (this.onLocationDenied) {
            this.onLocationDenied(msg);
          }
        } else if (msg.type === 'alert_zone_event') {
          if (this.onZoneEventReceived) {
            this.onZoneEventReceived(msg);
          }
        } else if (msg.type === 'cmd_sync_zones') {
          if (this.role === 'child' && window.app && window.app.onZonesSyncedFromParent) {
            window.app.onZonesSyncedFromParent(msg.zones || []);
          }
        } else if (msg.type === 'cmd_update_child_profile') {
          if (msg.senderId !== this.clientId) {
            if (window.app && window.app.onProfileRemotelyUpdated) {
              window.app.onProfileRemotelyUpdated(msg.name, msg.avatar, msg.timestamp || 0);
            }
          }
        } else if (msg.type === 'cmd_sync_admin_pin') {
          if (this.role === 'child' && msg.pin) {
            if (window.app && window.app.onAdminPinSynced) {
              window.app.onAdminPinSynced(msg.pin);
            }
          }
        } else if (msg.type === 'cmd_remote_ota_update') {
          if (this.role === 'child') {
            console.log('[NETWORK] Received remote OTA update command:', msg.apkUrl);
            this.sendOtaStatusUpdate('downloading', 0, 'Команда принята, скачивание...');
            if (window.app && window.app.onRemoteOtaUpdateReceived) {
              window.app.onRemoteOtaUpdateReceived(msg.apkUrl);
            }
          }
        } else if (msg.type === 'resp_remote_ota_status') {
          if (this.role === 'admin' || this.role === 'parent') {
            console.log('[NETWORK] Received remote OTA status from child:', msg);
            if (window.app && window.app.onRemoteOtaStatusReceived) {
              window.app.onRemoteOtaStatusReceived(msg);
            }
          }
        } else if (msg.type === 'child_updated') {
          if ((this.role === 'admin' || this.role === 'parent') && window.app && window.app.onChildUpdatedNotice) {
            window.app.onChildUpdatedNotice(msg);
          }
        } else if (msg.type === 'direct_call') {
          if (this.onIncomingCall) {
            this.onIncomingCall(msg.senderCallsign || 'РОДИТЕЛЬ', 1);
          }
        }
      } catch (e) {}
    } else if (data instanceof ArrayBuffer) {
      const view = new DataView(data);
      if (data.byteLength > 2 && view.getUint8(0) === 0x50 && view.getUint8(1) === 0x54) {
        this._handleAudioPacket(data);
      } else {
        try {
          const text = new TextDecoder().decode(data);
          this._handleData(text);
        } catch (e) {}
      }
    }
  }

  _handleAudioPacket(buffer) {
    try {
      const view = new DataView(buffer);
      const senderIdLen = view.getUint8(3);
      const enc = new TextDecoder();
      const senderId = enc.decode(new Uint8Array(buffer, 4, senderIdLen));
      if (senderId === this.clientId) return; // Ignore own voice

      const callsignLen = view.getUint8(4 + senderIdLen);
      const callsign = enc.decode(new Uint8Array(buffer, 5 + senderIdLen, callsignLen));
      const isEncrypted = view.getUint8(5 + senderIdLen + callsignLen) === 1;
      const audioPayload = buffer.slice(6 + senderIdLen + callsignLen);

      if (this.onAudioChunk) {
        this.onAudioChunk(audioPayload, callsign, isEncrypted);
      }
    } catch (e) {}
  }

  _sendOut(data, customTopic = null) {
    if (!this.childId) return;

    const defaultTopic = (data instanceof ArrayBuffer)
      ? `guardian/${this.childId}/audio`
      : `guardian/${this.childId}/data`;

    const topic = customTopic || defaultTopic;

    // 1. Send via MQTT over Internet (Wi-Fi or Mobile 4G/5G)
    if (this.mqttClient && this.mqttClient.connected) {
      this.mqttClient.publish(topic, data, { qos: 0 });
    }

    // 2. Send via Web BroadcastChannel
    try {
      this.localBroadcast.postMessage(data);
    } catch (e) {}

    // 3. Send via Local Wi-Fi UDP Broadcast (safe for small control packets under 30KB)
    if (window.AndroidNative && window.AndroidNative.sendBroadcast) {
      try {
        if (typeof data === 'string' && data.length < 30000) {
          const b64 = btoa(unescape(encodeURIComponent(data)));
          window.AndroidNative.sendBroadcast(b64);
        } else if (data instanceof ArrayBuffer && data.byteLength < 30000) {
          let binary = '';
          const bytes = new Uint8Array(data);
          const len = bytes.byteLength;
          for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(bytes[i]);
          }
          window.AndroidNative.sendBroadcast(btoa(binary));
        }
      } catch (e) {}
    }
  }

  broadcastPresence(isTransmitting = false) {
    if (!this.childId) return;
    this._updateBattery();

    const profileUpdatedAt = parseInt(localStorage.getItem('guardian_profile_updated_at') || '0', 10);
    const msg = JSON.stringify({
      type: 'presence',
      senderId: this.clientId,
      callsign: this.callsign,
      role: this.role,
      childId: this.childId,
      childName: (this.role === 'child') ? (localStorage.getItem('guardian_child_name') || 'Ребенок') : undefined,
      childAvatar: (this.role === 'child') ? (localStorage.getItem('guardian_child_avatar') || '🧒') : undefined,
      profileUpdatedAt: profileUpdatedAt,
      isTransmitting: isTransmitting,
      battery: this.myBattery,
      location: this.myLocation,
      timestamp: Date.now()
    });
    this._sendOut(msg);
  }

  _respondWithLocation() {
    if (window.AndroidNative && window.AndroidNative.getLatestLocationJson) {
      try {
        const raw = window.AndroidNative.getLatestLocationJson();
        if (raw && raw !== '{}') {
          const parsed = JSON.parse(raw);
          if (parsed.lat && parsed.lng) {
            this.myLocation = {
              lat: parsed.lat,
              lng: parsed.lng,
              accuracy: parsed.accuracy || 10,
              timestamp: Date.now()
            };
            this._sendLocationPacket();
          }
        }
      } catch (e) {}
    }

    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition((pos) => {
        this.myLocation = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          timestamp: Date.now()
        };
        this._sendLocationPacket();
      }, (err) => {
        if (this.myLocation) {
          this._sendLocationPacket();
        }
      }, { enableHighAccuracy: true, timeout: 6000, maximumAge: 0 });
    } else if (this.myLocation) {
      this._sendLocationPacket();
    }
  }

  _sendLocationPacket() {
    if (!this.myLocation) return;
    const msg = JSON.stringify({
      type: 'resp_location',
      senderId: this.clientId,
      senderCallsign: this.callsign,
      callsign: this.callsign,
      location: this.myLocation,
      timestamp: Date.now()
    });
    this._sendOut(msg);
    this._sendOut(msg, `aeroptt/call/global`);
  }

  sendLocationRequest(targetCallsign) {
    const msg = JSON.stringify({
      type: 'req_location',
      enabled: true,
      senderId: this.clientId,
      senderCallsign: this.callsign,
      targetCallsign: targetCallsign,
      targetChildId: this.childId,
      timestamp: Date.now()
    });
    this._sendOut(msg);
    this._sendOut(msg, `aeroptt/call/global`);
  }

  sendDirectCall(targetCallsign) {
    const msg = JSON.stringify({
      type: 'direct_call',
      senderId: this.clientId,
      senderCallsign: this.callsign,
      targetCallsign: targetCallsign,
      timestamp: Date.now()
    });
    this._sendOut(msg);
    this._sendOut(msg, `aeroptt/call/global`);
  }

  sendPhoto(targetCallsign, base64Photo, location = null) {
    const msg = JSON.stringify({
      type: 'child_photo',
      senderId: this.clientId,
      senderCallsign: this.callsign,
      targetCallsign: targetCallsign,
      photo: base64Photo,
      location: location,
      timestamp: Date.now()
    });
    this._sendOut(msg);
  }

  sendVideo(targetCallsign, base64Video, location = null) {
    if (!base64Video) return;
    const chunkSize = 32000;
    const totalChunks = Math.ceil(base64Video.length / chunkSize);
    const videoId = 'vid_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);

    for (let i = 0; i < totalChunks; i++) {
      const chunkData = base64Video.substr(i * chunkSize, chunkSize);
      const chunkMsg = JSON.stringify({
        type: 'child_video_chunk',
        videoId: videoId,
        index: i,
        total: totalChunks,
        senderId: this.clientId,
        senderCallsign: this.callsign,
        targetCallsign: targetCallsign,
        location: location,
        chunk: chunkData,
        timestamp: Date.now()
      });
      setTimeout(() => {
        this._sendOut(chunkMsg);
      }, i * 35);
    }
  }

  sendSosAlert(targetCallsign, lat, lng) {
    const msg = JSON.stringify({
      type: 'alert_sos',
      senderId: this.clientId,
      senderCallsign: this.callsign,
      targetCallsign: targetCallsign,
      lat: lat,
      lng: lng,
      timestamp: Date.now()
    });
    this._sendOut(msg);
    this._sendOut(msg, `aeroptt/call/global`);
  }

  sendDisplacementAlert(targetCallsign, distanceMeters, lat, lng) {
    const msg = JSON.stringify({
      type: 'alert_displacement',
      senderId: this.clientId,
      senderCallsign: this.callsign,
      targetCallsign: targetCallsign,
      distanceMeters: Math.round(distanceMeters),
      lat: lat,
      lng: lng,
      timestamp: Date.now()
    });
    this._sendOut(msg);
  }

  sendGeofenceSync(targetCallsign, anchorLat, anchorLng, radiusMeters) {
    const msg = JSON.stringify({
      type: 'cmd_set_geofence',
      senderId: this.clientId,
      senderCallsign: this.callsign,
      targetCallsign: targetCallsign,
      anchorLat: anchorLat,
      anchorLng: anchorLng,
      radiusMeters: radiusMeters,
      timestamp: Date.now()
    });
    this._sendOut(msg);
  }

  sendRemoteGpsCommand(targetCallsign) {
    const msg = JSON.stringify({
      type: 'cmd_enable_gps',
      enabled: true,
      senderId: this.clientId,
      senderCallsign: this.callsign,
      targetCallsign: targetCallsign,
      targetChildId: this.childId,
      timestamp: Date.now()
    });
    this._sendOut(msg);
    this._sendOut(msg, `aeroptt/call/global`);
  }

  sendToggleChildGps(targetCallsign, enabled) {
    const msg = JSON.stringify({
      type: 'cmd_enable_gps',
      enabled: enabled,
      senderId: this.clientId,
      senderCallsign: this.callsign,
      targetCallsign: targetCallsign,
      targetChildId: this.childId,
      timestamp: Date.now()
    });
    this._sendOut(msg);
    this._sendOut(msg, `aeroptt/call/global`);
  }

  sendMuteCommand(targetCallsign, isSilent, volumePercent = 100) {
    const msg = JSON.stringify({
      type: 'cmd_set_silent_mode',
      senderId: this.clientId,
      senderCallsign: this.callsign,
      targetCallsign: targetCallsign,
      targetChildId: this.childId,
      silent: isSilent,
      volumePercent: volumePercent,
      timestamp: Date.now()
    });
    this._sendOut(msg);
    this._sendOut(msg, `aeroptt/call/global`);
  }

  sendUnmuteCommand(targetCallsign, volumePercent = 100) {
    const msg = JSON.stringify({
      type: 'cmd_unmute',
      senderId: this.clientId,
      senderCallsign: this.callsign,
      targetCallsign: targetCallsign,
      targetChildId: this.childId,
      volumePercent: volumePercent,
      timestamp: Date.now()
    });
    this._sendOut(msg);
    this._sendOut(msg, `aeroptt/call/global`);
  }

  sendRequestTelemetry(targetCallsign) {
    const msg = JSON.stringify({
      type: 'cmd_req_telemetry',
      senderId: this.clientId,
      senderCallsign: this.callsign,
      targetCallsign: targetCallsign,
      targetChildId: this.childId,
      timestamp: Date.now()
    });
    this._sendOut(msg);
    this._sendOut(msg, `aeroptt/call/global`);
  }

  sendLaunchAppCommand(targetCallsign, packageName) {
    const msg = JSON.stringify({
      type: 'cmd_launch_app',
      senderId: this.clientId,
      senderCallsign: this.callsign,
      targetCallsign: targetCallsign,
      targetChildId: this.childId,
      packageName: packageName,
      timestamp: Date.now()
    });
    this._sendOut(msg);
    this._sendOut(msg, `aeroptt/call/global`);
  }

  sendPowerSaverCommand(targetCallsign, enabled) {
    const msg = JSON.stringify({
      type: 'cmd_power_saver',
      senderId: this.clientId,
      senderCallsign: this.callsign,
      targetCallsign: targetCallsign,
      targetChildId: this.childId,
      enabled: enabled,
      timestamp: Date.now()
    });
    this._sendOut(msg);
    this._sendOut(msg, `aeroptt/call/global`);
  }

  sendVoicePtt(targetCallsign, base64Audio, voiceFx = 'normal') {
    const msg = JSON.stringify({
      type: 'voice_ptt',
      msgId: 'ptt_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
      senderId: this.clientId,
      senderCallsign: this.callsign,
      targetCallsign: targetCallsign,
      targetChildId: this.childId,
      audio: base64Audio,
      voiceFx: voiceFx || 'normal',
      timestamp: Date.now()
    });
    this._sendOut(msg);
  }

  sendRelaunchAppCommand(targetCallsign) {
    const msg = JSON.stringify({
      type: 'cmd_open_guardian',
      senderId: this.clientId,
      senderCallsign: this.callsign,
      targetCallsign: targetCallsign,
      targetChildId: this.childId,
      timestamp: Date.now()
    });
    this._sendOut(msg);
    this._sendOut(msg, `aeroptt/call/global`);
  }

  sendRemoteUpdateCommand(apkUrl) {
    const msg = JSON.stringify({
      type: 'cmd_remote_ota_update',
      senderId: this.clientId,
      senderCallsign: this.callsign,
      targetChildId: this.childId,
      apkUrl: apkUrl,
      timestamp: Date.now()
    });
    this._sendOut(msg);
    this._sendOut(msg, `aeroptt/call/global`);
  }

  sendOtaStatusUpdate(status, progress, message) {
    const msg = JSON.stringify({
      type: 'resp_remote_ota_status',
      senderId: this.clientId,
      senderCallsign: this.callsign,
      targetChildId: this.childId,
      status: status,
      progress: progress,
      message: message,
      timestamp: Date.now()
    });
    this._sendOut(msg);
    this._sendOut(msg, `aeroptt/call/global`);
  }

  sendChildUpdatedNotification(versionName, versionCode) {
    const msg = JSON.stringify({
      type: 'child_updated',
      senderId: this.clientId,
      senderCallsign: this.callsign,
      targetChildId: this.childId,
      versionName: versionName,
      versionCode: versionCode,
      timestamp: Date.now()
    });
    this._sendOut(msg);
    this._sendOut(msg, `aeroptt/call/global`);
  }

  sendChildUpdatedNotice(versionName, versionCode) {
    this.sendChildUpdatedNotification(versionName, versionCode);
  }

  _sendInstalledApps() {
    let apps = [];
    if (window.AndroidNative && window.AndroidNative.getInstalledAppsJson) {
      try {
        apps = JSON.parse(window.AndroidNative.getInstalledAppsJson());
      } catch(e) {}
    }
    const msg = JSON.stringify({
      type: 'resp_installed_apps',
      senderId: this.clientId,
      senderCallsign: this.callsign,
      targetChildId: this.childId,
      apps: apps,
      timestamp: Date.now()
    });
    this._sendOut(msg);
    this._sendOut(msg, `aeroptt/call/global`);
  }

  sendRequestInstalledApps(targetCallsign) {
    const msg = JSON.stringify({
      type: 'req_installed_apps',
      senderId: this.clientId,
      senderCallsign: this.callsign,
      targetCallsign: targetCallsign,
      targetChildId: this.childId,
      timestamp: Date.now()
    });
    this._sendOut(msg);
    this._sendOut(msg, `aeroptt/call/global`);
  }

  sendAmbientListenStart(targetCallsign) {
    const msg = JSON.stringify({
      type: 'cmd_ambient_listen_start',
      senderId: this.clientId,
      senderCallsign: this.callsign,
      targetCallsign: targetCallsign,
      targetChildId: this.childId,
      timestamp: Date.now()
    });
    this._sendOut(msg);
    this._sendOut(msg, `aeroptt/call/global`);
  }

  sendAmbientListenStop(targetCallsign) {
    const msg = JSON.stringify({
      type: 'cmd_ambient_listen_stop',
      senderId: this.clientId,
      senderCallsign: this.callsign,
      targetCallsign: targetCallsign,
      targetChildId: this.childId,
      timestamp: Date.now()
    });
    this._sendOut(msg);
    this._sendOut(msg, `aeroptt/call/global`);
  }

  confirmAndSendLocation(targetCallsign, loc) {
    const msg = JSON.stringify({
      type: 'resp_location',
      senderId: this.clientId,
      callsign: this.callsign,
      targetCallsign: targetCallsign,
      targetChildId: this.childId,
      location: loc,
      timestamp: Date.now()
    });
    this._sendOut(msg);
    this._sendOut(msg, `aeroptt/call/global`);
  }

  sendGpsDenied(targetCallsign) {
    const msg = JSON.stringify({
      type: 'resp_location_denied',
      senderId: this.clientId,
      senderCallsign: this.callsign,
      targetCallsign: targetCallsign,
      targetChildId: this.childId,
      timestamp: Date.now()
    });
    this._sendOut(msg);
    this._sendOut(msg, `aeroptt/call/global`);
  }

  sendZoneAlert(targetCallsign, eventType, zoneName, zoneIcon, lat, lng) {
    const msg = JSON.stringify({
      type: 'alert_zone_event',
      senderId: this.clientId,
      senderCallsign: this.callsign,
      targetCallsign: targetCallsign,
      targetChildId: this.childId,
      eventType: eventType, // 'arrived' or 'left'
      zoneName: zoneName,
      zoneIcon: zoneIcon,
      lat: lat,
      lng: lng,
      timestamp: Date.now()
    });
    this._sendOut(msg);
    this._sendOut(msg, `aeroptt/call/global`);
  }

  sendZonesSync(targetCallsign, zones) {
    const msg = JSON.stringify({
      type: 'cmd_sync_zones',
      senderId: this.clientId,
      senderCallsign: this.callsign,
      targetCallsign: targetCallsign,
      targetChildId: this.childId,
      zones: zones,
      timestamp: Date.now()
    });
    this._sendOut(msg);
    this._sendOut(msg, `aeroptt/call/global`);
  }

  sendAudio(payloadBuffer, isEncrypted = false) {
    const enc = new TextEncoder();
    const senderIdBytes = enc.encode(this.clientId);
    const callsignBytes = enc.encode(this.callsign);

    const headerLen = 4 + senderIdBytes.length + 1 + callsignBytes.length + 1;
    const packet = new Uint8Array(headerLen + payloadBuffer.byteLength);

    packet[0] = 0x50; // 'P'
    packet[1] = 0x54; // 'T'
    packet[2] = 0x01; // Version
    packet[3] = senderIdBytes.length;
    packet.set(senderIdBytes, 4);

    const callsignOffset = 4 + senderIdBytes.length;
    packet[callsignOffset] = callsignBytes.length;
    packet.set(callsignBytes, callsignOffset + 1);

    const secOffset = callsignOffset + 1 + callsignBytes.length;
    packet[secOffset] = isEncrypted ? 1 : 0;
    packet.set(new Uint8Array(payloadBuffer), headerLen);

    this._sendOut(packet.buffer);
  }

  sendChildUpdatedNotice(versionName, versionCode) {
    const msg = JSON.stringify({
      type: 'child_updated',
      senderId: this.clientId,
      senderCallsign: this.callsign,
      childId: this.childId,
      versionName: versionName,
      versionCode: versionCode,
      timestamp: Date.now()
    });
    this._sendOut(msg);
    this._sendOut(msg, `aeroptt/call/global`);
  }

  sendChildProfileUpdate(targetCallsign, name, avatar, timestamp = Date.now()) {
    const msg = JSON.stringify({
      type: 'cmd_update_child_profile',
      senderId: this.clientId,
      senderCallsign: this.callsign,
      targetCallsign: targetCallsign,
      childId: this.childId,
      name: name,
      avatar: avatar,
      timestamp: timestamp
    });
    this._sendOut(msg);
  }

  sendAdminPinSync(targetCallsign, pin) {
    const msg = JSON.stringify({
      type: 'cmd_sync_admin_pin',
      senderId: this.clientId,
      senderCallsign: this.callsign,
      targetCallsign: targetCallsign,
      pin: pin,
      timestamp: Date.now()
    });
    this._sendOut(msg);
  }

  _cleanupPeers() {
    const now = Date.now();
    let changed = false;
    for (const [id, peer] of this.peers.entries()) {
      if (now - peer.lastSeen > 6500) {
        this.peers.delete(id);
        changed = true;
      }
    }
    if (changed && this.onPeerUpdate) this.onPeerUpdate(this.peers);
  }
}

window.radioNetwork = new RadioNetwork();
