import { spawn } from 'child_process';

const RTMP_URL = process.env.LIVEPEER_RTMP_URL;
const DISPLAY = process.env.DISPLAY || ':99';

console.log(`🎥 RECORDING DISPLAY: ${DISPLAY}`);

const ffmpeg = spawn('ffmpeg', [
    // --- GLOBAL ---
    '-hide_banner', '-loglevel', 'info',

    // --- INPUT 1: VIDEO (X11) ---
    '-f', 'x11grab',
    // Increase probe size to handle stream resumption delays
    '-probesize', '100M',
    '-analyzeduration', '100M',
    '-thread_queue_size', '512',
    '-draw_mouse', '0',
    '-video_size', '1280x720',
    '-framerate', '12',
    // CRITICAL: Keep wallclock timestamps - this makes video the "master clock"
    '-use_wallclock_as_timestamps', '1',
    '-i', DISPLAY,

    // --- INPUT 2: AUDIO (stdin pipe) ---
    // CRITICAL: NO -re flag here!
    // AudioStreamer already generates in real-time
    // We let FFmpeg consume as fast as data arrives
    '-f', 's16le',
    '-ar', '44100',
    '-ac', '2',
    // Larger buffer to handle bursts and prevent underruns
    '-thread_queue_size', '16384',
    '-i', 'pipe:0',

    // --- MAPPING ---
    '-map', '0:v:0',
    '-map', '1:a:0',

    // --- SYNC STRATEGY ---
    // Video is the master (wallclock timestamps)
    // Audio must sync to video
    '-async', '1',

    // --- AUDIO FILTER ---
    // aresample with async=1000 allows aggressive timestamp correction
    // This will stretch/compress audio to match video timestamps
    // The "1000" means it can adjust up to 1000 samples per second to compensate
    '-af', 'aresample=async=1000:first_pts=0',

    // --- VIDEO ENCODING ---
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-pix_fmt', 'yuv420p',
    '-b:v', '1200k',
    '-maxrate', '1200k',
    '-bufsize', '2400k',
    '-g', '24',
    '-keyint_min', '24',
    '-r', '12',

    // --- AUDIO ENCODING ---
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ar', '44100',

    // --- TIMING ---
    // Start both streams at timestamp 0
    '-start_at_zero',
    '-copyts',

    // --- OUTPUT ---
    '-f', 'flv',
    RTMP_URL
], { stdio: ['pipe', 'pipe', 'pipe'] });

ffmpeg.stderr.on('data', d => {
    const msg = d.toString();
    // Show important messages
    process.stdout.write(msg);
});

ffmpeg.stdout.on('data', d => {
    process.stdout.write(d.toString());
});

process.stdin.pipe(ffmpeg.stdin);

ffmpeg.stdin.on('error', (err) => {
    if (err.code !== 'EPIPE') {
        console.error('[stdin error]', err);
    }
});

ffmpeg.on('close', code => {
    console.log(`[FFmpeg] Exited: ${code}`);
    process.exit(code);
});

process.on('SIGTERM', () => {
    console.log('[Broadcaster] SIGTERM received');
    ffmpeg.kill('SIGTERM');
});

process.on('SIGINT', () => {
    console.log('[Broadcaster] SIGINT received');
    ffmpeg.kill('SIGTERM');
});