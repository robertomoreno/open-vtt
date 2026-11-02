import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/**/*.test.ts'], environment: 'node', server: { deps: { inline: ['@trystero-p2p/core'] } } } });
