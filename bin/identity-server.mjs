#!/usr/bin/env node
/**
 * MCP identity server CLI (SDK-based).
 *
 *   node bin/identity-server.mjs --registry <registry.json> --port 8781 [--allow-missing-attestation] [--quiet]
 *
 * Binds 127.0.0.1 only. Each accepted request emits one JSON audit line on stdout.
 */
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createIdentityServer } from '../lib/mcp-server.mjs';

const { values } = parseArgs({
  options: {
    registry: { type: 'string' },
    port: { type: 'string', default: '8781' },
    'allow-missing-attestation': { type: 'boolean', default: false },
    quiet: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help || !values.registry) {
  process.stderr.write('usage: identity-server --registry <registry.json> --port <n> [--allow-missing-attestation] [--quiet]\n');
  process.exit(values.help ? 0 : 2);
}

const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  process.stderr.write('invalid --port\n');
  process.exit(2);
}

const audit = values.quiet ? () => {} : event => process.stdout.write(`${JSON.stringify(event)}\n`);

const server = await createIdentityServer({
  registryFile: path.resolve(values.registry),
  requireAttestation: !values['allow-missing-attestation'],
  audit,
});

try {
  await server.start(port);
} catch (error) {
  const code = /** @type {any} */ (error).code ? `${/** @type {any} */ (error).code}: ` : '';
  process.stderr.write(`[startup] ${code}${/** @type {Error} */ (error).message}\n`);
  process.exit(1);
}

const shutdown = async () => {
  await server.close().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
