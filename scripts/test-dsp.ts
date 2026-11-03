// Compares host-gcc vectors from dsp/src/check.c with the TypeScript formulas.
// Not part of npm test: Docker has to be up.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scratchRoll } from "../src/core/deck.ts";
import { euclidGate, motif } from "../src/core/motif.ts";
import {
  hatDecaySeconds,
  kickDecaySeconds,
  percDecaySeconds,
  snareBodyDecaySeconds,
  snareNoiseDecaySeconds,
} from "../src/dsp/envelope.ts";
import { bendTimeSeconds, drumPitchHz, fmRatioOf, isoGain } from "../src/dsp/voice.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mount = root.replace(/\\/g, "/") + "/dsp";
const sources = [
  "src/check.c",
  "src/wave.c",
  "src/envelope.c",
  "src/motif.c",
  "src/drums.c",
  "src/notes.c",
  "src/fx.c",
  "src/deck.c",
  "src/phrase.c",
  "src/render.c",
  "src/plugin.c",
].join(" ");
const compile = `gcc -O2 -Wall -Werror -o /tmp/moveless-check ${sources} -lm && /tmp/moveless-check`;

const run = spawnSync(
  "docker",
  ["run", "--rm", "-v", `${mount}:/src`, "moveless-dsp", "bash", "-lc", compile],
  { encoding: "utf8" },
);
if (run.status !== 0) {
  process.stderr.write(run.stderr || run.stdout || "docker gcc failed\n");
  process.exit(run.status ?? 1);
}

const decayOf: Record<string, (unit: number) => number> = {
  kick: kickDecaySeconds,
  bend: bendTimeSeconds,
  snare_body: snareBodyDecaySeconds,
  snare_noise: snareNoiseDecaySeconds,
  hat: hatDecaySeconds,
  perc: percDecaySeconds,
};

function close(got: number, want: number): boolean {
  const gap = Math.abs(got - want);
  return gap <= 1e-4 || gap <= 1e-4 * Math.max(Math.abs(got), Math.abs(want));
}

let failed = 0;
function check(label: string, got: number, want: number): void {
  if (close(got, want)) return;
  failed += 1;
  process.stderr.write(`${label}: c ${got} ts ${want}\n`);
}

for (const line of run.stdout.split(/\n/)) {
  if (!line) continue;
  const part = line.split(" ");
  if (part[0] === "decay") {
    const fn = decayOf[part[1]];
    check(line, Number(part[3]), fn(Number(part[2])));
  } else if (part[0] === "pitch") {
    check(line, Number(part[3]), drumPitchHz(Number(part[1]), Number(part[2])));
  } else if (part[0] === "fm") {
    check(line, Number(part[2]), fmRatioOf(Number(part[1])));
  } else if (part[0] === "motif") {
    check(line, Number(part[3]), motif(Number(part[1]), Number(part[2])));
  } else if (part[0] === "euclid") {
    check(line, Number(part[4]), euclidGate(Number(part[1]), Number(part[2]), Number(part[3])));
  } else if (part[0] === "iso") {
    check(line, Number(part[2]), isoGain(Number(part[1])));
  } else if (part[0] === "scratch") {
    const notes = scratchRoll(2, 1, 3, 1);
    const got = part.slice(3).map((item) => item.split(":").map(Number));
    const count = Number(part[1]);
    const sum = Number(part[2]);
    const wantSum = notes.reduce((total, note) => total + note.len, 0);
    if (count !== notes.length || sum !== wantSum || got.length !== notes.length) {
      failed += 1;
      process.stderr.write(`${line}: ts ${notes.map((note) => `${note.len}:${note.type}:${note.sign}`).join(" ")}\n`);
      continue;
    }
    notes.forEach((note, index) => {
      const [len, type, sign] = got[index] ?? [];
      if (len !== note.len || type !== note.type || sign !== note.sign) {
        failed += 1;
        process.stderr.write(`scratch[${index}]: c ${got[index]} ts ${note.len}:${note.type}:${note.sign}\n`);
      }
    });
  } else {
    failed += 1;
    process.stderr.write(`unknown vector ${line}\n`);
  }
}

if (failed) {
  process.stderr.write(`${failed} dsp vectors differ\n`);
  process.exit(1);
}
process.stdout.write("dsp vectors match\n");
