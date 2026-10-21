// Print a new vault keypair (design §14.3). Put VAULT_PUBLIC_KEY in the env of
// both api and worker, VAULT_PRIVATE_KEYS in the worker's only. To rotate:
// generate a new pair, set the new public key, and put the new private key
// FIRST in VAULT_PRIVATE_KEYS with the old one after it until old values are
// re-sealed.
//
//   npm run vault:keygen
import { generateVaultKeys } from './vault.js';

const { publicKey, privateKey } = generateVaultKeys();
process.stdout.write(`VAULT_PUBLIC_KEY=${publicKey}\nVAULT_PRIVATE_KEYS=${privateKey}\n`);
