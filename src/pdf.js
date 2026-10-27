// One page of a PDF becomes a PNG with poppler's pdftoppm (installed in the image), for pictures such as a shipping
// label. The PDF is written to a private temporary folder that is removed afterwards; poppler runs with a time limit.
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InputError } from './validation.js';

export const isPdf = bytes => bytes.subarray(0, 5).toString('latin1') === '%PDF-';

function run(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [], err = []; let done = false;
    const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new InputError('Reading the PDF timed out.', 503)); }, timeoutMs);
    child.on('error', () => finish(new InputError(`The PDF reader (${command}) is not available.`, 503)));
    child.stdout.on('data', chunk => { if (out.length < 200) out.push(chunk); });
    child.stderr.on('data', chunk => { if (err.length < 20) err.push(chunk); });
    child.on('close', code => code === 0 ? finish(null, Buffer.concat(out).toString('utf8'))
      : finish(new InputError(`The PDF could not be read: ${Buffer.concat(err).toString('utf8').trim().slice(0, 200) || `exit ${code}`}`, 422)));
  });
}

// page: 1 for the first page. The page is drawn at 300 dpi (the printer's resolution), or smaller so that its longer
// side stays within maxSide pixels. Returns { png, page, pages }.
export async function pdfPage(bytes, page = 1, { maxSide = 4000, timeoutMs = 30000, bin = process.env.POPPLER_BIN || '' } = {}) {
  const tool = name => bin ? join(bin, name) : name;
  const folder = await mkdtemp(join(tmpdir(), 'pdf-'));
  try {
    const input = join(folder, 'in.pdf');
    await writeFile(input, bytes);
    // The page count first: pdfinfo refuses a page range past the last page with an error of its own.
    const pages = +(/^Pages:\s+(\d+)/m.exec(await run(tool('pdfinfo'), [input], timeoutMs))?.[1] || 0);
    if (!pages) throw new InputError('The PDF has no pages.', 422);
    if (page > pages) throw new InputError(`The PDF has ${pages} page${pages === 1 ? '' : 's'}.`, 422);
    const info = await run(tool('pdfinfo'), ['-f', String(page), '-l', String(page), input], timeoutMs);
    const size = new RegExp(`^Page\\s+${page}\\s+size:\\s+([\\d.]+) x ([\\d.]+)`, 'm').exec(info) || /^Page size:\s+([\d.]+) x ([\d.]+)/m.exec(info);
    const longest = size ? Math.max(+size[1], +size[2]) / 72 : 11.7;
    const dpi = Math.max(36, Math.min(300, Math.floor(maxSide / longest)));
    await run(tool('pdftoppm'), ['-f', String(page), '-l', String(page), '-r', String(dpi), '-png', '-singlefile', '-aa', 'yes', '-aaVector', 'yes', input, join(folder, 'page')], timeoutMs);
    return { png: await readFile(join(folder, 'page.png')), page, pages };
  } finally { await rm(folder, { recursive: true, force: true }); }
}
