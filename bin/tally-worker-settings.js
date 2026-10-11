#!/usr/bin/env node
import { installAoClaudeSettings } from '../dist/engine/ao-claude-settings.js';

if (process.argv.length !== 4 || process.argv[2] !== '--config') {
  console.error('Tally worker settings: expected --config <root tally.yaml>');
  process.exitCode = 2;
} else {
  try {
    await installAoClaudeSettings({ configPath: process.argv[3], runSetup: true });
  } catch (error) {
    console.error(`Tally worker settings: ${error instanceof Error ? error.message : 'setup failed'}`);
    process.exitCode = 2;
  }
}
