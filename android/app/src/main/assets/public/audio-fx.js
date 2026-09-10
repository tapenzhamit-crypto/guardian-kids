/**
 * AeroPTT Hardware-Accelerated Audio Engine - Direct Web Audio API Buffer Playback
 */

class AudioStreamEngine {
  constructor() {
    this.audioCtx = null;
    this.gainNode = null;
    this.analyzerNode = null;
    this.volume = 1.0;
    this.enableRogerBeep = true;
    this.enableSquelch = true;
    
    this.audioQueue = [];
    this.isPlaying = false;
    this.currentSource = null;
    this.onPlaybackEnd = null;
  }

  init() {
    if (!this.audioCtx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new AudioCtx({ sampleRate: 48000 });
      this.gainNode = this.audioCtx.createGain();
      this.gainNode.gain.value = this.volume;
      this.analyzerNode = this.audioCtx.createAnalyser();
      this.analyzerNode.fftSize = 64;
      
      this.gainNode.connect(this.audioCtx.destination);
    }
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
  }

  setVolume(vol) {
    this.volume = Math.max(0, Math.min(1, vol));
    if (this.gainNode) this.gainNode.gain.value = this.volume;
  }

  playAudioBuffer(arrayBuffer) {
    this.init();
    this.audioQueue.push(arrayBuffer);

    if (!this.isPlaying) {
      this._playNextInQueue();
    }
  }

  playAudioBlob(blob) {
    blob.arrayBuffer().then(buf => this.playAudioBuffer(buf)).catch(() => {});
  }

  async _playNextInQueue() {
    if (this.audioQueue.length === 0) {
      this.isPlaying = false;
      if (this.onPlaybackEnd) this.onPlaybackEnd();
      return;
    }

    this.isPlaying = true;
    const rawBuffer = this.audioQueue.shift();

    try {
      if (this.audioCtx.state === 'suspended') {
        await this.audioCtx.resume();
      }

      // Clone buffer because decodeAudioData detaches the arrayBuffer
      const bufferCopy = rawBuffer.slice(0);
      
      this.audioCtx.decodeAudioData(
        bufferCopy,
        (decodedBuffer) => {
          try {
            const source = this.audioCtx.createBufferSource();
            source.buffer = decodedBuffer;
            this.currentSource = source;

            source.connect(this.analyzerNode);
            this.analyzerNode.connect(this.gainNode);

            source.onended = () => {
              this.currentSource = null;
              this._playNextInQueue();
            };

            source.start(0);
          } catch (e) {
            this._fallbackHtmlAudio(rawBuffer);
          }
        },
        (err) => {
          this._fallbackHtmlAudio(rawBuffer);
        }
      );
    } catch (e) {
      this._fallbackHtmlAudio(rawBuffer);
    }
  }

  _fallbackHtmlAudio(rawBuffer) {
    try {
      const blob = new Blob([rawBuffer], { type: 'audio/webm' });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.volume = this.volume;
      audio.onended = () => {
        URL.revokeObjectURL(url);
        this._playNextInQueue();
      };
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        this._playNextInQueue();
      };
      audio.play().catch(() => {
        this._playNextInQueue();
      });
    } catch (e) {
      this._playNextInQueue();
    }
  }

  playEmergencyAlarm() {
    this.init();
    const now = this.audioCtx.currentTime;
    const osc = this.audioCtx.createOscillator();
    const gain = this.audioCtx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.setValueAtTime(1320, now + 0.15);

    gain.gain.setValueAtTime(0.2, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);

    osc.connect(gain);
    gain.connect(this.gainNode);
    osc.start(now);
    osc.stop(now + 0.4);
  }

  playClickSound() {
    if (!this.enableSquelch) return;
    this.init();
    const now = this.audioCtx.currentTime;
    const osc = this.audioCtx.createOscillator();
    const g = this.audioCtx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(220, now);
    osc.frequency.exponentialRampToValueAtTime(40, now + 0.02);
    g.gain.setValueAtTime(0.18, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.02);
    osc.connect(g);
    g.connect(this.gainNode);
    osc.start(now);
    osc.stop(now + 0.02);
  }

  playSquelchBurst(duration = 0.04) {
    if (!this.enableSquelch) return;
    this.init();
    const now = this.audioCtx.currentTime;
    const count = Math.floor(this.audioCtx.sampleRate * duration);
    const buf = this.audioCtx.createBuffer(1, count, this.audioCtx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < count; i++) d[i] = (Math.random() * 2 - 1) * 0.18;

    const noise = this.audioCtx.createBufferSource();
    noise.buffer = buf;
    const filter = this.audioCtx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1600;
    const g = this.audioCtx.createGain();
    g.gain.setValueAtTime(0.12, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + duration);

    noise.connect(filter);
    filter.connect(g);
    g.connect(this.gainNode);
    noise.start(now);
  }

  playRogerBeep() {
    if (!this.enableRogerBeep) return;
    this.init();
    const now = this.audioCtx.currentTime;

    const o1 = this.audioCtx.createOscillator();
    const g1 = this.audioCtx.createGain();
    o1.type = 'sine';
    o1.frequency.setValueAtTime(1200, now);
    g1.gain.setValueAtTime(0.14, now);
    g1.gain.setValueAtTime(0.14, now + 0.05);
    g1.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
    o1.connect(g1);
    g1.connect(this.gainNode);
    o1.start(now);
    o1.stop(now + 0.06);

    const o2 = this.audioCtx.createOscillator();
    const g2 = this.audioCtx.createGain();
    o2.type = 'sine';
    o2.frequency.setValueAtTime(2400, now + 0.06);
    g2.gain.setValueAtTime(0.14, now + 0.06);
    g2.gain.setValueAtTime(0.14, now + 0.12);
    g2.gain.exponentialRampToValueAtTime(0.001, now + 0.13);
    o2.connect(g2);
    g2.connect(this.gainNode);
    o2.start(now + 0.06);
    o2.stop(now + 0.13);

    setTimeout(() => this.playSquelchBurst(0.03), 130);
  }

  getAudioLevel() {
    if (!this.analyzerNode) return 0;
    const arr = new Uint8Array(this.analyzerNode.frequencyBinCount);
    this.analyzerNode.getByteFrequencyData(arr);
    let sum = 0;
    for (let i = 0; i < arr.length; i++) sum += arr[i];
    return (sum / arr.length) / 255;
  }
}

window.audioFX = new AudioStreamEngine();
