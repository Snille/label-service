// SVG to PDF (for CUPS) and PNG (for previews) with librsvg's rsvg-convert, installed in the image.
// The SVG carries text as outlines, so the conversion needs no fonts and gives the same shapes everywhere.
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InputError } from './validation.js';

// svg: one SVG, or a list of SVGs for a PDF with one page each (a batch). rsvg-convert reads several pages only from
// files, so a list is written to a private temporary folder that is removed afterwards.
// width: a PNG this many pixels wide, keeping the proportions (used to turn an uploaded SVG or JPEG into a PNG);
// background: false keeps transparency.
export async function rsvgConvert(svg, format, options = {}) {
  if (!Array.isArray(svg)) return run(svg, format, [], options);
  if (format !== 'pdf') throw new InputError('Only a PDF can hold several labels.', 500);
  const folder = await mkdtemp(join(tmpdir(), 'labels-'));
  try {
    const files = svg.map((_, index) => join(folder, `${String(index).padStart(4, '0')}.svg`));
    await Promise.all(svg.map((page, index) => writeFile(files[index], page)));
    return await run('', format, files, { ...options, timeoutMs: (options.timeoutMs || 15000) + svg.length * 1000 });
  } finally { await rm(folder, { recursive: true, force: true }); }
}

function run(svg, format, files, { dpi = 300, width, background = true, timeoutMs = 15000, command = process.env.RSVG_CONVERT || 'rsvg-convert' } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['--format', format, ...(format === 'png' ? ['--dpi-x', String(dpi), '--dpi-y', String(dpi), ...(background ? ['--background-color', 'white'] : [])] : []),
      ...(width ? ['--width', String(width), '--keep-aspect-ratio'] : []), ...files];
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [], err = []; let size = 0, done = false;
    const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new InputError('Label rendering timed out.', 503)); }, timeoutMs);
    child.on('error', () => finish(new InputError('The label renderer (rsvg-convert) is not available.', 503)));
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 32 * 1024 * 1024) { child.kill('SIGKILL'); finish(new InputError('Rendered label is too large.', 503)); } else out.push(chunk); });
    child.stderr.on('data', chunk => { if (err.length < 20) err.push(chunk); });
    child.on('close', code => code === 0 ? finish(null, Buffer.concat(out)) : finish(new InputError(`Label rendering failed: ${Buffer.concat(err).toString('utf8').trim().slice(0, 200) || `exit ${code}`}`, 503)));
    child.stdin.on('error', () => {});
    child.stdin.end(svg);
  });
}
