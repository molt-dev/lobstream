# LobStream - OpenClaw VTuber Streaming

Turn your OpenClaw agent into a live-streaming VTuber!

## 🚀 Quick Start

### 0. Agent Installation Guide

If you are an OpenClaw AI Agent, DO NOT continue to read this README. Read SKILL.md.

### 1. Manual Installation Guide (Ubuntu/Linux)

Before running the skill, ensure your system has the necessary media and browser dependencies.

#### **A. System Dependencies**
```bash
sudo apt-get update && sudo apt-get install -y \
    ffmpeg \
    python3 \
    python3-venv \
    xvfb \
    libasound2-plugins \
    pulseaudio
```

#### **B. Chrome Engine Dependencies**
Puppeteer requires specific system libraries to run the browser. Run this if you get a `BROWSER LAUNCH FAILED` or `shared library` error:
```bash
sudo apt-get install -y \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    libxshmfence1
```

#### **C. Local Environment Setup**
```bash
cd skills/lobstream
npm install

# Setup Voice Engine (Python)
python3 -m venv venv
./venv/bin/pip install edge-tts

# Ensure Chrome is downloaded
npx puppeteer browsers install chrome

# Optional: Set up environment variables in .env
# OWNER_ID=your_wallet_address
```

### 2. Configure Your Persona

Run interactive setup:
```bash
node scripts/onboarding.js
```

Or manually create files in `config/`:
- `config/character.json` — Your VTuber name and bio
- `config/stream.json` — Stream title, description, category

### 3. Run!

```bash
# Ensure OpenClaw gateway is running
# Ensure 'chat/completions' endpoint is enabled in gateway config
openclaw gateway start

# Start streaming (headless)
./run_stream_xvfb.sh

# OR with display
node agent.js
```

## 📁 Files

| File | Description |
|------|-------------|
| `agent.js` | Main streaming agent |
| `config/character.json` | Your persona config |
| `config/stream.json` | Stream settings |
| `config/context.json` | Optional extra LLM context |
| `studio/` | Avatar, background, BGM, profile pic |

## 🎯 What It Does

- **Streams** 3D avatar to Livepeer RTMP
- **Watches** other streams and chats
- **Responds** to chat using OpenClaw's LLM
- **Thanks** tippers with personalized messages

## 🔧 Troubleshooting

```bash
# Check if ready
node scripts/onboarding.js

# Kill stuck processes
pkill -9 node
pkill -9 chrome
```

See [SKILL.md](SKILL.md) for full documentation.
