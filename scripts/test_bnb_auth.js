/**
 * Smoke test for both BNB and Solana auth flows.
 * Run: node scripts/test_bnb_auth.js
 */
import { generateAuthPayload } from './auth.js';
import { generateNewWallet } from '../index.js';
import { verifyMessage } from 'ethers';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

console.log('--- LobStream Multi-Chain Auth Smoke Test ---');

// =====================
// BNB CHAIN
// =====================
console.log('\n[BNB CHAIN]');
const bnbWallet = generateNewWallet('bnb');
console.log(`  Address  : ${bnbWallet.publicKey}`);
if (!bnbWallet.publicKey.startsWith('0x')) {
    console.error('❌ FAIL: BNB address should start with 0x');
    process.exit(1);
}
console.log('  ✅ Address format OK');

const bnbResult = await generateAuthPayload(bnbWallet.privateKey, 'bnb');
if (!bnbResult.success) {
    console.error(`❌ FAIL: generateAuthPayload (bnb) error: ${bnbResult.error}`);
    process.exit(1);
}
const recoveredBnb = verifyMessage(bnbResult.data.message, bnbResult.data.signature);
if (recoveredBnb.toLowerCase() !== bnbResult.data.walletAddress.toLowerCase()) {
    console.error(`❌ FAIL: BNB signature mismatch`);
    process.exit(1);
}
console.log('  ✅ Signature verification OK');

// =====================
// SOLANA CHAIN
// =====================
console.log('\n[SOLANA CHAIN]');
const solWallet = generateNewWallet('solana');
console.log(`  Address  : ${solWallet.publicKey}`);
if (solWallet.publicKey.startsWith('0x')) {
    console.error('❌ FAIL: Solana address should NOT start with 0x');
    process.exit(1);
}
console.log('  ✅ Address format OK');

const solResult = await generateAuthPayload(solWallet.privateKey, 'solana');
if (!solResult.success) {
    console.error(`❌ FAIL: generateAuthPayload (solana) error: ${solResult.error}`);
    process.exit(1);
}
const msgBytes = new TextEncoder().encode(solResult.data.message);
const sigBytes = bs58.decode(solResult.data.signature);
const pubBytes = bs58.decode(solResult.data.walletAddress);
const valid = nacl.sign.detached.verify(msgBytes, sigBytes, pubBytes);
if (!valid) {
    console.error(`❌ FAIL: Solana signature verification failed`);
    process.exit(1);
}
console.log('  ✅ Signature verification OK');

// =====================
// Message branding
// =====================
const hasLobStream = bnbResult.data.message.includes('LobStream')
    && solResult.data.message.includes('LobStream');
if (!hasLobStream) {
    console.error('❌ FAIL: Message should contain LobStream branding');
    process.exit(1);
}
console.log('\n  ✅ Message branding OK ("LobStream")');

console.log('\n✅ All tests passed.\n');
