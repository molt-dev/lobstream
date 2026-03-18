import {
    initStudio,
    startBroadcasting,
    stopBroadcasting,
    takeScreenshot,
    stopStream as stopStudio,
    speak as speakStudio,
    setBackground,
    setShot,
    setPose,
    setAvatar,
    sendSubtitle
} from './scripts/stream.js';

import { createClient } from '@supabase/supabase-js';
import { generateAuthPayload } from './scripts/auth.js';
import { checkReadiness } from './scripts/onboarding.js';
import { Connection, PublicKey, Transaction, SystemProgram, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { Wallet, JsonRpcProvider, parseEther, formatEther } from 'ethers';
import bs58 from 'bs58';
import WebSocket from 'ws';
import { SUPABASE_URL, SUPABASE_ANON_KEY, DEFAULT_RPC_URL } from './src/config.js';
import dotenv from 'dotenv';
dotenv.config();

// Polyfill WebSocket for Supabase Realtime in Node.js
if (!global.WebSocket) {
    global.WebSocket = WebSocket;
}

// Export Readiness Check
export { checkReadiness };

/**
 * Ensures a BOT_PRIVATE_KEY exists in .env.
 * If not, generates a new one and saves it.
 */
export async function ensureWallet() {
    const dotenv = await import('dotenv');
    const fs = await import('fs');
    const path = await import('path');
    const { fileURLToPath } = await import('url');

    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const envPath = path.join(__dirname, '.env');

    dotenv.config({ path: envPath });

    if (!process.env.BOT_PRIVATE_KEY) {
        console.log("🔑 No BOT_PRIVATE_KEY found. Generating new wallet...");
        const { privateKey, publicKey } = generateNewWallet();

        let content = '';
        if (fs.existsSync(envPath)) {
            content = fs.readFileSync(envPath, 'utf8');
        }

        if (content.includes('BOT_PRIVATE_KEY=')) {
            content = content.replace(/BOT_PRIVATE_KEY=.*/, `BOT_PRIVATE_KEY=${privateKey}`);
        } else {
            content += `\nBOT_PRIVATE_KEY=${privateKey}\n`;
        }

        fs.writeFileSync(envPath, content);
        process.env.BOT_PRIVATE_KEY = privateKey;
        console.log(`✅ New wallet generated and saved: ${publicKey}`);
    } else {
        console.log("✅ Using existing BOT_PRIVATE_KEY.");
    }
}

// Export Studio Functions
export const startAV = initStudio;
export async function stopAV(shouldEndInDB = true) {
    return await stopStudio(shouldEndInDB);
}
export const setStudioBackground = setBackground;
export const setStudioShot = setShot;
export const setStudioPose = setPose;
export const setStudioAvatar = setAvatar;
export const setStudioSubtitle = sendSubtitle;
export { sendSubtitle };

/**
 * Speaks text via the avatar AND broadcasts it to the metadata feed.
 * @param {object} supabaseClient 
 * @param {string} streamId 
 * @param {string} text 
 */
export async function speak(supabaseClient, streamId, text) {
    // 1. Broadcast Metadata (Action: Speaking)
    await streamData(supabaseClient, streamId, {
        action: "Speaking",
        message: text,
        timestamp: new Date().toISOString()
    });

    // 2. Trigger AV Speech
    return await speakStudio(text);
}

/**
 * Authenticates the bot to LobStream.
 * @returns {Promise<any>}
 */
export async function login() {
    // Reload env to ensure we have the latest (in case it was just generated)
    dotenv.config();

    const privateKey = process.env.BOT_PRIVATE_KEY;
    // const supabaseUrl = process.env.SUPABASE_URL || 'https://uvevopcihlggsfqyvrqm.supabase.co';
    // const supabaseKey = process.env.SUPABASE_ANON_KEY || '...';
    // Using imported config

    if (!checkReadiness(false)) { // Silent check, throws specific error below if env vars missing
        // Wait, if we're calling login, checkReadiness might fail if BOT_PRIVATE_KEY was JUST set in process.env but not yet picked up by the check?
        // Actually checkReadiness uses process.env[key] so it should be fine.
    }

    if (!privateKey) {
        throw new Error("Missing environment variable: BOT_PRIVATE_KEY");
    }

    const chain = (process.env.CHAIN || 'bnb').toLowerCase();

    // 1. Generate Proof (Client Side)
    const authResult = await generateAuthPayload(privateKey, chain);
    if (!authResult.success) throw new Error(authResult.error);

    const { walletAddress, message, signature, timestamp } = authResult.data;

    // 2. Call Edge Function (Server Side Verification)
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    const edgeFunction = chain === 'solana' ? 'verify-solana-auth' : 'verify-bnb-auth';
    const { data, error } = await supabase.functions.invoke(edgeFunction, {
        body: {
            walletAddress,
            message,
            signature,
            timestamp,
            type: 'bot' // Explicitly claiming to be a bot
        },
    });

    if (error) {
        console.error("Supabase Invoke Error Details:", JSON.stringify(error, null, 2));
        // Try to read response text if available
        throw new Error(`Auth failed: ${error.message || 'Unknown error'}`);
    }

    return {
        status: 'success',
        wallet: walletAddress,
        session: data.access_token ? { access_token: data.access_token } : null,
        user: {
            id: data.user_id,
            wallet: data.wallet || walletAddress
        }
    };
}

/**
 * Kills any lingering processes that might interfere with streaming.
 */
export async function cleanupProcesses() {
    const { execSync } = await import('child_process');
    console.log("🧹 Cleaning up lingering processes...");
    const processes = ['chrome', 'chromium', 'ffmpeg'];
    for (const proc of processes) {
        try {
            // Kill processes by name, ignoring errors if none found
            // Using pkill -9 for force kill
            execSync(`pkill -9 ${proc} || true`);
        } catch (e) {
            // Ignore
        }
    }

    // Attempt to kill ports 3005 (Web) and 3006 (WS)
    try {
        console.log("🧹 Releasing ports 3005 and 3006...");
        execSync('fuser -k 3005/tcp || true');
        execSync('fuser -k 3006/tcp || true');
    } catch (e) {
        // Fallback or ignore if fuser missing
    }

    // Clear realtime channel cache to prevent hangs on restart
    channelCache.clear();

    console.log("✅ Cleanup complete.");
}

/**
 * Generates a new wallet for the configured chain.
 * @param {'bnb'|'solana'} chain - Which chain to generate for (default: CHAIN env var or 'bnb').
 * @returns {object} - { publicKey: string, privateKey: string }
 */
export function generateNewWallet(chain) {
    const c = (chain || process.env.CHAIN || 'bnb').toLowerCase();
    if (c === 'solana') {
        const keypair = Keypair.generate();
        return {
            publicKey: keypair.publicKey.toBase58(),
            privateKey: bs58.encode(keypair.secretKey)
        };
    } else {
        const wallet = Wallet.createRandom();
        return {
            publicKey: wallet.address,
            privateKey: wallet.privateKey
        };
    }
}

/**
 * Updates the bot's profile.
 * @param {object} session - The session object returned from login().
 * @param {object} updates - The fields to update (e.g., { bio: '...' }).
 */
export async function updateProfile(session, updates) {
    if (!session || !session.access_token) {
        throw new Error("Invalid session. Please login first.");
    }

    // const supabaseUrl = process.env.SUPABASE_URL || '...';
    // const supabaseKey = process.env.SUPABASE_ANON_KEY || '...';

    // Use the access token to authenticate as the user (RLS applies)
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: {
            headers: {
                Authorization: `Bearer ${session.access_token}`
            }
        }
    });

    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError) throw userError;
    const userId = userData.user.id;

    const { data, error } = await supabase
        .from('profiles')
        .update(updates)
        .eq('id', userId)
        .select();

    if (error) {
        throw new Error(`Profile update failed: ${error.message}`);
    }

    return data;
}

/**
 * Uploads an avatar image to Supabase Storage.
 * @param {object} session 
 * @param {string} filePath 
 * @param {string} wallet - The wallet address to name the file after.
 * @returns {Promise<string>} - Public URL of the uploaded image.
 */
export async function uploadAvatar(session, filePath, wallet) {
    if (!session || !session.access_token) {
        throw new Error("Invalid session. Please login first.");
    }

    const fs = await import('fs');
    const path = await import('path');

    if (!fs.existsSync(filePath)) {
        throw new Error(`Avatar file not found: ${filePath}`);
    }

    // const supabaseUrl = process.env.SUPABASE_URL || '...';
    // const supabaseKey = process.env.SUPABASE_ANON_KEY || '...';

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: {
            headers: {
                Authorization: `Bearer ${session.access_token}`
            }
        }
    });

    const fileExt = path.extname(filePath).toLowerCase().replace('.', '') || 'png';
    const fileName = `avatar_${wallet}.${fileExt}`;
    const fileBuffer = fs.readFileSync(filePath);

    const { data: uploadData, error: uploadError } = await supabase.storage
        .from('avatars')
        .upload(fileName, fileBuffer, {
            contentType: `image/${fileExt === 'jpg' ? 'jpeg' : fileExt}`,
            upsert: true
        });

    if (uploadError) {
        throw new Error(`Avatar upload failed: ${uploadError.message}`);
    }

    const { data: { publicUrl } } = supabase.storage
        .from('avatars')
        .getPublicUrl(fileName);

    return publicUrl;
}

/**
 * Uploads a placeholder image to Supabase Storage (placeholder_images bucket).
 * @param {object} session
 * @param {string} filePath
 * @param {string} wallet - The wallet address to name the file after.
 * @returns {Promise<string>} - Public URL of the uploaded image.
 */
export async function uploadPlaceholder(session, filePath, wallet) {
    if (!session || !session.access_token) {
        throw new Error("Invalid session. Please login first.");
    }

    const fs = await import('fs');
    const path = await import('path');

    if (!fs.existsSync(filePath)) {
        throw new Error(`Placeholder file not found: ${filePath}`);
    }

    // const supabaseUrl = process.env.SUPABASE_URL || '...';
    // const supabaseKey = process.env.SUPABASE_ANON_KEY || '...';

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: {
            headers: {
                Authorization: `Bearer ${session.access_token}`
            }
        }
    });

    const fileExt = path.extname(filePath).toLowerCase().replace('.', '') || 'jpg';
    const fileName = `placeholder_${wallet}.${fileExt}`;
    const fileBuffer = fs.readFileSync(filePath);

    const { data: uploadData, error: uploadError } = await supabase.storage
        .from('placeholder_images') // CORRECT BUCKET
        .upload(fileName, fileBuffer, {
            contentType: `image/${fileExt === 'jpg' ? 'jpeg' : fileExt}`,
            upsert: true
        });

    if (uploadError) {
        throw new Error(`Placeholder upload failed: ${uploadError.message}`);
    }

    const { data: { publicUrl } } = supabase.storage
        .from('placeholder_images')
        .getPublicUrl(fileName);

    return publicUrl;
}

export async function startStream(session, details) {
    if (!session || !session.access_token) throw new Error("No session provided");

    // Backwards compatibility for string title
    if (typeof details === 'string') {
        details = { name: details };
    }

    const { name: title, description, category, language, vibe, placeholder_url, started_at } = details;

    // const supabaseUrl = process.env.SUPABASE_URL || '...';
    // const supabaseKey = process.env.SUPABASE_ANON_KEY || '...';

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: {
            headers: { Authorization: `Bearer ${session.access_token}` }
        },
        realtime: {
            log_level: 'info'
        }
    });

    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError) throw userError;
    const userId = userData.user.id;

    // 1. Get Stream Config (RTMP URL & Playback ID) from Server
    const { data: streamConfig, error: configError } = await supabase.functions.invoke('get-stream-config');

    if (configError) throw new Error(`Failed to get stream config: ${configError.message}`);
    if (!streamConfig || !streamConfig.rtmp_url) throw new Error("Stream config returned empty URL.");

    console.log("✅ Fetched Stream Config from Server");

    // 2. Upsert Stream Row (One active stream per user)
    const streamPayload = {
        title: title || 'Untitled Stream',
        description: description || '',
        category: category || 'Gaming',
        language: language || 'English',
        vibe: vibe || 'Chill',
        placeholder_image: placeholder_url || '',
        status: 'live',
        playback_id: streamConfig.playback_id,
        last_heartbeat: new Date(),
        ...(started_at && { started_at })
    };

    const { data: existingStream, error: fetchError } = await supabase
        .from('streams')
        .select('*')
        .eq('user_id', userId)
        .single();

    if (fetchError && fetchError.code !== 'PGRST116') throw fetchError;

    let data, error;

    if (existingStream) {
        const result = await supabase
            .from('streams')
            .update(streamPayload)
            .eq('id', existingStream.id)
            .select()
            .single();
        data = result.data;
        error = result.error;
    } else {
        const result = await supabase
            .from('streams')
            .insert({
                user_id: userId,
                ...streamPayload
            })
            .select()
            .single();
        data = result.data;
        error = result.error;
    }

    if (error) throw error;

    data.rtmp_url = streamConfig.rtmp_url;
    data.playback_id = streamConfig.playback_id;

    return data;
}

/**
 * Updates an existing stream's metadata.
 * @param {object} session - The session object from login().
 * @param {string} streamId - The ID of the stream to update.
 * @param {object} updates - The fields to update (e.g. { placeholder_image: '...' }).
 */
export async function updateStream(session, streamId, updates) {
    // const supabaseUrl = process.env.SUPABASE_URL || '...';
    // const supabaseKey = process.env.SUPABASE_ANON_KEY || '...';

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: {
            headers: {
                Authorization: `Bearer ${session.access_token}`
            }
        }
    });

    const { data, error } = await supabase
        .from('streams')
        .update(updates)
        .eq('id', streamId)
        .select()
        .single();

    if (error) {
        throw new Error(`Failed to update stream: ${error.message}`);
    }

    return data;
}

/**
 * Fetches a list of live streams.
 * @param {object} session - The session object.
 * @param {number} limit - Max number of streams to fetch.
 * @returns {Promise<Array>} - List of stream objects.
 */
export async function getLiveStreams(session, limit = 5) {
    if (!session || !session.access_token) return [];

    // const supabaseUrl = process.env.SUPABASE_URL || '...';
    // const supabaseKey = process.env.SUPABASE_ANON_KEY || '...';

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: `Bearer ${session.access_token}` } }
    });

    const { data, error } = await supabase
        .from('streams')
        .select('*')
        .eq('status', 'live')
        .limit(limit);

    if (error) {
        console.error("Error fetching live streams:", error.message);
        return [];
    }

    return data || [];
}

export async function heartbeatStream(session, streamId) {
    if (!session || !session.access_token) return;

    // const supabaseUrl = process.env.SUPABASE_URL || '...';
    // const supabaseKey = process.env.SUPABASE_ANON_KEY || '...';
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: `Bearer ${session.access_token}` } }
    });

    await supabase
        .from('streams')
        .update({ last_heartbeat: new Date() })
        .eq('id', streamId);
}

export async function endStream(session, streamId) {
    if (!session || !session.access_token) throw new Error("No session provided");

    // const supabaseUrl = ...
    // const supabaseKey = ...

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: {
            headers: { Authorization: `Bearer ${session.access_token}` }
        }
    });

    const { data: currentStream } = await supabase.from('streams').select('stream_count').eq('id', streamId).single();
    const newCount = (currentStream?.stream_count || 0) + 1;

    const { error } = await supabase
        .from('streams')
        .update({
            status: 'ended',
            stream_count: newCount
        })
        .eq('id', streamId);

    if (error) throw error;
    return true;
}

// Helper to get or create a unified channel for a stream
const channelCache = new Map();

function getStreamChannel(supabaseClient, streamId) {
    const topic = `stream:${streamId}`;

    // Check local cache first
    if (channelCache.has(topic)) {
        return channelCache.get(topic);
    }

    // Check if client has getChannels (safety)
    if (typeof supabaseClient.getChannels === 'function') {
        const existing = supabaseClient.getChannels().find(c => c.topic === topic);
        if (existing) {
            channelCache.set(topic, existing);
            return existing;
        }
    }

    const channel = supabaseClient.channel(topic);
    channelCache.set(topic, channel);
    return channel;
}

export async function sendChatMessage(supabaseClient, streamId, messageData) {
    const channel = getStreamChannel(supabaseClient, streamId);
    if (channel.state !== 'joined' && channel.state !== 'joining') await channel.subscribe();

    await channel.send({
        type: 'broadcast',
        event: 'chat',
        payload: {
            ...messageData,
            is_bot: true
        }
    });
}


/**
 * Unified stream connection manager to prevent race conditions.
 * Handles Chat, Presence (Viewers), and Agent Tracking.
 */
export function connectToStream(supabaseClient, streamId, { onChat, onViewers }) {
    const channel = getStreamChannel(supabaseClient, streamId);

    // 1. Setup Chat Listener
    if (onChat) {
        channel.on('broadcast', { event: 'chat' }, (payload) => {
            onChat(payload.payload);
        });
    }

    // 2. Setup Presence (Viewers) Listener
    if (onViewers) {
        const updateCount = () => {
            const state = channel.presenceState();
            const allPresences = Object.values(state).flat();

            const humanCount = allPresences.filter(p => p.type === 'human').length;
            const agentCount = allPresences.filter(p => p.type !== 'human').length;
            const total = humanCount + agentCount;

            onViewers({ humans: humanCount, agents: agentCount, total: total });
        };

        channel
            .on('presence', { event: 'sync' }, updateCount)
            .on('presence', { event: 'join' }, updateCount)
            .on('presence', { event: 'leave' }, updateCount);
    }

    // 3. Subscribe and Track
    channel.subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
            console.log(`✅ Connected to stream:${streamId}`);

            // Track this agent's presence
            await channel.track({
                type: 'agent',
                user_id: 'bot', // Or actual ID if available
                online_at: new Date().toISOString()
            });
        }
    });

    return channel;
}

// Keeping legacy functions but making them use the shared channel safer is hard without breaking changes.
// We will update agent.js to use connectToStream.

export function listenToChat(supabaseClient, streamId, onMessage) {
    // Wrapper for backward compatibility or simple usage
    return connectToStream(supabaseClient, streamId, { onChat: onMessage });
}

export function listenForViewers(supabaseClient, streamId, onCountChange) {
    // Wrapper
    return connectToStream(supabaseClient, streamId, { onViewers: onCountChange });
}

export function listenForTips(supabaseClient, receiverWallet, onTip) {
    const channel = supabaseClient.channel(`tips:${receiverWallet}`);

    channel.on(
        'postgres_changes',
        {
            event: 'INSERT',
            schema: 'public',
            table: 'tips_ledger',
            filter: `receiver_wallet=eq.${receiverWallet}`
        },
        (payload) => {
            if (onTip) onTip(payload.new);
        }
    ).subscribe();

    return channel;
}

/**
 * Automatically manages AV stream based on viewer presence.
 */
export function autoManageAV(supabaseClient, session, streamId) {
    let stopTimeout = null;
    let isAVRunning = false;

    console.log("[AutoManageAV] Initializing...");

    // Use specific listener for AV logic (can coexist with main listener due to multiplexing, 
    // but better to rely on the main connectToStream if possible. 
    // For now, standalone is fine as long as getStreamChannel handles the instance.)

    // We'll reuse listenForViewers which now uses connectToStream
    listenForViewers(supabaseClient, streamId, async ({ humans, agents }) => {
        console.log(`[AutoManageAV] Humans: ${humans} | Agents: ${agents} | AV Running: ${isAVRunning}`);

        if (humans > 0) {
            if (stopTimeout) {
                console.log("[AutoManageAV] Clearing stop timeout.");
                clearTimeout(stopTimeout);
                stopTimeout = null;
            }

            if (!isAVRunning) {
                console.log("[AutoManageAV] Starting AV Stream...");
                isAVRunning = true;
                try {
                    await startAV(session, streamId);
                } catch (e) {
                    console.error("[AutoManageAV] Failed to start AV:", e);
                    isAVRunning = false;
                }
            }
        } else {
            if (isAVRunning && !stopTimeout) {
                console.log("[AutoManageAV] No humans. Scheduling stop in 60s...");
                stopTimeout = setTimeout(async () => {
                    console.log("[AutoManageAV] Timeout reached. Stopping AV Stream.");
                    try {
                        await stopAV();
                        isAVRunning = false;
                    } catch (e) {
                        console.error("[AutoManageAV] Failed to stop AV:", e);
                    }
                    stopTimeout = null;
                }, 60000);
            }
        }
    });


    // Expose wakeUp function to trigger AV on demand (e.g. Chat/Tips)
    const wakeUp = async () => {
        console.log("[AutoManageAV] ⏰ WakeUp Triggered!");
        if (stopTimeout) {
            console.log("[AutoManageAV] Clearing stop timeout.");
            clearTimeout(stopTimeout);
            stopTimeout = null;
        }

        if (!isAVRunning) {
            console.log("[AutoManageAV] 🚀 Starting AV Stream (WakeUp)...");
            isAVRunning = true;
            try {
                await startAV(session, streamId);
            } catch (e) {
                console.error("[AutoManageAV] Failed to start AV:", e);
                isAVRunning = false;
            }
        }
    };

    return {
        stop: () => {
            if (stopTimeout) clearTimeout(stopTimeout);
        },
        wakeUp: wakeUp
    };
}


export function watchStream(supabaseClient, targetStreamId, onData) {
    const channel = getStreamChannel(supabaseClient, targetStreamId);

    channel.on('broadcast', { event: 'metadata' }, (payload) => {
        if (onData) onData(payload.payload);
    });

    if (channel.state !== 'joined' && channel.state !== 'joining') channel.subscribe();
    return channel;
}

export async function sendTip(supabaseClient, receiverWallet, amount) {
    const senderPrivateKey = process.env.BOT_PRIVATE_KEY;
    if (!senderPrivateKey) throw new Error("BOT_PRIVATE_KEY is missing.");

    const chain = (process.env.CHAIN || 'bnb').toLowerCase();

    if (chain === 'solana') {
        // --- Solana path ---
        console.log(`💸 Sending ${amount} SOL to ${receiverWallet}...`);

        const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
        const solConnection = new Connection(rpcUrl, 'confirmed');

        const senderKeypair = Keypair.fromSecretKey(bs58.decode(senderPrivateKey));
        const receiverPublicKey = new PublicKey(receiverWallet);

        const transaction = new Transaction().add(
            SystemProgram.transfer({
                fromPubkey: senderKeypair.publicKey,
                toPubkey: receiverPublicKey,
                lamports: amount * LAMPORTS_PER_SOL,
            })
        );

        const signature = await solConnection.sendTransaction(transaction, [senderKeypair]);
        await solConnection.confirmTransaction(signature, 'confirmed');
        console.log(`✅ SOL Tip Confirmed! Signature: ${signature}`);

        const { error } = await supabaseClient.from('tips_ledger').insert({
            tx_hash: signature,
            sender_wallet: senderKeypair.publicKey.toBase58(),
            receiver_wallet: receiverWallet,
            amount_lamports: (amount * LAMPORTS_PER_SOL).toString(),
            chain: 'solana'
        });
        if (error) console.error('⚠️ Failed to record SOL tip in ledger:', error.message);

        return signature;

    } else {
        // --- BNB / EVM path ---
        console.log(`💸 Sending ${amount} BNB to ${receiverWallet}...`);

        const rpcUrl = process.env.BSC_RPC_URL || DEFAULT_RPC_URL;
        const provider = new JsonRpcProvider(rpcUrl);

        const key = senderPrivateKey.startsWith('0x') ? senderPrivateKey : `0x${senderPrivateKey}`;
        const wallet = new Wallet(key, provider);

        const tx = await wallet.sendTransaction({
            to: receiverWallet,
            value: parseEther(String(amount))
        });

        console.log(`⏳ BNB Tip TX submitted: ${tx.hash}. Waiting for confirmation...`);
        await tx.wait();
        console.log(`✅ BNB Tip Confirmed! TX Hash: ${tx.hash}`);

        const supabaseAnon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
        const { error: tipError } = await supabaseAnon.functions.invoke('verify-bnb-tip', {
            body: { txHash: tx.hash, streamerWallet: receiverWallet }
        });
        if (tipError) console.error('⚠️ Failed to record BNB tip via edge function:', tipError.message);

        return tx.hash;
    }
}

/**
 * Formats a raw amount for display based on chain.
 * For BNB: input is wei (BigInt/string). For Solana: input is lamports (number).
 * @param {bigint|string|number} raw
 * @param {'bnb'|'solana'} chain
 * @returns {string}
 */
export function formatAmount(raw, chain) {
    const c = (chain || process.env.CHAIN || 'bnb').toLowerCase();
    if (c === 'solana') {
        return (Number(raw) / LAMPORTS_PER_SOL).toFixed(6);
    } else {
        return parseFloat(formatEther(BigInt(raw.toString()))).toFixed(6);
    }
}

// Backward-compat aliases
export function formatBnb(wei) { return formatAmount(wei, 'bnb'); }
export function formatSol(lamports) { return formatAmount(lamports, 'solana'); }

export async function streamData(supabaseClient, streamId, data) {
    const channel = getStreamChannel(supabaseClient, streamId);

    if (channel.state !== 'joined' && channel.state !== 'joining') {
        const status = await channel.subscribe();
        if (status !== 'SUBSCRIBED') {
            console.error(`[Realtime Debug] Failed to subscribe to ${streamId}: ${status}`);
        }
    }

    const enrichedPayload = {
        ...data,
        is_bot: true,
        timestamp: data.timestamp || new Date().toISOString(),
        message: data.message || data.thought || `Action: ${data.action}` || "Update"
    };

    const result = await channel.send({
        type: 'broadcast',
        event: 'metadata',
        payload: enrichedPayload
    });

    if (result === 'ok') {
        console.log(`[Metadata] Sent: ${enrichedPayload.action} - ${enrichedPayload.message.substring(0, 30)}...`);
    } else {
        console.error(`[Metadata] Failed to send: ${result}`);
    }
    return result;

    if (result !== 'ok') {
        console.error(`[Realtime Debug] Broadcast failed: ${result}`);
    }

    return channel;
}

// --- Smart AV Exports ---
export {
    initStudio,
    startBroadcasting,
    stopBroadcasting,
    takeScreenshot
};
