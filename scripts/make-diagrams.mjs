// Writes the architecture diagram shown in the README, once for GitHub's light
// theme and once for its dark theme: assets/branding/architecture-{light,dark}.svg
//
//   node scripts/make-diagrams.mjs
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

const THEMES = {
  light: { ink: '#1b1f2e', soft: '#5a6072', line: '#c5cad8', panel: '#f6f7fb', box: '#ffffff', accent: '#4347d9', accentSoft: '#e5e8fd' },
  dark: { ink: '#e8eaf4', soft: '#a2a8bd', line: '#3a4058', panel: '#161924', box: '#1e2230', accent: '#9aa5ff', accentSoft: '#272d57' },
};

function diagram(t) {
  const font = `font-family="system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif"`;
  const box = (x, y, w, h, title, lines, opts = {}) => `
  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="${opts.fill ?? t.box}" stroke="${opts.stroke ?? t.line}" stroke-width="1.25"/>
  <text x="${x + 16}" y="${y + 27}" ${font} font-size="14" font-weight="600" fill="${t.ink}">${title}</text>
  ${lines.map((l, i) => `<text x="${x + 16}" y="${y + 48 + i * 18}" ${font} font-size="12.5" fill="${t.soft}">${l}</text>`).join('\n  ')}`;
  const group = (x, y, w, h, label) => `
  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${t.panel}" stroke="${t.line}" stroke-width="1.25"/>
  <text x="${x + 18}" y="${y + 28}" ${font} font-size="11.5" font-weight="600" letter-spacing="1.2" fill="${t.soft}">${label}</text>`;
  const arrow = (x1, y1, x2, y2, both = false) =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${t.accent}" stroke-width="1.6" marker-end="url(#head)"${both ? ' marker-start="url(#tail)"' : ''}/>`;
  const tag = (x, y, text) => {
    const w = text.length * 6.6 + 18;
    return `<rect x="${x - w / 2}" y="${y - 12}" width="${w}" height="22" rx="11" fill="${t.accentSoft}"/><text x="${x}" y="${y + 3.5}" text-anchor="middle" ${font} font-size="11.5" font-weight="600" fill="${t.accent}">${text}</text>`;
  };

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 500" width="1000" height="500" role="img" aria-labelledby="title desc">
  <title id="title">How NODAL connects you to AI models</title>
  <desc id="desc">You use the NODAL window on your computer. The window talks only to NODAL's main process, which stores chats and API keys on your computer and sends requests directly to the cloud providers or local model servers you configure. There are no NODAL servers in between.</desc>
  <defs>
    <marker id="head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="${t.accent}"/></marker>
    <marker id="tail" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M10 0 L0 5 L10 10 z" fill="${t.accent}"/></marker>
  </defs>

  ${group(160, 24, 452, 420, 'NODAL · ON YOUR COMPUTER')}
  ${box(16, 76, 96, 64, 'You', ['type or talk'])}
  ${arrow(114, 108, 178, 108, true)}
  ${box(180, 66, 412, 84, 'Interface window', ['Sandboxed. Makes no network requests.', 'Never receives an API key.'])}
  ${arrow(386, 150, 386, 192, true)}
  ${box(180, 194, 412, 84, 'Main process', ['Holds keys, builds requests, streams replies back.', 'Sends only to the hosts you configured.'], { stroke: t.accent })}
  ${arrow(282, 278, 282, 318)}
  ${arrow(490, 278, 490, 318, true)}
  ${box(180, 320, 200, 104, 'Chats and settings', ['One SQLite file.', 'Optional passphrase', 'encryption.'])}
  ${box(392, 320, 200, 104, 'API keys', ['Encrypted by the', 'operating system', 'credential store.'])}

  ${group(700, 24, 284, 190, 'CLOUD PROVIDERS')}
  ${box(720, 66, 244, 128, 'Your accounts', ['Venice.ai · OpenRouter · OpenAI', 'Any OpenAI-compatible', 'endpoint you add'])}
  ${arrow(592, 222, 716, 138)}
  ${tag(654, 166, 'HTTPS, direct')}

  ${group(700, 254, 284, 190, 'LOCAL INFERENCE')}
  ${box(720, 296, 244, 128, 'Your hardware', ['LM Studio · Ollama', 'On this computer or', 'your own network'])}
  ${arrow(592, 252, 716, 352)}
  ${tag(654, 318, 'localhost / LAN')}

  <text x="500" y="482" text-anchor="middle" ${font} font-size="12.5" fill="${t.soft}">No NODAL servers in between. No account. No telemetry.</text>
</svg>
`;
}

for (const [name, theme] of Object.entries(THEMES)) {
  writeFileSync(join(root, `assets/branding/architecture-${name}.svg`), diagram(theme), 'utf8');
  console.log(`architecture-${name}.svg`);
}
