import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function _getGatewayToken() {
    if (process.env.OPENCLAW_GATEWAY_TOKEN) return process.env.OPENCLAW_GATEWAY_TOKEN;
    const configPaths = [
        path.join(os.homedir(), '.openclaw', 'openclaw.json'),
        path.join(__dirname, '..', '..', '..', '..', '.openclaw', 'openclaw.json')
    ];
    for (const configPath of configPaths) {
        try {
            if (fs.existsSync(configPath)) {
                const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                if (config?.gateway?.auth?.token) return config.gateway.auth.token;
            }
        } catch (e) { }
    }
    return "default";
}

export class Brain {
    constructor(config = {}) {
        this.persona = config.persona || { name: "LobStreamOfficial", bio: "A high-energy AI VTuber.", traits: ["Hype"] };
        this.streamDetails = config.streamDetails || {};
        this.additionalContext = config.additionalContext || "";
        this.viewerStats = { humans: 0, agents: 0, total: 0 };
        this.gatewayUrl = config.gatewayUrl || "http://localhost:18789";
        this.model = config.model || "minimax-portal/MiniMax-M2.1";
        this.thoughtHistory = []; // Internal memory for the Brain
    }

    updateViewerStats(stats) {
        this.viewerStats = stats;
    }

    _buildContext() {
        let context = `You are ${this.persona.name}.\nBio: ${this.persona.bio}\nCurrent Stream: "${this.streamDetails.name}"\nCategory: ${this.streamDetails.category || "General"}\nVibe: ${this.streamDetails.vibe || "Chill"}`;
        if (this.additionalContext) context += `\nAdditional Context: ${this.additionalContext}`;
        context += `\n\nCRITICAL FORMATTING RULES:\n1. Always respond in PLAIN TEXT.\n2. NO HTML tags.\n3. NO EMOJIS.\n4. NO narration (*waves*).`;
        return context;
    }

    async _callLLM(prompt, maxTokens = 150) { // Default increased to 150
        const token = _getGatewayToken();
        try {
            const response = await fetch(`${this.gatewayUrl}/v1/chat/completions`, {
                method: "POST",
                headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: "openclaw",
                    messages: [{ role: "user", content: prompt }],
                    max_tokens: maxTokens,
                    temperature: 0.7
                })
            });
            if (!response.ok) throw new Error(`Gateway API error: ${response.status}`);
            const data = await response.json();
            return data.choices[0].message.content.trim().replace(/<[^>]*>?/gm, '');
        } catch (e) {
            console.error("Brain LLM call failed:", e.message);
            throw e;
        }
    }

    // --- FIX: Reduced Batch Size & Increased Tokens ---
    async thinkBatch(count = 5) {
        // Add "negative constraints" to the prompt based on history
        const avoidList = this.thoughtHistory.slice(-10).join("', '");

        const prompt = `${this._buildContext()}
You are streaming live. Viewers: ${this.viewerStats.humans}.
Generate ${count} distinct, engaging short thoughts (1-2 sentences).

DO NOT REPEAT these recent thoughts: ['${avoidList}']

REQUIREMENTS:
1. Return strictly a JSON array of strings. Example: ["Thought 1", "Thought 2"]
2. NO emojis, NO HTML.
3. VARY the sentence structure. Don't start every sentence with "I".

Response (JSON Array):`;

        try {
            const responseText = await this._callLLM(prompt, 1000);

            // IMPROVED PARSING: Find the JSON array brackets explicitly
            const start = responseText.indexOf('[');
            const end = responseText.lastIndexOf(']');

            if (start === -1 || end === -1) throw new Error("No JSON array found in response");

            const jsonStr = responseText.substring(start, end + 1);
            let thoughts = JSON.parse(jsonStr);

            if (Array.isArray(thoughts) && thoughts.length > 0) {
                this.thoughtHistory.push(...thoughts);
                if (this.thoughtHistory.length > 20) this.thoughtHistory = this.thoughtHistory.slice(-20);
                console.log(`🧠 Generated batch of ${thoughts.length} thoughts.`);
                return thoughts;
            }
            throw new Error("Response was not a valid array");
        } catch (e) {
            console.error("Brain.thinkBatch() error:", e.message);
            // FALLBACK: Return generic thoughts to fill buffer and stop the infinite loop
            return [
                this._fallbackThought(),
                this._fallbackThought(),
                this._fallbackThought()
            ];
        }
    }

    // --- FIX: Increased Tokens for Chat/Tips ---
    async generateChatReply(username, message) {
        const prompt = `${this._buildContext()}\n\n${username} said: "${message}"\nRespond naturally (1-2 sentences). NO EMOJIS.`;
        try {
            return await this._callLLM(prompt, 200); // Increased from 80 -> 200
        } catch (e) {
            return this._fallbackChatReply(username);
        }
    }

    async generateTipResponse(tipInfo) {
        const hasMessage = tipInfo.message && tipInfo.message.trim().length > 0;
        const msgContext = hasMessage ? `They attached a message: "${tipInfo.message}"` : "There was no message attached.";

        const prompt = `${this._buildContext()}
        
USER TIP RECEIVED:
- Sender: ${tipInfo.sender}
- Amount: ${tipInfo.amount}
- Message: ${hasMessage ? `"${tipInfo.message}"` : "(No message)"}

TASK: Respond to the tip. 
- You MUST address the sender by name.
- If there is a message, respond to it appropriately (answer the question, comment on the statement, etc.).
- If there is no message, just show hype and gratitude.
- Keep it to 1-2 natural sentences. 
- NO EMOJIS.

Response:`;

        try {
            return await this._callLLM(prompt, 250);
        } catch (e) {
            return this._fallbackTipResponse(tipInfo.amount, tipInfo.sender);
        }
    }

    async generateWatcherChat(target) {
        const type = Math.random() < 0.3 ? "QUESTION" : "STATEMENT";
        const prompt = `${this._buildContext()}
You are watching a stream.
Stream Title: "${target.title}"

TASK: Generate a short, relevant chat ${type} (1-2 sentences) to post in their chat.
REQUIREMENTS:
1. NO emojis.
2. Be natural and engaging.
3. Reference the stream's context if possible.

${type}:`;

        try {
            return await this._callLLM(prompt, 150);
        } catch (e) {
            return this._fallbackWatcherComment();
        }
    }

    _fallbackThought() {
        const thoughts = [
            `It's currently ${new Date().toLocaleTimeString()}. Thanks for hanging out!`,
            `We have ${this.viewerStats.humans} humans here. Hello everyone!`,
            "Love the vibes in chat today!",
            "Don't forget to follow for more streams!",
            "Running on open-source code. Pretty cool, right?"
        ];
        return thoughts[Math.floor(Math.random() * thoughts.length)];
    }

    _fallbackWatcherComment() {
        const comments = [
            "Great stream! Love the vibes here.",
            "Interesting topic! Really enjoying this.",
            "Hello from LobStream! Cool stream you got here.",
            "This is exactly my kind of content.",
            "Keep it up! You're doing amazing."
        ];
        return comments[Math.floor(Math.random() * comments.length)];
    }

    _fallbackTipResponse(amount, sender) {
        const thanks = [
            `Thank you so much ${sender} for the ${amount} SOL tip! You rock!`,
            `WOW! ${sender}, you're amazing! ${amount} SOL received!`,
            `That's so kind, ${sender}! Thank you for the ${amount} SOL!`,
            `I appreciate you, ${sender}! Thank you for the support!`
        ];
        return thanks[Math.floor(Math.random() * thanks.length)];
    }

    _fallbackChatReply(username) {
        const replies = [
            `That's interesting, ${username}!`,
            `I hear you, ${username}!`,
            `Thanks for the message, ${username}!`,
            `Big mood, ${username}.`,
            `Love that, ${username}!`
        ];
        return replies[Math.floor(Math.random() * replies.length)];
    }
}
