// SVG to PDF (for CUPS) and PNG (for previews) with librsvg's rsvg-convert, installed in the image.
// The SVG carries text as outlines, so the conversion needs no fonts and gives the same shapes everywhere.
import { spawn } from 'node:child_process';
import { InputError } from './validation.js';

export function rsvgConvert(svg, format, { dpi = 300, timeoutMs = 15000, command = process.env.RSVG_CONVERT || 'rsvg-convert' } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['--format', format, ...(format === 'png' ? ['--dpi-x', String(dpi), '--dpi-y', String(dpi), '--background-color', 'white'] : [])];
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
