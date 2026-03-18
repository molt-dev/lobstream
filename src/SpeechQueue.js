
export class SpeechQueue {
    constructor() {
        this.queue = [];
        this.isSpeaking = false;

        // Priority Constants
        this.PRIORITY = {
            CRITICAL: 3, // Tips, Warnings
            HIGH: 2,     // Direct replies
            NORMAL: 1,   // Chat interactions
            LOW: 0       // Idle chatter
        };
    }

    /**
     * Add generic item to queue
     * @param {Object} item - { text, id, priority, type }
     */
    add(item) {
        // Validation
        if (!item.text) return;

        // Default priority
        if (item.priority === undefined) item.priority = this.PRIORITY.NORMAL;

        this.queue.push(item);
        this.queue.sort((a, b) => b.priority - a.priority); // Higher priority first

        console.log(`🗣️ Queue Add: [${item.type}] "${item.text.slice(0, 20)}..." (Size: ${this.queue.length})`);
    }

    /**
     * Set speaking state
     * @param {boolean} state 
     */
    setSpeaking(state) {
        this.isSpeaking = state;
        if (state) {
            this.lastSpeakingAt = Date.now();
        } else {
            this.lastSpeakingAt = null;
        }
    }

    /**
     * Get next item if available and not speaking
     * @returns {Object|null}
     */
    getNext() {
        if (this.isSpeaking || this.queue.length === 0) return null;
        return this.queue.shift();
    }

    /**
     * Clear queue (e.g. on stop)
     */
    clear() {
        this.queue = [];
        this.isSpeaking = false;
    }
}
