// Builds the icon and in-app logo from the artwork in assets/brand/source.
// The sources are raster images on a white background; this removes the white
// so they work on light and dark surfaces, and trims them to the artwork.
//
//   desktop-logo.png -> build/icon.png                         app, installer and window icon
//                    -> src/renderer/src/assets/nodal-mark.png  the mark, used in the GUI
//   gui-logo.webp    -> src/renderer/src/assets/nodal-wordmark.png
//                       the "NODAL" lettering as a white shape with transparency; the
//                       GUI uses it as a mask, so it takes the current text colour.
//
// Run with `npm run brand` after `npm run bundle` (it borrows the app's Chromium for image work).
import { _electron as electron } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const src = (name) => readFileSync(join(root, 'assets/brand/source', name)).toString('base64');
const userData = mkdtempSync(join(tmpdir(), 'nodal-brand-'));
const app = await electron.launch({ args: [root], env: { ...process.env, NODAL_USER_DATA: userData } });
const page = await app.firstWindow();
await page.waitForLoadState('domcontentloaded');

const out = await page.evaluate(
  async ({ desktop, gui }) => {
    const load = (b64, mime) =>
      new Promise((res, rej) => {
        const img = new Image();
        img.onload = () => res(img);
        img.onerror = () => rej(new Error('could not decode image'));
        img.src = `data:${mime};base64,${b64}`;
      });
    const pixels = (img) => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      return ctx.getImageData(0, 0, c.width, c.height);
    };
    const bounds = (data, x0, x1) => {
      let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
      for (let y = 0; y < data.height; y++)
        for (let x = x0; x < x1; x++)
          if (data.data[(y * data.width + x) * 4 + 3] > 24) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
      return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
    };
    const toCanvas = (data) => {
      const c = document.createElement('canvas');
      c.width = data.width;
      c.height = data.height;
      c.getContext('2d').putImageData(data, 0, 0);
      return c;
    };
    const render = (source, box, width, height, pad) => {
      const c = document.createElement('canvas');
      c.width = width;
      c.height = height;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      const scale = Math.min((width * (1 - 2 * pad)) / box.w, (height * (1 - 2 * pad)) / box.h);
      const w = box.w * scale, h = box.h * scale;
      ctx.drawImage(source, box.x, box.y, box.w, box.h, (width - w) / 2, (height - h) / 2, w, h);
      return c.toDataURL('image/png').split(',')[1];
    };

    // Distance of each pixel from the background colour (taken from the top-left corner).
    const distances = (data) => {
      const bg = [data.data[0], data.data[1], data.data[2]];
      const d = new Float32Array(data.width * data.height);
      for (let i = 0, j = 0; i < data.data.length; i += 4, j++) {
        d[j] = Math.max(Math.abs(data.data[i] - bg[0]), Math.abs(data.data[i + 1] - bg[1]), Math.abs(data.data[i + 2] - bg[2]));
      }
      return { d, bg };
    };

    // --- the mark: background becomes transparent, colours are un-blended at the soft edges
    const mark = pixels(await load(desktop, 'image/png'));
    let transparentAlready = 0;
    for (let i = 3; i < mark.data.length; i += 4) if (mark.data[i] < 16) transparentAlready++;
    const hasAlpha = transparentAlready > mark.data.length / 4 / 20;
    if (!hasAlpha) {
      // A flat background: key it out.
      const { d, bg } = distances(mark);
      for (let i = 0, j = 0; i < mark.data.length; i += 4, j++) {
        const a = d[j] <= 75 ? 0 : d[j] >= 120 ? 1 : (d[j] - 75) / 45;
        if (a > 0 && a < 1) for (let k = 0; k < 3; k++) mark.data[i + k] = Math.max(0, Math.min(255, (mark.data[i + k] - (1 - a) * bg[k]) / a));
        mark.data[i + 3] = Math.round(a * 255);
      }
    }
    // Otherwise the artwork already carries its own transparency; use it.
    // Either way, clear the faint specks such artwork often has around its shapes:
    // drop near-transparent pixels, then any island too small to be part of the mark.
    {
      const w = mark.width, h = mark.height, px = mark.data;
      for (let i = 3; i < px.length; i += 4) if (px[i] < 80) px[i] = 0;
      const seen = new Uint8Array(w * h);
      const stack = [];
      for (let start = 0; start < w * h; start++) {
        if (seen[start] || px[start * 4 + 3] === 0) continue;
        const island = [];
        stack.push(start);
        seen[start] = 1;
        while (stack.length) {
          const p = stack.pop();
          island.push(p);
          const x = p % w, y = (p - x) / w;
          for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
            if (q >= 0 && !seen[q] && px[q * 4 + 3] !== 0) {
              seen[q] = 1;
              stack.push(q);
            }
          }
        }
        if (island.length < (w * h) / 2000) for (const p of island) px[p * 4 + 3] = 0;
      }
    }
    const markCanvas = toCanvas(mark);
    const markBox = bounds(mark, 0, mark.width);

    // --- the wordmark: everything that is not background becomes a solid shape
    const logo = pixels(await load(gui, 'image/webp'));
    {
      const { d } = distances(logo);
      for (let i = 0, j = 0; i < logo.data.length; i += 4, j++) {
        const a = d[j] <= 5 ? 0 : d[j] >= 13 ? 1 : (d[j] - 5) / 8;
        logo.data[i] = logo.data[i + 1] = logo.data[i + 2] = 255;
        logo.data[i + 3] = Math.round(a * 255);
      }
    }
    // Columns that hold artwork, grouped into runs. The first run is the mark;
    // after the first wide gap come the letters. Slivers of compression noise are dropped.
    const filled = [];
    for (let x = 0; x < logo.width; x++) {
      let n = 0;
      for (let y = 0; y < logo.height; y++) if (logo.data[(y * logo.width + x) * 4 + 3] === 255) n++;
      filled.push(n >= 3);
    }
    const runs = [];
    for (let x = 0, start = -1; x <= logo.width; x++) {
      if (filled[x] && start < 0) start = x;
      if (!filled[x] && start >= 0) {
        if (x - start >= 12) runs.push([start, x]);
        start = -1;
      }
    }
    let first = runs.findIndex((r, i) => i > 0 && r[0] - runs[i - 1][1] >= 45);
    if (first < 0) first = 0;
    let last = first;
    while (last + 1 < runs.length && runs[last + 1][0] - runs[last][1] < 100) last++;
    // Vertical extent: the tallest band of rows that hold solid lettering (ignores stray noise rows).
    const x0 = runs[first][0], x1 = runs[last][1];
    let band = [0, 0];
    for (let y = 0, start = -1; y <= logo.height; y++) {
      let n = 0;
      if (y < logo.height) for (let x = x0; x < x1; x++) if (logo.data[(y * logo.width + x) * 4 + 3] === 255) n++;
      if (n >= 8 && start < 0) start = y;
      if (n < 8 && start >= 0) {
        if (y - start > band[1] - band[0]) band = [start, y];
        start = -1;
      }
    }
    const wordBox = { x: x0, y: band[0], w: x1 - x0, h: band[1] - band[0] };
    const best = { runs: runs.length, letters: last - first + 1 };
    const wordHeight = 96;
    const wordWidth = Math.round((wordBox.w / wordBox.h) * wordHeight);

    return {
      icon: render(markCanvas, markBox, 1024, 1024, 0.04),
      mark: render(markCanvas, markBox, 256, 256, 0),
      wordmark: render(toCanvas(logo), wordBox, wordWidth, wordHeight, 0),
      info: { hasAlpha, markBox, wordBox, wordmark: [wordWidth, wordHeight], gap: best },
    };
  },
  { desktop: src('desktop-logo.png'), gui: src('gui-logo.webp') },
);
await app.close();
rmSync(userData, { recursive: true, force: true, maxRetries: 5 });

const write = (rel, b64) => {
  const file = join(root, rel);
  mkdirSync(resolve(file, '..'), { recursive: true });
  writeFileSync(file, Buffer.from(b64, 'base64'));
  console.log(`wrote ${rel}`);
};
write('build/icon.png', out.icon);
write('src/renderer/src/assets/nodal-mark.png', out.mark);
write('src/renderer/src/assets/nodal-wordmark.png', out.wordmark);
console.log(JSON.stringify(out.info));
