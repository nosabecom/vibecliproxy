import { HttpError } from './types.ts';

export interface ActivityQuery {
 search?: string; person?: string; account?: string; model?: string; provider?: string;
 route?: string; endpoint?: string; result?: string; time?: number;
 offset?: number; limit?: number; snapshot?: number;
}

export function activityQuery(params: URLSearchParams): ActivityQuery {
 const query: ActivityQuery = {};
 for (const key of ['search', 'person', 'account', 'model', 'provider', 'route', 'endpoint', 'result'] as const) {
  const value = params.get(key);
  if (value) {
   if (value.length > (key === 'search' ? 500 : 300)) throw new HttpError(400, `Invalid ${key} filter`);
   query[key] = value;
  }
 }
 for (const [key, allowed] of [
  ['provider', ['codex', 'claude']], ['route', ['shared', 'personal', 'unknown']],
  ['result', ['active', 'receiving', 'queued', 'running', 'completed', 'cancelled', 'errors', 'limited']],
 ] as const) {
  if (query[key] && !(allowed as readonly string[]).includes(query[key])) throw new HttpError(400, `Invalid ${key} filter`);
 }
 for (const key of ['time', 'offset', 'limit', 'snapshot'] as const) {
  const value = params.get(key);
  if (value !== null) {
   const parsed = Number(value);
   if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < (key === 'limit' ? 1 : 0)) throw new HttpError(400, `Invalid ${key}`);
   query[key] = parsed;
  }
 }
 if (query.limit && query.limit > 100) throw new HttpError(400, 'Page size must be between 1 and 100');
 if (query.time !== undefined && ![900000, 3600000, 86400000, 604800000].includes(query.time)) throw new HttpError(400, 'Invalid time range');
 return query;
}
