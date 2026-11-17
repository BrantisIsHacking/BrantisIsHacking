#!/usr/bin/env node
// Tetris contribution graph generator.
// Fetches a user's GitHub contribution calendar, splits the filled squares into
// tetromino-like pieces, and renders an animated SVG where the pieces fall into
// place, the board flashes, and the rows clear before the loop starts again.
//
// Usage:
//   GITHUB_TOKEN=... node scripts/tetris.mjs --user <login> [--out dist]
//   node scripts/tetris.mjs --user <login>            (no token: reads the public contributions page)
//   node scripts/tetris.mjs --user <login> --mock     (fake data)
//
// Requires Node 18+ (built-in fetch). No dependencies.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---------- args ----------
const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? def : args[i + 1];
};
const USER = arg("user", process.env.GITHUB_REPOSITORY_OWNER);
const OUT = arg("out", "dist");
const MOCK = args.includes("--mock");
if (!USER) {
  console.error("Missing --user <login>");
  process.exit(1);
}

// ---------- layout ----------
const CELL = 11;
const GAP = 3;
const STEP = CELL + GAP;
const PAD = 14;
const HEADER = 30;

// ---------- data ----------
const LEVELS = { NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4 };

// No-token fallback: read the public contributions page GitHub shows on a profile.
async function scrapeCalendar(login) {
  const res = await fetch(`https://github.com/users/${encodeURIComponent(login)}/contributions`, {
    headers: { "User-Agent": "tetris-contribution-graph" },
  });
  if (!res.ok) throw new Error(`Could not load contributions page (HTTP ${res.status})`);
  const html = await res.text();
  const weeks = [];
  const re = /id="contribution-day-component-(\d)-(\d+)"[^>]*data-level="(\d)"/g;
  for (let m; (m = re.exec(html)); ) {
    const [, day, week, level] = m.map(Number);
    weeks[week] ??= Array(7).fill(0);
    weeks[week][day] = level;
  }
  if (!weeks.length) throw new Error("No contribution cells found on the page");
  const total = Number((html.match(/([\d,]+)\s+contributions?\s+in the last year/) ?? [, "0"])[1].replace(/,/g, ""));
  return { total, weeks: Array.from(weeks, (w) => w ?? Array(7).fill(0)) };
}

async function fetchCalendar(login) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return scrapeCalendar(login);
  const query = `query($login: String!) {
    user(login: $login) {
      contributionsCollection {
        contributionCalendar {
          totalContributions
          weeks { contributionDays { contributionCount contributionLevel weekday } }
        }
      }
    }
  }`;
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${token}`, "Content-Type": "application/json", "User-Agent": "tetris-contribution-graph" },
    body: JSON.stringify({ query, variables: { login } }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(`GitHub API error: ${JSON.stringify(json.errors ?? json)}`);
  const cal = json.data.user.contributionsCollection.contributionCalendar;
  const weeks = cal.weeks.map((w) => {
    const col = Array(7).fill(0);
    for (const d of w.contributionDays) col[d.weekday] = LEVELS[d.contributionLevel] ?? 0;
    return col;
  });
  return { total: cal.totalContributions, weeks };
}

function mockCalendar() {
  let seed = 42;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  let total = 0;
  const weeks = Array.from({ length: 53 }, (_, w) =>
    Array.from({ length: 7 }, (_, d) => {
      const busy = Math.sin(w / 6) * 0.3 + (d > 0 && d < 6 ? 0.55 : 0.2);
      if (rand() > busy) return 0;
      const lvl = 1 + Math.floor(rand() * 4);
      total += lvl * 2;
      return lvl;
    })
  );
  return { total, weeks };
}

// ---------- split filled cells into pieces ----------
function buildPieces(weeks) {
  const W = weeks.length;
  const owner = weeks.map((c) => c.map(() => -1));
  const pieces = [];
  for (let x = 0; x < W; x++) {
    for (let y = 6; y >= 0; y--) {
      if (!weeks[x][y] || owner[x][y] !== -1) continue;
      const id = pieces.length;
      const cells = [];
      const queue = [[x, y]];
      owner[x][y] = id;
      while (queue.length && cells.length < 4) {
        const [cx, cy] = queue.shift();
        cells.push([cx, cy]);
        for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || nx >= W || ny < 0 || ny > 6) continue;
          if (!weeks[nx][ny] || owner[nx][ny] !== -1) continue;
          if (cells.length + queue.length >= 4) break;
          owner[nx][ny] = id;
          queue.push([nx, ny]);
        }
      }
      // anything queued but not taken goes back to the pool
      for (const [qx, qy] of queue) owner[qx][qy] = -1;
      pieces.push({ cells });
    }
  }
  // drop order: lowest pieces first, sweeping left to right, so the board fills bottom-up
  for (const p of pieces) {
    p.bottom = Math.max(...p.cells.map((c) => c[1]));
    p.top = Math.min(...p.cells.map((c) => c[1]));
    p.left = Math.min(...p.cells.map((c) => c[0]));
  }
  pieces.sort((a, b) => b.bottom - a.bottom || a.left - b.left);
  return pieces;
}

// classic tetromino colors, picked from the piece's shape so equal shapes share a color
const PALETTE = ["#00d8f0", "#f0d000", "#a040f0", "#30d050", "#f04050", "#3070f0", "#f09020"];
function shapeColor(cells) {
  const minX = Math.min(...cells.map((c) => c[0]));
  const minY = Math.min(...cells.map((c) => c[1]));
  const key = cells.map(([x, y]) => `${x - minX},${y - minY}`).sort().join(";");
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

// ---------- render ----------
const THEMES = {
  light: { board: "#f6f8fa", border: "#d0d7de", empty: "#ebedf0", text: "#24292f", dim: "#57606a", flash: "#ffffff" },
  dark: { board: "#0d1117", border: "#30363d", empty: "#161b22", text: "#e6edf3", dim: "#7d8590", flash: "#ffffff" },
};
const LEVEL_ALPHA = [0, 0.45, 0.65, 0.85, 1];

const pct = (t, T) => ((t / T) * 100).toFixed(3) + "%";

function render({ total, weeks }, pieces, theme, login) {
  const c = THEMES[theme];
  const W = weeks.length;
  const boardW = W * STEP - GAP;
  const boardH = 7 * STEP - GAP;
  const width = boardW + PAD * 2;
  const height = HEADER + boardH + PAD * 2;
  const bx = PAD, by = HEADER + PAD;

  // timeline (seconds)
  const N = Math.max(pieces.length, 1);
  const spawnPhase = Math.min(14, Math.max(4, N * 0.07));
  const FALL = 0.55;
  const HOLD = 1.6;
  const ROW_GAP = 0.18;
  const CLEAR = 0.35;
  const landEnd = spawnPhase + FALL;
  const clearStart = landEnd + HOLD;
  const T = clearStart + 7 * ROW_GAP + CLEAR + 0.8;

  const css = [];
  const body = [];

  // static board + empty squares
  body.push(`<rect x="${bx - 6}" y="${by - 6}" width="${boardW + 12}" height="${boardH + 12}" rx="6" fill="${c.board}" stroke="${c.border}"/>`);
  for (let x = 0; x < W; x++)
    for (let y = 0; y < 7; y++)
      body.push(`<rect x="${bx + x * STEP}" y="${by + y * STEP}" width="${CELL}" height="${CELL}" rx="2" fill="${c.empty}"/>`);

  // rows clear bottom-up: each row fades out at its time
  for (let y = 0; y < 7; y++) {
    const t = clearStart + (6 - y) * ROW_GAP;
    css.push(`@keyframes r${y}{0%,${pct(t, T)}{opacity:1}${pct(t + CLEAR, T)},100%{opacity:0}}`);
    css.push(`.r${y}{animation:r${y} ${T.toFixed(2)}s linear infinite}`);
    css.push(`@keyframes f${y}{0%,${pct(t, T)}{opacity:0}${pct(t + CLEAR * 0.35, T)}{opacity:.85}${pct(t + CLEAR, T)},100%{opacity:0}}`);
    css.push(`.f${y}{opacity:0;animation:f${y} ${T.toFixed(2)}s linear infinite}`);
  }

  // falling pieces
  const pieceSvg = [];
  pieces.forEach((p, i) => {
    const spawn = (i / N) * spawnPhase;
    const land = spawn + FALL;
    const dy = (p.bottom + 2) * STEP; // start fully above the board
    css.push(
      `@keyframes p${i}{0%,${pct(spawn, T)}{transform:translateY(-${dy}px);animation-timing-function:cubic-bezier(.55,0,1,.45)}` +
        `${pct(land, T)},100%{transform:translateY(0)}}`
    );
    css.push(`.p${i}{animation:p${i} ${T.toFixed(2)}s infinite}`);
    const color = shapeColor(p.cells);
    const cells = p.cells
      .map(([x, y]) => {
        const px = bx + x * STEP, py = by + y * STEP;
        const a = LEVEL_ALPHA[weeks[x][y]];
        return (
          `<g class="r${y}"><rect x="${px}" y="${py}" width="${CELL}" height="${CELL}" rx="2" fill="${color}" fill-opacity="${a}"/>` +
          `<rect x="${px + 1.5}" y="${py + 1.5}" width="${CELL - 5}" height="2" rx="1" fill="#fff" fill-opacity="${(0.45 * a).toFixed(2)}"/></g>`
        );
      })
      .join("");
    pieceSvg.push(`<g class="p${i}">${cells}</g>`);
  });
  body.push(`<g clip-path="url(#board)">${pieceSvg.join("")}</g>`);

  // row flash overlays
  for (let y = 0; y < 7; y++)
    body.push(`<rect class="f${y}" x="${bx - 2}" y="${by + y * STEP - 1}" width="${boardW + 4}" height="${CELL + 2}" rx="2" fill="${c.flash}"/>`);

  // header
  const font = `font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" font-size="12" font-weight="700"`;
  body.push(`<text x="${bx - 4}" y="${PAD + 10}" ${font} fill="${c.text}">@${esc(login)}</text>`);
  body.push(
    `<text x="${bx + boardW + 4}" y="${PAD + 10}" ${font} text-anchor="end" fill="${c.dim}">SCORE <tspan fill="${c.text}">${String(total).padStart(6, "0")}</tspan></text>`
  );

  css.push(`@media (prefers-reduced-motion:reduce){*{animation:none!important}.f0,.f1,.f2,.f3,.f4,.f5,.f6{opacity:0}}`);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<title>${esc(login)}'s contributions as Tetris</title>
<defs><clipPath id="board"><rect x="${bx - 6}" y="${by - 6}" width="${boardW + 12}" height="${boardH + 12}"/></clipPath></defs>
<style>${css.join("")}</style>
${body.join("\n")}
</svg>`;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
}

// ---------- main ----------
const data = MOCK ? mockCalendar() : await fetchCalendar(USER);
const pieces = buildPieces(data.weeks);
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "tetris-contribution-graph.svg"), render(data, pieces, "light", USER));
writeFileSync(join(OUT, "tetris-contribution-graph-dark.svg"), render(data, pieces, "dark", USER));
console.log(`Wrote ${pieces.length} pieces (${data.total} contributions) to ${OUT}/`);
