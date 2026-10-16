import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const TOKEN_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'];
const WIDTH = 680;
const COLORS = {
  background: '#131822',
  text: '#F4F7FB',
  muted: '#A8B3C5',
  accent: '#2F8FFF',
  track: '#283242',
  panel: '#191F2B',
};

function assert(condition, message) {
  if (!condition) throw new TypeError(`Invalid Tokscale report: ${message}`);
}

function tokenCount(tokens, context) {
  assert(tokens && typeof tokens === 'object' && !Array.isArray(tokens), `${context} tokens must be an object`);
  let sum = 0;
  for (const field of TOKEN_FIELDS) {
    const value = tokens[field];
    assert(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0, `${context}.${field} must be a non-negative safe integer`);
    sum += value;
  }
  assert(Number.isSafeInteger(sum), `${context} token sum exceeds safe integer range`);
  return sum;
}

function add(map, key, value) {
  const next = (map.get(key) ?? 0) + value;
  assert(Number.isSafeInteger(next), 'aggregated token sum exceeds safe integer range');
  map.set(key, next);
}

export function aggregateReport(report) {
  assert(report && typeof report === 'object' && !Array.isArray(report), 'root must be an object');
  assert(report.summary && typeof report.summary === 'object', 'summary is required');
  const expected = report.summary.totalTokens;
  assert(typeof expected === 'number' && Number.isSafeInteger(expected) && expected >= 0, 'summary.totalTokens must be a non-negative safe integer');
  assert(Array.isArray(report.contributions), 'contributions must be an array');

  const models = new Map();
  const tools = new Map();
  const providers = new Map();
  let detailTotal = 0;
  for (const [dayIndex, day] of report.contributions.entries()) {
    assert(day && Array.isArray(day.clients), `contributions[${dayIndex}].clients must be an array`);
    let dayTotal = 0;
    for (const [clientIndex, client] of day.clients.entries()) {
      const context = `contributions[${dayIndex}].clients[${clientIndex}]`;
      assert(client && typeof client === 'object', `${context} must be an object`);
      assert(typeof client.modelId === 'string' && client.modelId.length > 0, `${context}.modelId must be a non-empty string`);
      assert(typeof client.client === 'string' && client.client.length > 0, `${context}.client must be a non-empty string`);
      const tokens = tokenCount(client.tokens, context);
      add(models, client.modelId, tokens);
      add(tools, client.client, tokens);
      add(providers, typeof client.providerId === 'string' && client.providerId.trim() ? client.providerId : 'Unknown', tokens);
      dayTotal += tokens;
      assert(Number.isSafeInteger(dayTotal), `${context} daily sum exceeds safe integer range`);
    }
    const reportedDay = day.totals?.tokens;
    assert(typeof reportedDay === 'number' && Number.isSafeInteger(reportedDay) && reportedDay >= 0, `contributions[${dayIndex}].totals.tokens must be a non-negative safe integer`);
    assert(dayTotal === reportedDay, `contributions[${dayIndex}] client tokens do not match daily total`);
    detailTotal += dayTotal;
    assert(Number.isSafeInteger(detailTotal), 'detail total exceeds safe integer range');
  }
  assert(detailTotal === expected, `client detail total (${detailTotal}) does not match summary.totalTokens (${expected})`);

  const rank = (map) => [...map].map(([name, tokens]) => ({ name, tokens }))
    .sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));
  return {
    totalTokens: expected,
    generatedAt: report.meta?.generatedAt,
    models: rank(models).slice(0, 3),
    tools: withOther(tools),
    providers: withOther(providers),
  };
}

function withOther(map) {
  const ranked = [...map].map(([name, tokens]) => ({ name, tokens }))
    .sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));
  const top = ranked.slice(0, 3);
  const other = ranked.slice(3).reduce((sum, row) => sum + row.tokens, 0);
  if (other > 0) top.push({ name: 'Other', tokens: other });
  return top;
}

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[char]);
}

function safeLabel(value, max = 24) {
  const chars = Array.from(value);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : value;
}

function formatTokens(value) {
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return value.toLocaleString('en-US');
}

function share(value, total) {
  if (total === 0 || value === 0) return '0.0%';
  const percentage = value * 100 / total;
  return percentage < 0.1 ? '<0.1%' : `${percentage.toFixed(1)}%`;
}

function displayName(name, category) {
  const names = category === 'tool'
    ? { codex: 'Codex', claude: 'Claude Code', opencode: 'OpenCode' }
    : { openai: 'OpenAI', anthropic: 'Anthropic', opencode_go: 'OpenCode Go' };
  return names[name] ?? name;
}

function text(x, y, content, { size = 12, color = COLORS.text, weight = 400, anchor = 'start' } = {}) {
  return `<text x="${x}" y="${y}" fill="${color}" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}">${escapeXml(content)}</text>`;
}

function renderRows(rows, x, y, width, total, maxRows, labelLimit, category, rowGap = 34) {
  const visible = rows.slice(0, maxRows);
  return visible.map((row, index) => {
    const rowY = y + index * rowGap;
    const fillWidth = total > 0 ? width * row.tokens / total : 0;
    return [
      text(x, rowY + 10, safeLabel(displayName(row.name, category), labelLimit), { size: 11, color: COLORS.text, weight: 500 }),
      text(x + width, rowY + 10, `${formatTokens(row.tokens)} · ${share(row.tokens, total)}`, { size: 10, color: COLORS.muted, anchor: 'end' }),
      `<rect x="${x}" y="${rowY + 16}" width="${width}" height="7" rx="3.5" fill="${COLORS.track}"/>`,
      `<rect x="${x}" y="${rowY + 16}" width="${fillWidth.toFixed(1)}" height="7" rx="3.5" fill="${COLORS.accent}"/>`,
    ].join('');
  }).join('');
}

export function renderDetailsCard(data) {
  assert(data && Number.isSafeInteger(data.totalTokens) && data.totalTokens >= 0, 'aggregated totalTokens is required');
  assert(Array.isArray(data.models) && Array.isArray(data.tools) && Array.isArray(data.providers), 'aggregated models, tools, and providers are required');
  const generatedAt = data.generatedAt;
  const date = new Date(generatedAt);
  assert(Number.isFinite(date.getTime()), 'meta.generatedAt must be a valid date');
  const updated = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
  const height = 454;
  const leftX = 24;
  const rightX = 354;
  const columnWidth = 302;
  const providerRows = data.providers;
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" role="img" aria-labelledby="card-title card-desc">`,
    `<title id="card-title">Usage breakdown</title>`,
    `<desc id="card-desc">All-time token usage by top models, tools, and providers. Total ${formatTokens(data.totalTokens)} tokens.</desc>`,
    `<rect width="${WIDTH}" height="${height}" rx="18" fill="${COLORS.background}"/>`,
    text(24, 36, 'Usage breakdown', { size: 19, weight: 650 }),
    text(656, 35, 'ALL-TIME', { size: 10, color: COLORS.muted, weight: 600, anchor: 'end' }),
    `<rect x="20" y="54" width="316" height="200" rx="12" fill="${COLORS.panel}"/>`,
    `<rect x="344" y="54" width="316" height="200" rx="12" fill="${COLORS.panel}"/>`,
    text(leftX + 14, 80, 'Models', { size: 13, weight: 600 }),
    text(leftX + 14, 98, 'TOP 3', { size: 9, color: COLORS.muted, weight: 600 }),
    text(rightX + 14, 80, 'Tools', { size: 13, weight: 600 }),
    text(rightX + 14, 98, 'TOKENS', { size: 9, color: COLORS.muted, weight: 600 }),
    renderRows(data.models, leftX + 14, 113, columnWidth - 28, data.totalTokens, 3, 20, 'model'),
    renderRows(data.tools, rightX + 14, 113, columnWidth - 28, data.totalTokens, 4, 16, 'tool'),
    `<rect x="20" y="262" width="640" height="164" rx="12" fill="${COLORS.panel}"/>`,
    text(38, 287, 'Providers', { size: 13, weight: 600 }),
    text(642, 287, 'TOKENS', { size: 9, color: COLORS.muted, weight: 600, anchor: 'end' }),
    renderRows(providerRows, 38, 300, 604, data.totalTokens, 4, 22, 'provider', 29),
    text(24, 445, `Updated ${updated} KST · share of total tokens · Providers follow recorded routing IDs`, { size: 10, color: COLORS.muted }),
    '</svg>',
  ].join('');
  return svg;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , inputPath, outputPath] = process.argv;
  if (!inputPath || !outputPath) {
    console.error('Usage: node render.mjs INPUT_JSON OUTPUT_SVG');
    process.exitCode = 2;
  } else {
    try {
      const report = JSON.parse(await readFile(inputPath, 'utf8'));
      await writeFile(outputPath, renderDetailsCard(aggregateReport(report)), 'utf8');
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
