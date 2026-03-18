import puppeteer from 'puppeteer';
import express from 'express';

import axios from 'axios';
import { WebSocketServer } from 'ws';
import http from 'http';
import path from 'path';
import handler from 'serve-handler';
import { fileURLToPath } from 'url';
import { AudioStreamer } from './AudioStreamer.js';
import { spawn } from 'child_process';

// import pkg from 'edge-tts-client';
// const { EdgeTTS } = pkg;
// Removed broken Node library.
// Using Python edge-tts instead

import dotenv from 'dotenv';
import fs from 'fs';
dotenv.config();

import { heartbeatStream, endStream } from '../index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Config
const STUDIO_PORT = 3006;
const WS_PORT = 3005;

// Helper: Kill process tree (cross-platform)
function killProcessTree(child) {
    try {
        if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', child.pid, '/f', '/t']);
        } else {
            try {
                process.kill(-child.pid, 'SIGKILL');
            } catch (e) {
                child.kill('SIGKILL');
            }
        }
    } catch (e) {
        console.error("Kill Error:", e.message);
    }
}

// Helper: Clean up stale ports (common on Linux/WSL after crashes)
async function cleanupStalePorts() {
    if (process.platform === 'linux') {
        const ports = [STUDIO_PORT, WS_PORT];
        for (const port of ports) {
            try {
                // Try to bind each port to detect if it's in use
                const net = await import('net');
                const server = net.createServer();
                await new Promise((resolve, reject) => {
                    server.on('error', reject);
                    server.listen(port, '127.0.0.1', resolve);
                });
                server.close();
                console.log(`✅ Port ${port} is free`);
            } catch (e) {
                if (e.code === 'EADDRINUSE') {
                    console.log(`⚠️ Port ${port} in use - continuing (browser reconnect will handle)`);
                }
            }
        }
    }
}

let browser, page, wss, wsConnection;
let studioServer;

// Stream State
// Stream State
let currentSession = null;
let currentStreamId = null;
let heartbeatInterval = null;
let isStreaming = false;
let broadcasterProcess = null; // Track broadcaster process
let audioStreamer = null;      // Infinite audio stream
let currentFPS = 12;           // Current target FPS for adaptive throttling
let broadcastStartTime = 0;    // Warmup grace period

// Signal Handler
async function handleSignal() {
    console.log("\n🛑 Received Termination Signal (Ctrl+C). Cleaning up...");
    await stopStream();
    process.exit(0);
}

// 1. Initialize Studio (Browser + WS Server) - No RTMP yet
export async function initStudio(agentSession, streamName, options = {}) {
    if (studioServer) {
        console.log("⚠️ Studio already initialized.");
        return;
    }
    console.log("🎥 Initializing Studio (Warm Standby)...");

    // Store State
    currentSession = agentSession;
    currentStreamId = streamName;

    // Register Cleanup Handlers
    process.on('SIGINT', handleSignal);
    process.on('SIGTERM', handleSignal);

    // Start Heartbeat (Every 60s) to keep DB entry alive even if not streaming RTMP
    if (agentSession && streamName) {
        if (heartbeatInterval) clearInterval(heartbeatInterval); // Clean up existing
        console.log("💓 Starting Heartbeat Loop...");
        heartbeatInterval = setInterval(() => {
            heartbeatStream(agentSession, streamName).catch(err => console.error("Heartbeat Error:", err.message));
        }, 60000);
        heartbeatStream(agentSession, streamName).catch(err => console.error("Heartbeat Error:", err.message));
    }

    // 0. Clean up any stale port bindings (Linux/WSL leaves them sometimes)
    await cleanupStalePorts();

    // 1. (Broadcaster Logic Removed - Launched on-demand)

    // --- 2. Studio Server (HTTP) ---
    if (!studioServer) {
        const app = express();

        // Serve dynamic background image
        app.get('/bg', (req, res) => {
            const studioDir = path.resolve(__dirname, '../studio');
            const extensions = ['png', 'jpg', 'jpeg', 'gif', 'webp'];

            for (const ext of extensions) {
                if (fs.existsSync(path.join(studioDir, `bg.${ext}`))) {
                    console.log(`[Studio] Found background: bg.${ext}. Redirecting...`);
                    return res.redirect(`/bg.${ext}`);
                }
            }

            console.warn(`[Studio] No bg.* found.`);
            res.status(404).send('No background found');
        });

        // Serve static files from the studio directory
        app.use(express.static(path.join(__dirname, '../studio')));

        studioServer = http.createServer(app);
        studioServer.listen(STUDIO_PORT, () => console.log(`🌍 Studio UI: http://localhost:${STUDIO_PORT}/renderer.html`));
    }

    // --- 3. WebSocket Server (MediaRecorder stream + commands) ---
    if (!wss) {
        wss = new WebSocketServer({ port: WS_PORT });
        wss.on('connection', (ws) => {
            console.log("✅ Renderer Connected");
            wsConnection = ws;

            ws.on('message', (data, isBinary) => {
                if (isBinary) {
                    // [FIX] REMOVED DIRECT BINARY WRITE
                    // AudioStreamer now handles independent audio piping.
                    return;
                } else {
                    try {
                        const msg = JSON.parse(data);
                        if (msg.type === 'event' && msg.event === 'audio_end') {
                            // console.log("🎤 Audio Finished (Client Event)");
                            if (options.onAudioEnd) options.onAudioEnd();
                        }
                    } catch (e) {
                        // Ignore non-JSON
                    }
                }
            });
        });
    }

    // --- 4. Launch Puppeteer ---
    await launchBrowser(options);
}

async function launchBrowser(options) {
    console.log("🚀 Launching Browser (Headless)...");

    try {
        // OS Detection
        const isLinux = process.platform === 'linux';
        console.log(`[System Probe] OS: ${process.platform} | Linux/WSL Mode: ${isLinux}`);

        const baseArgs = [
            '--kiosk',                       // Removes navbar
            '--window-position=0,0',         // Locks to top-left
            '--window-size=1280,720',         // Exact resolution
            '--start-fullscreen',
            '--autoplay-policy=no-user-gesture-required',
            '--disable-web-security',
            '--disable-features=AudioServiceSandbox',
            '--no-default-browser-check'
        ];


        const linuxArgs = [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu-sandbox',
            '--ignore-gpu-blocklist',
            '--enable-webgl',
            '--hide-scrollbars',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            '--js-flags="--max-old-space-size=2048"',
            // critical for xvfb
            '--display=' + (process.env.DISPLAY || ':99')
        ];

        // Combine args based on OS
        const finalArgs = isLinux ? [...baseArgs, ...linuxArgs] : baseArgs;

        const launchArgs = {
            // Force headless: false on Linux to support Xvfb
            headless: isLinux ? false : (options.headless !== false ? "new" : false),
            defaultViewport: null,
            handleSIGINT: false,
            handleSIGTERM: false,
            args: finalArgs
        };

        if (process.env.PUPPETEER_EXECUTABLE_PATH) {
            launchArgs.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
        }

        launchArgs.timeout = 60000; // Increase timeout to 60s (safer for Xvfb)

        browser = await puppeteer.launch(launchArgs);

        page = await browser.newPage();

        // --- DIAGNOSTICS: Capture Browser Logs ---
        page.on('console', msg => {
            // Filter noise
            if (msg.text().includes('PAGE LOG')) console.log(msg.text());
        });
        page.on('pageerror', err => console.error('PAGE ERROR:', err.message));
        page.on('requestfailed', req => console.error(`PAGE REQ FAILED: ${req.url()} - ${req.failure().errorText}`));
        // -----------------------------------------

        await page.setViewport({ width: 1280, height: 720 }); // Upgraded to 720p
        // Allow FPS override, otherwise let renderer auto-detect
        const rendererUrl = options.fps
            ? `http://localhost:${STUDIO_PORT}/renderer.html?fps=${options.fps}`
            : `http://localhost:${STUDIO_PORT}/renderer.html?fps=24`;
        await page.goto(rendererUrl, { waitUntil: 'domcontentloaded' });

        // Ensure the page reacts (Audio Context)
        try {
            await page.evaluate(() => document.body.click());
        } catch (e) { }

        console.log("✅ Studio is Live! Ready for On-Demand Broadcasting.");
    } catch (err) {
        console.error("⚠️ BROWSER LAUNCH FAILED:", err.message);
    }
}

export async function takeScreenshot() {
    if (!page) return null;
    const screenshotPath = path.join(__dirname, '../studio/screenshot.jpg');
    await page.screenshot({ path: screenshotPath, quality: 80 });
    return screenshotPath;
}

let currentRtmpUrl = null;
let restartDebounce = null;

export async function restartBroadcasting() {
    if (restartDebounce) return;
    restartDebounce = setTimeout(() => { restartDebounce = null; }, 10000); // 10s cooldown

    console.log("⚠️ low speed detected! Restarting stream to purge lag...");

    // Stop but don't kill the browser/WS, just the FFmpeg process
    await stopBroadcasting();

    // Wait a bit
    await new Promise(r => setTimeout(r, 2000));

    // Restart
    if (currentRtmpUrl) {
        await startBroadcasting(currentRtmpUrl);
    }
}

export async function startBroadcasting(rtmpUrl) {
    if (isStreaming) {
        console.log("⚠️ Already broadcasting.");
        return;
    }
    isStreaming = true;
    currentRtmpUrl = rtmpUrl;
    broadcastStartTime = Date.now();
    console.log("📡 Starting Independent Broadcaster...");

    // 1. Create Audio Streamer with WS Connection
    // Now AudioStreamer has direct access to the browser for sync lock
    audioStreamer = new AudioStreamer(wsConnection);

    // 2. Spawn FFmpeg (Broadcaster)
    const broadcasterScript = path.join(__dirname, 'broadcaster.js');
    broadcasterProcess = spawn('node', [broadcasterScript], {
        stdio: ['pipe', 'pipe', 'inherit'], // Capture stdout for monitoring
        env: { ...process.env, LIVEPEER_RTMP_URL: rtmpUrl }
    });

    // Handle Broadcaster Logs & Speed Monitoring
    broadcasterProcess.stdout.on('data', (data) => {
        const msg = data.toString();
        process.stdout.write(msg); // Forward to console

        // Parse speed metric: [FFmpeg] ... speed=0.45x
        const speedMatch = msg.match(/speed=([\d.]+)x/);
        if (speedMatch) {
            const speedValue = parseFloat(speedMatch[1]);

            // --- Adaptive Framerate (Safety Valve 2.0) ---
            if (speedValue < 0.9) {
                // Too slow! Drop frames (throttle)
                if (currentFPS > 2) {
                    currentFPS = Math.max(2, currentFPS - 1);
                    console.log(`[Stream] 🐢 SLOW (${speedValue}x). Throttling FPS to ${currentFPS}...`);
                    if (wsConnection) wsConnection.send(JSON.stringify({ type: 'command', command: 'set_fps', fps: currentFPS }));
                }
            } else if (speedValue > 0.95) {
                // Performance recovered! Increase frames
                if (currentFPS < 12) {
                    currentFPS = Math.min(12, currentFPS + 1);
                    console.log(`[Stream] 🚀 OK (${speedValue}x). Recovering FPS to ${currentFPS}...`);
                    if (wsConnection) wsConnection.send(JSON.stringify({ type: 'command', command: 'set_fps', fps: currentFPS }));
                }
            }

            // Last resort safety restart (Wait 30s for warmup)
            if (speedValue < 0.5 && (Date.now() - broadcastStartTime > 30000)) {
                console.log(`[Stream] 🚨 CRITICAL LAG: ${speedValue}x. Force restarting...`);
                restartBroadcasting();
            }
        }
    });

    // 3. Pipe our AudioStreamer -> Broadcaster
    audioStreamer.pipe(broadcasterProcess.stdin);

    // [FIX] Handle EPIPE error if broadcaster dies unexpectedly
    broadcasterProcess.stdin.on('error', (err) => {
        if (err.code === 'EPIPE') {
            console.log("[Stream] Broadcaster stdin closed (EPIPE) - cleaning up pipe.");
        } else {
            console.error("[Stream] Broadcaster stdin error:", err.message);
        }
    });
}

export function sendSubtitle(text, duration = 6000) {
    if (!wsConnection) return;
    try {
        wsConnection.send(JSON.stringify({
            type: 'subtitle',
            text: text,
            duration: duration
        }));
    } catch (e) {
        console.error("Failed to send subtitle:", e);
    }
}

export async function stopBroadcasting() {
    if (!isStreaming) return;
    isStreaming = false;
    console.log("🛑 Stopping RTMP Broadcast...");

    // 1. Clear Audio Pipe
    if (audioStreamer) {
        audioStreamer.unpipe();
        audioStreamer.destroy();
        audioStreamer = null;
    }

    // 2. Kill Broadcaster with Promise Wrapper
    if (broadcasterProcess) {
        const proc = broadcasterProcess;
        broadcasterProcess = null; // Detach immediately

        await new Promise((resolve) => {
            const timeout = setTimeout(() => {
                console.warn("⚠️ Broadcaster process did not exit in time. Force resolving.");
                resolve();
            }, 3000); // 3s timeout

            proc.on('exit', () => {
                clearTimeout(timeout);
                // console.log("✅ Broadcaster process exited cleanly.");
                resolve();
            });

            console.log("🛑 Killing Broadcaster Service (Tree)...");
            try {
                if (process.platform === 'win32') {
                    spawn('taskkill', ['/pid', proc.pid, '/f', '/t']);
                } else {
                    // Linux/Mac: Kill process group (-pid) to ensure shell + children die
                    try {
                        process.kill(-proc.pid, 'SIGKILL');
                    } catch (e) {
                        // Fallback if not in a detached group
                        proc.kill('SIGKILL');
                    }
                }
            } catch (e) {
                console.error("Kill Error:", e.message);
                resolve(); // resolve anyway
            }
        });
    }
}

// Fallback Stream Logic
let fallbackInterval = null;

function startFallbackStream() {
    const fallbackImagePath = path.join(__dirname, '../studio/fallback.jpg');

    if (!fs.existsSync(fallbackImagePath)) {
        console.error("❌ Fallback image missing at:", fallbackImagePath);
        return;
    }

    const imageBuffer = fs.readFileSync(fallbackImagePath);

    const pushImage = () => {
        axios.post(`${BROADCASTER_URL}/video`, imageBuffer, {
            headers: { 'Content-Type': 'application/octet-stream' }
        }).catch(err => {
            if (err.code !== 'ECONNREFUSED') console.error("Fallback Video Push Error:", err.message);
        });
    };

    // Push immediately then every 2s
    pushImage();
    fallbackInterval = setInterval(pushImage, 2000);
    console.log("⚠️ Fallback Stream Active.");
}

const DEFAULT_ELEVENLABS_VOICE = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
const DEFAULT_ELEVENLABS_MODEL = "eleven_monolingual_v1";
const DEFAULT_EDGE_VOICE = process.env.EDGE_TTS_VOICE || "en-US-AriaNeural";

/**
 * Speak text using the specified or default provider.
 * @param {string} text - The text to speak.
 * @param {object} options - Configuration options.
 * @param {string} [options.provider] - 'elevenlabs' or 'edge-tts'. Defaults to 'elevenlabs' if key exists, else 'edge-tts'.
 * @param {string} [options.voiceId] - Voice ID (ElevenLabs) or ShortName (Edge TTS).
 * @param {string} [options.modelId] - Model ID (ElevenLabs only).
 */
export async function speak(text, options = {}) {
    let totalPcmBytes = 0;

    // Safety: If AV stream (browser) isn't running, we can't generate audio/lipsync via the browser.
    // However, if we are using EdgeTTS/ElevenLabs directly, we COULD just return the audio...
    // But this function is designed to send audio TO the browser for broadcasting.
    // So if the browser isn't connected, we should just log and return safely.
    if (!wsConnection || !page) {
        console.log(`[Speak] Skipped (AV Stream OFF): "${text}"`);
        return;
    }


    // Determine Provider
    const hasElevenLabsKey = !!process.env.ELEVENLABS_API_KEY;
    let provider = options.provider || (hasElevenLabsKey ? 'elevenlabs' : 'edge-tts');

    console.log(`🗣️ Speaking via [${provider}]: "${text}"`);

    let mp3Buffer;

    try {
        if (provider === 'elevenlabs') {
            if (!hasElevenLabsKey) {
                console.warn("⚠️ ElevenLabs requested but no API Key found. Falling back to edge-tts.");
                provider = 'edge-tts';
            } else {
                const voiceId = options.voiceId || DEFAULT_ELEVENLABS_VOICE;
                const modelId = options.modelId || DEFAULT_ELEVENLABS_MODEL;

                try {
                    const response = await axios({
                        method: 'POST',
                        url: `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
                        data: { text, model_id: modelId },
                        headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
                        responseType: 'arraybuffer'
                    });
                    mp3Buffer = Buffer.from(response.data);
                    console.log(`[Audio Debug] Received ${mp3Buffer.length} bytes from ElevenLabs.`);
                } catch (apiError) {
                    const errorMsg = apiError.response ? apiError.response.data.toString() : apiError.message;
                    console.error("❌ ElevenLabs API Error (Quota/Credit issue?):", errorMsg);
                    console.log("🔄 Falling back to edge-tts...");
                    provider = 'edge-tts';
                }
            }
        }

        if (provider === 'edge-tts' && !mp3Buffer) {
            const voice = options.voiceId || DEFAULT_EDGE_VOICE;

            // Dynamically detect Python executable in venv (cross-platform)
            const skillDir = path.resolve(__dirname, '..');
            const isWindows = process.platform === 'win32';

            const pythonPaths = [
                path.join(skillDir, 'venv', 'Scripts', 'python.exe'),
                path.join(skillDir, 'venv', 'bin', 'python3'),
                path.join(skillDir, 'venv', 'bin', 'python'),
                isWindows ? 'python' : 'python3'
            ];

            let pythonExe = pythonPaths[pythonPaths.length - 1];
            for (const pyPath of pythonPaths) {
                if (fs.existsSync(pyPath)) {
                    pythonExe = pyPath;
                    // console.log(`[EdgeTTS] Using Python: ${pythonExe}`);
                    break;
                }
            }

            // Command: python -m edge_tts --text "..." --write-media -
            await new Promise((resolve, reject) => {
                const python = spawn(pythonExe, [
                    '-m', 'edge_tts',
                    '--text', text,
                    '--voice', voice,
                    '--write-media', '-'
                ]);

                let chunks = [];
                let errorChunks = [];
                python.stdout.on('data', (chunk) => chunks.push(chunk));
                python.stderr.on('data', (chunk) => errorChunks.push(chunk));

                python.on('close', (code) => {
                    if (code !== 0) {
                        const errorMsg = Buffer.concat(errorChunks).toString();
                        reject(new Error(`Edge TTS process exited with code ${code}. Error: ${errorMsg}`));
                    } else if (chunks.length === 0) {
                        reject(new Error("Edge TTS produced no audio chunks"));
                    } else {
                        mp3Buffer = Buffer.concat(chunks);
                        console.log(`[Audio Debug] Generated MP3 Size: ${mp3Buffer.length} bytes via Edge-TTS.`);
                        resolve();
                    }
                });

                python.on('error', (err) => reject(new Error(`Failed to spawn python edge-tts: ${err.message}`)));
            });
        }

        if (!mp3Buffer) {
            console.error(`Unknown TTS provider or generation failed: ${provider}`);
            return;
        }

        // Feed the audio streamer with improved decoding
        if (audioStreamer) {
            const decoder = spawn('ffmpeg', [
                '-f', 'mp3',
                '-i', 'pipe:0',
                // [FIX] Removed complex filter that caused crash. -ar handled resampling.
                '-af', 'aresample=resampler=swr',
                '-f', 's16le',
                '-ar', '44100',
                '-ac', '2',
                'pipe:1'
            ], { stdio: ['pipe', 'pipe', 'pipe'] });

            // Buffer stderr for better error reporting
            let stderrBuffer = '';
            decoder.stderr.on('data', d => {
                stderrBuffer += d.toString();
            });

            decoder.stdin.write(mp3Buffer);
            decoder.stdin.end();

            // CRITICAL FIX: Buffer ALL PCM data before adding to streamer
            // This ensures we add complete, properly aligned audio
            const pcmChunks = [];

            await new Promise((resolve, reject) => {
                decoder.stdout.on('data', (pcmChunk) => {
                    pcmChunks.push(pcmChunk);
                });

                decoder.on('close', (code) => {
                    if (code !== 0) {
                        console.error(`[Decoder Error] FFmpeg exited with code ${code}`);
                        if (stderrBuffer) {
                            // Only show critical errors, not info messages
                            const errors = stderrBuffer.split('\n').filter(line =>
                                line.includes('Error') || line.includes('error')
                            );
                            if (errors.length > 0) {
                                console.error('[Decoder Error]', errors.join('\n'));
                            }
                        }
                        reject(new Error('Audio decoding failed'));
                    } else {
                        resolve();
                    }
                });

                decoder.on('error', (err) => {
                    reject(new Error(`Decoder spawn error: ${err.message}`));
                });
            });

            // Concatenate all PCM chunks into one buffer
            const fullPCM = Buffer.concat(pcmChunks);
            totalPcmBytes = fullPCM.length;

            // Ensure buffer is properly aligned (stereo 16-bit = 4 bytes per sample)
            const alignedLength = Math.floor(fullPCM.length / 4) * 4;
            const alignedPCM = fullPCM.subarray(0, alignedLength);

            if (alignedLength !== fullPCM.length) {
                console.warn(`[Audio] Trimmed ${fullPCM.length - alignedLength} misaligned bytes`);
            }

            // Add complete, aligned buffer to streamer in one go
            audioStreamer.addPCM(alignedPCM);

            console.log(`[Audio] Added ${alignedPCM.length} bytes (${(alignedPCM.length / 176400 * 1000).toFixed(0)}ms) to stream`);
        }

        // Return estimated duration in ms
        // PCM S16LE Stereo 44100Hz = 44100 * 2 (channels) * 2 (bytes per sample) = 176400 bytes per second
        const durationMs = (totalPcmBytes / 176400) * 1000;
        return { duration: Math.ceil(durationMs) };

    } catch (err) {
        console.error("Speech Error:", err.message);
    }
}

export async function setShot(shotName) {
    if (!wsConnection) {
        console.warn("⚠️ Cannot change shot: Renderer (WS) not connected.");
        return;
    }
    console.log(`🎥 Changing Camera Shot to: ${shotName}`);
    wsConnection.send(JSON.stringify({ type: 'command', command: 'set_shot', shot: shotName }));
}

export async function setBackground(url) {
    if (!wsConnection) {
        console.warn("⚠️ Cannot change background: Renderer (WS) not connected.");
        return;
    }
    console.log(`🖼️ Changing Background to: ${url}`);
    wsConnection.send(JSON.stringify({ type: 'background', url: url }));
}



/**
 * Changes the avatar in the studio.
 * @param {string} url - URL of the .vrm file.
 */
export async function setAvatar(url) {
    if (!wsConnection) {
        console.warn("⚠️ Cannot set avatar: Renderer (WS) not connected or stream not started.");
        return;
    }

    if (!url) return;

    console.log(`🎭 Sending Avatar Change Command: ${url}`);

    try {
        wsConnection.send(JSON.stringify({
            type: 'command',
            command: 'load_avatar',
            url: url
        }));
    } catch (e) {
        console.error("❌ Failed to send avatar command:", e);
    }
}

/**
 * Updates the avatar pose (e.g. arm offset).
 * @param {object} pose - Pose settings (e.g. { armOffset: 1.21 }).
 */
export async function setPose(pose) {
    if (!wsConnection) {
        console.warn("⚠️ Cannot set pose: Renderer (WS) not connected.");
        return;
    }
    console.log(`🧍 Setting Avatar Pose:`, pose);
    wsConnection.send(JSON.stringify({ type: 'command', command: 'set_pose', pose }));
}

export async function stopStream(shouldEndInDB = true) {
    console.log("🛑 Stopping Studio...");

    // Remove Listeners
    process.off('SIGINT', handleSignal);
    process.off('SIGTERM', handleSignal);

    // Clear Heartbeat
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }

    // End Stream in DB
    if (shouldEndInDB && currentSession && currentStreamId) {
        console.log("💾 Ending Stream in Database...");
        try {
            await endStream(currentSession, currentStreamId);
            console.log("✅ Stream marked as ended in DB.");
        } catch (e) {
            console.error("❌ Failed to update stream status:", e.message);
        }
    }

    if (browser) {
        await browser.close().catch(() => { });
        browser = null;
        page = null;
    }
    if (wss) {
        wss.close();
        wss = null;
        wsConnection = null;
    }
    if (studioServer) {
        studioServer.close();
        studioServer = null;
    }

    // [FIX] Consolidate cleanup via stopBroadcasting to reset isStreaming flag
    await stopBroadcasting();
}