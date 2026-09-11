import { readFileSync } from 'node:fs';
const config = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
if (!config.d1_databases?.[0]?.database_id || config.d1_databases[0].database_id.startsWith('00000000-')) throw new Error('Create the Cloudflare D1 database and configure its real database_id first.');
if (!config.vars?.APP_ORIGIN?.startsWith('https://')) throw new Error('Configure the public HTTPS APP_ORIGIN before deploying.');
