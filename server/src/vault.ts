// The vault: sealing secrets at rest (design §14.3; CLAUDE.md "Vendor tokens
// are secrets and are handled like secrets").
//
// PUBLIC-KEY SEALING, SO ONLY THE WORKER CAN OPEN ANYTHING
// The api is internet-facing; the worker is not. So the api is given only the
// vault's PUBLIC key: it can seal what the user types (phone number, OTP) but
// can open nothing. Only the worker holds the private key, which it needs to
// use a vendor session and to read an OTP it must submit. A compromised api
// plus a database dump still yields no grocery session.
//
// Construction (all Node built-ins — no dependency):
//   ephemeral X25519 keypair per value → ECDH with the vault public key →
//   HKDF-SHA256 (salt = both public keys) → AES-256-GCM, random 96-bit nonce.
// Associated data binds the value to its CONTEXT — the table, row and field
// it's stored in — so a ciphertext copied to another row refuses to open.
//
// Format:  v1.<keyId>.<ephemeralPublic>.<nonce>.<tag>.<ciphertext>  (base64url)
// keyId names the vault key it was sealed for, so after a rotation the worker
// can hold several private keys and still open older values.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';

import { VAULT_FORMAT, VAULT_HKDF_INFO, VAULT_KEY_ID_CHARS, VAULT_NONCE_BYTES } from './constants.js';

// Messages never include plaintext, keys or the sealed value.
export class VaultError extends Error {}

// DER prefixes that wrap a raw 32-byte X25519 key (RFC 8410).
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

function raw32(b64url: string, what: string): Buffer {
  const b = Buffer.from(b64url, 'base64url');
  if (b.length !== 32) throw new VaultError(`${what} is not a 32-byte X25519 key`);
  return b;
}

function publicKeyObject(publicRaw: Buffer): KeyObject {
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, publicRaw]), format: 'der', type: 'spki' });
}

function privateKeyObject(privateRaw: Buffer): KeyObject {
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, privateRaw]), format: 'der', type: 'pkcs8' });
}

function publicRawOf(key: KeyObject): Buffer {
  return (key.export({ format: 'der', type: 'spki' }) as Buffer).subarray(SPKI_PREFIX.length);
}

export function keyIdOf(publicKey: string): string {
  return createHash('sha256').update(raw32(publicKey, 'vault public key')).digest('hex').slice(0, VAULT_KEY_ID_CHARS);
}

// A new vault keypair, base64url raw keys. Generate once per deploy
// (`npm run vault:keygen`); the public key goes to api + worker, the private
// key to the worker only.
export function generateVaultKeys(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const priv = (privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).subarray(PKCS8_PREFIX.length);
  return { publicKey: publicRawOf(publicKey).toString('base64url'), privateKey: priv.toString('base64url') };
}

// The public key belonging to a private key — used to catch a mismatched
// VAULT_PUBLIC_KEY / VAULT_PRIVATE_KEYS pair at startup.
export function publicKeyOf(privateKey: string): string {
  return publicRawOf(createPublicKey(privateKeyObject(raw32(privateKey, 'vault private key')))).toString('base64url');
}

function deriveKey(shared: Buffer, ephemeralPub: Buffer, recipientPub: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', shared, Buffer.concat([ephemeralPub, recipientPub]), VAULT_HKDF_INFO, 32));
}

const aad = (keyId: string, context: string) => Buffer.from(`${VAULT_FORMAT}.${keyId}.${context}`);

export function seal(publicKey: string, plaintext: string, context: string): string {
  const recipientRaw = raw32(publicKey, 'vault public key');
  const keyId = keyIdOf(publicKey);
  const eph = generateKeyPairSync('x25519');
  const ephRaw = publicRawOf(eph.publicKey);
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: publicKeyObject(recipientRaw) });
  const key = deriveKey(shared, ephRaw, recipientRaw);
  const nonce = randomBytes(VAULT_NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad(keyId, context));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VAULT_FORMAT, keyId, ephRaw, nonce, tag, ct]
    .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
    .join('.');
}

// `privateKeys`: the worker's keys, current first, older ones after (rotation).
export function openSealed(privateKeys: string[], sealed: string, context: string): string {
  const parts = sealed.split('.');
  if (parts.length !== 6 || parts[0] !== VAULT_FORMAT) throw new VaultError('not a sealed vault value');
  const [, keyId, ephB64, nonceB64, tagB64, ctB64] = parts as [string, string, string, string, string, string];

  let match: { priv: KeyObject; pubRaw: Buffer } | null = null;
  for (const pk of privateKeys) {
    const priv = privateKeyObject(raw32(pk, 'vault private key'));
    const pubRaw = publicRawOf(createPublicKey(priv));
    if (keyIdOf(pubRaw.toString('base64url')) === keyId) {
      match = { priv, pubRaw };
      break;
    }
  }
  if (!match) throw new VaultError('no vault key held for this value');

  try {
    const ephRaw = Buffer.from(ephB64, 'base64url');
    const shared = diffieHellman({ privateKey: match.priv, publicKey: publicKeyObject(ephRaw) });
    const key = deriveKey(shared, ephRaw, match.pubRaw);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonceB64, 'base64url'));
    decipher.setAAD(aad(keyId, context));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    throw new VaultError('sealed value could not be opened (wrong context, tampered, or corrupt)');
  }
}
