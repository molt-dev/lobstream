import { execSync } from 'child_process';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Helper to run commands with nice logging
const run = (cmd, opts = {}) => {
    try {
        console.log(`> ${cmd}`);
        execSync(cmd, { stdio: 'inherit', ...opts });
    } catch (e) {
        console.error(`❌ Command failed: ${cmd}`);
        if (!opts.ignoreFail) process.exit(1);
    }
};

// Ensure we are in the project root
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
process.chdir(projectRoot);
console.log(`📂 Working directory set to: ${projectRoot}`);

const platform = os.platform(); // 'linux', 'win32', 'darwin' (mac)
const isWindows = platform === 'win32';

console.log(`\n🚀 Starting LobStream Setup for ${platform.toUpperCase()}...\n`);

// --- STEP 1: SYSTEM DEPENDENCIES ---
console.log("📦 Checking System Dependencies...");

if (platform === 'linux') {
    // Linux: Use apt-get and sudo
    console.log("🐧 Linux detected. Installing FFmpeg, Python, Xvfb...");
    const packages = [
        'ffmpeg', 'python3', 'python3-venv', 'xvfb',
        'libasound2-plugins', 'pulseaudio', 'libnss3', 'libatk1.0-0t64',
        'libatk-bridge2.0-0t64', 'libcups2t64', 'libdrm2', 'libxkbcommon0',
        'libxcomposite1', 'libxdamage1', 'libxrandr2', 'libgbm1',
        'libpango-1.0-0', 'libcairo2', 'libasound2t64', 'libxshmfence1'
    ];
    run(`sudo apt-get update && sudo apt-get install -y ${packages.join(' ')}`);

} else if (isWindows) {
    // Windows: Use Winget (built-in to Windows 10/11)
    console.log("🪟 Windows detected. Installing FFmpeg via Winget...");
    try {
        // Try installing FFmpeg. Ignore error if already installed.
        run('winget install -e --id Gyan.FFmpeg', { ignoreFail: true });
    } catch (e) {
        console.warn("⚠️  Could not install FFmpeg automatically. Please ensure it is installed and in your PATH.");
    }
    // Windows doesn't need Xvfb (Chrome runs headless natively)
    console.log("✅ Xvfb is not required on Windows.");
} else {
    // MacOS (Optional support)
    console.log("🍎 MacOS detected. Assuming Brew is installed...");
    run('brew install ffmpeg python');
}

// --- STEP 2: NODE DEPENDENCIES ---
console.log("\n📦 Installing Node.js Packages...");
run('npm install');
// Ensure Chrome is downloaded for Puppeteer
run('npx puppeteer browsers install chrome');

// --- STEP 3: MAKE RUN SCRIPTS EXECUTABLE ---
console.log("\n🔧 Setting script permissions...");
if (!isWindows) {
    fs.chmodSync('./run_stream_xvfb.sh', '755');
    console.log("✅ Made run_stream_xvfb.sh executable");
}

// --- STEP 4: PYTHON ENVIRONMENT ---
console.log("\n🐍 Setting up Python Environment...");
const venvPath = path.join(process.cwd(), 'venv');
const pipPath = isWindows
    ? path.join(venvPath, 'Scripts', 'pip')
    : path.join(venvPath, 'bin', 'pip');

// Create Venv
if (!fs.existsSync(pipPath)) {
    console.log("🐍 Creating Python Virtual Environment...");
    // On Windows 'python' is often used instead of 'python3'
    const pythonCmd = isWindows ? 'python' : 'python3';

    // If venv folder exists but pip doesn't, it's broken - nuke it
    if (fs.existsSync(venvPath)) {
        fs.rmSync(venvPath, { recursive: true, force: true });
    }

    run(`${pythonCmd} -m venv venv`);
}

// Install Edge-TTS
run(`"${pipPath}" install edge-tts`);


// --- STEP 4: ONBOARDING ---
console.log("\n⚙️  Running Configuration Wizard...");
run('node scripts/onboarding.js');

console.log("\n🎉 SETUP COMPLETE!");
console.log("To start your agent, run:");
console.log(isWindows ? "   node agent.js" : "   node agent.js");
// (Note: Linux users might still need xvfb-run if not using the 'new' headless mode,
// but we updated dependencies to handle that.)
