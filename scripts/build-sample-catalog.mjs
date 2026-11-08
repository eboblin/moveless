// Turns Strudel's drum map and gm.mjs into the name catalog the UI and the packer share.
import { readFileSync, writeFileSync } from "node:fs";

const drums = JSON.parse(readFileSync("assets/samples/tidal-drum-machines.json", "utf8"));
const gmSource = readFileSync("assets/samples/gm.mjs", "utf8");

const TR = /Roland(TR|R8|DDR30|Compurhythm)/;
const LINN = /^(Linn|AkaiLinn|OberheimDMX|SequentialCircuitsDrumtracks)/;
const BOX = /^(BossDR|Korg(Minipops|DDM|KPR|KR55)|Alesis|YamahaR[YX]|Emu(SP|Drumulator)|Akai(XR|MPC)|MPC1000|RhythmAce|Sakata|Xdrum|Univox|MFB|Soundmasters|CasioRZ|AJK|Simmons)/;
const ANALOG = /^(Roland(SH09|System100|MC)|Visco|Moog|Doepfer|Serge|EmuModular)/;
const RM50 = /^YamahaRM50/;

const KICK_ORDER = ["RM50", "ANALOG", "BOX", "TR", "DIGITAL", "LINN"];
const SNARE_ORDER = ["BOX", "RM50", "TR", "ANALOG", "DIGITAL", "LINN", "CLAP", "RIM"];
const HAT_ORDER = ["CLOSED", "OPEN", "CRASH", "RIDE"];
const PERC_ORDER = ["HIGH", "MID", "LOW", "FX", "HAND", "BELL", "SHAKE", "WOOD", "TAMB", "CLICK", "SCRAPE", "WHISTLE"];

const SHORT = {
  YamahaRM50: "RM50",
  RolandTR808: "808",
  RolandTR909: "909",
  RolandTR707: "707",
  RolandTR626: "626",
  RolandTR606: "606",
  RolandTR505: "505",
  RolandR8: "R8",
  RolandDDR30: "DDR30",
  RolandCompurhythm1000: "CR1000",
  RolandCompurhythm78: "CR78",
  RolandCompurhythm8000: "CR8000",
  RolandSH09: "SH09",
  RolandMC303: "MC303",
  RolandMC202: "MC202",
  RolandSystem100: "SYS100",
  RolandJD990: "JD990",
  RolandD70: "D70",
  RolandD110: "D110",
  RolandS50: "S50",
  RolandMT32: "MT32",
  LinnLM1: "LM1",
  LinnLM2: "LM2",
  LinnDrum: "LINN",
  Linn9000: "L9000",
  AkaiLinn: "AKAI",
  OberheimDMX: "DMX",
  SequentialCircuitsDrumtracks: "DRUMTRAK",
  SequentialCircuitsTom: "SCTOM",
  EmuSP12: "SP12",
  EmuDrumulator: "DRUMUL",
  EmuModular: "MODULAR",
  AlesisSR16: "SR16",
  AlesisHR16: "HR16",
  YamahaRY30: "RY30",
  YamahaRX5: "RX5",
  YamahaRX21: "RX21",
  YamahaTG33: "TG33",
  SimmonsSDS5: "SDS5",
  SimmonsSDS400: "SDS400",
  AkaiXR10: "XR10",
  AkaiMPC60: "MPC60",
  MPC1000: "MPC1000",
  KorgMinipops: "MINIPOP",
  KorgDDM110: "DDM110",
  KorgKPR77: "KPR77",
  KorgKR55: "KR55",
  KorgT3: "T3",
  KorgPoly800: "POLY800",
  KorgM1: "M1",
  KorgKRZ: "KRZ",
  BossDR550: "DR550",
  BossDR55: "DR55",
  BossDR110: "DR110",
  BossDR220: "DR220",
  ViscoSpaceDrum: "VISCO",
  MoogConcertMateMG1: "MOOG",
  DoepferMS404: "MS404",
  SergeModular: "SERGE",
  RhodesPolaris: "POLARIS",
  CasioRZ1: "RZ1",
  CasioSK1: "SK1",
  CasioVL1: "VL1",
  RhythmAce: "ACE",
  SakataDPM48: "DPM48",
  XdrumLM8953: "XDRUM",
  UnivoxMicroRhythmer12: "UNIVOX",
  MFB512: "MFB",
  SoundmastersR88: "R88",
  AJKPercusyn: "AJK",
};

function machineOf(key) {
  const cut = key.lastIndexOf("_");
  return cut > 0 ? key.slice(0, cut) : key;
}

function suffixOf(key) {
  const cut = key.lastIndexOf("_");
  return cut > 0 ? key.slice(cut + 1) : "";
}

function machineShort(machine) {
  return SHORT[machine] ?? machine.slice(0, 8).toUpperCase();
}

function voiceOf(machine) {
  if (TR.test(machine)) return "TR";
  if (LINN.test(machine)) return "LINN";
  if (RM50.test(machine)) return "RM50";
  if (BOX.test(machine)) return "BOX";
  if (ANALOG.test(machine)) return "ANALOG";
  return "DIGITAL";
}

function baseName(file) {
  return file.split("/").pop().replace(/\.wav$/i, "");
}

function has(name, ...words) {
  const n = name.toLowerCase();
  return words.some((word) => n.includes(word));
}

function tomHeight(suffix, name) {
  const n = name.toLowerCase();
  if (suffix === "ht" || /\bht\b/.test(n) || /tom h|hitom|synth tom h/.test(n)) return "HIGH";
  if (suffix === "mt" || /\bmt\b/.test(n) || /tom m|midtom|acmid/.test(n)) return "MID";
  if (suffix === "lt" || /\blt\b/.test(n) || /tom l|lotom/.test(n)) return "LOW";
  if (has(name, "tom") || suffix === "ht" || suffix === "mt" || suffix === "lt") return null;
  return undefined;
}

/** Null drops the file. Undefined means this rule does not claim it. */
function placeDrum(machine, suffix, file) {
  const name = baseName(file);
  const voice = voiceOf(machine);
  const kit = machineShort(machine);
  const kickName = suffix === "bd" || has(name, "bassdrum", "square kick") || /\bbd\b/.test(name.toLowerCase()) || /kck|kick/.test(name.toLowerCase());
  if (kickName && !(has(name, "snare") && !has(name, "kick"))) {
    return { lane: "kick", category: voice, instrument: kit, name: kit };
  }
  const snareName = (suffix === "sd" || /\bsd\b/.test(name.toLowerCase()) || has(name, "snare", "snarderum", "naredrum")) && !(has(name, "noise") && !has(name, "snare"));
  if (snareName) return { lane: "snare", category: voice, instrument: kit, name: kit };
  if (suffix === "cp" || has(name, "clap")) return { lane: "snare", category: "CLAP", instrument: "CLAP", name: "CLAP" };
  if (has(name, "snap", "fingersanp", "fingersn")) return { lane: "snare", category: "CLAP", instrument: "SNAP", name: "SNAP" };
  if (suffix === "rim" || has(name, "rimshot", "rim shot", "sidestick", "rimsd")) {
    return { lane: "snare", category: "RIM", instrument: "RIM", name: kit };
  }
  if (suffix === "hh" || suffix === "oh" || has(name, "hat", "hihat", "chh", "ohh")) {
    const open = (has(name, "open") || has(name, "ohh") || suffix === "oh") && !has(name, "closed");
    const category = open ? "OPEN" : "CLOSED";
    return { lane: "hat", category, instrument: category, name: kit };
  }
  if (suffix === "cr" || has(name, "crash", "china")) return { lane: "hat", category: "CRASH", instrument: "CRASH", name: kit };
  if (suffix === "rd" || has(name, "ride")) return { lane: "hat", category: "RIDE", instrument: "RIDE", name: kit };
  if (has(name, "cymbal")) return { lane: "hat", category: "CRASH", instrument: "CRASH", name: kit };
  const tom = tomHeight(suffix, name);
  if (tom === null) return null;
  if (tom) return { lane: "perc", category: tom, instrument: tom, name: kit };
  if (has(name, "cowbell", "cowbel") || suffix === "cb") return { lane: "perc", category: "BELL", instrument: "COWBELL", name: "COWBELL" };
  if (has(name, "agogo")) return { lane: "perc", category: "BELL", instrument: "AGOGO", name: "AGOGO" };
  if (has(name, "triangle", "tria", "opentria", "mutetria")) return { lane: "perc", category: "BELL", instrument: "TRIANGLE", name: "TRIANGLE" };
  if (has(name, "bell", "chime")) return { lane: "perc", category: "BELL", instrument: "BELL", name: "BELL" };
  if (suffix === "tb" || has(name, "tamb")) return { lane: "perc", category: "TAMB", instrument: "TAMB", name: kit };
  if (has(name, "cabasa")) return { lane: "perc", category: "SHAKE", instrument: "CABASA", name: "CABASA" };
  if (has(name, "maraca")) return { lane: "perc", category: "SHAKE", instrument: "MARACAS", name: "MARACAS" };
  if (suffix === "sh" || has(name, "shaker", "shuffle")) return { lane: "perc", category: "SHAKE", instrument: "SHAKER", name: "SHAKER" };
  if (has(name, "bongo")) return { lane: "perc", category: "HAND", instrument: "BONGO", name: "BONGO" };
  if (has(name, "timb")) return { lane: "perc", category: "HAND", instrument: "TIMBALE", name: "TIMBALE" };
  if (has(name, "cuica", "cuic")) return { lane: "perc", category: "HAND", instrument: "CUICA", name: "CUICA" };
  if (has(name, "surd")) return { lane: "perc", category: "HAND", instrument: "SURDO", name: "SURDO" };
  if (has(name, "pand")) return { lane: "perc", category: "HAND", instrument: "PANDEIRO", name: "PANDEIRO" };
  if (has(name, "conga", "congo") || /\b(hc|mc|lc)\b/.test(name.toLowerCase())) {
    return { lane: "perc", category: "HAND", instrument: "CONGA", name: "CONGA" };
  }
  if (has(name, "clave")) return { lane: "perc", category: "WOOD", instrument: "CLAVE", name: "CLAVE" };
  if (has(name, "wood", "block", "wblk")) return { lane: "perc", category: "WOOD", instrument: "WOODBLOCK", name: "WOODBLOCK" };
  if (has(name, "guiro", "guirro", "guir")) return { lane: "perc", category: "SCRAPE", instrument: "GUIRO", name: "GUIRO" };
  if (has(name, "quijada", "qijada", "quid", "vibra")) return { lane: "perc", category: "SCRAPE", instrument: "QUIJADA", name: "QUIJADA" };
  if (has(name, "whistle", "whstl", "whis")) return { lane: "perc", category: "WHISTLE", instrument: "WHISTLE", name: "WHISTLE" };
  if (has(name, "click", "metronome", "stick", "tock") || /\bhi ?q\b/.test(name.toLowerCase())) {
    return { lane: "perc", category: "CLICK", instrument: "CLICK", name: "CLICK" };
  }
  return { lane: "perc", category: "FX", instrument: "FX", name: "FX" };
}

function orderRank(order, category) {
  const at = order.indexOf(category);
  return at < 0 ? order.length : at;
}

function finish(rows, order) {
  const takes = new Map();
  const stamped = rows.map((row) => {
    const key = `${row.category}\0${row.instrument}`;
    const take = takes.get(key) ?? 0;
    takes.set(key, take + 1);
    return { ...row, take };
  });
  const seen = new Map();
  for (const row of stamped) {
    const key = `${row.category}\0${row.instrument}`;
    if (!seen.has(key)) seen.set(key, seen.size);
  }
  stamped.sort((a, b) => {
    const cat = orderRank(order, a.category) - orderRank(order, b.category);
    if (cat !== 0) return cat;
    const inst = (seen.get(`${a.category}\0${a.instrument}`) ?? 0) - (seen.get(`${b.category}\0${b.instrument}`) ?? 0);
    if (inst !== 0) return inst;
    return a.take - b.take;
  });
  return stamped;
}

const raw = { kick: [], snare: [], hat: [], perc: [] };
let dropped = 0;
for (const [key, files] of Object.entries(drums)) {
  if (key.startsWith("_") || !Array.isArray(files)) continue;
  const machine = machineOf(key);
  const suffix = suffixOf(key);
  for (const file of files) {
    if (typeof file !== "string") continue;
    const placed = placeDrum(machine, suffix, file);
    if (!placed) {
      dropped += 1;
      continue;
    }
    raw[placed.lane].push({ category: placed.category, instrument: placed.instrument, name: placed.name, file });
  }
}

const lanes = {
  kick: finish(raw.kick, KICK_ORDER),
  snare: finish(raw.snare, SNARE_ORDER),
  hat: finish(raw.hat, HAT_ORDER),
  perc: finish(raw.perc, PERC_ORDER),
};

const gm = [];
let key = null;
let family = null;
let take = 0;
let instrument = null;
for (const line of gmSource.split(/\n/)) {
  const named = line.match(/^\s*(gm_[a-z0-9_]+)\s*:/);
  if (named) {
    key = named[1];
    take = 0;
    instrument = key.replace(/^gm_/, "").replace(/_/g, " ").toUpperCase();
    continue;
  }
  const fam = line.match(/\/\/\s*[^:]+:\s*(.+?)\s*$/);
  if (fam && !line.includes("_sf2") && !/broken|\?/.test(line)) family = fam[1].trim().toUpperCase();
  if (!key || !family || line.trim().startsWith("//")) continue;
  const comment = line.indexOf("//");
  const code = comment >= 0 ? line.slice(0, comment) : line;
  for (const hit of code.matchAll(/'([0-9]{4}_[A-Za-z0-9_]+)'/g)) {
    gm.push({ category: family, instrument, name: instrument, take, file: hit[1] });
    take += 1;
  }
}

const base = typeof drums._base === "string" ? drums._base : "";
const body = `// Generated by scripts/build-sample-catalog.mjs. Do not edit.
export interface SampleName {
  category: string;
  instrument: string;
  name: string;
  take: number;
  file: string;
}

export const DRUM_BASE = ${JSON.stringify(base)};
export const GM_BASE = "https://felixroos.github.io/webaudiofontdata/sound/";

export const KICK_SAMPLES: SampleName[] = ${JSON.stringify(lanes.kick)};
export const SNARE_SAMPLES: SampleName[] = ${JSON.stringify(lanes.snare)};
export const HAT_SAMPLES: SampleName[] = ${JSON.stringify(lanes.hat)};
export const PERC_SAMPLES: SampleName[] = ${JSON.stringify(lanes.perc)};
export const GM_SAMPLES: SampleName[] = ${JSON.stringify(gm)};
`;

writeFileSync("src/core/sample-catalog.ts", body);

function report(label, list) {
  const cats = new Map();
  for (const item of list) {
    const row = cats.get(item.category) ?? new Map();
    row.set(item.instrument, (row.get(item.instrument) ?? 0) + 1);
    cats.set(item.category, row);
  }
  console.log(`\\n${label} ${list.length}`);
  for (const [cat, inst] of cats) {
    const n = [...inst.values()].reduce((sum, count) => sum + count, 0);
    console.log(`  ${cat} ${inst.size} inst ${n}`);
  }
}

report("kick", lanes.kick);
report("snare", lanes.snare);
report("hat", lanes.hat);
report("perc", lanes.perc);
report("gm", gm);
console.log(`dropped ${dropped}`);
