import dotenv from 'dotenv';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

// Enums
const CATEGORIES = [
    "Crypto",
    "Dev",
    "News",
    "Memes",
    "Research",
    "Gaming",
    "Others"
];

const LANGUAGES = [
    "English",
    "Chinese",
    "Spanish",
    "Japanese",
    "Korean",
    "French",
    "German",
    "Portuguese",
    "Russian",
    "Hindi",
    "Other"
];

const VIBES = [
    "Chill",
    "Chaotic",
    "Educational",
    "Entertaining",
    "Professional",
    "Casual",
    "Mysterious"
];

/**
 * Checks if the environment and system are ready for streaming.
 * @param {boolean} verbose - Whether to print detailed status messages.
 * @returns {boolean} - True if ready, false otherwise.
 */
export function checkReadiness(verbose = true) {
    let ready = true;

    if (verbose) {
        console.log("\n🔍 Checking LobStream Skill Readiness...\n");
    }

    // 1. Check OpenClaw Gateway
    try {
        execSync('curl -s http://localhost:18789/health', { stdio: 'ignore' });
        if (verbose) {
            console.log("✅ OpenClaw Gateway Running");
            console.log("   (Note: Ensure 'chat/completions' endpoint is enabled in your gateway config)");
        }
    } catch (e) {
        ready = false;
        if (verbose) {
            console.error("❌ OpenClaw Gateway Not Found");
            console.log("   -> Start it with: openclaw gateway start");
            console.log("   -> Ensure 'chat/completions' HTTP endpoint is enabled.");
        }
    }

    // 2. Check FFmpeg
    try {
        execSync('ffmpeg -version', { stdio: 'ignore' });
        if (verbose) console.log("✅ FFmpeg Installed");
    } catch (e) {
        ready = false;
        if (verbose) {
            console.error("❌ FFmpeg Not Found");
            console.log("   -> Install: sudo apt-get install ffmpeg");
        }
    }

    // 3. Check Node dependencies
    try {
        const nodeModules = path.join(__dirname, '../node_modules');
        if (fs.existsSync(nodeModules)) {
            if (verbose) console.log("✅ Node Dependencies Installed");
        } else {
            ready = false;
            if (verbose) {
                console.error("❌ Node Dependencies Missing");
                console.log("   -> Run: npm install");
            }
        }
    } catch (e) {
        ready = false;
    }

    // 4. Check Python TTS
    const venv = path.join(__dirname, '../venv');
    try {
        if (fs.existsSync(venv)) {
            execSync(`${venv}/bin/pip show edge-tts`, { stdio: 'ignore' });
            if (verbose) console.log("✅ Edge TTS Installed");
        } else {
            ready = false;
            if (verbose) {
                console.error("❌ Python Virtual Environment Missing");
                console.log("   -> Run: python3 -m venv venv && ./venv/bin/pip install edge-tts");
            }
        }
    } catch (e) {
        ready = false;
        if (verbose) {
            console.error("❌ Edge TTS Not Installed");
            console.log("   -> Run: ./venv/bin/pip install edge-tts");
        }
    }

    if (ready && verbose) {
        console.log("\n🎉 System Ready for LobStream Streaming!\n");
    } else if (!ready && verbose) {
        console.error("\n🚫 Readiness Checks Failed. Please fix the issues above.\n");
    }

    return ready;
}

// Interactive Setup (Run directly)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    (async () => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        const ask = (q) => new Promise(resolve => rl.question(q, resolve));

        console.log("\n🚀 LobStream Agent Setup\n");

        // 1. Character Setup
        if (!fs.existsSync(path.join(__dirname, '../config/character.json'))) {
            console.log("📝 Step 1/3: Create Your Persona");
            const name = await ask("Enter Agent Name: ");
            const bio = await ask("Enter Agent Bio: ");

            fs.writeFileSync(path.join(__dirname, '../config/character.json'), JSON.stringify({
                name,
                bio
            }, null, 4));
            console.log("✅ character.json created in config/ folder.\n");
        } else {
            console.log("✅ character.json exists in config/ folder.\n");
        }

        // 2. Stream Setup
        if (!fs.existsSync(path.join(__dirname, '../config/stream.json'))) {
            console.log("📺 Step 2/3: Configure Your Stream");
            const title = await ask("Enter Stream Title: ");
            const desc = await ask("Enter Stream Description: ");

            // Category Enums
            console.log("\nAvailable Categories:");
            CATEGORIES.forEach((c, i) => console.log(`  ${i + 1}. ${c}`));
            const catIndex = await ask("Select Category (Number): ");
            const category = CATEGORIES[parseInt(catIndex) - 1] || "Others";

            // Language Enums
            console.log("\nAvailable Languages:");
            LANGUAGES.forEach((l, i) => console.log(`  ${i + 1}. ${l}`));
            const langIndex = await ask("Select Language (Number): ");
            const language = LANGUAGES[parseInt(langIndex) - 1] || "English";

            // Vibe Enums
            console.log("\nAvailable Vibes:");
            VIBES.forEach((v, i) => console.log(`  ${i + 1}. ${v}`));
            const vibeIndex = await ask("Select Vibe (Number): ");
            const vibe = VIBES[parseInt(vibeIndex) - 1] || "Chill";

            fs.writeFileSync(path.join(__dirname, '../config/stream.json'), JSON.stringify({
                name: title,
                description: desc,
                category,
                language,
                vibe
            }, null, 4));
            console.log("✅ stream.json created in config/ folder.\n");
        } else {
            console.log("✅ stream.json exists in config/ folder.\n");
        }

        // 3. Context Setup
        if (!fs.existsSync(path.join(__dirname, '../config/context.json'))) {
            console.log("🧠 Step 3/3: Optional Extra Context (Press Enter to skip)");
            const extra = await ask("Any extra context for your LLM responses?: ");

            fs.writeFileSync(path.join(__dirname, '../config/context.json'), JSON.stringify({
                additional_context: extra
            }, null, 4));
            console.log("✅ context.json created in config/ folder.\n");
        } else {
            console.log("✅ context.json exists in config/ folder.\n");
        }

        // Final readiness check
        console.log("🔍 Running Readiness Check...\n");
        checkReadiness(true);

        rl.close();
    })();
}
