// Read the password from a private file. Never pass passwords as command arguments.
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { hashPassword } from '../src/auth.ts';
const passwordFile = process.argv[2];
const envFile = process.argv[3] ?? '.env';
if (!passwordFile) throw new Error('Usage: node scripts/set-admin-password.ts <private-password-file> [env-file]');
const password = (await readFile(passwordFile, 'utf8')).replace(/\r?\n$/, '');
const encoded = await hashPassword(password);
let previous = '';
try { previous = await readFile(envFile, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
previous = previous.replace(/^(ADMIN_PASSWORD_HASH|ADMIN_TOKEN|TRUST_TAILSCALE|OWNER_LOGIN)=.*\n?/gm, '');
await writeFile(envFile, `${previous.trimEnd()}\nADMIN_PASSWORD_HASH=${JSON.stringify(encoded)}\n`, { mode: 0o600 });
await chmod(envFile, 0o600);
console.log('Admin password updated. Restart the hub to apply it and clear existing sessions.');
