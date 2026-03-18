#!/bin/bash
# Wrapper script to run LobStream stream with Xvfb (Virtual Display)
# Usage: ./run_stream_xvfb.sh [script_name] [args...]

SCRIPT=${1:-agent.js}
shift

# Check if xvfb-run is installed
if ! command -v xvfb-run &> /dev/null; then
    echo "❌ xvfb-run could not be found. Please install it (e.g., sudo apt install xvfb)."
    exit 1
fi

echo "🚀 Starting stream with Xvfb (Virtual Display)..."
echo "   Script: $SCRIPT"
echo "   Resolution: 1280x720x24"
echo "   Display:    :99"

# NUCLEAR CLEANUP: Forcefully clear stale X11 resources
# 1. Kill any existing Xvfb processes for display 99
pkill -9 -f "Xvfb :99" &> /dev/null || true
# 2. Remove the lock file
rm -f /tmp/.X99-lock
# 3. Remove the unix socket (the heart of the 'failing to start' error)
rm -f /tmp/.X11-unix/X99 &> /dev/null || true

# Wait a beat for the OS to release resources
sleep 0.5

# Run with -n 99 to ensure DISPLAY=:99 (matching our internal config)
xvfb-run -n 99 --server-args="-screen 0 1280x720x24" node "$SCRIPT" "$@"
