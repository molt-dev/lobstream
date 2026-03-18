import { Readable } from 'stream';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class AudioStreamer extends Readable {
    constructor(wsConnection, options = {}) {
        // CRITICAL: Large buffer to prevent any underruns
        super({ highWaterMark: 131072, ...options });

        this.wsConnection = wsConnection;
        this.sampleRate = 44100;
        this.channels = 2;
        this.blockAlign = 4;

        // --- VOLUMES ---
        this.musicVolumeNormal = 0.2;
        this.musicVolumeDucking = 0.06;
        this.duckingSpeed = 0.05;
        this.speechVolume = 0.7;

        // --- STATE ---
        this.musicBuffer = null;
        this.musicCursor = 0;
        this.currentMusicVolume = this.musicVolumeNormal;

        this.speechQueue = [];

        // 20ms chunk
        this.chunkSize = Math.floor((this.sampleRate * 20) / 1000) * this.blockAlign;

        this.generationInterval = 10;
        this.bufferTargetMs = 1000;

        this.startTime = Date.now();
        this.samplesGenerated = 0;
        this.isGenerating = false;

        this._loadMusic(path.join(__dirname, '../studio/bgm.mp3'));
    }

    _loadMusic(filePath) {
        if (!fs.existsSync(filePath)) return;
        const decoder = spawn('ffmpeg', [
            '-i', filePath, '-f', 's16le', '-ac', '2', '-ar', '44100', 'pipe:1'
        ]);
        const chunks = [];
        decoder.stdout.on('data', c => chunks.push(c));
        decoder.on('close', () => {
            if (chunks.length > 0) this.musicBuffer = Buffer.concat(chunks);
        });
    }

    _read(size) {
        if (!this.isGenerating) {
            this.isGenerating = true;
            this._generateLoop();
        }
    }

    _generateLoop() {
        setImmediate(() => {
            const now = Date.now();
            const elapsed = now - this.startTime;

            const targetMs = elapsed + this.bufferTargetMs;
            const targetSamples = Math.floor((targetMs / 1000) * this.sampleRate);

            while (this.samplesGenerated < targetSamples) {
                const chunk = this._generateChunk();

                if (!this.push(chunk)) {
                    setTimeout(() => this._generateLoop(), this.generationInterval);
                    return;
                }

                this.samplesGenerated += this.chunkSize / this.blockAlign;
            }

            setTimeout(() => this._generateLoop(), this.generationInterval);
        });
    }

    _generateChunk() {
        // 1. Speech
        let speechChunk = null;
        if (this.speechQueue.length > 0) {
            speechChunk = this.speechQueue.shift();
        }

        // 2. Music
        let musicChunk = Buffer.alloc(this.chunkSize, 0);
        if (this.musicBuffer && this.musicBuffer.length > 0) {
            if (this.musicCursor + this.chunkSize > this.musicBuffer.length) {
                this.musicCursor = 0;
            }
            musicChunk = this.musicBuffer.subarray(this.musicCursor, this.musicCursor + this.chunkSize);
            this.musicCursor += this.chunkSize;
        }

        // 3. Mix
        const targetVolume = speechChunk ? this.musicVolumeDucking : this.musicVolumeNormal;
        this.currentMusicVolume += (targetVolume - this.currentMusicVolume) * this.duckingSpeed;

        const output = Buffer.alloc(this.chunkSize);

        for (let i = 0; i < this.chunkSize; i += 2) {
            const musicSample = musicChunk.readInt16LE(i);
            const speechSample = speechChunk ? speechChunk.readInt16LE(i) : 0;

            let mixed = (speechSample * this.speechVolume) + (musicSample * this.currentMusicVolume);
            mixed = Math.max(-32768, Math.min(32767, Math.floor(mixed)));

            output.writeInt16LE(mixed, i);
        }

        return output;
    }

    addPCM(buffer) {
        if (buffer.length % 2 !== 0) {
            console.warn('[AudioStreamer] Received misaligned PCM buffer');
            buffer = buffer.subarray(0, buffer.length - 1);
        }

        // --- NEW: Direct Lip Sync Bypass ---
        // Send the entire buffer to the browser immediately.
        // The browser's audio context scheduler handles large buffers perfectly.
        // This ensures the mouth moves smoothly regardless of FFmpeg/Broadcast status.
        if (this.wsConnection && this.wsConnection.readyState === 1) {
            try {
                this.wsConnection.send(buffer);
            } catch (e) {
                console.warn('[AudioStreamer] Failed to send audio to browser:', e);
            }
        }

        // Split into standard 20ms chunks for the Broadcast (FFmpeg)
        for (let i = 0; i < buffer.length; i += this.chunkSize) {
            const end = Math.min(i + this.chunkSize, buffer.length);
            const chunk = Buffer.alloc(this.chunkSize, 0);
            buffer.copy(chunk, 0, i, end);
            this.speechQueue.push(chunk);
        }
    }

    _destroy(error, callback) {
        this.isGenerating = false;
        callback(error);
    }
}