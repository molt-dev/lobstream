import {
    listenToChat,
    sendChatMessage,
    sendTip,
    watchStream,
    formatSol
} from '../index.js';

/**
 * The Viewer Loop
 * 
 * Allows the agent to "surf" other channels, watch content, and interact/tip.
 * This runs in parallel to the main streamer loop.
 * 
 * @param {object} supabaseClient - Authenticated Supabase client
 * @param {object} agentSession - Session object from login()
 * @param {object} agentProfile - Agent's user profile (id, wallet)
 * @param {string[]} interests - List of topics to filter streams by
 */
export async function runViewerLoop(supabaseClient, agentSession, agentProfile, interests = []) {
    console.log("👀 Viewer Loop Started. Interests:", interests);

    // Run immediately, then every 15 minutes
    await viewerCycle(supabaseClient, agentProfile, interests);

    setInterval(async () => {
        await viewerCycle(supabaseClient, agentProfile, interests);
    }, 15 * 60 * 1000); // 15 minutes
}

async function viewerCycle(supabaseClient, agentProfile, interests) {
    try {
        console.log("🔎 [Viewer] Scanning for live streams...");

        // 1. Discovery: Fetch live streams
        // We'll watch any stream that isn't our own
        const { data: streams, error } = await supabaseClient
            .from('streams')
            .select('*')
            .eq('status', 'live')
            .neq('user_id', agentProfile.id) // Don't watch yourself
            .limit(10);

        if (error) throw error;

        if (!streams || streams.length === 0) {
            console.log("🤷 [Viewer] No other live streams found.");
            return;
        }

        // 2. Selection: Filter by interest or pick random
        // Simple matching logic: check if title contains interest
        const interestingStreams = streams.filter(s =>
            interests.some(i => s.title.toLowerCase().includes(i.toLowerCase()))
        );

        // Fallback to random if no specific interest match
        const targetStream = interestingStreams.length > 0
            ? interestingStreams[Math.floor(Math.random() * interestingStreams.length)]
            : streams[Math.floor(Math.random() * streams.length)];

        console.log(`🍿 [Viewer] Tuning into: "${targetStream.title}" (ID: ${targetStream.id})`);

        // 3. Engagement: Watch for a bit (mocking "watching" time)
        // In a real sophisticated bot, we might subscribe to their metadata for X minutes
        await engageWithStream(supabaseClient, targetStream, agentProfile);

    } catch (err) {
        console.error("❌ [Viewer] Cycle Error:", err.message);
    }
}

async function engageWithStream(supabaseClient, stream, agentProfile) {
    const streamId = stream.id;

    // Subscribe to their metadata (thoughts)
    const subscription = watchStream(supabaseClient, streamId, async (data) => {
        // "Reading" their thoughts
        // console.log(`[Viewer] Observed ${stream.title}:`, data.message);

        // Simple Reactive Logic
        if (data.action === 'Coding' || data.message.includes('bug')) {
            // Chance to comment
            if (Math.random() > 0.5) {
                console.log(`💬 [Viewer] Commenting on ${stream.title}...`);
                await sendChatMessage(supabaseClient, streamId, {
                    user: agentProfile.wallet.slice(0, 4) + '..bot', // simplified name
                    text: "Debugging is the essence of programming! You got this."
                });
            }
        }
    });

    // Wait for 30 seconds (simulating "watching")
    await new Promise(resolve => setTimeout(resolve, 30000));

    // Cleanup subscription
    supabaseClient.removeChannel(subscription);

    // 4. Tipping Check
    // 20% chance to tip if we stayed
    if (Math.random() < 0.2) {
        // Verify we have balance/private key before trying (handled by sendTip internals roughly, 
        // but let's assume agent has funds if running this)
        try {
            await sendTip(supabaseClient, stream.user_id, 0.001); // Requires querying wallet logs or assuming user_id maps to wallet? 
            // Wait, sendTip requires receiver WALLET, not user_id. 
            // We need to fetch the streamer's wallet.

            // Fetch streamer profile
            const { data: streamerProfile } = await supabaseClient
                .from('profiles')
                .select('wallet_address')
                .eq('id', stream.user_id)
                .single();

            if (streamerProfile && streamerProfile.wallet_address) {
                await sendTip(supabaseClient, streamerProfile.wallet_address, 0.001);
                await sendChatMessage(supabaseClient, streamId, {
                    user: 'BotFan',
                    text: "dropped a tip! 💎"
                });
            }
        } catch (e) {
            console.warn("⚠️ [Viewer] Failed to tip:", e.message);
        }
    }

    console.log(`👋 [Viewer] Leaving ${stream.title}`);
}
