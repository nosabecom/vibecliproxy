import { HttpError } from './types.ts';
import { isPasswordHash } from './auth.ts';
export interface Config {
  host: string; port: number; dataPath: string; publicOrigin: string; basePath?: string;
  adminPasswordHash: string;
  proxyUrl: string; proxyKey: string; managementKey: string;
  oauthBinary?: string; oauthDirectory?: string;
  decisionsApiKey?: string;
  pushSubject?: string;
}
export function readConfig(env = process.env): Config {
  const publicOrigin = env.PUBLIC_ORIGIN ?? 'http://127.0.0.1:8320';
  const proxyUrl = (env.CLIPROXY_URL ?? 'http://127.0.0.1:8317').replace(/\/$/, '');
  const basePath = (env.BASE_PATH ?? '').replace(/\/$/, '');
  if (basePath && !/^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(basePath)) throw new Error('BASE_PATH must be an absolute URL path without a trailing slash');
  for (const value of [publicOrigin, proxyUrl]) { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new HttpError(500, 'URLs must be HTTP(S) origins without paths or credentials'); }
  const config = {
    host: env.HOST ?? '127.0.0.1', port: Number(env.PORT ?? 8320), dataPath: env.DATA_PATH ?? '.data/hub.db', publicOrigin: new URL(publicOrigin).origin, basePath,
    adminPasswordHash: env.ADMIN_PASSWORD_HASH ?? '',
    proxyUrl, proxyKey: env.CLIPROXY_API_KEY ?? '', managementKey: env.CLIPROXY_MANAGEMENT_KEY ?? '',
    oauthBinary: env.CLIPROXY_BINARY ?? './bin/cli-proxy-api', oauthDirectory: env.OAUTH_DIRECTORY ?? '.data/onboarding',
    decisionsApiKey: env.OPENAI_DECISIONS_API_KEY ?? env.OPENAI_API_KEY ?? '',
    pushSubject: env.PUSH_SUBJECT ?? '',
  };
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) throw new Error('Invalid port');
  if (!isPasswordHash(config.adminPasswordHash)) throw new Error('Set ADMIN_PASSWORD_HASH before starting the hub');
  if (!config.proxyKey || !config.managementKey) throw new Error('CLIProxy service and management keys are required');
  return config;
}
