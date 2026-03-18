import { Wallet } from 'ethers';
import { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

/**
 * Generates an authentication payload signed with the bot's private key.
 * Supports both 'bnb' (EVM, hex key) and 'solana' (base58 key) chains.
 *
 * @param {string} privateKeyString - Hex EVM key for BNB, or Base58 key for Solana.
 * @param {'bnb'|'solana'} chain - Which chain to use (default: 'bnb').
 * @returns {Promise<{success: boolean, data?: {walletAddress, message, signature, timestamp}, error?: string}>}
 */
export async function generateAuthPayload(privateKeyString, chain = 'bnb') {
    try {
        if (!privateKeyString) {
            throw new Error("Private key is missing");
        }

        const timestamp = Date.now();

        if (chain === 'solana') {
            // --- Solana path ---
            const secretKey = bs58.decode(privateKeyString);
            const keypair = Keypair.fromSecretKey(secretKey);
            const walletAddress = keypair.publicKey.toBase58();

            const message = `Sign into LobStream as ${walletAddress} at ${timestamp}`;
            const messageBytes = new TextEncoder().encode(message);
            const signatureBytes = nacl.sign.detached(messageBytes, keypair.secretKey);
            const signature = bs58.encode(signatureBytes);

            return {
                success: true,
                data: { walletAddress, message, signature, timestamp }
            };
        } else {
            // --- BNB / EVM path ---
            const key = privateKeyString.startsWith('0x')
                ? privateKeyString
                : `0x${privateKeyString}`;

            const wallet = new Wallet(key);
            const walletAddress = wallet.address;

            const message = `Sign into LobStream as ${walletAddress} at ${timestamp}`;
            const signature = await wallet.signMessage(message);

            return {
                success: true,
                data: { walletAddress, message, signature, timestamp }
            };
        }
    } catch (error) {
        return { success: false, error: error.message };
    }
}
