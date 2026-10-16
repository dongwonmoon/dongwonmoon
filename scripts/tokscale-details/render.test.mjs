import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateReport, renderDetailsCard } from './render.mjs';

const buckets = (input = 0, output = 0, cacheRead = 0, cacheWrite = 0, reasoning = 0) => ({
  input, output, cacheRead, cacheWrite, reasoning,
});

function client({ modelId, client = 'codex', providerId, tokens }) {
  return { modelId, client, providerId, tokens };
}

function report(clients, generatedAt = '2026-10-15T15:00:00.000Z') {
  const total = clients.reduce((sum, row) => sum + Object.values(row.tokens).reduce((a, b) => a + b, 0), 0);
  return {
    meta: { generatedAt },
    summary: { totalTokens: total },
    contributions: [{ totals: { tokens: total }, clients }],
  };
}

test('combines the same model across clients and preserves reasoning as an independent bucket', () => {
  const input = report([
    client({ modelId: 'model-a', client: 'codex', providerId: 'openai', tokens: buckets(10, 2, 3, 4, 5) }),
    client({ modelId: 'model-a', client: 'claude', providerId: 'openai', tokens: buckets(1, 2, 0, 0, 6) }),
    client({ modelId: 'model-b', client: 'codex', providerId: 'anthropic', tokens: buckets(2) }),
  ]);

  const result = aggregateReport(input);
  assert.equal(result.models[0].name, 'model-a');
  assert.equal(result.models[0].tokens, 33);
  assert.equal(result.totalTokens, 35);
  assert.deepEqual(result.tools.map(({ name, tokens }) => [name, tokens]), [['codex', 26], ['claude', 9]]);
});

test('uses Unknown when providerId is missing and combines the remainder into Other', () => {
  const rows = [
    client({ modelId: 'm1', client: 't1', providerId: 'alpha', tokens: buckets(10) }),
    client({ modelId: 'm2', client: 't2', providerId: 'beta', tokens: buckets(9) }),
    client({ modelId: 'm3', client: 't3', providerId: 'gamma', tokens: buckets(8) }),
    client({ modelId: 'm4', client: 't4', tokens: buckets(7) }),
    client({ modelId: 'm5', client: 't5', providerId: 'delta', tokens: buckets(6) }),
  ];
  const result = aggregateReport(report(rows));
  assert.deepEqual(result.providers.map(({ name, tokens }) => [name, tokens]), [
    ['alpha', 10], ['beta', 9], ['gamma', 8], ['Other', 13],
  ]);
  assert.deepEqual(result.tools.map(({ tokens }) => tokens).reduce((a, b) => a + b, 0), result.totalTokens);
});

test('rejects detail totals that do not match the summary', () => {
  const input = report([client({ modelId: 'm', tokens: buckets(5), providerId: 'p' })]);
  input.summary.totalTokens = 6;
  assert.throws(() => aggregateReport(input), /does not match summary\.totalTokens/);
});

test('rejects invalid token values and daily totals', () => {
  const negative = report([client({ modelId: 'm', tokens: buckets(-1), providerId: 'p' })]);
  assert.throws(() => aggregateReport(negative), /non-negative safe integer/);
  const nan = report([client({ modelId: 'm', tokens: buckets(1), providerId: 'p' })]);
  nan.contributions[0].clients[0].tokens.reasoning = Number.NaN;
  assert.throws(() => aggregateReport(nan), /non-negative safe integer/);
  const wrongDay = report([client({ modelId: 'm', tokens: buckets(1), providerId: 'p' })]);
  wrongDay.contributions[0].totals.tokens = 2;
  assert.throws(() => aggregateReport(wrongDay), /do not match daily total/);
});

test('escapes XML label text and renders the all-time card accessibility text', () => {
  const input = report([client({
    modelId: 'model <& "x">', client: 'cli & tool', providerId: 'provider <one>', tokens: buckets(42),
  })]);
  const svg = renderDetailsCard(aggregateReport(input));
  assert.match(svg, /model &lt;&amp; &quot;x&quot;&gt;/);
  assert.match(svg, /cli &amp; tool/);
  assert.match(svg, /provider &lt;one&gt;/);
  assert.match(svg, /aria-labelledby="card-title card-desc"/);
  assert.match(svg, /Updated 2026-10-16 KST · share of total tokens/);
  assert.match(svg, /<title id="card-title">Usage breakdown<\/title>/);
});

test('keeps source keys while displaying friendly tool and provider names', () => {
  const input = report([
    client({ modelId: 'm1', client: 'codex', providerId: 'openai', tokens: buckets(400) }),
    client({ modelId: 'm2', client: 'claude', providerId: 'anthropic', tokens: buckets(300) }),
    client({ modelId: 'm3', client: 'opencode', providerId: 'opencode_go', tokens: buckets(200) }),
    client({ modelId: 'm4', client: 'other', providerId: 'other-provider', tokens: buckets(100) }),
  ]);
  const aggregated = aggregateReport(input);
  const svg = renderDetailsCard(aggregated);

  assert.deepEqual(aggregated.tools.map(({ name }) => name), ['codex', 'claude', 'opencode', 'Other']);
  assert.deepEqual(aggregated.providers.map(({ name }) => name), ['openai', 'anthropic', 'opencode_go', 'Other']);
  assert.match(svg, />Codex<\/text>/);
  assert.match(svg, />Claude Code<\/text>/);
  assert.match(svg, />OpenCode<\/text>/);
  assert.match(svg, />OpenAI<\/text>/);
  assert.match(svg, />Anthropic<\/text>/);
  assert.match(svg, />OpenCode Go<\/text>/);
  assert.match(svg, /Providers follow recorded routing IDs/);
});

test('draws bars against total tokens and labels positive shares below 0.1 percent', () => {
  const input = report([
    client({ modelId: 'm1', client: 'tool1', providerId: 'p1', tokens: buckets(354) }),
    client({ modelId: 'm2', client: 'tool2', providerId: 'p2', tokens: buckets(1645) }),
    client({ modelId: 'm3', client: 'tool3', providerId: 'p3', tokens: buckets(1) }),
  ]);
  const svg = renderDetailsCard(aggregateReport(input));

  assert.match(svg, /354 · 17\.7%/);
  assert.match(svg, /1 · &lt;0\.1%/);
  assert.match(svg, /<rect x="38" y="163" width="48\.5" height="7"/);
});
