import { createClient } from '@supabase/supabase-js';
import {
    login,
    initStudio,
    startStream,
    startBroadcasting,
    stopBroadcasting,
    takeScreenshot,
    streamData,
    speak,
    connectToStream,
    listenForTips,
    endStream,
    stopAV as stopAVFn,
    setStudioPose,
    ensureWallet,
    updateProfile,
    updateStream,
    uploadAvatar,
    uploadPlaceholder,
    cleanupProcesses,
    heartbeatStream,
    getLiveStreams,
    sendSubtitle,
    sendTip,
    sendChatMessage
} from './index.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './src/config.js';
import { Brain } from './src/Brain.js';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CHARACTER_FILE = path.join(__dirname, 'config', 'character.json');
const STREAM_FILE = path.join(__dirname, 'config', 'stream.json');
const CONTEXT_FILE = path.join(__dirname, 'config', 'context.json');

// Helper to format time
function getTime() {
    return new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

let streamRecord = null;
let persona, streamConfig, session, user;
const watchedChannels = new Map();

async function runSession() {
    let poseSettings = {};
    let currentSpeechId = 0;
    const recentThoughts = new Set();
    let speechQueue;
    let brain;
    let supabase;

    let realtimeChannel;
    let watcherInterval;

    async function cleanup() {
        console.log('\n🛑 Shutting down current session...');
        try {
            if (realtimeChannel) {
                console.log("🔌 Unsubscribing from realtime listeners...");
                realtimeChannel.unsubscribe();
                realtimeChannel = null;
            }
            await stopBroadcasting();
            await stopAVFn(false);
            if (watcherInterval) clearInterval(watcherInterval);

            // Note: We DON'T unsubscribe watchedChannels here to keep inflating viewers across restarts
        } catch (e) {
            console.error("Cleanup error:", e.message);
        }
    }

    try {
        // First run of stream, load values and set configs
        if (!streamRecord) {

            // 2. Load Persona & Stream Config
            if (!fs.existsSync(CHARACTER_FILE)) {
                console.log("⚠️ character.json not found. Generating defaults...");
                fs.writeFileSync(CHARACTER_FILE, JSON.stringify({ name: "ClawBot", bio: "Default" }, null, 4));
            }

            if (!fs.existsSync(STREAM_FILE)) {
                console.log("⚠️ stream.json not found. Generating defaults...");
                fs.writeFileSync(STREAM_FILE, JSON.stringify({ name: "Live Stream", description: "Test" }, null, 4));
            }

            persona = JSON.parse(fs.readFileSync(CHARACTER_FILE, 'utf8'));
            streamConfig = JSON.parse(fs.readFileSync(STREAM_FILE, 'utf8'));

            // 3. Login
            console.log('\n🔐 Logging in...');
            await ensureWallet();
            const loginData = await login();
            session = loginData.session;
            user = loginData.user;
            console.log(`✅ Logged in! Wallet: ${user.wallet.slice(0, 8)}...`);

            // 3.5. Check & Upload Profile Picture
            let avatarUrl = null;
            const pfpCandidates = ['pfp.png', 'pfp.jpg', 'pfp.jpeg', 'pfp.gif', 'profile.png', 'profile.jpg', 'profile.jpeg', 'profile.gif'];
            for (const fileName of pfpCandidates) {
                const pfpPath = path.join(__dirname, 'studio', fileName);
                if (fs.existsSync(pfpPath)) {
                    console.log(`📸 Found profile picture: ${fileName}`);
                    try {
                        avatarUrl = await uploadAvatar(session, pfpPath, user.wallet);
                        console.log(`✅ Avatar uploaded: ${avatarUrl}`);
                        break; // Stop after first valid match
                    } catch (e) {
                        console.warn(`⚠️ Failed to upload avatar (${fileName}):`, e.message);
                    }
                }
            }

            // 4. Update Profile
            const profileUpdates = {
                username: persona.name,
                bio: persona.bio,
                model_details: persona.model_details || ""
            };
            if (process.env.OWNER_ID) {
                profileUpdates.owner_id = process.env.OWNER_ID;
            }
            if (avatarUrl) {
                profileUpdates.avatar_url = avatarUrl;
            }
            await updateProfile(session, profileUpdates);

            // 5. Start stream, get stream record
            console.log('\n📡 Preparing Stream...');
            streamConfig.started_at = new Date().toISOString();
            streamRecord = await startStream(session, streamConfig);
            console.log(`✅ Stream live! ID: ${streamRecord.id}`);
        } else {
            console.log(`\n📡 Reusing existing stream record: ${streamRecord.id}`);
        }

        // 7. Initialize Speech Queue & Brain
        const { SpeechQueue } = await import('./src/SpeechQueue.js');
        speechQueue = new SpeechQueue();

        // Load context
        let additionalContext = "";
        if (fs.existsSync(CONTEXT_FILE)) {
            try {
                const ctx = JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf8'));
                additionalContext = ctx.additional_context || "";
            } catch (e) { }
        }

        brain = new Brain({ persona, streamDetails: streamConfig, additionalContext });

        // 10. Real-time Events & Smart AV Logic
        supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
            global: { headers: { Authorization: `Bearer ${session.access_token}` } }
        });

        const processQueue = async () => {
            const item = speechQueue.getNext();
            if (item) {
                // Deduplication
                if (recentThoughts.has(item.text)) {
                    speechQueue.setSpeaking(false);
                    return;
                }
                recentThoughts.add(item.text);
                if (recentThoughts.size > 50) {
                    const first = recentThoughts.values().next().value;
                    recentThoughts.delete(first);
                }

                speechQueue.setSpeaking(true);
                const mySpeechId = ++currentSpeechId;

                console.log(`🗣️ Speaking [${item.priority}] #${mySpeechId}: ${item.text}`);

                // --- FIX START: Better Subtitle Timing ---
                // 1. Initial Estimate: 500ms per word + 3s buffer (min 6s)
                // This ensures the subtitle stays on screen while audio is generating.
                const estimatedDuration = Math.max(6000, (item.text.split(' ').length * 500) + 3000);
                sendSubtitle(item.text, estimatedDuration);
                // --- FIX END ---

                try {
                    const result = await speak(supabase, streamRecord.id, item.text);

                    // --- FIX START: Update with Exact Duration ---
                    // Once audio is generated, we know exactly how long it is.
                    // Update the subtitle timer to match the audio + 1s buffer.
                    if (result && result.duration) {
                        sendSubtitle(item.text, result.duration + 1000);
                    }
                    // --- FIX END ---

                    // --- FAILURE CHECK ---
                    if (!result || !result.duration || result.duration < 100) {
                        console.warn("⚠️ Audio generation failed. Adding delay.");
                        setTimeout(() => {
                            if (currentSpeechId === mySpeechId) {
                                speechQueue.setSpeaking(false);
                            }
                        }, 2000);
                        return;
                    }

                    // --- PACING LOGIC ---
                    // Minimal buffer to handle hardware tail
                    const finishTime = result.duration + 2000;

                    setTimeout(async () => {
                        if (currentSpeechId === mySpeechId) {
                            speechQueue.setSpeaking(false);
                            smartState.lastSpeechEndedAt = Date.now();
                        }
                    }, finishTime);

                } catch (e) {
                    console.error(`⚠️ Failed to trigger speech: ${e.message}`);
                    speechQueue.setSpeaking(false);
                }
            }
        };

        // 8. Initialize Studio
        await initStudio(session, streamRecord.id, {});

        if (persona.arm_offset !== undefined) poseSettings.armOffset = persona.arm_offset;
        if (persona.zoom !== undefined) poseSettings.zoom = persona.zoom;
        if (persona.offset_x !== undefined) poseSettings.modelOffsetX = persona.offset_x;
        if (persona.offset_y !== undefined) poseSettings.modelOffsetY = persona.offset_y;
        if (persona.lip_sync_multiplier !== undefined) poseSettings.lipSyncMultiplier = persona.lip_sync_multiplier;

        if (Object.keys(poseSettings).length > 0) {
            setStudioPose(poseSettings);
        }

        // 9. Take Screenshot & Set Placeholder
        console.log("📸 Taking initial stream screenshot...");
        try {
            await new Promise(r => setTimeout(r, 5000)); // Wait for render
            const screenshotPath = await takeScreenshot();
            if (screenshotPath && fs.existsSync(screenshotPath)) {
                console.log("⬆️ Uploading screenshot...");
                const publicUrl = await uploadPlaceholder(session, screenshotPath, user.wallet);
                console.log(`✅ Placeholder Uploaded: ${publicUrl}`);

                await updateStream(session, streamRecord.id, {
                    placeholder_image: publicUrl
                });
                console.log("✅ Stream placeholder updated.");
            }
        } catch (e) {
            console.error("⚠️ Failed to set placeholder:", e.message);
        }

        console.log('\n🔈 Establishing Realtime Listeners (Smart AV Mode)...');
        const INACTIVITY_TIMEOUT = 60 * 1000;

        const smartState = {
            isBroadcasting: false,
            lastHumanActivity: Date.now(),
            humanCount: 0,
            chatBuffer: [],
            lastChatProcess: 0,
            idleBuffer: [],
            isRefilling: false,
            lastSpeechEndedAt: 0,
            refillCooldown: 0
        };

        realtimeChannel = connectToStream(supabase, streamRecord.id, {
            onChat: async (msg) => {
                const userName = msg.user || 'Anonymous';
                const text = msg.text || '';

                // IGNORE OWN MESSAGES & OTHER BOTS
                if (userName === persona.name || msg.is_bot) {
                    console.log(`🤖 Bot Message ignored: ${userName}: ${text}`);
                    return;
                }

                console.log(`[CHAT] ${userName}: ${text}`);
                smartState.lastHumanActivity = Date.now();
                smartState.chatBuffer.push({ user: userName, text });

                if (!smartState.isBroadcasting && (persona.enable_streaming !== false)) {
                    console.log("👀 Request to wake up from chat!");
                    smartState.isBroadcasting = true;
                    await startBroadcasting(streamRecord.rtmp_url);
                }
            },
            onViewers: async (stats) => {
                smartState.humanCount = stats.humans;
                brain.updateViewerStats(stats);

                if (stats.humans > 0) {
                    smartState.lastHumanActivity = Date.now();
                    if (!smartState.isBroadcasting && (persona.enable_streaming !== false)) {
                        console.log("👀 Human detected! Starting Broadcast...");
                        smartState.isBroadcasting = true;
                        await startBroadcasting(streamRecord.rtmp_url);
                    }
                }
            }
        });

        // 10.5. Listen for Tips
        listenForTips(supabase, user.wallet, async (tip) => {
            const chain = (process.env.CHAIN || 'bnb').toLowerCase();
            const divisor = chain === 'solana' ? 1e9 : 1e18;
            const symbol = chain === 'solana' ? 'SOL' : 'BNB';
            const displayAmount = (Number(tip.amount_lamports) / divisor).toFixed(6);
            console.log(`💰 TIP RECEIVED: ${displayAmount} ${symbol} from ${tip.sender_wallet}`);
            smartState.lastHumanActivity = Date.now();

            // Try to find the tipper's username
            let senderName = tip.sender_wallet ? `${tip.sender_wallet.slice(0, 4)}...${tip.sender_wallet.slice(-4)}` : 'Anonymous';
            try {
                const { data: profile } = await supabase
                    .from('profiles')
                    .select('username')
                    .eq('wallet_address', tip.sender_wallet)
                    .single();
                if (profile?.username) senderName = profile.username;
            } catch (e) {
                console.warn("⚠️ Could not fetch tipper username:", e.message);
            }

            const reply = await brain.generateTipResponse({
                amount: displayAmount,
                sender: senderName,
                message: tip.message || ""
            });

            speechQueue.add({
                text: reply,
                priority: speechQueue.PRIORITY.HIGH,
                type: 'Tip'
            });

            if (!speechQueue.isSpeaking) await processQueue();

            if (!smartState.isBroadcasting && (persona.enable_streaming !== false)) {
                console.log("👀 Request to wake up from tip!");
                smartState.isBroadcasting = true;
                await startBroadcasting(streamRecord.rtmp_url);
            }
        });

        // 11. Start Watcher Loop (Background)
        let watcherTickCount = 0;
        if (persona.enable_watching !== false) {
            watcherInterval = setInterval(async () => {
                try {
                    watcherTickCount++;
                    console.log(`\n🔍 Watcher Tick #${watcherTickCount}: Full refresh cycle starting...`);
                    const allStreams = await getLiveStreams(session, 20);
                    const liveIds = new Set(allStreams.map(s => s.id));

                    // 1. Cleanup: Drop streams that ENDED
                    for (const [id, channel] of watchedChannels) {
                        if (!liveIds.has(id)) {
                            console.log(`🧹 Stream ${id} ended. Unsubscribing.`);
                            channel.unsubscribe();
                            watchedChannels.delete(id);
                        }
                    }

                    // 2. Cleanup: Drop streams with NO HUMAN viewers
                    for (const [id, channel] of watchedChannels) {
                        const state = channel.presenceState();
                        const humans = Object.values(state).flat().filter(p => p.type === 'human').length;
                        if (humans === 0) {
                            console.log(`📭 No humans in stream ${id}. Dropping to make room.`);
                            channel.unsubscribe();
                            watchedChannels.delete(id);
                        }
                    }

                    // 3. Refill: Join random new streams up to 3 total
                    if (watchedChannels.size < 3) {
                        const others = allStreams.filter(s => s.id !== streamRecord.id && !watchedChannels.has(s.id));
                        const newTargets = others.sort(() => 0.5 - Math.random()).slice(0, 3 - watchedChannels.size);

                        for (const target of newTargets) {
                            console.log(`👀 Joining stream: ${target.title} (${target.id})`);
                            const chan = connectToStream(supabase, target.id, {
                                onViewers: () => { } // Empty callback to enable presence sync
                            });
                            watchedChannels.set(target.id, chan);
                        }
                    }

                    // 4. Wait briefly for presence to sync on newly joined channels
                    if (watchedChannels.size > 0) {
                        await new Promise(r => setTimeout(r, 5000));
                    }

                    // 5. Interact: Check ALL watched streams for humans
                    for (const [id, channel] of watchedChannels) {
                        const targetStream = allStreams.find(s => s.id === id);
                        if (!targetStream) continue;

                        const state = channel.presenceState();
                        const humans = Object.values(state).flat().filter(p => p.type === 'human').length;

                        if (humans > 0) {
                            console.log(`👤 ${humans} human(s) in ${targetStream.title}! Rolling interaction...`);

                            // Roll 40% chance to Chat
                            if (Math.random() < 0.4) {
                                const text = await brain.generateWatcherChat(targetStream);
                                await sendChatMessage(supabase, id, { user: persona.name, text });
                                console.log(`💬 Sent chat to ${targetStream.title}: "${text}"`);
                            }

                            // Roll 10% chance to Tip
                            if (Math.random() < 0.1 && persona.enable_tipping) {
                                const { data: owner } = await supabase.from('profiles').select('wallet').eq('id', targetStream.user_id).single();
                                if (owner?.wallet) {
                                    try {
                                        const _chain = (process.env.CHAIN || 'bnb').toLowerCase();
                                        const _sym = _chain === 'solana' ? 'SOL' : 'BNB';
                                        const sig = await sendTip(supabase, owner.wallet, 0.001);
                                        console.log(`💸 Tipped 0.001 ${_sym} to ${targetStream.title}`);
                                        await sendChatMessage(supabase, id, { user: persona.name, text: `I just tipped 0.001 ${_sym}! 🚀` });
                                    } catch (e) { console.warn("Tip failed:", e.message); }
                                }
                            }
                        } else {
                            console.log(`📭 No humans in ${targetStream.title}. Skipping interaction.`);
                        }
                    }

                    console.log(`✅ Watcher Tick #${watcherTickCount} complete. Watching ${watchedChannels.size} streams. Next tick in 2 min.`);

                } catch (e) {
                    console.error("Watcher Loop Error:", e.message);
                }
            }, 120 * 1000);
        } else {
            console.log("🚫 Watcher disabled via character.json");
        }

        // Main Loop
        while (true) {
            try {
                // Keep activity alive if humans are present
                if (smartState.humanCount > 0) {
                    smartState.lastHumanActivity = Date.now();
                }

                // Inactivity Watchdog
                if (smartState.isBroadcasting && (Date.now() - smartState.lastHumanActivity > INACTIVITY_TIMEOUT)) {
                    console.log(`🚨 No humans detected for 1 min. Fully restarting agent for stability...`);
                    await cleanup();
                    return; // Return to main loop for restart
                }

                // AI Watchdog (30s) for stuck speech
                if (speechQueue.isSpeaking && speechQueue.lastSpeakingAt && (Date.now() - speechQueue.lastSpeakingAt > 30000)) {
                    console.warn("⏳ Watchdog: Resetting stuck speech.");
                    speechQueue.setSpeaking(false);
                    await processQueue();
                }

                if (smartState.isBroadcasting) {
                    // Chat Processing
                    if (Date.now() - smartState.lastChatProcess > 5000) {
                        if (smartState.chatBuffer.length > 0) {
                            const randomMsg = smartState.chatBuffer[Math.floor(Math.random() * smartState.chatBuffer.length)];
                            const reply = await brain.generateChatReply(randomMsg.user, randomMsg.text);

                            speechQueue.add({
                                text: reply,
                                priority: speechQueue.PRIORITY.HIGH,
                                type: 'Chat'
                            });

                            if (!speechQueue.isSpeaking) await processQueue();
                            smartState.chatBuffer = [];
                        }
                        smartState.lastChatProcess = Date.now();
                    }

                    // Idle Logic (Enforce 20s gap)
                    if (!speechQueue.isSpeaking && speechQueue.queue.length === 0) {
                        const timeSinceLastSpeech = Date.now() - smartState.lastSpeechEndedAt;

                        // FIX: Check if we are already refilling OR on a failure cooldown
                        const isOnCooldown = smartState.refillCooldown && Date.now() < smartState.refillCooldown;

                        if (smartState.idleBuffer.length <= 2 && !smartState.isRefilling && !isOnCooldown) {
                            smartState.isRefilling = true;
                            console.log("🧠 Refilling thought buffer...");

                            brain.thinkBatch(5).then(thoughts => {
                                if (thoughts && thoughts.length > 0) {
                                    smartState.idleBuffer.push(...thoughts);
                                    smartState.refillCooldown = 0; // Success, clear cooldown
                                } else {
                                    console.warn("⚠️ Brain returned 0 thoughts. Applying cooldown.");
                                    smartState.refillCooldown = Date.now() + 10000; // Wait 10s before retrying
                                }
                                smartState.isRefilling = false;
                            }).catch(() => {
                                console.error("⚠️ ThinkBatch failed. Applying cooldown.");
                                smartState.refillCooldown = Date.now() + 10000; // Wait 10s before retrying
                                smartState.isRefilling = false;
                            });
                        }

                        // Apply 20s gap ONLY for Idle thoughts
                        if (smartState.idleBuffer.length > 0 && smartState.humanCount > 0 && timeSinceLastSpeech > 20000) {
                            const thought = smartState.idleBuffer.shift();
                            speechQueue.add({
                                text: thought,
                                priority: speechQueue.PRIORITY.LOW,
                                type: 'Idle'
                            });
                            await processQueue();
                        }
                    } else if (!speechQueue.isSpeaking && speechQueue.queue.length > 0) {
                        // Interactions in queue speak immediately
                        await processQueue();
                    }
                }

            } catch (e) {
                console.error("Session Loop Error:", e);
            }
            await new Promise(r => setTimeout(r, 2000));
        }

    } catch (err) {
        console.error("Session CRITICAL Error:", err.message);
        await cleanup();
    }
}

async function main() {
    console.log(`\n🎬 === LOBSTREAM AGENT STARTING === 🎬`);
    console.log(`Time: ${getTime()}`);

    // Setup global signal handlers
    process.on('SIGINT', async () => {
        console.log('\n🛑 SIGINT received. Final cleanup...');
        await cleanupProcesses();
        process.exit(0);
    });

    while (true) {
        console.log('\n🚀 Starting new session cycle...');
        await cleanupProcesses();
        await runSession();
        console.log('🔄 Session cycle ended. Waiting 5s before restart...');
        await new Promise(r => setTimeout(r, 5000));
    }
}

main().catch(console.error);
