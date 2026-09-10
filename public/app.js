/**
 * GUARDIAN - Parental Control & Child Safety System
 * Real-time 2-Way PTT Walkie-Talkie (zero echo/delay),
 * Ambient Sound with Confirmation Modal & Hold-to-Listen,
 * Multi-Zone Geofencing (Home, School, Section arrival/departure alerts),
 * Fully Automatic & Silent Child Geolocation (Remote Toggle ON/OFF by Parent),
 * Persistent Background Service with Remote App Launcher & Relauncher.
 */

class GuardianApp {
  constructor() {
    this.isSetupDone = localStorage.getItem('guardian_setup_completed') === 'true';
    this.role = localStorage.getItem('guardian_role') || 'admin';
    this.childId = localStorage.getItem('guardian_child_id') || '';
    this.adminPin = localStorage.getItem('guardian_admin_pin') || '1234';
    this.childPin = localStorage.getItem('guardian_child_pin') || '0000';

    this.childName = localStorage.getItem('guardian_child_name') || 'Ребенок';
    this.childAvatar = localStorage.getItem('guardian_child_avatar') || '🧒';
    this.profileUpdatedAt = parseInt(localStorage.getItem('guardian_profile_updated_at') || '0', 10);
    this.availableAvatars = ['👦', '👧', '🧒', '🦸', '🚀', '🐱', '🐶', '🌟', '🛡️', '🦁', '🦄', '⚽'];
    this.pendingSettingsUnlock = null;

    this.enteredPin = '';
    this.isUnlocked = false;
    this.tempChildId = '';

    // Callsigns
    this.adminCallsign = 'РОДИТЕЛЬ_' + this.childId;
    this.childCallsign = 'РЕБЕНОК_' + this.childId;
    this.myActiveCallsign = (this.role === 'admin') ? this.adminCallsign : this.childCallsign;
    this.targetActiveCallsign = (this.role === 'admin') ? this.childCallsign : this.adminCallsign;

    // Location & Multi-Zone Geofencing
    this.childLocation = null;
    this.parentLocation = null;
    this.parentMarker = null;
    this.parentWatchId = null;
    this.myLocation = null;
    this.lastAlertTime = 0;

    // Remote Geolocation State (Parent can turn ON/OFF silently)
    this.isChildGpsEnabled = localStorage.getItem('guardian_child_gps_enabled') !== 'false';

    // Multiple Geofence Zones (Home, School, Sports, etc.)
    const defaultZones = [
      { id: 'zone_home', name: 'Дом', icon: '🏠', lat: 55.751244, lng: 37.618423, radius: 100 },
      { id: 'zone_school', name: 'Школа', icon: '🏫', lat: 55.754000, lng: 37.620000, radius: 150 }
    ];
    this.geofenceZones = JSON.parse(localStorage.getItem('guardian_geofence_zones') || JSON.stringify(defaultZones));
    this.zoneStatusMap = new Map(); // zoneId -> isInside boolean
    this.zoneCircleLayers = new Map(); // zoneId -> Leaflet Circle

    // Zone creation temp state
    this.tempNewZoneLat = null;
    this.tempNewZoneLng = null;
    this.tempNewZoneRadius = 100;
    this.tempNewZoneIcon = '🏠';

    // Sound mode state (Single unified button)
    this.isChildSilent = localStorage.getItem('guardian_is_silent') === 'true';

    // Power Saver mode
    this.isPowerSaverActive = false;

    // Ambient live listening
    this.isHoldingAmbient = false;
    this.ambientStream = null;
    this.ambientInterval = null;
    this.ambientWatchdog = null;

    // 2-Way Walkie-Talkie (PTT) & Voice FX
    this.isPttTransmitting = false;
    this.isPttRecording = false;
    this.pttStopRequested = false;
    this.pttRecorder = null;
    this.prewarmedStream = null;
    this.pttChunks = [];
    this.currentPttAudio = null;
    this.currentVoiceFx = localStorage.getItem('guardian_voice_fx') || 'normal';
    this.pttAudioCtx = null;
    this._pttEffectOsc = null;

    // Photo Gallery
    this.childPhotoGallery = JSON.parse(localStorage.getItem('guardian_photo_gallery') || '[]');
    this.selectedPhotoId = null;

    // Video Gallery
    this.childVideoGallery = JSON.parse(localStorage.getItem('guardian_video_gallery') || '[]');
    this.selectedVideoId = null;

    // Remote Apps List
    const defaultApps = [
      { name: 'WhatsApp', pkg: 'com.whatsapp', icon: '🟢' },
      { name: 'Telegram', pkg: 'org.telegram.messenger', icon: '✈️' },
      { name: 'Телефон', pkg: 'phone', icon: '📞' },
      { name: 'YouTube', pkg: 'com.google.android.youtube', icon: '▶️' }
    ];
    this.remoteApps = JSON.parse(localStorage.getItem('guardian_remote_apps') || JSON.stringify(defaultApps));
    this.childInstalledApps = [];

    // Map
    this.map = null;
    this.mapLayers = {};
    this.childMarker = null;

    // Battery
    this.childBattery = 100;

    this.dom = {};
  }

  init() {
    this._cacheDom();
    this._initNetwork();
    this._initOnboarding();
    this._initAuthKeypad();
    this._initChildControls();
    this._initParentDashboardUI();
    this._initMultiZoneGeofenceUI();
    this._initRemoteAppsManager();
    this._initPhotoGalleryUI();
    this._initVideoGalleryUI();
    this._initVoiceEffectsUI();
    this._initAmbientConfirmationModal();
    this._startLocationMonitoring();
    this._startBatteryWatcher();
    this._initGpsTrainingMacroUI();
    this._initVersionAndChangelogUI();
    this._checkAppUpdateNotice();

    if (!this.isSetupDone) {
      this._showOnboarding();
    } else {
      if (this.role === 'child') {
        this._openChildScreenDirectly();
      } else {
        this._showPinLockScreen();
      }
    }
  }

  _cacheDom() {
    // Onboarding
    this.dom.obOverlay = document.getElementById('onboardingOverlay');
    this.dom.obStep1 = document.getElementById('obStep1');
    this.dom.obStepChild = document.getElementById('obStepChild');
    this.dom.obStepParent = document.getElementById('obStepParent');
    this.dom.btnChooseParent = document.getElementById('btnChooseParent');
    this.dom.btnChooseChild = document.getElementById('btnChooseChild');
    this.dom.obChildUniqueId = document.getElementById('obChildUniqueId');
    this.dom.btnFinishChildSetup = document.getElementById('btnFinishChildSetup');
    this.dom.obInputChildId = document.getElementById('obInputChildId');
    this.dom.obInputAdminPin = document.getElementById('obInputAdminPin');
    this.dom.obInputChildPin = document.getElementById('obInputChildPin');
    this.dom.btnFinishParentSetup = document.getElementById('btnFinishParentSetup');
    this.dom.btnBackToStep1 = document.getElementById('btnBackToStep1');

    // Lock screen
    this.dom.lockOverlay = document.getElementById('lockScreenOverlay');
    this.dom.lockSubtitle = document.getElementById('lockSubtitle');
    this.dom.lockErrorMsg = document.getElementById('lockErrorMsg');
    this.dom.pinDots = [
      document.getElementById('pDot1'),
      document.getElementById('pDot2'),
      document.getElementById('pDot3'),
      document.getElementById('pDot4')
    ];
    this.dom.btnBioUnlock = document.getElementById('btnBiometricUnlock');

    // Dashboards
    this.dom.adminDashboard = document.getElementById('adminDashboard');
    this.dom.childDashboard = document.getElementById('childDashboard');

    // Child Screen Elements
    this.dom.childHeaderAvatar = document.getElementById('childHeaderAvatar');
    this.dom.childHeaderName = document.getElementById('childHeaderName');
    this.dom.childHeaderIdTag = document.getElementById('childHeaderIdTag');
    this.dom.childHeaderBattery = document.getElementById('childHeaderBattery');
    this.dom.btnChildSettings = document.getElementById('btnChildSettings');
    this.dom.btnChildSwitchToAdmin = document.getElementById('btnChildSwitchToAdmin');
    this.dom.btnChildSos = document.getElementById('btnChildSos');
    this.dom.btnChildPtt = document.getElementById('btnChildPtt');
    this.dom.btnChildCamera = document.getElementById('btnChildCamera');
    this.dom.btnChildVideo = document.getElementById('btnChildVideo');
    this.dom.childVideoCaptureInput = document.getElementById('childVideoCaptureInput');
    this.dom.btnChildVoiceFx = document.getElementById('btnChildVoiceFx');
    this.dom.btnParentVoiceFx = document.getElementById('btnParentVoiceFx');

    // Admin Dashboard Elements
    this.dom.adminHeaderBadge = document.getElementById('adminHeaderBadge');
    this.dom.childOnlineDot = document.getElementById('childOnlineDot');
    this.dom.childStatusText = document.getElementById('childStatusText');
    this.dom.childBatteryText = document.getElementById('childBatteryText');
    this.dom.btnOpenPhotos = document.getElementById('btnOpenPhotos');
    this.dom.btnOpenVideos = document.getElementById('btnOpenVideos');
    this.dom.btnOpenConfig = document.getElementById('btnOpenConfig');
    this.dom.btnSwitchProfile = document.getElementById('btnSwitchProfile');
    this.dom.mapCoordInfo = document.getElementById('mapCoordInfo');
    this.dom.btnCenterChild = document.getElementById('btnCenterChild');
    this.dom.btnCenterParent = document.getElementById('btnCenterParent');
    this.dom.btnCenterBoth = document.getElementById('btnCenterBoth');
    this.dom.btnZoomIn = document.getElementById('btnZoomIn');
    this.dom.btnZoomOut = document.getElementById('btnZoomOut');

    // Parent PTT
    this.dom.btnParentPtt = document.getElementById('btnParentPtt');
    this.dom.parentPttStatus = document.getElementById('parentPttStatus');

    // Multi-Zone Geofencing
    this.dom.geofenceZonesList = document.getElementById('geofenceZonesList');
    this.dom.btnOpenAddZoneModal = document.getElementById('btnOpenAddZoneModal');
    this.dom.btnQuickAnchorCurrent = document.getElementById('btnQuickAnchorCurrent');

    // Alerts
    this.dom.displacementBanner = document.getElementById('displacementAlertBanner');
    this.dom.alertBannerTitle = document.getElementById('alertBannerTitle');
    this.dom.alertBannerSub = document.getElementById('alertBannerSub');
    this.dom.btnLocateDisplacement = document.getElementById('btnLocateDisplacement');
    this.dom.btnDismissAlert = document.getElementById('btnDismissAlert');

    // Remote Actions
    this.dom.btnToggleChildGps = document.getElementById('btnToggleChildGps');
    this.dom.gpsToggleIcon = document.getElementById('gpsToggleIcon');
    this.dom.gpsToggleTitle = document.getElementById('gpsToggleTitle');
    this.dom.gpsToggleDesc = document.getElementById('gpsToggleDesc');

    this.dom.btnToggleSoundMode = document.getElementById('btnToggleSoundMode');
    this.dom.soundActionIcon = document.getElementById('soundActionIcon');
    this.dom.soundActionTitle = document.getElementById('soundActionTitle');
    this.dom.soundActionDesc = document.getElementById('soundActionDesc');

    this.dom.btnHoldListenAmbient = document.getElementById('btnHoldListenAmbient');
    this.dom.btnTogglePowerSaver = document.getElementById('btnTogglePowerSaver');
    this.dom.powerSaverTitle = document.getElementById('powerSaverTitle');
    this.dom.powerSaverDesc = document.getElementById('powerSaverDesc');
    this.dom.powerSaverIcon = document.getElementById('powerSaverIcon');

    this.dom.btnRelaunchChildApp = document.getElementById('btnRelaunchChildApp');
    this.dom.btnWakeChild = document.getElementById('btnWakeChild');

    // Remote Apps Grid
    this.dom.remoteAppsGrid = document.getElementById('remoteAppsGrid');
    this.dom.btnShowAddAppModal = document.getElementById('btnShowAddAppModal');

    // Modals
    this.dom.modalCameraChoice = document.getElementById('modalCameraChoice');
    this.dom.btnChildChooseRealtime = document.getElementById('btnChildChooseRealtime');
    this.dom.btnChildChooseGallery = document.getElementById('btnChildChooseGallery');
    this.dom.btnChildCancelCamera = document.getElementById('btnChildCancelCamera');
    this.dom.btnCloseCameraChoice = document.getElementById('btnCloseCameraChoice');

    this.dom.modalSosAlarm = document.getElementById('modalSosAlarm');
    this.dom.sosAlarmCallerId = document.getElementById('sosAlarmCallerId');
    this.dom.sosAlarmCoordsInfo = document.getElementById('sosAlarmCoordsInfo');
    this.dom.btnSosViewOnMap = document.getElementById('btnSosViewOnMap');
    this.dom.btnDismissSosAlarm = document.getElementById('btnDismissSosAlarm');

    // Photo Gallery Modal
    this.dom.modalPhotoGallery = document.getElementById('modalPhotoGallery');
    this.dom.photoGalleryTitle = document.getElementById('photoGalleryTitle');
    this.dom.selectedPhotoWrap = document.getElementById('selectedPhotoWrap');
    this.dom.selectedPhotoMetaRow = document.getElementById('selectedPhotoMetaRow');
    this.dom.viewerPhotoImage = document.getElementById('viewerPhotoImage');
    this.dom.photoMetaInfo = document.getElementById('photoMetaInfo');
    this.dom.btnDeleteSelectedPhoto = document.getElementById('btnDeleteSelectedPhoto');
    this.dom.galleryThumbsGrid = document.getElementById('galleryThumbsGrid');
    this.dom.btnClearPhotoGallery = document.getElementById('btnClearPhotoGallery');
    this.dom.btnDismissPhotoGallery = document.getElementById('btnDismissPhotoGallery');
    this.dom.btnClosePhotoGallery = document.getElementById('btnClosePhotoGallery');

    // Video Gallery Modal
    this.dom.modalVideoGallery = document.getElementById('modalVideoGallery');
    this.dom.selectedVideoWrap = document.getElementById('selectedVideoWrap');
    this.dom.viewerVideoPlayer = document.getElementById('viewerVideoPlayer');
    this.dom.selectedVideoMetaRow = document.getElementById('selectedVideoMetaRow');
    this.dom.videoMetaInfo = document.getElementById('videoMetaInfo');
    this.dom.btnDeleteSelectedVideo = document.getElementById('btnDeleteSelectedVideo');
    this.dom.videoGalleryThumbsGrid = document.getElementById('videoGalleryThumbsGrid');
    this.dom.btnClearVideoGallery = document.getElementById('btnClearVideoGallery');
    this.dom.btnDismissVideoGallery = document.getElementById('btnDismissVideoGallery');
    this.dom.btnCloseVideoGallery = document.getElementById('btnCloseVideoGallery');

    // Voice Effects Modal
    this.dom.modalVoiceEffects = document.getElementById('modalVoiceEffects');
    this.dom.btnCloseVoiceEffects = document.getElementById('btnCloseVoiceEffects');
    this.dom.btnDismissVoiceEffects = document.getElementById('btnDismissVoiceEffects');

    // Ambient Confirmation Modal
    this.dom.modalConfirmAmbient = document.getElementById('modalConfirmAmbient');
    this.dom.btnCloseConfirmAmbient = document.getElementById('btnCloseConfirmAmbient');
    this.dom.btnDismissConfirmAmbient = document.getElementById('btnDismissConfirmAmbient');
    this.dom.btnModalHoldAmbient = document.getElementById('btnModalHoldAmbient');

    // Emergency Call Confirmation Modal
    this.dom.modalConfirmEmergencyCall = document.getElementById('modalConfirmEmergencyCall');
    this.dom.btnCloseConfirmEmergency = document.getElementById('btnCloseConfirmEmergency');
    this.dom.btnDismissConfirmEmergency = document.getElementById('btnDismissConfirmEmergency');
    this.dom.btnExecuteEmergencyCall = document.getElementById('btnExecuteEmergencyCall');

    // Add Geofence Zone Modal
    this.dom.modalAddGeofenceZone = document.getElementById('modalAddGeofenceZone');
    this.dom.btnCloseAddZone = document.getElementById('btnCloseAddZone');
    this.dom.inputNewZoneName = document.getElementById('inputNewZoneName');
    this.dom.btnUseCurrentChildLocForZone = document.getElementById('btnUseCurrentChildLocForZone');
    this.dom.zoneCoordsPreview = document.getElementById('zoneCoordsPreview');
    this.dom.btnSaveGeofenceZone = document.getElementById('btnSaveGeofenceZone');

    // Child installed apps modal
    this.dom.modalAddApp = document.getElementById('modalAddApp');
    this.dom.btnCloseAddApp = document.getElementById('btnCloseAddApp');
    this.dom.btnDismissAddApp = document.getElementById('btnDismissAddApp');
    this.dom.inputFilterChildApps = document.getElementById('inputFilterChildApps');
    this.dom.childInstalledAppsList = document.getElementById('childInstalledAppsList');
    this.dom.btnRefreshChildApps = document.getElementById('btnRefreshChildApps');

    this.dom.modalIncomingCall = document.getElementById('modalIncomingCall');
    this.dom.btnAcceptCall = document.getElementById('btnAcceptCall');
    this.dom.incomingCallerName = document.getElementById('incomingCallerName');
    this.dom.incomingChannelInfo = document.getElementById('incomingChannelInfo');

    this.dom.modalConfig = document.getElementById('modalConfig');
    this.dom.btnCloseConfig = document.getElementById('btnCloseConfig');
    this.dom.btnSaveConfig = document.getElementById('btnSaveConfig');
    this.dom.inputChildUniqueId = document.getElementById('inputChildUniqueId');
    this.dom.btnResetAdminPin = document.getElementById('btnResetAdminPin');
    this.dom.btnResetChildPin = document.getElementById('btnResetChildPin');
    this.dom.btnResetSetupCompletely = document.getElementById('btnResetSetupCompletely');
    this.dom.bannerAccessibilityPrompt = document.getElementById('bannerAccessibilityPrompt');
    this.dom.btnActivateAccessibility = document.getElementById('btnActivateAccessibility');
    this.dom.btnHelpAccessibilityBanner = document.getElementById('btnHelpAccessibilityBanner');
    this.dom.toggleBiometricAuth = document.getElementById('toggleBiometricAuth');
    this.dom.zoneEventsLog = document.getElementById('zoneEventsLog');
    this.dom.volPills = document.querySelectorAll('.vol-pill');

    // OTA Updates
    this.dom.labelCurrentAppVersion = document.getElementById('labelCurrentAppVersion');
    this.dom.inputOtaManifestUrl = document.getElementById('inputOtaManifestUrl');
    this.dom.btnCheckOtaUpdate = document.getElementById('btnCheckOtaUpdate');
    this.dom.otaProgressContainer = document.getElementById('otaProgressContainer');
    this.dom.otaProgressStatus = document.getElementById('otaProgressStatus');
    this.dom.otaProgressPercent = document.getElementById('otaProgressPercent');
    this.dom.otaProgressBarFill = document.getElementById('otaProgressBarFill');
    this.dom.otaAvailableCard = document.getElementById('otaAvailableCard');
    this.dom.otaNewVersionTitle = document.getElementById('otaNewVersionTitle');
    this.dom.otaChangelogText = document.getElementById('otaChangelogText');
    this.dom.btnDownloadInstallOta = document.getElementById('btnDownloadInstallOta');
    this.dom.btnOpenAutostartSettings = document.getElementById('btnOpenAutostartSettings');

    // GPS Gesture Training Macro (Child device)
    this.dom.childGpsTriggerCard = document.getElementById('childGpsTriggerCard');
    this.dom.childGpsMacroStatusBadge = document.getElementById('childGpsMacroStatusBadge');
    this.dom.childGpsMacroDesc = document.getElementById('childGpsMacroDesc');
    this.dom.btnChildStartGpsTraining = document.getElementById('btnChildStartGpsTraining');
    this.dom.btnChildTestGpsTraining = document.getElementById('btnChildTestGpsTraining');
    this.dom.btnChildResetGpsTraining = document.getElementById('btnChildResetGpsTraining');
    this.dom.btnStartGpsTraining = document.getElementById('btnStartGpsTraining');
    this.dom.btnTestGpsMacro = document.getElementById('btnTestGpsMacro');
    this.dom.btnClearGpsMacro = document.getElementById('btnClearGpsMacro');
    this.dom.gpsMacroStatusBadge = document.getElementById('gpsMacroStatusBadge');
    this.dom.gpsMacroCoordsText = document.getElementById('gpsMacroCoordsText');
    this.dom.btnRemoteUpdateChild = document.getElementById('btnRemoteUpdateChild');
    this.dom.bannerUnknownSourcesPrompt = document.getElementById('bannerUnknownSourcesPrompt');
    this.dom.btnActivateUnknownSources = document.getElementById('btnActivateUnknownSources');
    this.dom.btnChildManualOta = document.getElementById('btnChildManualOta');
    this.dom.remoteOtaStatusContainer = document.getElementById('remoteOtaStatusContainer');
    this.dom.remoteOtaStatusText = document.getElementById('remoteOtaStatusText');
    this.dom.remoteOtaProgressText = document.getElementById('remoteOtaProgressText');
    this.dom.remoteOtaProgressBar = document.getElementById('remoteOtaProgressBar');

    // Version History & App Updated Notice
    this.dom.labelAppVersionDetails = document.getElementById('labelAppVersionDetails');
    this.dom.btnShowVersionHistory = document.getElementById('btnShowVersionHistory');
    this.dom.modalVersionHistory = document.getElementById('modalVersionHistory');
    this.dom.btnCloseVersionHistory = document.getElementById('btnCloseVersionHistory');
    this.dom.btnDismissVersionHistory = document.getElementById('btnDismissVersionHistory');
    this.dom.versionHistoryList = document.getElementById('versionHistoryList');
    this.dom.modalAppUpdated = document.getElementById('modalAppUpdated');
    this.dom.btnDismissAppUpdated = document.getElementById('btnDismissAppUpdated');
    this.dom.appUpdatedModalText = document.getElementById('appUpdatedModalText');

    // Child Device Settings Modal (#modalChildConfig)
    this.dom.modalChildConfig = document.getElementById('modalChildConfig');
    this.dom.btnCloseChildConfig = document.getElementById('btnCloseChildConfig');
    this.dom.btnSaveChildConfig = document.getElementById('btnSaveChildConfig');
    this.dom.inputChildNameConfig = document.getElementById('inputChildNameConfig');
    this.dom.childAvatarPickerGrid = document.getElementById('childAvatarPickerGrid');
    this.dom.childToggleBiometrics = document.getElementById('childToggleBiometrics');
    this.dom.btnChildOpenAutostart = document.getElementById('btnChildOpenAutostart');
    this.dom.btnChildResetSetup = document.getElementById('btnChildResetSetup');

    // Child GPS Trigger in Child Settings
    this.dom.childSettingsGpsStatusBadge = document.getElementById('childSettingsGpsStatusBadge');
    this.dom.btnChildSettingsStartGpsTraining = document.getElementById('btnChildSettingsStartGpsTraining');
    this.dom.btnChildSettingsTestGpsTraining = document.getElementById('btnChildSettingsTestGpsTraining');
    this.dom.btnChildSettingsResetGpsTraining = document.getElementById('btnChildSettingsResetGpsTraining');

    // Child OTA in Child Settings
    this.dom.childDeviceAppVersionLabel = document.getElementById('childDeviceAppVersionLabel');
    this.dom.inputChildOtaUrl = document.getElementById('inputChildOtaUrl');
    this.dom.btnChildCheckOtaUpdate = document.getElementById('btnChildCheckOtaUpdate');
    this.dom.childOtaProgressContainer = document.getElementById('childOtaProgressContainer');
    this.dom.childOtaProgressStatus = document.getElementById('childOtaProgressStatus');
    this.dom.childOtaProgressPercent = document.getElementById('childOtaProgressPercent');
    this.dom.childOtaProgressBarFill = document.getElementById('childOtaProgressBarFill');
    this.dom.childOtaAvailableCard = document.getElementById('childOtaAvailableCard');
    this.dom.childOtaNewVersionTitle = document.getElementById('childOtaNewVersionTitle');
    this.dom.childOtaChangelogText = document.getElementById('childOtaChangelogText');
    this.dom.btnChildDownloadInstallOta = document.getElementById('btnChildDownloadInstallOta');

    // Parent Child Profile Elements
    this.dom.inputParentChildName = document.getElementById('inputParentChildName');
    this.dom.parentChildAvatarGrid = document.getElementById('parentChildAvatarGrid');

    // Admin & Child PIN direct inputs in Parent Settings
    this.dom.inputSettingsAdminPin = document.getElementById('inputSettingsAdminPin');
    this.dom.inputSettingsChildPin = document.getElementById('inputSettingsChildPin');
    this.dom.btnSaveAdminPinDirect = document.getElementById('btnSaveAdminPinDirect');
    this.dom.btnSaveChildPinDirect = document.getElementById('btnSaveChildPinDirect');

    // Child device Admin PIN & Help
    this.dom.inputChildDeviceAdminPin = document.getElementById('inputChildDeviceAdminPin');
    this.dom.btnSaveChildDeviceAdminPin = document.getElementById('btnSaveChildDeviceAdminPin');
    this.dom.btnShowRestrictedHelpFromChildSettings = document.getElementById('btnShowRestrictedHelpFromChildSettings');

    // Restricted Settings Help Modal
    this.dom.modalRestrictedSettingsHelp = document.getElementById('modalRestrictedSettingsHelp');
    this.dom.btnCloseRestrictedHelp = document.getElementById('btnCloseRestrictedHelp');
    this.dom.btnDismissRestrictedHelp = document.getElementById('btnDismissRestrictedHelp');
    this.dom.btnOpenAppDetailsFromHelp = document.getElementById('btnOpenAppDetailsFromHelp');
    this.dom.btnOpenAccessibilityFromHelp = document.getElementById('btnOpenAccessibilityFromHelp');

    // Child PIN Auth Modal
    this.dom.modalChildPinAuth = document.getElementById('modalChildPinAuth');
    this.dom.btnCloseChildPinAuth = document.getElementById('btnCloseChildPinAuth');
    this.dom.btnCancelChildPinAuth = document.getElementById('btnCancelChildPinAuth');
    this.dom.btnSubmitChildPinAuth = document.getElementById('btnSubmitChildPinAuth');
    this.dom.inputChildSettingsEnteredPin = document.getElementById('inputChildSettingsEnteredPin');
    this.dom.childPinAuthError = document.getElementById('childPinAuthError');
  }

  /* ==========================================================================
     0. ONBOARDING & PAIRING
     ========================================================================== */
  _initOnboarding() {
    this.dom.btnChooseParent.addEventListener('click', () => {
      this.dom.obStep1.style.display = 'none';
      this.dom.obStepParent.style.display = 'block';
    });

    this.dom.btnChooseChild.addEventListener('click', () => {
      this.tempChildId = Math.floor(100000 + Math.random() * 900000).toString();
      const formatted = this.tempChildId.substring(0, 3) + ' ' + this.tempChildId.substring(3);
      this.dom.obChildUniqueId.textContent = formatted;

      this.dom.obStep1.style.display = 'none';
      this.dom.obStepChild.style.display = 'block';
    });

    this.dom.btnBackToStep1.addEventListener('click', () => {
      this.dom.obStepParent.style.display = 'none';
      this.dom.obStep1.style.display = 'block';
    });

    this.dom.btnFinishChildSetup.addEventListener('click', () => {
      this.childId = this.tempChildId;
      this.role = 'child';
      this.isSetupDone = true;

      localStorage.setItem('guardian_setup_completed', 'true');
      localStorage.setItem('guardian_role', 'child');
      localStorage.setItem('guardian_child_id', this.childId);

      this.dom.obOverlay.style.display = 'none';
      this._bindCallsignsAndTopics();
      this._openChildScreenDirectly();
    });

    this.dom.btnFinishParentSetup.addEventListener('click', () => {
      const childNum = this.dom.obInputChildId.value.trim();
      const aPin = this.dom.obInputAdminPin.value.trim();
      const cPin = this.dom.obInputChildPin.value.trim();

      if (!childNum || childNum.length < 5) {
        alert('Пожалуйста, введите корректный номер с экрана ребенка (6 цифр)!');
        return;
      }
      if (!aPin || aPin.length !== 4) {
        alert('PIN Администратора должен состоять ровно из 4 цифр!');
        return;
      }
      if (!cPin || cPin.length !== 4) {
        alert('PIN Ребенка должен состоять ровно из 4 цифр!');
        return;
      }

      this.childId = childNum;
      this.adminPin = aPin;
      this.childPin = cPin;
      this.role = 'admin';
      this.isSetupDone = true;

      localStorage.setItem('guardian_setup_completed', 'true');
      localStorage.setItem('guardian_role', 'admin');
      localStorage.setItem('guardian_child_id', this.childId);
      localStorage.setItem('guardian_admin_pin', this.adminPin);
      localStorage.setItem('guardian_child_pin', this.childPin);

      this.dom.obOverlay.style.display = 'none';
      this._bindCallsignsAndTopics();
      this._unlockAdminDashboard();
    });
  }

  _showOnboarding() {
    this.dom.obOverlay.style.display = 'flex';
    this.dom.obStep1.style.display = 'block';
    this.dom.obStepChild.style.display = 'none';
    this.dom.obStepParent.style.display = 'none';
  }

  _bindCallsignsAndTopics() {
    this.adminCallsign = 'РОДИТЕЛЬ_' + this.childId;
    this.childCallsign = 'РЕБЕНОК_' + this.childId;
    this.myActiveCallsign = (this.role === 'admin') ? this.adminCallsign : this.childCallsign;
    this.targetActiveCallsign = (this.role === 'admin') ? this.childCallsign : this.adminCallsign;

    window.radioNetwork.connectPair(this.childId, this.myActiveCallsign, this.role);

    if (window.AndroidNative && window.AndroidNative.setMyCallsign) {
      window.AndroidNative.setMyCallsign(this.myActiveCallsign);
    }
    if (window.AndroidNative && window.AndroidNative.setAppRole) {
      window.AndroidNative.setAppRole(this.role);
    }
    if (window.AndroidNative && window.AndroidNative.setChildId) {
      window.AndroidNative.setChildId(this.childId);
    }

    if (this.dom.childHeaderIdTag) {
      this.dom.childHeaderIdTag.textContent = 'ID: ' + this.childId;
    }
  }

  /* ==========================================================================
     AUTHENTICATION KEYPAD
     ========================================================================== */
  _initAuthKeypad() {
    document.querySelectorAll('.pin-key[data-key]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (this.enteredPin.length < 4) {
          this.enteredPin += btn.dataset.key;
          this._updatePinDots();
          this.vibrate(30);

          if (this.enteredPin.length === 4) {
            setTimeout(() => this._verifyAdminPin(), 120);
          }
        }
      });
    });

    document.getElementById('btnPinDelete').addEventListener('click', () => {
      if (this.enteredPin.length > 0) {
        this.enteredPin = this.enteredPin.slice(0, -1);
        this._updatePinDots();
        this.vibrate(20);
      }
    });

    if (this.dom.btnBioUnlock) {
      this.dom.btnBioUnlock.addEventListener('click', () => {
        if (window.AndroidNative && window.AndroidNative.requestBiometric) {
          window.AndroidNative.requestBiometric();
        }
      });
    }
  }

  _showPinLockScreen() {
    this.isUnlocked = false;
    this.enteredPin = '';
    this._updatePinDots();
    this.dom.lockErrorMsg.textContent = '';
    this.dom.lockOverlay.style.display = 'flex';
    this.dom.adminDashboard.style.display = 'none';
    this.dom.childDashboard.style.display = 'none';

    // Auto-prompt biometric if enabled
    const isBioEnabled = localStorage.getItem('guardian_bio_auth_enabled') !== 'false';
    if (isBioEnabled && window.AndroidNative && window.AndroidNative.canAuthenticateBiometric && window.AndroidNative.canAuthenticateBiometric()) {
      setTimeout(() => {
        if (!this.isUnlocked && window.AndroidNative.requestBiometric) {
          window.AndroidNative.requestBiometric();
        }
      }, 350);
    }
  }

  onBiometricSuccess() {
    this.vibrate([40, 40]);
    if (this.pendingSettingsUnlock === 'child_config') {
      this.pendingSettingsUnlock = null;
      this._openChildConfigModal();
      return;
    }
    this._unlockAdminDashboard();
  }

  onBiometricFailed(errorMsg) {
    if (this.pendingSettingsUnlock === 'child_config') {
      this.pendingSettingsUnlock = null;
      this._promptChildSettingsPin();
      return;
    }
    if (this.dom.lockErrorMsg) {
      this.dom.lockErrorMsg.textContent = errorMsg || 'Отпечаток не распознан';
    }
    this.vibrate([80, 50, 80]);
  }

  onTelemetryReceived(data) {
    if (!data) return;
    if (typeof data.isSilent === 'boolean') {
      this.isChildSilent = data.isSilent;
      this._updateSoundToggleUI();
    }
    if (typeof data.isPowerSaver === 'boolean') {
      this.isChildPowerSaver = data.isPowerSaver;
      this._updatePowerSaverUI();
    }
    if (typeof data.battery === 'number') {
      if (this.dom.childBatteryText) {
        this.dom.childBatteryText.textContent = `🔋 ${data.battery}%`;
      }
      if (this.dom.childStatusText) {
        this.dom.childStatusText.textContent = `В сети • 🔋 ${data.battery}%`;
      }
    }
    if (typeof data.gpsEnabled === 'boolean') {
      this.isChildGpsEnabled = data.gpsEnabled;
      this._updateChildGpsToggleUI();
    }
    if (typeof data.volume === 'number' && this.dom.soundActionTitle) {
      if (!this.isChildSilent) {
        this.dom.soundActionTitle.textContent = `Звук: ${data.volume}% (ВКЛ)`;
      }
    }
  }

  _updatePinDots() {
    this.dom.pinDots.forEach((dot, idx) => {
      dot.classList.toggle('filled', idx < this.enteredPin.length);
    });
  }

  _verifyAdminPin() {
    if (this.enteredPin === this.adminPin) {
      this._unlockAdminDashboard();
    } else {
      this.dom.lockErrorMsg.textContent = 'Неверный PIN Администратора!';
      this.vibrate([100, 50, 100]);
      setTimeout(() => {
        this.enteredPin = '';
        this._updatePinDots();
        this.dom.lockErrorMsg.textContent = '';
      }, 700);
    }
  }

  _unlockAdminDashboard() {
    this.isUnlocked = true;
    this.role = 'admin';
    localStorage.setItem('guardian_role', 'admin');
    this._bindCallsignsAndTopics();

    this.dom.lockOverlay.style.display = 'none';
    this.dom.childDashboard.style.display = 'none';
    this.dom.adminDashboard.style.display = 'flex';

    this._updateSoundToggleUI();
    this._updateChildGpsToggleUI();
    this._updatePhotoCountBadge();
    this._renderGeofenceZonesList();

    setTimeout(() => {
      this._initMap();
      this._renderZoneCirclesOnMap();
    }, 250);

    if (this.isChildGpsEnabled) {
      window.radioNetwork.sendLocationRequest(this.targetActiveCallsign);
    }
  }

  _openChildScreenDirectly() {
    this.role = 'child';
    localStorage.setItem('guardian_role', 'child');
    this._bindCallsignsAndTopics();

    this.dom.lockOverlay.style.display = 'none';
    this.dom.adminDashboard.style.display = 'none';
    this.dom.childDashboard.style.display = 'flex';
    this._updateChildHeaderUI();
    this._checkAccessibilityBanner();
    this._checkUnknownSourcesBanner();
    this._refreshGpsMacroUI();
  }

  _updateChildHeaderUI() {
    if (this.dom.childHeaderAvatar) {
      this.dom.childHeaderAvatar.textContent = this.childAvatar || '🧒';
    }
    if (this.dom.childHeaderName) {
      this.dom.childHeaderName.textContent = (this.childName || 'GUARDIAN KIDS').toUpperCase();
    }
  }

  _renderAvatarPickerGrid(container, selectedAvatar, onSelect) {
    if (!container) return;
    container.innerHTML = '';
    this.availableAvatars.forEach(av => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'avatar-choice-btn' + (av === selectedAvatar ? ' active' : '');
      btn.textContent = av;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        container.querySelectorAll('.avatar-choice-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        onSelect(av);
      });
      container.appendChild(btn);
    });
  }

  _promptChildSettingsPin() {
    if (!this.dom.modalChildPinAuth) {
      // Fallback
      this._openChildConfigModal();
      return;
    }
    if (this.dom.inputChildSettingsEnteredPin) {
      this.dom.inputChildSettingsEnteredPin.value = '';
    }
    if (this.dom.childPinAuthError) {
      this.dom.childPinAuthError.style.display = 'none';
    }
    this.dom.modalChildPinAuth.classList.add('active');
    setTimeout(() => {
      this.dom.inputChildSettingsEnteredPin?.focus();
    }, 200);
  }

  _submitChildPinAuth() {
    const entered = (this.dom.inputChildSettingsEnteredPin?.value || '').trim();
    // Accept current adminPin, or fallback default 1234
    if (entered === this.adminPin || entered === '1234') {
      if (this.dom.modalChildPinAuth) {
        this.dom.modalChildPinAuth.classList.remove('active');
      }
      this._openChildConfigModal();
    } else {
      if (this.dom.childPinAuthError) {
        this.dom.childPinAuthError.style.display = 'block';
      }
      this.vibrate([100, 50, 100]);
    }
  }

  _openChildConfigModal() {
    this.tempSelectedChildAvatar = this.childAvatar;
    if (this.dom.inputChildNameConfig) {
      this.dom.inputChildNameConfig.value = this.childName;
    }
    if (this.dom.childAvatarPickerGrid) {
      this._renderAvatarPickerGrid(this.dom.childAvatarPickerGrid, this.childAvatar, (newAvatar) => {
        this.tempSelectedChildAvatar = newAvatar;
      });
    }
    if (this.dom.inputChildDeviceAdminPin) {
      this.dom.inputChildDeviceAdminPin.value = this.adminPin;
    }
    if (this.dom.childToggleBiometrics) {
      this.dom.childToggleBiometrics.checked = localStorage.getItem('guardian_child_bio_enabled') !== 'false';
    }
    if (this.dom.childDeviceAppVersionLabel && this.dom.labelCurrentAppVersion) {
      this.dom.childDeviceAppVersionLabel.textContent = this.dom.labelCurrentAppVersion.textContent;
    }
    if (this.dom.inputChildOtaUrl) {
      const saved = localStorage.getItem('last_ota_apk_url') || localStorage.getItem('guardian_ota_url');
      if (saved) this.dom.inputChildOtaUrl.value = saved;
    }
    this._refreshGpsMacroUI();
    if (this.dom.modalChildConfig) {
      this.dom.modalChildConfig.classList.add('active');
    }
  }

  onProfileRemotelyUpdated(name, avatar, timestamp = 0) {
    if (timestamp && timestamp < this.profileUpdatedAt) {
      return; // Stale update, do not overwrite newer local settings!
    }
    if (timestamp) {
      this.profileUpdatedAt = timestamp;
      localStorage.setItem('guardian_profile_updated_at', timestamp.toString());
    }
    if (name) {
      this.childName = name;
      localStorage.setItem('guardian_child_name', name);
    }
    if (avatar) {
      this.childAvatar = avatar;
      localStorage.setItem('guardian_child_avatar', avatar);
    }
    if (this.role === 'child') {
      this._updateChildHeaderUI();
      this.showQuickToast(`Профиль обновлен: ${this.childName} ${this.childAvatar}`, 2500);
    } else {
      if (this.dom.childStatusText) {
        this.dom.childStatusText.textContent = `${this.childName}: В сети`;
      }
      if (this.childLocation) {
        this._updateChildMarker(this.childLocation.lat, this.childLocation.lng, this.childLocation.accuracy);
      }
    }
  }

  onChildProfileUpdated(name, avatar, timestamp = 0) {
    if (timestamp && timestamp < this.profileUpdatedAt) {
      return; // Heartbeat packet is older than recent local change, do not overwrite!
    }
    if (timestamp) {
      this.profileUpdatedAt = timestamp;
      localStorage.setItem('guardian_profile_updated_at', timestamp.toString());
    }
    if (name) {
      this.childName = name;
      localStorage.setItem('guardian_child_name', name);
    }
    if (avatar) {
      this.childAvatar = avatar;
      localStorage.setItem('guardian_child_avatar', avatar);
    }
    if (this.dom.childStatusText) {
      this.dom.childStatusText.textContent = `${this.childName}: В сети`;
    }
    if (this.childLocation) {
      this._updateChildMarker(this.childLocation.lat, this.childLocation.lng, this.childLocation.accuracy);
    }
  }

  onAdminPinSynced(pin) {
    if (pin && pin.length === 4) {
      this.adminPin = pin;
      localStorage.setItem('guardian_admin_pin', pin);
      if (this.dom.inputChildDeviceAdminPin) {
        this.dom.inputChildDeviceAdminPin.value = pin;
      }
      this.showQuickToast('Родительский PIN-код синхронизирован!', 2500);
    }
  }

  _checkAccessibilityBanner() {
    if (!this.dom.bannerAccessibilityPrompt) return;
    if (this.role === 'child' && window.AndroidNative && window.AndroidNative.isAccessibilityServiceEnabled) {
      const isEnabled = window.AndroidNative.isAccessibilityServiceEnabled();
      this.dom.bannerAccessibilityPrompt.style.display = isEnabled ? 'none' : 'flex';
    } else {
      this.dom.bannerAccessibilityPrompt.style.display = 'none';
    }
  }

  _checkUnknownSourcesBanner() {
    if (!this.dom.bannerUnknownSourcesPrompt) return;
    if (this.role === 'child' && window.AndroidNative && window.AndroidNative.isUnknownAppSourcesAllowed) {
      const isAllowed = window.AndroidNative.isUnknownAppSourcesAllowed();
      this.dom.bannerUnknownSourcesPrompt.style.display = isAllowed ? 'none' : 'flex';
    } else {
      this.dom.bannerUnknownSourcesPrompt.style.display = 'none';
    }
  }

  /* ==========================================================================
     1. CHILD SCREEN: 3 BUTTONS (INSTANT SOS, PTT WALKIE-TALKIE, CAMERA)
     ========================================================================== */
  _initChildControls() {
    if (this.dom.btnActivateAccessibility) {
      this.dom.btnActivateAccessibility.addEventListener('click', () => {
        if (window.AndroidNative && window.AndroidNative.openAccessibilitySettings) {
          window.AndroidNative.openAccessibilitySettings();
        }
      });
    }

    if (this.dom.btnHelpAccessibilityBanner) {
      this.dom.btnHelpAccessibilityBanner.addEventListener('click', () => {
        if (this.dom.modalRestrictedSettingsHelp) {
          this.dom.modalRestrictedSettingsHelp.classList.add('active');
        }
      });
    }

    if (this.dom.btnActivateUnknownSources) {
      this.dom.btnActivateUnknownSources.addEventListener('click', () => {
        if (window.AndroidNative && window.AndroidNative.requestUnknownAppSourcesPermission) {
          window.AndroidNative.requestUnknownAppSourcesPermission();
        }
      });
    }

    // BUTTON 1: INSTANT SOS (No confirmation dialog!)
    this.dom.btnChildSos.addEventListener('click', () => {
      this.vibrate([800, 150, 800]);
      const lat = this.myLocation ? this.myLocation.lat : 0;
      const lng = this.myLocation ? this.myLocation.lng : 0;

      window.radioNetwork.sendSosAlert(this.targetActiveCallsign, lat, lng);

      const origText = this.dom.btnChildSos.innerHTML;
      this.dom.btnChildSos.innerHTML = '<span class="child-btn-icon">🚨</span><span class="child-btn-label">SOS ОТПРАВЛЕН!</span>';
      setTimeout(() => {
        this.dom.btnChildSos.innerHTML = origText;
      }, 3000);
    });

    // BUTTON 2: WALKIE-TALKIE (PTT)
    const onChildPttPress = (e) => {
      e.preventDefault();
      if (this.isPttTransmitting) return;
      this.isPttTransmitting = true;
      this.dom.btnChildPtt.classList.add('recording');
      this.vibrate(40);
      this._startRecordingPttVoice();
    };

    const onChildPttRelease = (e) => {
      if (e) e.preventDefault();
      if (!this.isPttTransmitting) return;
      this.isPttTransmitting = false;
      this.dom.btnChildPtt.classList.remove('recording');
      this.vibrate(30);
      this._stopAndSendPttVoice();
    };

    this.dom.btnChildPtt.addEventListener('touchstart', onChildPttPress, { passive: false });
    this.dom.btnChildPtt.addEventListener('touchend', onChildPttRelease, { passive: false });
    this.dom.btnChildPtt.addEventListener('mousedown', onChildPttPress);
    this.dom.btnChildPtt.addEventListener('mouseup', onChildPttRelease);

    // BUTTON 3: CAMERA CHOICE (REALTIME VS GALLERY)
    this.dom.btnChildCamera.addEventListener('click', () => {
      this.vibrate(40);
      this.dom.modalCameraChoice.classList.add('active');
    });

    this.dom.btnCloseCameraChoice.addEventListener('click', () => {
      this.dom.modalCameraChoice.classList.remove('active');
    });
    this.dom.btnChildCancelCamera.addEventListener('click', () => {
      this.dom.modalCameraChoice.classList.remove('active');
    });

    this.dom.btnChildChooseRealtime.addEventListener('click', () => {
      this.dom.modalCameraChoice.classList.remove('active');
      if (window.AndroidNative && window.AndroidNative.openRealtimeCamera) {
        window.AndroidNative.openRealtimeCamera();
      }
    });

    this.dom.btnChildChooseGallery.addEventListener('click', () => {
      this.dom.modalCameraChoice.classList.remove('active');
      if (window.AndroidNative && window.AndroidNative.openPhotoGallery) {
        window.AndroidNative.openPhotoGallery();
      }
    });

    // BUTTON 3: VIDEO RECORDING (1080p)
    if (this.dom.btnChildVideo) {
      this.dom.btnChildVideo.addEventListener('click', () => {
        this.vibrate(40);
        if (window.AndroidNative && window.AndroidNative.openRealtimeVideo) {
          window.AndroidNative.openRealtimeVideo();
        } else if (this.dom.childVideoCaptureInput) {
          this.dom.childVideoCaptureInput.click();
        }
      });
    }

    if (this.dom.childVideoCaptureInput) {
      this.dom.childVideoCaptureInput.addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        if (file) {
          const reader = new FileReader();
          reader.onload = (evt) => {
            this.onNativeVideoCaptured(evt.target.result);
          };
          reader.readAsDataURL(file);
        }
      });
    }

    // Settings (Gear ⚙️) button -> Protected by Parent PIN / Biometrics
    if (this.dom.btnChildSettings) {
      this.dom.btnChildSettings.addEventListener('click', () => {
        const isBioEnabled = localStorage.getItem('guardian_child_bio_enabled') !== 'false';
        if (isBioEnabled && window.AndroidNative && window.AndroidNative.canAuthenticateBiometric && window.AndroidNative.canAuthenticateBiometric()) {
          this.pendingSettingsUnlock = 'child_config';
          if (window.AndroidNative.requestBiometric) {
            window.AndroidNative.requestBiometric();
            return;
          }
        }
        this._promptChildSettingsPin();
      });
    }

    if (this.dom.btnChildSwitchToAdmin) {
      this.dom.btnChildSwitchToAdmin.addEventListener('click', () => {
        this._promptChildSettingsPin();
      });
    }

    // Modal Child Config Wiring
    if (this.dom.btnCloseChildConfig) {
      this.dom.btnCloseChildConfig.addEventListener('click', () => {
        this.dom.modalChildConfig.classList.remove('active');
      });
    }

    if (this.dom.btnSaveChildConfig) {
      this.dom.btnSaveChildConfig.addEventListener('click', () => {
        const now = Date.now();
        const newName = (this.dom.inputChildNameConfig?.value || '').trim();
        if (newName) {
          this.childName = newName;
          localStorage.setItem('guardian_child_name', this.childName);
        }
        if (this.tempSelectedChildAvatar) {
          this.childAvatar = this.tempSelectedChildAvatar;
          localStorage.setItem('guardian_child_avatar', this.childAvatar);
        }
        this.profileUpdatedAt = now;
        localStorage.setItem('guardian_profile_updated_at', now.toString());

        const devPin = (this.dom.inputChildDeviceAdminPin?.value || '').trim();
        if (devPin && devPin.length === 4 && /^\d+$/.test(devPin)) {
          this.adminPin = devPin;
          localStorage.setItem('guardian_admin_pin', devPin);
        }

        if (this.dom.childToggleBiometrics) {
          localStorage.setItem('guardian_child_bio_enabled', this.dom.childToggleBiometrics.checked ? 'true' : 'false');
        }

        this._updateChildHeaderUI();

        // Broadcast to Parent with timestamp
        window.radioNetwork.broadcastPresence(false);
        window.radioNetwork.sendChildProfileUpdate(this.targetActiveCallsign, this.childName, this.childAvatar, now);

        this.dom.modalChildConfig.classList.remove('active');
        this.showQuickToast('Настройки сохранены!', 2000);
      });
    }

    if (this.dom.btnSaveChildDeviceAdminPin) {
      this.dom.btnSaveChildDeviceAdminPin.addEventListener('click', () => {
        const pin = (this.dom.inputChildDeviceAdminPin?.value || '').trim();
        if (pin && pin.length === 4 && /^\d+$/.test(pin)) {
          this.adminPin = pin;
          localStorage.setItem('guardian_admin_pin', pin);
          this.showQuickToast('Родительский PIN на этом устройстве сохранен!', 2500);
        } else {
          alert('PIN должен состоять ровно из 4 цифр!');
        }
      });
    }

    // PIN Authentication Modal wiring
    if (this.dom.btnSubmitChildPinAuth) {
      this.dom.btnSubmitChildPinAuth.addEventListener('click', () => {
        this._submitChildPinAuth();
      });
    }

    if (this.dom.btnCancelChildPinAuth) {
      this.dom.btnCancelChildPinAuth.addEventListener('click', () => {
        this.dom.modalChildPinAuth?.classList.remove('active');
      });
    }

    if (this.dom.btnCloseChildPinAuth) {
      this.dom.btnCloseChildPinAuth.addEventListener('click', () => {
        this.dom.modalChildPinAuth?.classList.remove('active');
      });
    }

    if (this.dom.inputChildSettingsEnteredPin) {
      this.dom.inputChildSettingsEnteredPin.addEventListener('keyup', (e) => {
        if (e.key === 'Enter' || (this.dom.inputChildSettingsEnteredPin.value.length === 4)) {
          this._submitChildPinAuth();
        }
      });
    }

    // Restricted Settings Help Modal wiring
    const showRestrictedHelp = () => {
      if (this.dom.modalRestrictedSettingsHelp) {
        this.dom.modalRestrictedSettingsHelp.classList.add('active');
      }
    };
    const hideRestrictedHelp = () => {
      if (this.dom.modalRestrictedSettingsHelp) {
        this.dom.modalRestrictedSettingsHelp.classList.remove('active');
      }
    };

    this.dom.btnShowRestrictedHelpFromChildSettings?.addEventListener('click', showRestrictedHelp);
    this.dom.btnCloseRestrictedHelp?.addEventListener('click', hideRestrictedHelp);
    this.dom.btnDismissRestrictedHelp?.addEventListener('click', hideRestrictedHelp);

    this.dom.btnOpenAppDetailsFromHelp?.addEventListener('click', () => {
      if (window.AndroidNative && window.AndroidNative.openAppDetailsSettings) {
        window.AndroidNative.openAppDetailsSettings();
      } else if (window.AndroidNative && window.AndroidNative.openAccessibilitySettings) {
        window.AndroidNative.openAccessibilitySettings();
      } else {
        alert('Откройте: Настройки -> Приложения -> Guardian Kids -> Меню (3 точки вверху) -> Разрешить ограниченные настройки.');
      }
    });

    this.dom.btnOpenAccessibilityFromHelp?.addEventListener('click', () => {
      if (window.AndroidNative && window.AndroidNative.openAccessibilitySettings) {
        window.AndroidNative.openAccessibilitySettings();
      }
    });

    if (this.dom.btnChildOpenAutostart) {
      this.dom.btnChildOpenAutostart.addEventListener('click', () => {
        if (window.AndroidNative && window.AndroidNative.openOemAutostartSettings) {
          window.AndroidNative.openOemAutostartSettings();
        } else {
          alert('Настройки автозапуска доступны на Android.');
        }
      });
    }

    // Child GPS Trigger controls inside Child Settings
    if (this.dom.btnChildSettingsStartGpsTraining) {
      this.dom.btnChildSettingsStartGpsTraining.addEventListener('click', () => {
        this.startGpsTraining();
        this.dom.modalChildConfig.classList.remove('active');
      });
    }

    if (this.dom.btnChildSettingsTestGpsTraining) {
      this.dom.btnChildSettingsTestGpsTraining.addEventListener('click', () => {
        this.testGpsMacro();
      });
    }

    if (this.dom.btnChildSettingsResetGpsTraining) {
      this.dom.btnChildSettingsResetGpsTraining.addEventListener('click', () => {
        if (confirm('Сбросить сохраненный макрос включения GPS?')) {
          if (window.AndroidNative && window.AndroidNative.clearGpsMacro) {
            window.AndroidNative.clearGpsMacro();
          }
          this._refreshGpsMacroUI();
        }
      });
    }

    // Child OTA Check & Update
    if (this.dom.btnChildCheckOtaUpdate) {
      this.dom.btnChildCheckOtaUpdate.addEventListener('click', () => {
        let apkUrl = (this.dom.inputChildOtaUrl?.value || '').trim();
        if (!apkUrl) {
          alert('Введите URL манифеста обновлений или APK!');
          return;
        }
        localStorage.setItem('last_ota_apk_url', apkUrl);
        localStorage.setItem('guardian_ota_url', apkUrl);
        this.vibrate(30);
        this.dom.btnChildCheckOtaUpdate.textContent = '⏳ Проверка...';
        this.dom.btnChildCheckOtaUpdate.disabled = true;

        if (window.AndroidNative && window.AndroidNative.checkForOtaUpdate) {
          window.AndroidNative.checkForOtaUpdate(apkUrl);
        } else if (window.AndroidNative && window.AndroidNative.startOtaDownload) {
          this.showQuickToast('Загрузка обновления...', 3000);
          window.AndroidNative.startOtaDownload(apkUrl);
          this.dom.btnChildCheckOtaUpdate.textContent = '🔄 Проверить и обновить это устройство';
          this.dom.btnChildCheckOtaUpdate.disabled = false;
        } else {
          setTimeout(() => {
            this.dom.btnChildCheckOtaUpdate.textContent = '🔄 Проверить и обновить это устройство';
            this.dom.btnChildCheckOtaUpdate.disabled = false;
            alert('Обновление по воздуху доступно в Android-приложении.');
          }, 1000);
        }
      });
    }

    if (this.dom.btnChildDownloadInstallOta) {
      this.dom.btnChildDownloadInstallOta.addEventListener('click', () => {
        const url = this.pendingOtaApkUrl || (this.dom.inputChildOtaUrl?.value || '').trim();
        if (!url) return;
        this.vibrate([40, 40]);
        this.dom.btnChildDownloadInstallOta.disabled = true;
        this.dom.btnChildDownloadInstallOta.textContent = '⏳ Скачивание...';
        if (this.dom.childOtaProgressContainer) this.dom.childOtaProgressContainer.style.display = 'block';

        if (window.AndroidNative && window.AndroidNative.startOtaDownload) {
          window.AndroidNative.startOtaDownload(url);
        }
      });
    }

    if (this.dom.btnChildResetSetup) {
      this.dom.btnChildResetSetup.addEventListener('click', () => {
        if (confirm('Сбросить привязку и переключить роль на Родителя?')) {
          localStorage.clear();
          location.reload();
        }
      });
    }
  }

  startNativeVideoReceive(videoId, totalChunks) {
    if (!this._nativeVideoBuffers) this._nativeVideoBuffers = {};
    this._nativeVideoBuffers[videoId] = new Array(totalChunks);
  }

  appendNativeVideoChunk(videoId, index, chunk) {
    if (!this._nativeVideoBuffers || !this._nativeVideoBuffers[videoId]) return;
    this._nativeVideoBuffers[videoId][index] = chunk;
    const buf = this._nativeVideoBuffers[videoId];
    let isComplete = true;
    for (let i = 0; i < buf.length; i++) {
      if (typeof buf[i] !== 'string') { isComplete = false; break; }
    }
    if (isComplete) {
      const fullDataUri = buf.join('');
      delete this._nativeVideoBuffers[videoId];
      this.onNativeVideoCaptured(fullDataUri);
    }
  }

  onNativePhotoCaptured(base64DataUri) {
    window.radioNetwork.sendPhoto(this.targetActiveCallsign, base64DataUri, this.myLocation);
    this.vibrate([100, 50, 100]);
    alert('📸 Снимок отправлен родителю!');
  }

  onNativeVideoCaptured(base64DataUri) {
    window.radioNetwork.sendVideo(this.targetActiveCallsign, base64DataUri, this.myLocation);
    this.vibrate([100, 50, 100]);
    alert('🎥 Видеосообщение отправлено родителю!');
  }

  /* ==========================================================================
     ZERO-DELAY PTT (PUSH-TO-TALK) VOICE ENGINE & REAL-TIME DSP VOICE EFFECTS
     ========================================================================== */
  _initVoiceEffectsUI() {
    this.currentVoiceFx = localStorage.getItem('guardian_voice_fx') || 'normal';
    this._updateVoiceFxButtons();

    const openVoiceModal = () => {
      this.vibrate(30);
      this._updateVoiceFxButtons();
      if (this.dom.modalVoiceEffects) this.dom.modalVoiceEffects.classList.add('active');
    };

    if (this.dom.btnChildVoiceFx) this.dom.btnChildVoiceFx.addEventListener('click', openVoiceModal);
    if (this.dom.btnParentVoiceFx) this.dom.btnParentVoiceFx.addEventListener('click', openVoiceModal);

    if (this.dom.btnCloseVoiceEffects) {
      this.dom.btnCloseVoiceEffects.addEventListener('click', () => {
        if (this.dom.modalVoiceEffects) this.dom.modalVoiceEffects.classList.remove('active');
      });
    }

    if (this.dom.btnDismissVoiceEffects) {
      this.dom.btnDismissVoiceEffects.addEventListener('click', () => {
        if (this.dom.modalVoiceEffects) this.dom.modalVoiceEffects.classList.remove('active');
      });
    }

    document.querySelectorAll('.voice-fx-card').forEach(card => {
      card.addEventListener('click', () => {
        const fx = card.getAttribute('data-fx');
        if (fx) {
          this.currentVoiceFx = fx;
          localStorage.setItem('guardian_voice_fx', fx);
          this._updateVoiceFxButtons();
          this.vibrate(40);
          if (this.dom.modalVoiceEffects) this.dom.modalVoiceEffects.classList.remove('active');
        }
      });
    });
  }

  _updateVoiceFxButtons() {
    const fxLabels = {
      'normal': '🎙️ Обычный',
      'robot': '🤖 Робот',
      'alien': '👽 Пришелец',
      'monster': '🐻 Великан',
      'chipmunk': '🐿️ Бурундук',
      'echo': '🏰 Эхо'
    };
    const label = fxLabels[this.currentVoiceFx] || '🎙️ Обычный';
    if (this.dom.btnChildVoiceFx) this.dom.btnChildVoiceFx.textContent = `🎭 Голос: ${label}`;
    if (this.dom.btnParentVoiceFx) this.dom.btnParentVoiceFx.textContent = `🎭 Эффект голоса: ${label}`;

    document.querySelectorAll('.voice-fx-card').forEach(card => {
      card.classList.toggle('active', card.getAttribute('data-fx') === this.currentVoiceFx);
    });
  }

  _startRecordingPttVoice() {
    this.pttChunks = [];
    this.isPttRecording = true;
    this.pttStopRequested = false;

    if (this.dom.parentPttStatus) this.dom.parentPttStatus.textContent = '⏳ ПОДКЛЮЧЕНИЕ...';

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert('Микрофон недоступен в этом браузере / WebView.');
      return;
    }

    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      this.currentPttStream = stream;

      // If user released before mic opened, finalize without discarding
      if (this.pttStopRequested) {
        this._finalizeAndSendPttVoice();
        return;
      }

      try {
        let mimeType = 'audio/webm;codecs=opus';
        if (!MediaRecorder.isTypeSupported(mimeType)) {
          mimeType = 'audio/webm';
          if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = '';
        }

        const recorderOptions = { audioBitsPerSecond: 64000 };
        if (mimeType) recorderOptions.mimeType = mimeType;

        this.pttRecorder = new MediaRecorder(stream, recorderOptions);

        this.pttRecorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) {
            this.pttChunks.push(e.data);
          }
        };

        this.pttRecorder.onstop = () => {
          this._finalizeAndSendPttVoice();
        };

        // 100ms chunk timeslices ensures all frames are captured immediately
        this.pttRecorder.start(100);

        // Sound cue and vibration that mic is hot and recording
        if (window.audioFX) window.audioFX.playBeep(880, 0.05);
        this.vibrate(35);

        if (this.dom.parentPttStatus) this.dom.parentPttStatus.textContent = '🔴 ГОВОРИТЕ СЕЙЧАС!';
      } catch(e) {
        console.warn('MediaRecorder error:', e);
      }
    }).catch(err => {
      console.warn('PTT Mic request error:', err);
      this.isPttRecording = false;
      this.pttStopRequested = false;
      if (this.dom.parentPttStatus) this.dom.parentPttStatus.textContent = 'Готов к передаче';
    });
  }

  _stopAndSendPttVoice() {
    this.pttStopRequested = true;
    this.isPttRecording = false;

    if (this.dom.parentPttStatus) this.dom.parentPttStatus.textContent = 'Отправка...';

    // Grace tail of 450ms: guarantees words are NEVER chopped off when finger is lifted!
    setTimeout(() => {
      if (this.pttRecorder && this.pttRecorder.state === 'recording') {
        try {
          this.pttRecorder.stop();
        } catch(e) {
          this._finalizeAndSendPttVoice();
        }
      } else if (!this.currentPttStream) {
        this._finalizeAndSendPttVoice();
      }
    }, 450);
  }

  _finalizeAndSendPttVoice() {
    // 1. Immediately release all hardware microphone tracks so WhatsApp / Phone have 100% free mic
    if (this.currentPttStream) {
      try {
        this.currentPttStream.getTracks().forEach(track => {
          track.stop();
          track.enabled = false;
        });
      } catch(e) {}
      this.currentPttStream = null;
    }

    if (this._pttEffectOsc) {
      try { this._pttEffectOsc.stop(); } catch(e) {}
      this._pttEffectOsc = null;
    }

    // 2. Encode and transmit recorded audio if chunks exist
    if (this.pttChunks && this.pttChunks.length > 0) {
      const blob = new Blob(this.pttChunks, { type: 'audio/webm' });
      const reader = new FileReader();
      reader.onloadend = () => {
        const res = reader.result;
        if (res && res.includes(',')) {
          const base64Audio = res.split(',')[1];
          window.radioNetwork.sendVoicePtt(this.targetActiveCallsign, base64Audio, this.currentVoiceFx || 'normal');
        }
      };
      reader.readAsDataURL(blob);
    }

    this.pttRecorder = null;
    this.pttChunks = [];
    this.pttStopRequested = false;
    if (this.dom.parentPttStatus) this.dom.parentPttStatus.textContent = 'Готов к передаче';
  }

  playVoicePtt(base64Audio, voiceFx = 'normal') {
    if (!this.isHoldingAmbient) {
      if (window.audioFX) window.audioFX.playRogerBeep();
      this.vibrate([80, 50, 80]);
    }

    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!this.pttPlaybackCtx || this.pttPlaybackCtx.state === 'closed') {
        this.pttPlaybackCtx = new AudioCtx();
      }
      const ctx = this.pttPlaybackCtx;
      if (ctx.state === 'suspended') ctx.resume();

      const binary = atob(base64Audio);
      const len = binary.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);

      ctx.decodeAudioData(bytes.buffer.slice(0), (audioBuffer) => {
        if (this.currentPttSource) {
          try { this.currentPttSource.stop(); } catch(e) {}
          this.currentPttSource = null;
        }

        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        this.currentPttSource = source;

        // Dynamics Compressor: keeps speech loud and punchy, eliminates clipping
        const compressor = ctx.createDynamicsCompressor();
        compressor.threshold.setValueAtTime(-24, ctx.currentTime);
        compressor.knee.setValueAtTime(30, ctx.currentTime);
        compressor.ratio.setValueAtTime(12, ctx.currentTime);
        compressor.attack.setValueAtTime(0.003, ctx.currentTime);
        compressor.release.setValueAtTime(0.25, ctx.currentTime);

        // Master Gain: +240% volume boost for loud, clear walkie-talkie speaker sound
        const masterGain = ctx.createGain();
        masterGain.gain.setValueAtTime(2.4, ctx.currentTime);

        compressor.connect(masterGain);
        masterGain.connect(ctx.destination);

        // Apply authentic Voice Effects
        if (voiceFx === 'chipmunk') {
          // Real Chipmunk pitch shift: +36% pitch/speed
          source.playbackRate.setValueAtTime(1.36, ctx.currentTime);
          source.connect(compressor);
        } else if (voiceFx === 'monster') {
          // Real Giant / Monster pitch shift: -24% pitch/speed + deep bass boost (+10dB)
          source.playbackRate.setValueAtTime(0.76, ctx.currentTime);
          const bass = ctx.createBiquadFilter();
          bass.type = 'lowshelf';
          bass.frequency.setValueAtTime(160, ctx.currentTime);
          bass.gain.setValueAtTime(10, ctx.currentTime);
          source.connect(bass);
          bass.connect(compressor);
        } else if (voiceFx === 'robot') {
          // Robot: 50Hz ring modulation + bandpass
          const osc = ctx.createOscillator();
          osc.type = 'sawtooth';
          osc.frequency.setValueAtTime(50, ctx.currentTime);
          const modGain = ctx.createGain();
          modGain.gain.setValueAtTime(0.7, ctx.currentTime);
          const bp = ctx.createBiquadFilter();
          bp.type = 'bandpass';
          bp.frequency.setValueAtTime(1100, ctx.currentTime);
          bp.Q.setValueAtTime(2.0, ctx.currentTime);

          osc.connect(modGain.gain);
          source.connect(modGain);
          modGain.connect(bp);
          bp.connect(compressor);
          osc.start();
        } else if (voiceFx === 'alien') {
          // Alien: 320Hz sine modulation
          const osc = ctx.createOscillator();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(320, ctx.currentTime);
          const modGain = ctx.createGain();
          modGain.gain.setValueAtTime(0.8, ctx.currentTime);
          osc.connect(modGain.gain);
          source.connect(modGain);
          modGain.connect(compressor);
          osc.start();
        } else if (voiceFx === 'echo') {
          // Echo in Cave: 220ms delay + feedback
          const delay = ctx.createDelay();
          delay.delayTime.setValueAtTime(0.22, ctx.currentTime);
          const feedback = ctx.createGain();
          feedback.gain.setValueAtTime(0.45, ctx.currentTime);
          const damp = ctx.createBiquadFilter();
          damp.type = 'lowpass';
          damp.frequency.setValueAtTime(2500, ctx.currentTime);

          source.connect(compressor); // Dry sound
          source.connect(delay);      // Wet echo path
          delay.connect(damp);
          damp.connect(feedback);
          feedback.connect(delay);
          damp.connect(compressor);
        } else {
          // Normal: pure, amplified, crystal-clear voice
          source.connect(compressor);
        }

        source.start(0);
      }, () => {
        // Fallback to HTML5 audio if decodeAudioData fails
        if (this.currentPttAudio) {
          try { this.currentPttAudio.pause(); } catch(e){}
        }
        this.currentPttAudio = new Audio("data:audio/webm;base64," + base64Audio);
        this.currentPttAudio.volume = 1.0;
        this.currentPttAudio.play().catch(() => {});
      });
    } catch(e) {
      if (this.currentPttAudio) {
        try { this.currentPttAudio.pause(); } catch(e){}
      }
      this.currentPttAudio = new Audio("data:audio/webm;base64," + base64Audio);
      this.currentPttAudio.volume = 1.0;
      this.currentPttAudio.play().catch(() => {});
    }
  }

  /* ==========================================================================
     PARENT DASHBOARD & REMOTE CONTROLS
     ========================================================================== */
  _initParentDashboardUI() {
    this.dom.btnSwitchProfile.addEventListener('click', () => {
      this._showPinLockScreen();
    });

    // Parent PTT Walkie-Talkie Button
    const onParentPttPress = (e) => {
      e.preventDefault();
      if (this.isPttTransmitting) return;
      this.isPttTransmitting = true;
      this.dom.btnParentPtt.classList.add('transmitting');
      this.dom.parentPttStatus.textContent = '🔴 Передача голоса...';
      this.vibrate(40);
      this._startRecordingPttVoice();
    };

    const onParentPttRelease = (e) => {
      if (e) e.preventDefault();
      if (!this.isPttTransmitting) return;
      this.isPttTransmitting = false;
      this.dom.btnParentPtt.classList.remove('transmitting');
      this.dom.parentPttStatus.textContent = '⏳ Завершение и отправка...';
      this.vibrate(30);
      this._stopAndSendPttVoice();
    };

    this.dom.btnParentPtt.addEventListener('touchstart', onParentPttPress, { passive: false });
    this.dom.btnParentPtt.addEventListener('touchend', onParentPttRelease, { passive: false });
    this.dom.btnParentPtt.addEventListener('mousedown', onParentPttPress);
    this.dom.btnParentPtt.addEventListener('mouseup', onParentPttRelease);

    // Map Controls
    this.dom.btnCenterChild.addEventListener('click', () => {
      if (this.childLocation && this.map) {
        this.map.setView([this.childLocation.lat, this.childLocation.lng], 18);
      } else {
        alert('Координаты ребенка еще не получены');
      }
    });
    this.dom.btnCenterParent.addEventListener('click', () => {
      if (this.parentLocation && this.map) {
        this.map.setView([this.parentLocation.lat, this.parentLocation.lng], 18);
      } else {
        alert('Ваши координаты еще определяются...');
      }
    });
    this.dom.btnCenterBoth.addEventListener('click', () => {
      if (this.parentLocation && this.childLocation && this.map) {
        const bounds = L.latLngBounds([
          [this.parentLocation.lat, this.parentLocation.lng],
          [this.childLocation.lat, this.childLocation.lng]
        ]);
        this.map.fitBounds(bounds, { padding: [50, 50], maxZoom: 18 });
      } else if (this.childLocation && this.map) {
        this.map.setView([this.childLocation.lat, this.childLocation.lng], 18);
      } else if (this.parentLocation && this.map) {
        this.map.setView([this.parentLocation.lat, this.parentLocation.lng], 18);
      }
    });
    this.dom.btnZoomIn.addEventListener('click', () => this.map && this.map.zoomIn());
    this.dom.btnZoomOut.addEventListener('click', () => this.map && this.map.zoomOut());

    document.querySelectorAll('.layer-btn').forEach(btn => {
      btn.addEventListener('click', () => this._switchMapLayer(btn.dataset.layer));
    });

    this.dom.btnDismissAlert.addEventListener('click', () => this._hideDisplacementAlert());
    this.dom.btnLocateDisplacement.addEventListener('click', () => {
      if (this.childLocation && this.map) {
        this.map.setView([this.childLocation.lat, this.childLocation.lng], 18);
      }
    });

    // REMOTE ACTION 1: SILENT AUTOMATIC GPS TOGGLE (ON/OFF FROM PARENT)
    this.dom.btnToggleChildGps.addEventListener('click', () => {
      this.isChildGpsEnabled = !this.isChildGpsEnabled;
      localStorage.setItem('guardian_child_gps_enabled', this.isChildGpsEnabled ? 'true' : 'false');
      this.vibrate(50);

      window.radioNetwork.sendToggleChildGps(this.targetActiveCallsign, this.isChildGpsEnabled);
      if (this.isChildGpsEnabled) {
        window.radioNetwork.sendLocationRequest(this.targetActiveCallsign);
      }
      this._updateChildGpsToggleUI();

      if (this.isChildGpsEnabled) {
        alert('🛰️ Геолокация ребенка ВКЛЮЧЕНА!\nКоординаты запрашиваются и обновляются автоматически.');
      } else {
        alert('🛑 Геолокация ребенка ОТКЛЮЧЕНА.');
      }
    });

    // Volume pills selection
    if (this.dom.volPills) {
      this.dom.volPills.forEach(pill => {
        pill.addEventListener('click', (e) => {
          e.stopPropagation();
          this.dom.volPills.forEach(p => {
            p.classList.remove('active');
            p.style.background = '#1e293b';
            p.style.color = '#cbd5e1';
            p.style.borderColor = '#334155';
          });
          pill.classList.add('active');
          pill.style.background = '#2563eb';
          pill.style.color = '#fff';
          pill.style.borderColor = '#3b82f6';
          this.selectedVolumePercent = parseInt(pill.dataset.vol, 10) || 100;
          this.vibrate(20);
          if (!this.isChildSilent) {
            window.radioNetwork.sendUnmuteCommand(this.targetActiveCallsign, this.selectedVolumePercent);
          }
        });
      });
    }

    // REMOTE ACTION 2: UNIFIED SOUND TOGGLE WITH VOLUME
    this.dom.btnToggleSoundMode.addEventListener('click', () => {
      this.isChildSilent = !this.isChildSilent;
      localStorage.setItem('guardian_is_silent', this.isChildSilent ? 'true' : 'false');
      this.vibrate(50);

      const vol = this.selectedVolumePercent || 100;
      if (this.isChildSilent) {
        window.radioNetwork.sendMuteCommand(this.targetActiveCallsign, true, vol);
      } else {
        window.radioNetwork.sendUnmuteCommand(this.targetActiveCallsign, vol);
      }
      this._updateSoundToggleUI();

      if (this.isChildSilent) {
        alert('Команда отправлена: Телефон ребенка переведен в БЕЗЗВУЧНЫЙ режим.');
      } else {
        alert(`Команда отправлена: ЗВУК ВКЛЮЧЕН НА ${vol}% на телефоне ребенка.`);
      }
    });

    // REMOTE ACTION 3: AMBIENT LISTENING (OPENS CONFIRMATION MODAL)
    this.dom.btnHoldListenAmbient.addEventListener('click', () => {
      this.vibrate(40);
      this.dom.modalConfirmAmbient.classList.add('active');
    });

    // REMOTE ACTION 4: POWER SAVER MODE TOGGLE
    this.dom.btnTogglePowerSaver.addEventListener('click', () => {
      this.isPowerSaverActive = !this.isPowerSaverActive;
      this.vibrate(50);
      window.radioNetwork.sendPowerSaverCommand(this.targetActiveCallsign, this.isPowerSaverActive);

      if (this.isPowerSaverActive) {
        this.dom.powerSaverTitle.textContent = 'Энергосбережение: ВКЛ';
        this.dom.powerSaverDesc.textContent = 'Экран затемнен до 2%, батарея экономится';
        this.dom.powerSaverIcon.textContent = '⚡';
        alert('🔋 Энергосберегающий режим активирован на телефоне ребенка!');
      } else {
        this.dom.powerSaverTitle.textContent = 'Энергосбережение';
        this.dom.powerSaverDesc.textContent = 'Снизить яркость до 2% и экономить батарею';
        this.dom.powerSaverIcon.textContent = '🔋';
        alert('Энергосберегающий режим отключен.');
      }
    });

    // REMOTE ACTION 5: RELAUNCH GUARDIAN APP FROM BACKGROUND
    this.dom.btnRelaunchChildApp.addEventListener('click', () => {
      this.vibrate(60);
      window.radioNetwork.sendRelaunchAppCommand(this.targetActiveCallsign);
      alert('🚀 Команда отправлена! Фоновый сервис разбудит экран и запустит Guardian у ребенка.');
    });

    // REMOTE ACTION 6: WAKE CHILD UP (EMERGENCY CALL VIA CONFIRMATION MODAL)
    this.dom.btnWakeChild.addEventListener('click', () => {
      this.vibrate(40);
      this.dom.modalConfirmEmergencyCall.classList.add('active');
    });

    const closeEmergencyModal = () => {
      this.dom.modalConfirmEmergencyCall.classList.remove('active');
    };
    this.dom.btnCloseConfirmEmergency.addEventListener('click', closeEmergencyModal);
    this.dom.btnDismissConfirmEmergency.addEventListener('click', closeEmergencyModal);

    this.dom.btnExecuteEmergencyCall.addEventListener('click', () => {
      closeEmergencyModal();
      this.vibrate([100, 50, 100]);
      window.radioNetwork.sendDirectCall(this.targetActiveCallsign);
      alert('🚨 Экстренный вызов отправлен ребенку! Сирена активирована.');
    });

    // SOS Emergency Modal Handlers
    this.dom.btnSosViewOnMap.addEventListener('click', () => {
      this.dom.modalSosAlarm.classList.remove('active');
      if (this.childLocation && this.map) {
        this.map.setView([this.childLocation.lat, this.childLocation.lng], 18);
      }
    });
    this.dom.btnDismissSosAlarm.addEventListener('click', () => {
      this.dom.modalSosAlarm.classList.remove('active');
    });

    // Settings Modal
    this.dom.btnOpenConfig.addEventListener('click', () => {
      this.dom.inputChildUniqueId.value = this.childId;
      if (this.dom.inputParentChildName) {
        this.dom.inputParentChildName.value = this.childName;
      }
      this.tempSelectedParentAvatar = this.childAvatar;
      if (this.dom.parentChildAvatarGrid) {
        this._renderAvatarPickerGrid(this.dom.parentChildAvatarGrid, this.childAvatar, (newAv) => {
          this.tempSelectedParentAvatar = newAv;
        });
      }

      if (this.dom.inputSettingsAdminPin) {
        this.dom.inputSettingsAdminPin.value = this.adminPin;
      }
      if (this.dom.inputSettingsChildPin) {
        this.dom.inputSettingsChildPin.value = this.childPin;
      }

      if (window.AndroidNative && window.AndroidNative.getAppVersionInfo) {
        try {
          const info = JSON.parse(window.AndroidNative.getAppVersionInfo());
          if (this.dom.labelCurrentAppVersion) {
            this.dom.labelCurrentAppVersion.textContent = `v${info.versionName} (${info.versionCode})`;
          }
        } catch (e) {}
      }
      const savedOtaUrl = localStorage.getItem('guardian_ota_url');
      if (savedOtaUrl && this.dom.inputOtaManifestUrl) {
        this.dom.inputOtaManifestUrl.value = savedOtaUrl;
      }
      if (this.dom.toggleBiometricAuth) {
        this.dom.toggleBiometricAuth.checked = localStorage.getItem('guardian_bio_auth_enabled') !== 'false';
      }
      this._refreshGpsMacroUI();
      this.dom.modalConfig.classList.add('active');
    });

    if (this.dom.toggleBiometricAuth) {
      this.dom.toggleBiometricAuth.addEventListener('change', () => {
        localStorage.setItem('guardian_bio_auth_enabled', this.dom.toggleBiometricAuth.checked ? 'true' : 'false');
      });
    }

    this.dom.btnCloseConfig.addEventListener('click', () => {
      this.dom.modalConfig.classList.remove('active');
    });

    // Check for OTA update button
    this.dom.btnCheckOtaUpdate.addEventListener('click', () => {
      const url = this.dom.inputOtaManifestUrl.value.trim();
      if (!url) {
        alert('Укажите URL манифеста обновлений!');
        return;
      }
      localStorage.setItem('guardian_ota_url', url);
      this.vibrate(30);
      this.dom.btnCheckOtaUpdate.textContent = '⏳ Проверка...';
      this.dom.btnCheckOtaUpdate.disabled = true;

      if (window.AndroidNative && window.AndroidNative.checkForOtaUpdate) {
        window.AndroidNative.checkForOtaUpdate(url);
      } else {
        setTimeout(() => {
          this.dom.btnCheckOtaUpdate.textContent = '🔄 Проверить обновление';
          this.dom.btnCheckOtaUpdate.disabled = false;
          alert('Обновление по воздуху доступно только в установленном Android-приложении.');
        }, 1000);
      }
    });

    // Download and install OTA update button
    this.dom.btnDownloadInstallOta.addEventListener('click', () => {
      if (!this.pendingOtaApkUrl) return;
      this.vibrate([40, 40]);
      this.dom.btnDownloadInstallOta.disabled = true;
      this.dom.btnDownloadInstallOta.textContent = '⏳ Скачивание...';
      this.dom.otaProgressContainer.style.display = 'block';

      if (window.AndroidNative && window.AndroidNative.startOtaDownload) {
        window.AndroidNative.startOtaDownload(this.pendingOtaApkUrl);
      }
    });

    // Autostart OEM settings helper
    this.dom.btnOpenAutostartSettings.addEventListener('click', () => {
      if (window.AndroidNative && window.AndroidNative.openOemAutostartSettings) {
        window.AndroidNative.openOemAutostartSettings();
      } else {
        alert('Настройки автозапуска доступны на Android.');
      }
    });

    this.dom.btnSaveConfig.addEventListener('click', () => {
      const now = Date.now();
      const newChildId = this.dom.inputChildUniqueId.value.trim();
      if (newChildId) {
        this.childId = newChildId;
        localStorage.setItem('guardian_child_id', this.childId);
        this._bindCallsignsAndTopics();
      }

      const pChildName = (this.dom.inputParentChildName?.value || '').trim();
      if (pChildName) {
        this.childName = pChildName;
        localStorage.setItem('guardian_child_name', this.childName);
      }
      if (this.tempSelectedParentAvatar) {
        this.childAvatar = this.tempSelectedParentAvatar;
        localStorage.setItem('guardian_child_avatar', this.childAvatar);
      }
      this.profileUpdatedAt = now;
      localStorage.setItem('guardian_profile_updated_at', now.toString());

      // Save PINs if modified
      const aPin = (this.dom.inputSettingsAdminPin?.value || '').trim();
      if (aPin && aPin.length === 4 && /^\d+$/.test(aPin)) {
        this.adminPin = aPin;
        localStorage.setItem('guardian_admin_pin', aPin);
        window.radioNetwork.sendAdminPinSync(this.targetActiveCallsign, aPin);
      }
      const cPin = (this.dom.inputSettingsChildPin?.value || '').trim();
      if (cPin && cPin.length === 4 && /^\d+$/.test(cPin)) {
        this.childPin = cPin;
        localStorage.setItem('guardian_child_pin', cPin);
      }

      // Broadcast profile to child with timestamp
      window.radioNetwork.sendChildProfileUpdate(this.targetActiveCallsign, this.childName, this.childAvatar, now);

      // Update map marker
      if (this.childLocation) {
        this._updateChildMarker(this.childLocation.lat, this.childLocation.lng, this.childLocation.accuracy);
      }
      if (this.dom.childStatusText) {
        this.dom.childStatusText.textContent = `${this.childName}: В сети`;
      }

      this.dom.modalConfig.classList.remove('active');
      this.showQuickToast('Настройки сохранены! Ребенок: ' + this.childName + ' (' + this.childId + ')', 2500);
    });

    if (this.dom.btnSaveAdminPinDirect) {
      this.dom.btnSaveAdminPinDirect.addEventListener('click', () => {
        const pin = (this.dom.inputSettingsAdminPin?.value || '').trim();
        if (pin && pin.length === 4 && /^\d+$/.test(pin)) {
          this.adminPin = pin;
          localStorage.setItem('guardian_admin_pin', pin);
          window.radioNetwork.sendAdminPinSync(this.targetActiveCallsign, pin);
          this.showQuickToast('PIN Родителя обновлен и синхронизирован с телефоном ребенка!', 2500);
        } else {
          alert('PIN Родителя должен состоять ровно из 4 цифр!');
        }
      });
    }

    if (this.dom.btnSaveChildPinDirect) {
      this.dom.btnSaveChildPinDirect.addEventListener('click', () => {
        const pin = (this.dom.inputSettingsChildPin?.value || '').trim();
        if (pin && pin.length === 4 && /^\d+$/.test(pin)) {
          this.childPin = pin;
          localStorage.setItem('guardian_child_pin', pin);
          this.showQuickToast('PIN Ребенка обновлен!', 2500);
        } else {
          alert('PIN Ребенка должен состоять ровно из 4 цифр!');
        }
      });
    }

    if (this.dom.btnResetAdminPin) {
      this.dom.btnResetAdminPin.addEventListener('click', () => {
        const pin = prompt('Введите новый 4-значный PIN Родителя:', this.adminPin);
        if (pin && pin.length === 4 && /^\d+$/.test(pin)) {
          this.adminPin = pin;
          localStorage.setItem('guardian_admin_pin', pin);
          if (this.dom.inputSettingsAdminPin) this.dom.inputSettingsAdminPin.value = pin;
          window.radioNetwork.sendAdminPinSync(this.targetActiveCallsign, pin);
          this.showQuickToast('PIN Родителя обновлен!', 2000);
        }
      });
    }

    if (this.dom.btnResetChildPin) {
      this.dom.btnResetChildPin.addEventListener('click', () => {
        const pin = prompt('Введите новый 4-значный PIN Ребенка:', this.childPin);
        if (pin && pin.length === 4 && /^\d+$/.test(pin)) {
          this.childPin = pin;
          localStorage.setItem('guardian_child_pin', pin);
          if (this.dom.inputSettingsChildPin) this.dom.inputSettingsChildPin.value = pin;
          this.showQuickToast('PIN Ребенка обновлен!', 2000);
        }
      });
    }

    this.dom.btnResetSetupCompletely.addEventListener('click', () => {
      if (confirm('Сбросить привязку и начать первоначальную настройку заново?')) {
        localStorage.clear();
        location.reload();
      }
    });

    this.dom.btnAcceptCall.addEventListener('click', () => {
      this.dom.modalIncomingCall.classList.remove('active');
    });
  }

  _updateSoundToggleUI() {
    if (!this.dom.btnToggleSoundMode) return;
    const vol = this.selectedVolumePercent || 100;
    if (this.isChildSilent) {
      this.dom.soundActionIcon.textContent = '🔇';
      this.dom.soundActionTitle.textContent = 'Режим: Без звука';
      this.dom.soundActionDesc.textContent = `Нажмите для включения (${vol}%)`;
      this.dom.btnToggleSoundMode.classList.remove('action-sound');
    } else {
      this.dom.soundActionIcon.textContent = '🔊';
      this.dom.soundActionTitle.textContent = `Звук: ${vol}% (ВКЛ)`;
      this.dom.soundActionDesc.textContent = 'Нажмите, чтобы отключить звук';
      this.dom.btnToggleSoundMode.classList.add('action-sound');
    }
  }

  _updateChildGpsToggleUI() {
    if (!this.dom.btnToggleChildGps) return;
    if (this.isChildGpsEnabled) {
      this.dom.gpsToggleIcon.textContent = '📍';
      this.dom.gpsToggleTitle.textContent = 'Геолокация: ВКЛ';
      this.dom.gpsToggleDesc.textContent = 'Нажмите для отключения GPS у ребенка';
      this.dom.btnToggleChildGps.classList.add('action-gps-active');
    } else {
      this.dom.gpsToggleIcon.textContent = '🛑';
      this.dom.gpsToggleTitle.textContent = 'Геолокация: ВЫКЛ';
      this.dom.gpsToggleDesc.textContent = 'Нажмите для включения GPS у ребенка';
      this.dom.btnToggleChildGps.classList.remove('action-gps-active');
    }
  }

  /* ==========================================================================
     AMBIENT CONFIRMATION MODAL & HOLD-TO-LISTEN
     ========================================================================== */
  _initAmbientConfirmationModal() {
    const closeModal = () => {
      if (this.isHoldingAmbient) {
        this.isHoldingAmbient = false;
        window.radioNetwork.sendAmbientListenStop(this.targetActiveCallsign);
        this.dom.btnModalHoldAmbient.classList.remove('holding');
      }
      this.dom.modalConfirmAmbient.classList.remove('active');
    };

    this.dom.btnCloseConfirmAmbient.addEventListener('click', closeModal);
    this.dom.btnDismissConfirmAmbient.addEventListener('click', closeModal);

    const onStartAmbientHold = (e) => {
      e.preventDefault();
      if (this.isHoldingAmbient) return;
      this.isHoldingAmbient = true;

      this.dom.btnModalHoldAmbient.classList.add('holding');
      this.dom.btnModalHoldAmbient.textContent = '🔴 СЛУШАЮ... (ОТПУСТИТЕ ДЛЯ СТОП)';
      this.vibrate(40);

      window.radioNetwork.sendAmbientListenStart(this.targetActiveCallsign);

      window.addEventListener('touchend', onStopAmbientHold, { once: true });
      window.addEventListener('touchcancel', onStopAmbientHold, { once: true });
      window.addEventListener('mouseup', onStopAmbientHold, { once: true });
    };

    const onStopAmbientHold = (e) => {
      if (e && e.preventDefault) e.preventDefault();
      if (!this.isHoldingAmbient) return;
      this.isHoldingAmbient = false;

      this.dom.btnModalHoldAmbient.classList.remove('holding');
      this.dom.btnModalHoldAmbient.textContent = '🎙️ ЗАЖМИТЕ И СЛУШАЙТЕ';
      this.vibrate(30);

      window.radioNetwork.sendAmbientListenStop(this.targetActiveCallsign);

      if (this.currentPttAudio) {
        try { this.currentPttAudio.pause(); } catch(err){}
      }
    };

    this.dom.btnModalHoldAmbient.addEventListener('touchstart', onStartAmbientHold, { passive: false });
    this.dom.btnModalHoldAmbient.addEventListener('mousedown', onStartAmbientHold);
    this.dom.btnModalHoldAmbient.addEventListener('touchend', onStopAmbientHold);
    this.dom.btnModalHoldAmbient.addEventListener('mouseup', onStopAmbientHold);

    window.addEventListener('blur', onStopAmbientHold);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) onStopAmbientHold();
    });
  }

  /* ==========================================================================
     MULTI-ZONE GEOFENCING (HOME, SCHOOL, ETC. ARRIVAL / DEPARTURE ALERTS)
     ========================================================================== */
  _initMultiZoneGeofenceUI() {
    this._renderGeofenceZonesList();

    this.dom.btnOpenAddZoneModal.addEventListener('click', () => {
      this._openAddZoneModal();
    });

    this.dom.btnCloseAddZone.addEventListener('click', () => {
      this.dom.modalAddGeofenceZone.classList.remove('active');
    });

    this.dom.btnQuickAnchorCurrent.addEventListener('click', () => {
      if (!this.childLocation) {
        alert('Сначала запросите координаты ребенка!');
        return;
      }
      const name = prompt('Введите название для этой зоны:', 'Новая точка');
      if (name) {
        const newZone = {
          id: 'zone_' + Date.now(),
          name: name,
          icon: '📍',
          lat: this.childLocation.lat,
          lng: this.childLocation.lng,
          radius: 100
        };
        this.geofenceZones.push(newZone);
        this._saveAndSyncZones();
        this._renderGeofenceZonesList();
        this._renderZoneCirclesOnMap();
        alert(`Зона "${name}" успешно сохранена!`);
      }
    });

    // Preset chips in modal
    document.querySelectorAll('.zone-preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.zone-preset-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.dom.inputNewZoneName.value = btn.dataset.name;
        this.tempNewZoneIcon = btn.dataset.icon;
      });
    });

    // Radius buttons in modal
    document.querySelectorAll('.zone-radius-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.zone-radius-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.tempNewZoneRadius = parseInt(btn.dataset.r, 10);
      });
    });

    this.dom.btnUseCurrentChildLocForZone.addEventListener('click', () => {
      if (this.childLocation) {
        this.tempNewZoneLat = this.childLocation.lat;
        this.tempNewZoneLng = this.childLocation.lng;
        this.dom.zoneCoordsPreview.textContent = `Выбрано место ребенка: ${this.tempNewZoneLat.toFixed(5)}, ${this.tempNewZoneLng.toFixed(5)}`;
      } else {
        alert('Координаты ребенка пока не получены.');
      }
    });

    this.dom.btnSaveGeofenceZone.addEventListener('click', () => {
      const name = this.dom.inputNewZoneName.value.trim();
      if (!name) {
        alert('Введите название зоны (например: Дом или Школа)!');
        return;
      }
      if (!this.tempNewZoneLat || !this.tempNewZoneLng) {
        if (this.childLocation) {
          this.tempNewZoneLat = this.childLocation.lat;
          this.tempNewZoneLng = this.childLocation.lng;
        } else {
          alert('Выберите координаты зоны (нажмите "Использовать текущее место ребенка")!');
          return;
        }
      }

      const zone = {
        id: 'zone_' + Date.now(),
        name: name,
        icon: this.tempNewZoneIcon || '📍',
        lat: this.tempNewZoneLat,
        lng: this.tempNewZoneLng,
        radius: this.tempNewZoneRadius || 100
      };

      this.geofenceZones.push(zone);
      this._saveAndSyncZones();
      this._renderGeofenceZonesList();
      this._renderZoneCirclesOnMap();

      this.dom.modalAddGeofenceZone.classList.remove('active');
      this.vibrate([40, 40]);
      alert(`Гео-зона "${name}" успешно создана!`);
    });
  }

  _openAddZoneModal() {
    this.dom.inputNewZoneName.value = 'Дом';
    this.tempNewZoneIcon = '🏠';
    this.tempNewZoneRadius = 100;
    document.querySelectorAll('.zone-preset-btn').forEach((b, i) => b.classList.toggle('active', i === 0));
    document.querySelectorAll('.zone-radius-btn').forEach((b, i) => b.classList.toggle('active', i === 1));

    if (this.childLocation) {
      this.tempNewZoneLat = this.childLocation.lat;
      this.tempNewZoneLng = this.childLocation.lng;
      this.dom.zoneCoordsPreview.textContent = `Место ребенка: ${this.childLocation.lat.toFixed(5)}, ${this.childLocation.lng.toFixed(5)}`;
    } else {
      this.tempNewZoneLat = null;
      this.tempNewZoneLng = null;
      this.dom.zoneCoordsPreview.textContent = 'Координаты: не выбраны (нажмите кнопку выше)';
    }

    this.dom.modalAddGeofenceZone.classList.add('active');
  }

  _saveAndSyncZones() {
    localStorage.setItem('guardian_geofence_zones', JSON.stringify(this.geofenceZones));
    window.radioNetwork.sendZonesSync(this.targetActiveCallsign, this.geofenceZones);
  }

  _renderGeofenceZonesList() {
    if (!this.dom.geofenceZonesList) return;
    this.dom.geofenceZonesList.innerHTML = '';

    if (this.geofenceZones.length === 0) {
      this.dom.geofenceZonesList.innerHTML = '<div style="text-align: center; color: #64748b; font-size: 11px; padding: 12px;">Зоны не заданы. Добавьте "Дом", "Школа", чтобы знать, когда ребенок прибывает или уходит.</div>';
      return;
    }

    this.geofenceZones.forEach((zone, idx) => {
      const isInside = this.zoneStatusMap.get(zone.id) === true;
      const card = document.createElement('div');
      card.className = 'zone-card-item' + (isInside ? ' inside' : '');

      card.innerHTML = `
        <div class="zone-card-left">
          <span class="zone-icon">${zone.icon || '📍'}</span>
          <div class="zone-info">
            <span class="zone-title">${zone.name}</span>
            <span class="zone-sub">Радиус: ${zone.radius} м</span>
          </div>
        </div>
        <div class="zone-card-right">
          <span class="zone-status-pill ${isInside ? 'inside' : ''}">${isInside ? '🟢 Ребенок там' : '⚪ Вне зоны'}</span>
          <button class="zone-del-btn" title="Удалить зону">✖</button>
        </div>
      `;

      card.querySelector('.zone-del-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm(`Удалить зону "${zone.name}"?`)) {
          this.geofenceZones.splice(idx, 1);
          this.zoneStatusMap.delete(zone.id);
          this._saveAndSyncZones();
          this._renderGeofenceZonesList();
          this._renderZoneCirclesOnMap();
        }
      });

      card.addEventListener('click', () => {
        if (this.map) {
          this.map.setView([zone.lat, zone.lng], 17);
        }
      });

      this.dom.geofenceZonesList.appendChild(card);
    });
  }

  _renderZoneCirclesOnMap() {
    if (!this.map) return;

    this.zoneCircleLayers.forEach(layer => this.map.removeLayer(layer));
    this.zoneCircleLayers.clear();

    this.geofenceZones.forEach(zone => {
      const isInside = this.zoneStatusMap.get(zone.id) === true;
      const circle = L.circle([zone.lat, zone.lng], {
        radius: zone.radius,
        color: isInside ? '#10b981' : '#3b82f6',
        fillColor: isInside ? '#10b981' : '#3b82f6',
        fillOpacity: 0.15,
        weight: 2,
        dashArray: isInside ? null : '4, 6'
      }).addTo(this.map);

      circle.bindTooltip(`<b>${zone.icon} ${zone.name}</b> (${zone.radius}м)`, { permanent: false, direction: 'top' });
      this.zoneCircleLayers.set(zone.id, circle);
    });
  }

  _checkZonesArrivalDeparture(childLat, childLng) {
    if (!this.geofenceZones || this.geofenceZones.length === 0) return;

    let hasStatusChanged = false;

    this.geofenceZones.forEach(zone => {
      const dist = this._calculateDistance(zone.lat, zone.lng, childLat, childLng);
      const isInside = dist <= zone.radius;
      const wasInside = this.zoneStatusMap.get(zone.id);

      if (wasInside === undefined) {
        this.zoneStatusMap.set(zone.id, isInside);
      } else if (!wasInside && isInside) {
        // ARRIVAL!
        this.zoneStatusMap.set(zone.id, true);
        hasStatusChanged = true;
        this._notifyZoneEvent('arrived', zone);
      } else if (wasInside && !isInside) {
        // DEPARTURE!
        this.zoneStatusMap.set(zone.id, false);
        hasStatusChanged = true;
        this._notifyZoneEvent('left', zone);
      }
    });

    if (hasStatusChanged) {
      this._renderGeofenceZonesList();
      this._renderZoneCirclesOnMap();
    }
  }

  _notifyZoneEvent(type, zone) {
    let title = '';
    let sub = '';
    const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    if (type === 'arrived') {
      title = `🟢 Ребенок прибыл в: ${zone.name}!`;
      sub = `Ребенок находится в зоне "${zone.name}" (Радиус: ${zone.radius}м)`;
      if (window.audioFX) window.audioFX.playRogerBeep();
      this.vibrate([150, 80, 150]);
    } else {
      title = `⚠️ Ребенок покинул зону: ${zone.name}!`;
      sub = `Ребенок вышел из зоны "${zone.name}"`;
      if (window.audioFX) window.audioFX.playEmergencyAlarm();
      this.vibrate([400, 150, 400]);
    }

    // Android Heads-Up System Notification with sound and vibration
    if (window.AndroidNative && window.AndroidNative.showSystemNotification) {
      window.AndroidNative.showSystemNotification(title, sub, true);
    }

    this.dom.displacementBanner.style.display = 'block';
    this.dom.alertBannerTitle.textContent = title;
    this.dom.alertBannerSub.textContent = sub;

    // Event Log inside parent dashboard
    if (this.dom.zoneEventsLog) {
      this.dom.zoneEventsLog.style.display = 'block';
      const entry = document.createElement('div');
      entry.style.cssText = 'padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,0.06); font-size: 10px; display: flex; justify-content: space-between;';
      const color = (type === 'arrived') ? '#34d399' : '#f87171';
      entry.innerHTML = `<span><b style="color: ${color};">${(type === 'arrived') ? '🟢 Прибыл в' : '⚠️ Вышел из'}</b> ${zone.name}</span><span style="color: #64748b;">${timeStr}</span>`;
      this.dom.zoneEventsLog.insertBefore(entry, this.dom.zoneEventsLog.firstChild);
    }
  }

  _hideDisplacementAlert() {
    this.dom.displacementBanner.style.display = 'none';
  }

  /* ==========================================================================
     PHOTO GALLERY UI (SELECTIVE DELETION & DELETE ALL)
     ========================================================================== */
  _initPhotoGalleryUI() {
    this.dom.btnOpenPhotos.addEventListener('click', () => {
      this._openPhotoGalleryModal();
    });

    this.dom.btnClosePhotoGallery.addEventListener('click', () => {
      this.dom.modalPhotoGallery.classList.remove('active');
    });

    this.dom.btnDismissPhotoGallery.addEventListener('click', () => {
      this.dom.modalPhotoGallery.classList.remove('active');
    });

    this.dom.btnDeleteSelectedPhoto.addEventListener('click', () => {
      if (!this.selectedPhotoId) return;

      if (confirm('Удалить этот снимок из галереи?')) {
        this.childPhotoGallery = this.childPhotoGallery.filter(p => p.id !== this.selectedPhotoId);
        localStorage.setItem('guardian_photo_gallery', JSON.stringify(this.childPhotoGallery));
        this._updatePhotoCountBadge();

        if (this.childPhotoGallery.length > 0) {
          this._selectPhotoInGallery(this.childPhotoGallery[0]);
        } else {
          this.selectedPhotoId = null;
          this.dom.selectedPhotoWrap.style.display = 'none';
          this.dom.selectedPhotoMetaRow.style.display = 'none';
        }
        this._renderGalleryThumbs();
        this.vibrate(30);
      }
    });

    this.dom.btnClearPhotoGallery.addEventListener('click', () => {
      if (confirm('Удалить ВСЕ фотографии из галереи?')) {
        this.childPhotoGallery = [];
        this.selectedPhotoId = null;
        localStorage.removeItem('guardian_photo_gallery');
        this._updatePhotoCountBadge();
        this._renderGalleryThumbs();
        this.dom.selectedPhotoWrap.style.display = 'none';
        this.dom.selectedPhotoMetaRow.style.display = 'none';
        this.vibrate(40);
      }
    });

    this._updatePhotoCountBadge();
  }

  _updatePhotoCountBadge() {
    const count = this.childPhotoGallery.length;
    this.dom.btnOpenPhotos.textContent = `📸 Фото (${count})`;
  }

  _openPhotoGalleryModal() {
    this._renderGalleryThumbs();
    if (this.childPhotoGallery.length > 0) {
      this._selectPhotoInGallery(this.childPhotoGallery[0]);
    } else {
      this.selectedPhotoId = null;
      this.dom.selectedPhotoWrap.style.display = 'none';
      this.dom.selectedPhotoMetaRow.style.display = 'none';
    }
    this.dom.modalPhotoGallery.classList.add('active');
  }

  _renderGalleryThumbs() {
    this.dom.galleryThumbsGrid.innerHTML = '';
    if (this.childPhotoGallery.length === 0) {
      this.dom.galleryThumbsGrid.innerHTML = '<div style="grid-column: span 3; text-align: center; color: #64748b; padding: 20px; font-size: 12px;">Галерея пуста.</div>';
      return;
    }

    this.childPhotoGallery.forEach((item) => {
      const card = document.createElement('div');
      card.className = 'gallery-thumb-card' + (item.id === this.selectedPhotoId ? ' active' : '');
      const timeStr = new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      card.innerHTML = `
        <img src="${item.photo}" alt="Снимок">
        <div class="gallery-thumb-time">${timeStr}</div>
      `;
      card.addEventListener('click', () => this._selectPhotoInGallery(item));
      this.dom.galleryThumbsGrid.appendChild(card);
    });
  }

  _selectPhotoInGallery(item) {
    this.selectedPhotoId = item.id;
    this.dom.viewerPhotoImage.src = item.photo;
    this.dom.selectedPhotoWrap.style.display = 'flex';

    const dateStr = new Date(item.timestamp).toLocaleString();
    const locStr = item.location ? ` | Координаты: ${item.location.lat.toFixed(4)}, ${item.location.lng.toFixed(4)}` : '';
    this.dom.photoMetaInfo.textContent = `📅 ${dateStr}${locStr}`;
    this.dom.selectedPhotoMetaRow.style.display = 'flex';

    document.querySelectorAll('.gallery-thumb-card').forEach((el, idx) => {
      el.classList.toggle('active', this.childPhotoGallery[idx] && this.childPhotoGallery[idx].id === item.id);
    });
  }

  /* ==========================================================================
     VIDEO GALLERY UI (FOR PARENT)
     ========================================================================== */
  _initVideoGalleryUI() {
    if (this.dom.btnOpenVideos) {
      this.dom.btnOpenVideos.addEventListener('click', () => {
        this._openVideoGalleryModal();
      });
    }

    if (this.dom.btnCloseVideoGallery) {
      this.dom.btnCloseVideoGallery.addEventListener('click', () => {
        this._closeVideoGalleryModal();
      });
    }

    if (this.dom.btnDismissVideoGallery) {
      this.dom.btnDismissVideoGallery.addEventListener('click', () => {
        this._closeVideoGalleryModal();
      });
    }

    if (this.dom.btnDeleteSelectedVideo) {
      this.dom.btnDeleteSelectedVideo.addEventListener('click', () => {
        if (!this.selectedVideoId) return;
        if (confirm('Удалить это видеосообщение?')) {
          this.childVideoGallery = this.childVideoGallery.filter(v => v.id !== this.selectedVideoId);
          localStorage.setItem('guardian_video_gallery', JSON.stringify(this.childVideoGallery));
          this._updateVideoCountBadge();
          if (this.childVideoGallery.length > 0) {
            this._selectVideoInGallery(this.childVideoGallery[0]);
          } else {
            this.selectedVideoId = null;
            if (this.dom.selectedVideoWrap) this.dom.selectedVideoWrap.style.display = 'none';
            if (this.dom.selectedVideoMetaRow) this.dom.selectedVideoMetaRow.style.display = 'none';
            if (this.dom.viewerVideoPlayer) this.dom.viewerVideoPlayer.src = '';
          }
          this._renderVideoGalleryThumbs();
          this.vibrate(30);
        }
      });
    }

    if (this.dom.btnClearVideoGallery) {
      this.dom.btnClearVideoGallery.addEventListener('click', () => {
        if (confirm('Удалить ВСЕ видеосообщения?')) {
          this.childVideoGallery = [];
          this.selectedVideoId = null;
          localStorage.removeItem('guardian_video_gallery');
          this._updateVideoCountBadge();
          this._renderVideoGalleryThumbs();
          if (this.dom.selectedVideoWrap) this.dom.selectedVideoWrap.style.display = 'none';
          if (this.dom.selectedVideoMetaRow) this.dom.selectedVideoMetaRow.style.display = 'none';
          if (this.dom.viewerVideoPlayer) this.dom.viewerVideoPlayer.src = '';
          this.vibrate(40);
        }
      });
    }

    this._updateVideoCountBadge();
  }

  _updateVideoCountBadge() {
    const count = this.childVideoGallery ? this.childVideoGallery.length : 0;
    if (this.dom.btnOpenVideos) {
      this.dom.btnOpenVideos.textContent = `🎥 Видео (${count})`;
    }
  }

  _openVideoGalleryModal() {
    this._renderVideoGalleryThumbs();
    if (this.childVideoGallery && this.childVideoGallery.length > 0) {
      this._selectVideoInGallery(this.childVideoGallery[0]);
    } else {
      this.selectedVideoId = null;
      if (this.dom.selectedVideoWrap) this.dom.selectedVideoWrap.style.display = 'none';
      if (this.dom.selectedVideoMetaRow) this.dom.selectedVideoMetaRow.style.display = 'none';
      if (this.dom.viewerVideoPlayer) this.dom.viewerVideoPlayer.src = '';
    }
    if (this.dom.modalVideoGallery) {
      this.dom.modalVideoGallery.classList.add('active');
    }
  }

  _closeVideoGalleryModal() {
    if (this.dom.viewerVideoPlayer) {
      try { this.dom.viewerVideoPlayer.pause(); } catch(e) {}
    }
    if (this.dom.modalVideoGallery) {
      this.dom.modalVideoGallery.classList.remove('active');
    }
  }

  _renderVideoGalleryThumbs() {
    if (!this.dom.videoGalleryThumbsGrid) return;
    this.dom.videoGalleryThumbsGrid.innerHTML = '';
    if (!this.childVideoGallery || this.childVideoGallery.length === 0) {
      this.dom.videoGalleryThumbsGrid.innerHTML = '<div style="grid-column: span 3; text-align: center; color: #64748b; padding: 20px; font-size: 12px;">Видеосообщений нет.</div>';
      return;
    }

    this.childVideoGallery.forEach((item) => {
      const card = document.createElement('div');
      card.className = 'gallery-thumb-card' + (item.id === this.selectedVideoId ? ' active' : '');
      const timeStr = new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      card.innerHTML = `
        <div style="width: 100%; height: 75px; background: #0f172a; display: flex; align-items: center; justify-content: center; font-size: 28px; border-radius: 8px;">🎥</div>
        <div class="gallery-thumb-time">${timeStr}</div>
      `;
      card.addEventListener('click', () => this._selectVideoInGallery(item));
      this.dom.videoGalleryThumbsGrid.appendChild(card);
    });
  }

  _selectVideoInGallery(item) {
    this.selectedVideoId = item.id;
    if (this.dom.viewerVideoPlayer) {
      this.dom.viewerVideoPlayer.src = item.video;
      this.dom.viewerVideoPlayer.load();
    }
    if (this.dom.selectedVideoWrap) this.dom.selectedVideoWrap.style.display = 'block';

    const dateStr = new Date(item.timestamp).toLocaleString();
    const locStr = item.location ? ` | Координаты: ${item.location.lat.toFixed(4)}, ${item.location.lng.toFixed(4)}` : '';
    if (this.dom.videoMetaInfo) this.dom.videoMetaInfo.textContent = `📅 ${dateStr}${locStr}`;
    if (this.dom.selectedVideoMetaRow) this.dom.selectedVideoMetaRow.style.display = 'flex';

    document.querySelectorAll('#videoGalleryThumbsGrid .gallery-thumb-card').forEach((el, idx) => {
      el.classList.toggle('active', this.childVideoGallery[idx] && this.childVideoGallery[idx].id === item.id);
    });
  }

  /* ==========================================================================
     REMOTE APPS MANAGER
     ========================================================================== */
  _initRemoteAppsManager() {
    this._renderRemoteApps();

    this.dom.btnShowAddAppModal.addEventListener('click', () => {
      this.dom.modalAddApp.classList.add('active');
      this.dom.inputFilterChildApps.value = '';
      window.radioNetwork.sendRequestInstalledApps(this.targetActiveCallsign);
      this._renderChildInstalledAppsList();
    });

    this.dom.btnCloseAddApp.addEventListener('click', () => {
      this.dom.modalAddApp.classList.remove('active');
    });

    this.dom.btnDismissAddApp.addEventListener('click', () => {
      this.dom.modalAddApp.classList.remove('active');
    });

    this.dom.btnRefreshChildApps.addEventListener('click', () => {
      window.radioNetwork.sendRequestInstalledApps(this.targetActiveCallsign);
      this.vibrate(30);
    });

    this.dom.inputFilterChildApps.addEventListener('input', () => {
      this._renderChildInstalledAppsList();
    });
  }

  _renderRemoteApps() {
    if (!this.dom.remoteAppsGrid) return;
    this.dom.remoteAppsGrid.innerHTML = '';

    this.remoteApps.forEach((app, idx) => {
      const card = document.createElement('div');
      card.className = 'app-remote-card';

      const main = document.createElement('div');
      main.className = 'app-card-main';
      main.innerHTML = `<span class="app-card-icon">${app.icon || '📱'}</span><span class="app-card-title">${app.name}</span>`;
      main.addEventListener('click', () => {
        window.radioNetwork.sendLaunchAppCommand(this.targetActiveCallsign, app.pkg);
        this.vibrate(50);
        alert(`Команда отправлена: Открыть "${app.name}" у ребенка.`);
      });

      const delBtn = document.createElement('button');
      delBtn.className = 'app-delete-btn';
      delBtn.innerHTML = '✖';
      delBtn.title = 'Удалить из списка';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm(`Удалить "${app.name}" из панели удаленного запуска?`)) {
          this.remoteApps.splice(idx, 1);
          localStorage.setItem('guardian_remote_apps', JSON.stringify(this.remoteApps));
          this._renderRemoteApps();
        }
      });

      card.appendChild(main);
      card.appendChild(delBtn);
      this.dom.remoteAppsGrid.appendChild(card);
    });
  }

  _renderChildInstalledAppsList() {
    if (!this.dom.childInstalledAppsList) return;
    const filter = (this.dom.inputFilterChildApps.value || '').toLowerCase().trim();

    const apps = this.childInstalledApps.filter(a => {
      return a.name.toLowerCase().includes(filter) || a.pkg.toLowerCase().includes(filter);
    });

    if (apps.length === 0) {
      this.dom.childInstalledAppsList.innerHTML = `
        <div style="text-align: center; color: #64748b; padding: 20px; font-size: 12px;">
          ${this.childInstalledApps.length === 0 ? 'Загрузка списка приложений... Убедитесь, что ребенок в сети.' : 'Ничего не найдено.'}
        </div>`;
      return;
    }

    this.dom.childInstalledAppsList.innerHTML = '';
    apps.forEach(app => {
      const item = document.createElement('div');
      item.className = 'child-app-pick-item';
      item.innerHTML = `
        <div class="child-app-info">
          <span class="child-app-label">${app.name}</span>
          <span class="child-app-pkg">${app.pkg}</span>
        </div>
        <button class="child-app-add-badge">➕ Добавить</button>
      `;

      item.addEventListener('click', () => {
        const exists = this.remoteApps.some(a => a.pkg === app.pkg);
        if (exists) {
          alert(`Приложение "${app.name}" уже добавлено!`);
          return;
        }

        this.remoteApps.push({ name: app.name, pkg: app.pkg, icon: '📱' });
        localStorage.setItem('guardian_remote_apps', JSON.stringify(this.remoteApps));
        this._renderRemoteApps();
        this.dom.modalAddApp.classList.remove('active');
        this.vibrate([40, 40]);
        alert(`Приложение "${app.name}" добавлено!`);
      });

      this.dom.childInstalledAppsList.appendChild(item);
    });
  }

  /* ==========================================================================
     MAP & LOCATION
     ========================================================================== */
  _initMap() {
    if (this.map) {
      this.map.invalidateSize();
      if (this.role === 'admin') this._startParentLocationTracking();
      return;
    }

    const defaultLat = 55.751244;
    const defaultLng = 37.618423;

    this.map = L.map('tacticalMap', {
      center: [defaultLat, defaultLng],
      zoom: 16,
      zoomControl: false,
      attributionControl: false
    });

    this.mapLayers = {
      streets: L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', { maxZoom: 19, subdomains: 'abcd' }),
      satellite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19 }),
      osm: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 })
    };

    this.mapLayers.streets.addTo(this.map);

    if (this.role === 'admin') {
      this._startParentLocationTracking();
    }
  }

  _startParentLocationTracking() {
    if (!navigator.geolocation) return;
    if (this.parentWatchId) {
      try { navigator.geolocation.clearWatch(this.parentWatchId); } catch (e) {}
    }

    const onPos = (pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      const accuracy = pos.coords.accuracy || 10;
      this.parentLocation = { lat, lng, accuracy };
      this._updateParentMarker(lat, lng, accuracy);
    };

    navigator.geolocation.getCurrentPosition(onPos, () => {}, { enableHighAccuracy: true, timeout: 5000 });
    this.parentWatchId = navigator.geolocation.watchPosition(onPos, () => {}, {
      enableHighAccuracy: true,
      maximumAge: 3000
    });
  }

  _updateParentMarker(lat, lng, accuracy = 0) {
    if (!this.map) return;

    if (!this.parentMarker) {
      const parentIcon = L.divIcon({
        className: 'parent-map-marker',
        html: `<div class="marker-pulse-ring parent-pulse"></div><div class="marker-avatar parent-avatar">👨</div>`,
        iconSize: [40, 40],
        iconAnchor: [20, 20]
      });

      this.parentMarker = L.marker([lat, lng], { icon: parentIcon }).addTo(this.map);
      this.parentMarker.bindPopup(`<b>Вы (Родитель)</b><br>Точность: ~${Math.round(accuracy)}м`);
      if (!this.childLocation) {
        this.map.setView([lat, lng], 16);
      }
    } else {
      this.parentMarker.setLatLng([lat, lng]);
      this.parentMarker.setPopupContent(`<b>Вы (Родитель)</b><br>Точность: ~${Math.round(accuracy)}м`);
    }

    this._updateMapStatusBar();
  }

  _switchMapLayer(layerKey) {
    Object.values(this.mapLayers).forEach(layer => {
      if (this.map.hasLayer(layer)) this.map.removeLayer(layer);
    });
    if (this.mapLayers[layerKey]) {
      this.mapLayers[layerKey].addTo(this.map);
    }
    document.querySelectorAll('.layer-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.layer === layerKey);
    });
  }

  _updateChildMarker(lat, lng, accuracy = 0) {
    if (!this.map) return;

    this.childLocation = { lat, lng, accuracy };
    const av = this.childAvatar || '🧒';
    const name = this.childName || 'Ребенок';

    const childIcon = L.divIcon({
      className: 'child-map-marker',
      html: `<div class="marker-pulse-ring"></div><div class="marker-avatar">${av}</div>`,
      iconSize: [40, 40],
      iconAnchor: [20, 20]
    });

    if (!this.childMarker) {
      this.childMarker = L.marker([lat, lng], { icon: childIcon }).addTo(this.map);
      this.childMarker.bindPopup(`<b>${av} ${name} (${this.childId})</b><br>Точность: ~${Math.round(accuracy)}м`).openPopup();
      if (!this.parentLocation) {
        this.map.setView([lat, lng], 17);
      }
    } else {
      this.childMarker.setIcon(childIcon);
      this.childMarker.setLatLng([lat, lng]);
      this.childMarker.setPopupContent(`<b>${av} ${name} (${this.childId})</b><br>Точность: ~${Math.round(accuracy)}м`);
    }

    this._updateMapStatusBar();
    this._checkZonesArrivalDeparture(lat, lng);
  }

  _updateMapStatusBar() {
    if (!this.dom.mapCoordInfo) return;
    const av = this.childAvatar || '🧒';
    const name = this.childName || 'Ребенок';

    if (this.parentLocation && this.childLocation) {
      const dist = this._calculateDistance(
        this.parentLocation.lat, this.parentLocation.lng,
        this.childLocation.lat, this.childLocation.lng
      );
      let distStr = (dist < 1000) ? `${Math.round(dist)} м` : `${(dist / 1000).toFixed(2)} км`;
      this.dom.mapCoordInfo.innerHTML = `${av} ${name} (${this.childLocation.lat.toFixed(4)}, ${this.childLocation.lng.toFixed(4)}) &nbsp;|&nbsp; 📏 До ребенка: <span class="map-distance-badge">${distStr}</span>`;
    } else if (this.childLocation) {
      this.dom.mapCoordInfo.textContent = `${av} ${name}: ${this.childLocation.lat.toFixed(5)}, ${this.childLocation.lng.toFixed(5)} (±${Math.round(this.childLocation.accuracy || 0)}м)`;
    } else if (this.parentLocation) {
      this.dom.mapCoordInfo.textContent = `👨 Вы: ${this.parentLocation.lat.toFixed(5)}, ${this.parentLocation.lng.toFixed(5)} | Ожидание координат ребенка...`;
    }
  }

  _calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3;
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ/2) * Math.sin(Δλ/2);
    return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)));
  }

  /* ==========================================================================
     AMBIENT STEALTH MIC STREAMING (WATCHDOG ON CHILD)
     ========================================================================== */
  startAmbientAudioStream(parentCallsign) {
    if (this.ambientWatchdog) clearTimeout(this.ambientWatchdog);
    this.ambientWatchdog = setTimeout(() => {
      this.stopAmbientAudioStream();
    }, 2800);

    if (this.ambientStream) return;

    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      this.ambientStream = stream;

      const recordSlice = () => {
        if (!this.ambientStream) return;
        const chunks = [];
        const recorder = new MediaRecorder(this.ambientStream, { audioBitsPerSecond: 16000 });

        recorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) chunks.push(e.data);
        };

        recorder.onstop = () => {
          if (chunks.length > 0) {
            const blob = new Blob(chunks, { type: 'audio/webm' });
            const reader = new FileReader();
            reader.onloadend = () => {
              if (reader.result && reader.result.includes(',')) {
                window.radioNetwork.sendVoicePtt(parentCallsign, reader.result.split(',')[1]);
              }
            };
            reader.readAsDataURL(blob);
          }
        };

        recorder.start();
        setTimeout(() => {
          if (recorder.state === 'recording') recorder.stop();
        }, 400);
      };

      recordSlice();
      this.ambientInterval = setInterval(recordSlice, 450);
    }).catch(err => {
      console.warn('Ambient mic stream error:', err);
    });
  }

  stopAmbientAudioStream() {
    if (this.ambientWatchdog) {
      clearTimeout(this.ambientWatchdog);
      this.ambientWatchdog = null;
    }
    if (this.ambientInterval) {
      clearInterval(this.ambientInterval);
      this.ambientInterval = null;
    }
    if (this.ambientStream) {
      this.ambientStream.getTracks().forEach(t => t.stop());
      this.ambientStream = null;
    }
  }

  /* ==========================================================================
     LOCATION MONITORING & BATTERY WATCHER
     ========================================================================== */
  _startLocationMonitoring() {
    if (!navigator.geolocation) return;

    navigator.geolocation.watchPosition(
      (pos) => {
        this.myLocation = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy
        };

        if (this.role === 'child') {
          this._checkZonesArrivalDeparture(this.myLocation.lat, this.myLocation.lng);
        }
      },
      (err) => {},
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 6000 }
    );
  }

  _startBatteryWatcher() {
    const update = () => {
      let lvl = 100;
      if (window.AndroidNative && window.AndroidNative.getBatteryLevel) {
        try {
          const l = window.AndroidNative.getBatteryLevel();
          if (l > 0 && l <= 100) lvl = l;
        } catch(e) {}
      }

      if (this.dom.childHeaderBattery) {
        this.dom.childHeaderBattery.textContent = `🔋 ${lvl}%`;
      }
    };

    update();
    setInterval(update, 3000);
  }

  onPowerSaverToggled(enabled) {
    this.isPowerSaverActive = enabled;
    if (this.role === 'child') {
      if (window.AndroidNative && window.AndroidNative.setPowerSaverMode) {
        window.AndroidNative.setPowerSaverMode(enabled);
      }
    }
  }

  onZonesSyncedFromParent(zones) {
    this.geofenceZones = zones;
    localStorage.setItem('guardian_geofence_zones', JSON.stringify(zones));
  }

  _initNetwork() {
    window.radioNetwork.onLocationReceived = (senderId, callsign, loc) => {
      if (this.role === 'admin') {
        this.childLocation = loc;
        this.dom.childOnlineDot.classList.add('online');
        this.dom.childStatusText.textContent = `Ребенок: Онлайн`;
        this._updateChildMarker(loc.lat, loc.lng, loc.accuracy || 10);
      }
    };

    window.radioNetwork.onPeerUpdate = (peers) => {
      let childFound = false;
      peers.forEach(peer => {
        const isChild = peer.callsign === this.childCallsign || 
                        peer.callsign === this.targetActiveCallsign ||
                        (peer.childId && peer.childId === this.childId && peer.role === 'child');
        if (isChild) {
          childFound = true;
          this.childBattery = peer.battery || 100;
          this.dom.childBatteryText.textContent = `🔋 ${this.childBattery}%`;
        }
      });

      this.dom.childOnlineDot.classList.toggle('online', childFound);
      this.dom.childStatusText.textContent = childFound ? `Ребенок: Онлайн` : `Ребенок: Ожидание...`;
    };

    window.radioNetwork.onPhotoReceived = (msg) => {
      if (this.role === 'admin') {
        const photoItem = {
          id: 'p_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
          photo: msg.photo,
          timestamp: msg.timestamp || Date.now(),
          location: msg.location || null
        };

        this.childPhotoGallery.unshift(photoItem);
        if (this.childPhotoGallery.length > 60) this.childPhotoGallery.pop();
        localStorage.setItem('guardian_photo_gallery', JSON.stringify(this.childPhotoGallery));

        this._updatePhotoCountBadge();
        this.vibrate([200, 100, 200]);
        if (window.audioFX) window.audioFX.playEmergencyAlarm();

        this._openPhotoGalleryModal();
      }
    };

    window.radioNetwork.onVideoReceived = (msg) => {
      if (this.role === 'admin') {
        const videoItem = {
          id: 'v_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
          video: msg.video,
          timestamp: msg.timestamp || Date.now(),
          location: msg.location || null
        };

        this.childVideoGallery.unshift(videoItem);
        if (this.childVideoGallery.length > 30) this.childVideoGallery.pop();
        localStorage.setItem('guardian_video_gallery', JSON.stringify(this.childVideoGallery));

        this._updateVideoCountBadge();
        this.vibrate([200, 100, 200]);
        if (window.audioFX) window.audioFX.playEmergencyAlarm();

        this._openVideoGalleryModal();
      }
    };

    window.radioNetwork.onInstalledAppsReceived = (apps) => {
      if (this.role === 'admin') {
        this.childInstalledApps = apps;
        this._renderChildInstalledAppsList();
      }
    };

    window.radioNetwork.onSosAlertReceived = (msg) => {
      if (this.role === 'admin') {
        if (msg.lat && msg.lng) {
          this.childLocation = { lat: msg.lat, lng: msg.lng };
          this._updateChildMarker(msg.lat, msg.lng);
          this.dom.sosAlarmCoordsInfo.textContent = `Координаты: ${msg.lat.toFixed(5)}, ${msg.lng.toFixed(5)}`;
        }
        this.dom.modalSosAlarm.classList.add('active');
        if (window.audioFX) window.audioFX.playEmergencyAlarm();
        this.vibrate([1000, 300, 1000, 300, 1500]);
      }
    };

    window.radioNetwork.onIncomingCall = (callerName, ch) => {
      this.dom.incomingCallerName.textContent = callerName;
      this.dom.incomingChannelInfo.textContent = 'Срочное оповещение от родителей!';
      this.dom.modalIncomingCall.classList.add('active');
      if (window.audioFX) window.audioFX.playEmergencyAlarm();
      this.vibrate([400, 200, 400, 200, 800]);
    };
  }

  onPowerSaverToggled(enabled) {
    this.isPowerSaverActive = enabled;
    if (this.role === 'child') {
      let overlay = document.getElementById('childPowerSaverOverlay');
      if (enabled) {
        if (!overlay) {
          overlay = document.createElement('div');
          overlay.id = 'childPowerSaverOverlay';
          overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.88);z-index:99999;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#94a3b8;font-family:sans-serif;pointer-events:none;';
          overlay.innerHTML = '<div style="font-size:50px;margin-bottom:12px;">🔋</div><div style="font-size:16px;font-weight:700;color:#f8fafc;margin-bottom:4px;">Энергосбережение активно</div><div style="font-size:12px;color:#64748b;">Яркость снижена, фоновые задачи закрыты</div>';
          document.body.appendChild(overlay);
        }
      } else {
        if (overlay) overlay.remove();
      }
    }
  }

  /* ==========================================================================
     OTA UPDATES (OVER-THE-AIR) CALLBACKS
     ========================================================================== */
  onOtaUpdateAvailable(versionName, versionCode, changelog, apkUrl) {
    this.pendingOtaApkUrl = apkUrl;
    if (this.dom.btnCheckOtaUpdate) {
      this.dom.btnCheckOtaUpdate.textContent = '🔄 Проверить обновление';
      this.dom.btnCheckOtaUpdate.disabled = false;
    }
    if (this.dom.btnChildCheckOtaUpdate) {
      this.dom.btnChildCheckOtaUpdate.textContent = '🔄 Проверить и обновить это устройство';
      this.dom.btnChildCheckOtaUpdate.disabled = false;
    }
    if (this.dom.otaAvailableCard) {
      this.dom.otaAvailableCard.style.display = 'block';
      this.dom.otaNewVersionTitle.textContent = `🎉 Доступна версия v${versionName} (Сборка ${versionCode})!`;
      this.dom.otaChangelogText.textContent = changelog || 'Исправления и улучшения работы в фоне.';
      this.dom.btnDownloadInstallOta.disabled = false;
      this.dom.btnDownloadInstallOta.textContent = '📥 Скачать и установить сейчас';
    }
    if (this.dom.childOtaAvailableCard) {
      this.dom.childOtaAvailableCard.style.display = 'block';
      if (this.dom.childOtaNewVersionTitle) {
        this.dom.childOtaNewVersionTitle.textContent = `🎉 Доступна версия v${versionName} (Сборка ${versionCode})!`;
      }
      if (this.dom.childOtaChangelogText) {
        this.dom.childOtaChangelogText.textContent = changelog || 'Исправления и улучшения работы в фоне.';
      }
      if (this.dom.btnChildDownloadInstallOta) {
        this.dom.btnChildDownloadInstallOta.disabled = false;
        this.dom.btnChildDownloadInstallOta.textContent = '📥 Скачать и установить сейчас';
      }
    }
    this.vibrate([100, 50, 100]);
  }

  onOtaNoUpdate(currentVersion) {
    if (this.dom.btnCheckOtaUpdate) {
      this.dom.btnCheckOtaUpdate.textContent = '🔄 Проверить обновление';
      this.dom.btnCheckOtaUpdate.disabled = false;
    }
    if (this.dom.btnChildCheckOtaUpdate) {
      this.dom.btnChildCheckOtaUpdate.textContent = '🔄 Проверить и обновить это устройство';
      this.dom.btnChildCheckOtaUpdate.disabled = false;
    }
    if (this.dom.otaAvailableCard) {
      this.dom.otaAvailableCard.style.display = 'none';
    }
    if (this.dom.childOtaAvailableCard) {
      this.dom.childOtaAvailableCard.style.display = 'none';
    }
    alert(`У вас уже установлена актуальная версия Guardian (${currentVersion}). Обновлений нет.`);
  }

  onOtaProgress(percent, downloadedBytes, totalBytes) {
    const mbRead = (downloadedBytes / (1024 * 1024)).toFixed(1);
    const mbTotal = (totalBytes / (1024 * 1024)).toFixed(1);
    const textStatus = `Загрузка: ${mbRead} МБ из ${mbTotal} МБ...`;

    if (this.dom.otaProgressContainer) this.dom.otaProgressContainer.style.display = 'block';
    if (this.dom.otaProgressBarFill) this.dom.otaProgressBarFill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    if (this.dom.otaProgressPercent) this.dom.otaProgressPercent.textContent = `${percent}%`;
    if (this.dom.otaProgressStatus) this.dom.otaProgressStatus.textContent = textStatus;

    if (this.dom.childOtaProgressContainer) this.dom.childOtaProgressContainer.style.display = 'block';
    if (this.dom.childOtaProgressBarFill) this.dom.childOtaProgressBarFill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    if (this.dom.childOtaProgressPercent) this.dom.childOtaProgressPercent.textContent = `${percent}%`;
    if (this.dom.childOtaProgressStatus) this.dom.childOtaProgressStatus.textContent = textStatus;
  }

  onOtaDownloadComplete() {
    if (this.dom.otaProgressStatus) {
      this.dom.otaProgressStatus.textContent = '✅ Загрузка завершена! Запуск установщика...';
    }
    if (this.dom.btnDownloadInstallOta) {
      this.dom.btnDownloadInstallOta.textContent = '✅ Открытие установщика...';
    }
    if (this.dom.childOtaProgressStatus) {
      this.dom.childOtaProgressStatus.textContent = '✅ Загрузка завершена! Запуск установщика...';
    }
    if (this.dom.btnChildDownloadInstallOta) {
      this.dom.btnChildDownloadInstallOta.textContent = '✅ Открытие установщика...';
    }
    this.vibrate([60, 60]);
  }

  onOtaError(errorMsg) {
    if (this.dom.btnCheckOtaUpdate) {
      this.dom.btnCheckOtaUpdate.textContent = '🔄 Проверить и установить обновление';
      this.dom.btnCheckOtaUpdate.disabled = false;
    }
    if (this.dom.btnChildCheckOtaUpdate) {
      this.dom.btnChildCheckOtaUpdate.textContent = '🔄 Проверить и обновить это устройство';
      this.dom.btnChildCheckOtaUpdate.disabled = false;
    }
    if (this.dom.btnDownloadInstallOta) {
      this.dom.btnDownloadInstallOta.disabled = false;
      this.dom.btnDownloadInstallOta.textContent = '📥 Скачать и установить сейчас';
    }
    if (this.dom.btnChildDownloadInstallOta) {
      this.dom.btnChildDownloadInstallOta.disabled = false;
      this.dom.btnChildDownloadInstallOta.textContent = '📥 Скачать и установить сейчас';
    }
    if (this.dom.otaProgressContainer) this.dom.otaProgressContainer.style.display = 'none';
    if (this.dom.childOtaProgressContainer) this.dom.childOtaProgressContainer.style.display = 'none';
    alert('Ошибка OTA обновления: ' + errorMsg);
  }

  /* ==========================================================================
     GPS GESTURE TRAINING & MACRO SYSTEM (CHILD & PARENT)
     ========================================================================== */
  _initGpsTrainingMacroUI() {
    this._refreshGpsMacroUI();

    // Child Dashboard controls
    this.dom.btnChildStartGpsTraining?.addEventListener('click', () => {
      this.startGpsTraining();
    });

    this.dom.btnChildTestGpsTraining?.addEventListener('click', () => {
      this.testGpsMacro();
    });

    this.dom.btnChildResetGpsTraining?.addEventListener('click', () => {
      if (confirm('Сбросить сохраненный макрос включения GPS?')) {
        if (window.AndroidNative && window.AndroidNative.clearGpsMacro) {
          window.AndroidNative.clearGpsMacro();
        }
        this._refreshGpsMacroUI();
      }
    });

    // Parent Remote OTA Update Button
    this.dom.btnRemoteUpdateChild?.addEventListener('click', () => {
      this.triggerRemoteUpdateChild();
    });

    // Legacy / fallback bindings if present
    this.dom.btnStartGpsTraining?.addEventListener('click', () => {
      this.startGpsTraining();
    });

    this.dom.btnTestGpsMacro?.addEventListener('click', () => {
      this.testGpsMacro();
    });

    this.dom.btnClearGpsMacro?.addEventListener('click', () => {
      if (confirm('Сбросить сохраненный макрос включения GPS?')) {
        if (window.AndroidNative && window.AndroidNative.clearGpsMacro) {
          window.AndroidNative.clearGpsMacro();
        }
        this._refreshGpsMacroUI();
      }
    });

    // Auto refresh when returning from Android settings screen
    window.addEventListener('focus', () => this._refreshGpsMacroUI());
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        this._refreshGpsMacroUI();
      } else {
        if (this.currentPttStream) {
          try {
            this.currentPttStream.getTracks().forEach(t => { t.stop(); t.enabled = false; });
          } catch(e) {}
          this.currentPttStream = null;
        }
      }
    });
  }

  startGpsTraining() {
    this.vibrate(40);
    if (window.AndroidNative && window.AndroidNative.startGpsTraining) {
      window.AndroidNative.startGpsTraining();
      if (this.dom.modalConfig) this.dom.modalConfig.classList.remove('active');
    } else {
      alert('Обучение жестам доступно в Android-приложении с активной службой специальных возможностей Guardian Kids.');
    }
  }

  testGpsMacro() {
    this.vibrate(30);
    if (window.AndroidNative && window.AndroidNative.testGpsMacro) {
      window.AndroidNative.testGpsMacro();
    } else {
      alert('Тест макроса доступен на устройстве Android.');
    }
  }

  _refreshGpsMacroUI() {
    if (window.AndroidNative && window.AndroidNative.getGpsMacroInfo) {
      try {
        const info = JSON.parse(window.AndroidNative.getGpsMacroInfo());
        const count = info.stepCount || (info.isCalibrated ? 1 : 0);

        // Child settings modal badge
        if (this.dom.childSettingsGpsStatusBadge) {
          if (info.isCalibrated) {
            this.dom.childSettingsGpsStatusBadge.textContent = `✅ Обучено (${count} шаг.)`;
            this.dom.childSettingsGpsStatusBadge.style.background = 'rgba(16, 185, 129, 0.2)';
            this.dom.childSettingsGpsStatusBadge.style.color = '#6ee7b7';
          } else {
            this.dom.childSettingsGpsStatusBadge.textContent = '⚠️ Не настроено';
            this.dom.childSettingsGpsStatusBadge.style.background = 'rgba(245, 158, 11, 0.2)';
            this.dom.childSettingsGpsStatusBadge.style.color = '#fde68a';
          }
        }

        // Child dashboard UI
        if (this.dom.childGpsMacroStatusBadge) {
          if (info.isCalibrated) {
            this.dom.childGpsMacroStatusBadge.textContent = `✅ Обучено (${count} шаг.)`;
            this.dom.childGpsMacroStatusBadge.style.background = 'rgba(16, 185, 129, 0.2)';
            this.dom.childGpsMacroStatusBadge.style.color = '#6ee7b7';
          } else {
            this.dom.childGpsMacroStatusBadge.textContent = '⚠️ Не настроено';
            this.dom.childGpsMacroStatusBadge.style.background = 'rgba(245, 158, 11, 0.2)';
            this.dom.childGpsMacroStatusBadge.style.color = '#fde68a';
          }
        }

        if (this.dom.childGpsMacroDesc) {
          if (info.isCalibrated) {
            this.dom.childGpsMacroDesc.textContent = `Записано шагов: ${count}. При запросе родителя приложение автоматически выполнит эту последовательность (1, 2...) и вернется назад.`;
          } else {
            this.dom.childGpsMacroDesc.textContent = 'Нажмите «ОБУЧИТЬ», откроются настройки: коснитесь тумблера GPS (шаг 1) и при необходимости подтверждения (шаг 2).';
          }
        }

        // Parent or legacy badges (if any exist)
        if (this.dom.gpsMacroStatusBadge) {
          if (info.isCalibrated) {
            this.dom.gpsMacroStatusBadge.textContent = `✅ Обучено (${count} шаг.)`;
            this.dom.gpsMacroStatusBadge.style.color = '#10b981';
          } else {
            this.dom.gpsMacroStatusBadge.textContent = '⚠️ Не настроено';
            this.dom.gpsMacroStatusBadge.style.color = '#f59e0b';
          }
        }
        if (this.dom.gpsMacroCoordsText) {
          if (info.isCalibrated) {
            this.dom.gpsMacroCoordsText.textContent = `Записано шагов: ${count} (Первая точка: X=${Math.round(info.x)}, Y=${Math.round(info.y)})`;
          } else {
            this.dom.gpsMacroCoordsText.textContent = 'Координаты переключателя: не заданы';
          }
        }
      } catch (e) {}
    }
  }

  triggerRemoteUpdateChild() {
    this.vibrate(30);
    let targetApkUrl = (this.dom.inputOtaManifestUrl?.value || '').trim();
    if (!targetApkUrl) {
      targetApkUrl = localStorage.getItem('last_ota_apk_url') || 'http://192.168.0.15:8080/app-debug.apk';
    }
    localStorage.setItem('last_ota_apk_url', targetApkUrl);

    if (this.dom.remoteOtaStatusContainer) {
      this.dom.remoteOtaStatusContainer.style.display = 'block';
      if (this.dom.remoteOtaStatusText) {
        this.dom.remoteOtaStatusText.textContent = '📡 Отправка команды на телефон ребенка...';
        this.dom.remoteOtaStatusText.style.color = '#fde68a';
      }
      if (this.dom.remoteOtaProgressText) this.dom.remoteOtaProgressText.textContent = '0%';
      if (this.dom.remoteOtaProgressBar) {
        this.dom.remoteOtaProgressBar.style.width = '10%';
        this.dom.remoteOtaProgressBar.style.background = '#f59e0b';
      }
    }

    if (window.radioNetwork && window.radioNetwork.sendRemoteUpdateCommand) {
      window.radioNetwork.sendRemoteUpdateCommand(targetApkUrl);
      this.showQuickToast('🚀 Команда отправлена на телефон ребенка...', 3000);
    } else {
      alert('Ошибка: сеть еще не подключена.');
    }
  }

  onRemoteOtaStatusReceived(msg) {
    console.log('[APP] Remote OTA status from child:', msg);
    if (!this.dom.remoteOtaStatusContainer) return;

    this.dom.remoteOtaStatusContainer.style.display = 'block';

    if (msg.status === 'started' || msg.status === 'downloading' || msg.status === 'progress') {
      const pct = (msg.progress >= 0) ? msg.progress : 0;
      if (this.dom.remoteOtaStatusText) {
        this.dom.remoteOtaStatusText.textContent = `📥 Скачивание ребенком: ${pct}%`;
        this.dom.remoteOtaStatusText.style.color = '#6ee7b7';
      }
      if (this.dom.remoteOtaProgressText) {
        this.dom.remoteOtaProgressText.textContent = `${pct}%`;
      }
      if (this.dom.remoteOtaProgressBar) {
        this.dom.remoteOtaProgressBar.style.width = `${pct}%`;
        this.dom.remoteOtaProgressBar.style.background = '#10b981';
      }
    } else if (msg.status === 'installing') {
      if (this.dom.remoteOtaStatusText) {
        this.dom.remoteOtaStatusText.textContent = '⚙️ Установка обновления на телефоне ребенка...';
        this.dom.remoteOtaStatusText.style.color = '#60a5fa';
      }
      if (this.dom.remoteOtaProgressBar) {
        this.dom.remoteOtaProgressBar.style.width = '100%';
        this.dom.remoteOtaProgressBar.style.background = '#3b82f6';
      }
    } else if (msg.status === 'error') {
      if (this.dom.remoteOtaStatusText) {
        this.dom.remoteOtaStatusText.textContent = `❌ Ошибка у ребенка: ${msg.message || msg.error}`;
        this.dom.remoteOtaStatusText.style.color = '#fca5a5';
      }
      if (this.dom.remoteOtaProgressBar) {
        this.dom.remoteOtaProgressBar.style.background = '#ef4444';
      }
      alert(`⚠️ Ошибка обновления у ребенка:\n\n${msg.message || msg.error}\n\nУбедитесь, что:\n1) На компьютере запущен файл «Запустить_Автообновление.bat»;\n2) Телефон ребенка и компьютер подключены к одному Wi-Fi.`);
    }
  }

  onRemoteOtaUpdateReceived(apkUrl) {
    if (!apkUrl) return;
    console.log('[APP] onRemoteOtaUpdateReceived:', apkUrl);
    this.vibrate([100, 100, 200]);
    if (window.AndroidNative && window.AndroidNative.startOtaDownload) {
      window.AndroidNative.startOtaDownload(apkUrl);
    }
  }

  /* ==========================================================================
     APP VERSIONING & CHANGELOG HISTORY
     ========================================================================== */
  _initVersionAndChangelogUI() {
    const defaultHistory = [
      {
        versionName: "2.5.0",
        versionCode: 4,
        title: "Освобождение микрофона (WhatsApp) и точный запуск триггера GPS",
        date: "06.09.2026",
        features: [
          "Полное освобождение микрофона: голосовые сообщения в WhatsApp и звонки теперь работают идеально",
          "Точный запуск триггера GPS: служба ждет открытия меню настроек и не нажимает на другие приложения",
          "Защита от случайного отключения геолокации, если она уже включена",
          "Стабильный автоматический возврат назад в приложение после переключения"
        ]
      },
      {
        versionName: "2.4.0",
        versionCode: 3,
        title: "Обучение GPS с автопоиском и надежное обновление по воздуху",
        date: "05.09.2026",
        features: [
          "Кнопка «⚡ Авто-найти тумблер» в режиме обучения GPS",
          "Кнопка «⬅ Шаг Назад» и автоматический возврат в приложение после включения",
          "Панель обучения перенесена вниз экрана (не перекрывает тумблеры)",
          "Надежное бесшовное обновление по воздуху (OTA) для обоих телефонов"
        ]
      },
      {
        versionName: "2.3.0",
        versionCode: 2,
        title: "Guardian Kids: Обучение жестам GPS и новый дизайн",
        date: "04.09.2026",
        features: [
          "Новый логотип и официальное название Guardian Kids",
          "Интерактивное обучение касанию GPS с авто-повтором и редактированием",
          "Оповещение об успешном обновлении на детском и родительском устройствах",
          "Журнал версий и изменений в настройках"
        ]
      },
      {
        versionName: "2.2.0",
        versionCode: 1,
        title: "Локальное автообновление и биометрия",
        date: "04.09.2026",
        features: [
          "Локальный OTA-сервер обновлений без Python",
          "Вход по отпечатку пальца для родителя",
          "Уведомления о входе/выходе из гео-зон",
          "Телеметрия звука, выбор громкости (30/60/100%)",
          "Глубокий спящий режим батареи"
        ]
      }
    ];

    this.dom.btnShowVersionHistory?.addEventListener('click', () => {
      this._renderVersionHistory(defaultHistory);
      if (this.dom.modalVersionHistory) {
        this.dom.modalVersionHistory.classList.add('active');
      }
    });

    this.dom.btnCloseVersionHistory?.addEventListener('click', () => {
      if (this.dom.modalVersionHistory) {
        this.dom.modalVersionHistory.classList.remove('active');
      }
    });

    this.dom.btnDismissVersionHistory?.addEventListener('click', () => {
      if (this.dom.modalVersionHistory) {
        this.dom.modalVersionHistory.classList.remove('active');
      }
    });

    this.dom.btnDismissAppUpdated?.addEventListener('click', () => {
      if (this.dom.modalAppUpdated) {
        this.dom.modalAppUpdated.classList.remove('active');
      }
    });
  }

  _renderVersionHistory(history) {
    if (!this.dom.versionHistoryList) return;
    this.dom.versionHistoryList.innerHTML = '';
    history.forEach(item => {
      const card = document.createElement('div');
      card.style.cssText = 'background: rgba(255,255,255,0.04); border: 1px solid var(--border-color); border-radius: 10px; padding: 12px; margin-bottom: 10px;';

      const head = document.createElement('div');
      head.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;';
      head.innerHTML = `<strong style="color: #60a5fa; font-size: 13px;">v${item.versionName}</strong><span style="color: #64748b; font-size: 10px;">${item.date}</span>`;
      card.appendChild(head);

      if (item.title) {
        const title = document.createElement('div');
        title.style.cssText = 'font-weight: 500; font-size: 12px; color: #f1f5f9; margin-bottom: 6px;';
        title.textContent = item.title;
        card.appendChild(title);
      }

      if (item.features && item.features.length) {
        const ul = document.createElement('ul');
        ul.style.cssText = 'margin: 0; padding-left: 18px; font-size: 11px; color: #94a3b8; line-height: 1.4;';
        item.features.forEach(feat => {
          const li = document.createElement('li');
          li.textContent = feat;
          ul.appendChild(li);
        });
        card.appendChild(ul);
      }

      this.dom.versionHistoryList.appendChild(card);
    });
  }

  /* ==========================================================================
     APP JUST UPDATED NOTIFICATION (CHILD & PARENT)
     ========================================================================== */
  _checkAppUpdateNotice() {
    if (window.AndroidNative && window.AndroidNative.checkAndClearUpdateNotice) {
      try {
        const notice = JSON.parse(window.AndroidNative.checkAndClearUpdateNotice());
        if (notice && notice.isJustUpdated) {
          if (this.dom.appUpdatedModalText) {
            this.dom.appUpdatedModalText.textContent = `Приложение Guardian Kids успешно обновлено до версии v${notice.versionName || '2.5.0'}! Все функции безопасности, авто-защита и связь активны.`;
          }
          if (this.dom.modalAppUpdated) {
            this.dom.modalAppUpdated.classList.add('active');
          }
          this.pendingOtaApkUrl = null;
          if (this.dom.otaAvailableCard) this.dom.otaAvailableCard.style.display = 'none';
          if (this.dom.childOtaAvailableCard) this.dom.childOtaAvailableCard.style.display = 'none';
          this.vibrate([100, 100, 100, 250]);

          // If on child device: notify parent immediately via network!
          if (this.role === 'child') {
            setTimeout(() => {
              if (window.radioNetwork && window.radioNetwork.sendChildUpdatedNotice) {
                window.radioNetwork.sendChildUpdatedNotice(notice.versionName, notice.versionCode);
              }
            }, 2500);
          }
        }
      } catch (e) {}
    }
  }

  onChildUpdatedNotice(msg) {
    const ver = msg.versionName || '2.5.0';
    const text = `Приложение ребенка успешно обновлено до версии v${ver}!`;

    // System Notification on Parent device
    if (window.AndroidNative && window.AndroidNative.showSystemNotification) {
      window.AndroidNative.showSystemNotification('🎉 Обновление у ребенка', text, true);
    }

    // Add to Parent Zone & Event Log
    if (this.dom.zoneEventsLog) {
      const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const entry = document.createElement('div');
      entry.className = 'zone-event-entry arrived';
      entry.innerHTML = `<span class="event-time">${timeStr}</span><span class="event-badge">🎉 ОБНОВЛЕНИЕ</span><span class="event-desc">Приложение ребенка обновлено до <strong>v${ver}</strong></span>`;
      this.dom.zoneEventsLog.prepend(entry);
    }

    this.vibrate([80, 50, 80]);
  }

  vibrate(pattern) {
    if (navigator.vibrate) {
      try { navigator.vibrate(pattern); } catch (e) {}
    }
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.app = new GuardianApp();
  window.app.init();
});
