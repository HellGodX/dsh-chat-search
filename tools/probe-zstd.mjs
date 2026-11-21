import fs from "node:fs";
import zlib from "node:zlib";

const f = process.argv[2];
const b = fs.readFileSync(f);

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
function findMagics(buf) {
  const out = [];
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) out.push(i);
  }
  return out;
}

function decompressAll(buf) {
  const magics = findMagics(buf);
  const parts = [];
  let start = magics.length && magics[0] === 0 ? 0 : 0;
  let next = 1;
  let fails = 0;
  while (next < magics.length) {
    const end = magics[next];
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(start, end)));
      start = end;
    } catch {
      fails++;
    }
    next++;
  }
  try {
    parts.push(zlib.zstdDecompressSync(buf.subarray(start)));
  } catch (e) {
    fails++;
  }
  return { text: Buffer.concat(parts).toString("utf8"), frames: parts.length, fails, magics: magics.length };
}

const t0 = Date.now();
const r = decompressAll(b);
const lines = r.text.split("\n").filter((l) => l.trim());
let ok = 0, bad = 0;
const types = {};
for (const l of lines) {
  try {
    const ev = JSON.parse(l);
    ok++;
    types[ev.type] = (types[ev.type] || 0) + 1;
  } catch { bad++; }
}
console.log({ bytes: b.length, ...r, chars: r.text.length, lines: lines.length, parsed: ok, bad, ms: Date.now() - t0 });
console.log(Object.entries(types).sort((a, b2) => b2[1] - a[1]).slice(0, 8));
