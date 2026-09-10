/**
 * AeroPTT Tactical Cryptography Engine
 * Shared Channel AES-GCM-256 Encryption (Synchronized across channel members)
 */

class RadioCrypto {
  constructor() {
    this.cryptoKey = null;
    this.isEncrypted = true;
    this.currentChannel = 1;
  }

  async setChannelKey(channel = 1) {
    this.currentChannel = channel;
    const baseKeyString = `AEROPTT_TACTICAL_AES256_CH_${channel}_SECURE_VOICE_STREAM`;
    return this.setPassword(baseKeyString);
  }

  async setPassword(password) {
    try {
      const enc = new TextEncoder();
      const keyMaterial = await crypto.subtle.importKey(
        'raw',
        enc.encode(password),
        { name: 'PBKDF2' },
        false,
        ['deriveKey']
      );

      this.cryptoKey = await crypto.subtle.deriveKey(
        {
          name: 'PBKDF2',
          salt: enc.encode('AeroPTT_Tactical_Salt_2026'),
          iterations: 10000,
          hash: 'SHA-256'
        },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );

      this.isEncrypted = true;
      return true;
    } catch (e) {
      console.warn('Crypto init error, falling back to open channel:', e);
      this.isEncrypted = false;
      return false;
    }
  }

  async encryptAudio(arrayBuffer) {
    if (!this.isEncrypted || !this.cryptoKey) {
      return { encrypted: false, data: arrayBuffer };
    }

    try {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encryptedBuffer = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv },
        this.cryptoKey,
        arrayBuffer
      );

      const packet = new Uint8Array(iv.length + encryptedBuffer.byteLength);
      packet.set(iv, 0);
      packet.set(new Uint8Array(encryptedBuffer), iv.length);

      return { encrypted: true, data: packet.buffer };
    } catch (e) {
      return { encrypted: false, data: arrayBuffer };
    }
  }

  async decryptAudio(arrayBuffer) {
    if (!this.isEncrypted || !this.cryptoKey) {
      return arrayBuffer;
    }

    try {
      const iv = new Uint8Array(arrayBuffer, 0, 12);
      const encryptedData = new Uint8Array(arrayBuffer, 12);

      const decryptedBuffer = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv },
        this.cryptoKey,
        encryptedData
      );

      return decryptedBuffer;
    } catch (e) {
      // If decryption fails, return null
      return null;
    }
  }
}

window.radioCrypto = new RadioCrypto();
