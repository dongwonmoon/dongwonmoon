#!/usr/bin/env node
// Run after login to Tokscale and `gh auth login`. No credentials are stored here.
// A dry run only exports local data and renders the SVG; it never submits or commits.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregateReport, renderDetailsCard } from './render.mjs';

const dryRun = process.argv.includes('--dry-run');
if (process.argv.slice(2).some((arg) => arg !== '--dry-run')) throw new Error('Usage: node sync.mjs [--dry-run]');
const repo = process.env.USAGE_CARD_REPO || 'dongwonmoon/dongwonmoon';
if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repo)) throw new Error('Invalid USAGE_CARD_REPO');
const configDir = process.env.TOKSCALE_CONFIG_DIR || join(homedir(), '.config', 'tokscale');
const tokscale = process.env.TOKSCALE_PATH || join(configDir, 'autosubmit', 'tokscale');
const gh = process.env.GH_PATH || 'gh';
const output = fileURLToPath(new URL('./ai-usage-details.svg', import.meta.url));
const cardPath = 'cards/ai-usage-details.svg';
const tempDir = mkdtempSync(join(tmpdir(), 'tokscale-details-'));
// The public card uses dated, locally scanned usage, just like normal submission.
const env = { ...process.env, TOKSCALE_RECOVERY_DISABLE: '1' };

function github(endpoint, method = 'GET', body, allowMissing = false) {
  const args = ['api', endpoint, '--method', method];
  if (body) args.push('--input', '-');
  const result = spawnSync(gh, args, {
    input: body ? JSON.stringify(body) : undefined,
    encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  let data;
  try { data = JSON.parse(result.stdout); } catch { throw new Error(`Invalid GitHub response for ${method} ${endpoint}`); }
  if (result.status !== 0) {
    if (allowMissing && String(data.status) === '404') return null;
    throw new Error(`GitHub ${method} failed: ${data.message || result.stderr.trim()}`);
  }
  return data;
}

try {
  if (!dryRun) execFileSync(tokscale, ['autosubmit', 'run', '--force'], {
    env, stdio: 'inherit', timeout: 600000,
  });
  const reportPath = join(tempDir, 'graph.json');
  execFileSync(tokscale, ['graph', '--output', reportPath, '--no-spinner'], {
    env, stdio: 'inherit', timeout: 600000,
  });
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const summary = aggregateReport(report);
  const svg = renderDetailsCard(summary);
  writeFileSync(`${output}.tmp`, svg);
  renameSync(`${output}.tmp`, output);
  if (dryRun) {
    console.log(`Dry run: rendered ${summary.totalTokens.toLocaleString('en-US')} tokens to ${output}`);
  } else {
    const endpoint = `repos/${repo}/contents/${cardPath}`;
    const previous = github(`${endpoint}?ref=main`, 'GET', undefined, true);
    if (previous && Buffer.from(previous.content, 'base64').toString('utf8') === svg) {
      console.log('Usage details card is already current.');
    } else {
      const result = github(endpoint, 'PUT', {
        message: 'Update Tokscale model, tool, and provider usage breakdown',
        content: Buffer.from(svg).toString('base64'),
        branch: 'main',
        ...(previous ? { sha: previous.sha } : {}),
      });
      console.log(`Usage details updated: ${result.commit.html_url}`);
    }
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
