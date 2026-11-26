// ============================================================= //
// TextureKeys - interface wiring + Web Audio texture engine      //
// ============================================================= //
// Design notes:                                                  //
// - No pitch following, no note retriggering. Keys/MIDI/hold are //
//   gates that open one shared texture bed.                      //
// - Layers are paused at rest and loop while played or fading.    //
// - Releasing every gate waits `holdDuration`, then fades out.    //
// ============================================================= //

// --- Constants ------------------------------------------------ //

const MIN_DB = -60;
const MAX_DB = 0;
const DEFAULT_DB = [0, 0, 0, 0];
const DEFAULT_NAMES = ["Layer One", "Layer Two", "Layer Three", "Layer Four"];

// Global ADSR, in milliseconds except sustain (percent of peak).
const ADSR_STORAGE_KEY = "texturekeys.adsr.v1";
const ADSR_DEFAULTS = { attack: 500, decay: 1500, sustain: 80, release: 2000, curve: 0 };
const ADSR_SLIDER_KEYS = ["attack", "decay", "sustain", "release", "curve"];
const adsr = { ...ADSR_DEFAULTS };

const AUDIO_STORAGE_KEY = "texturekeys.audio.v1";
const audioSettings = { deviceId: "", outputMode: "stereo" };

const LAYER_STORAGE_KEY = "texturekeys.layers.v1";
const HOLD_STORAGE_KEY = "texturekeys.hold.v1";
const MIDI_STORAGE_KEY = "texturekeys.midi.v1";

const PLAYHEAD_FPS = 30;

// Layer trimming and loop crossfade.
const XFADE_DEFAULT_MS = 80;
const XFADE_MAX_MS = 500;
const XFADE_STEP = 10;
const XFADE_MAX_RATIO = 0.25;
const MIN_TRIM_GAP = 0.01;

// Per-layer low-pass filter. The slider is logarithmic for musical control.
const LPF_MIN_HZ = 20;
const LPF_MAX_HZ = 16000;
const LPF_DEFAULT_HZ = LPF_MAX_HZ;
const LPF_BYPASS_HZ = 20000;
const LPF_Q = 0.707;
const LPF_SLIDER_MAX = 1000;
const LPF_RAMP_SECONDS = 0.02;

const SESSION_FORMAT = "texturekeys-session";
const SESSION_VERSION = 1;

// Optional demo scene, loaded on demand from the FILE menu. These are the
// original long recordings, so loading it is intentionally explicit.
const DEMO_FILES = [
  { name: "Deep Wind", file: "DEEP WIND.wav", db: -6 },
  { name: "Cold Wind", file: "COLD WIND.wav", db: -12 },
  { name: "Ocean Waves", file: "OCEAN WAVES.wav", db: -8 },
  { name: "Gentle Rain", file: "GENTLE RAIN.wav", db: -10 },
  { name: "Birds", file: "BIRDS.wav", db: -16 }
];
const DEMO_ADSR = { attack: 2000, decay: 2000, sustain: 80, release: 3000, curve: 0 };

const MIN_LAYERS = 1;
const MAX_LAYERS = 8;

const KEY_GATES = new Set([
  "KeyA", "KeyS", "KeyD", "KeyF",
  "KeyG", "KeyH", "KeyJ", "KeyK",
  "Space"
]);

const DB_TICKS = [0, -3, -6, -12, -24, -36, -48, -60];

// Fades are exponential in amplitude (linear in dB), which tracks hearing.
// Zero cannot be reached exponentially, so the ends use a tiny inaudible floor.
const FADE_FLOOR = 0.001;
const CURVE_SAMPLES = 64;
const BUMP_STRENGTH = 0.18;

// Canvas colors mirror the CSS accent variables.
const ACCENT_COLOR = "#d99a5b";
const ACCENT_FILL = "rgba(217, 154, 91, 0.10)";
const ACCENT_WAVE = "#d99a5baa";
const HOLD_COLOR = "#e0ae72";
const HOLD_FILL = "rgba(224, 174, 114, 0.10)";

// --- State ---------------------------------------------------- //

let layers = [];
let nextLayerId = 1;
let activeEditLayer = null;

// Gate sources: keyboard codes, MIDI notes, the touch HOLD button.
const midiNotes = new Set();
const midiSustainInputs = new Set();

let holdDuration = 1500;
let holdTimer = null;
let silenceMonitorInterval = null;
let releaseTimer = null;
let countdownInterval = null;
let releaseEndsAt = 0;
let releaseAt = 0;

let isEngaged = false;
let droneOn = false;
let demoLoading = false;
let sessionLoading = false;
let pendingLoadGate = false;

let midiAccess = null;
let midiInitialized = false;
let midiPermissionDenied = false;
let midiSelectAll = true;
const midiSelectedIds = new Set();
let midiInputList = [];

let playheadFrame = null;
let lastPlayheadDraw = 0;

const audio = {
  ctx: null,
  master: null,
  compressor: null,
  splitter: null,
  merger: null,
  downmixGains: [],
  sinkId: ""
};

const el = {};

// --- Small helpers ------------------------------------------- //

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function dbToGain(db) {
  return db <= MIN_DB ? 0 : Math.pow(10, db / 20);
}

function formatDb(db) {
  if (db <= MIN_DB) return "−∞ dB";
  const number = Number.isInteger(db) ? String(db) : db.toFixed(1);
  return `${number} dB`;
}

function formatHold(ms) {
  if (ms === 0) return "0 ms";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1).replace(/\.0$/, "")}s`;
}

function sustainFactor() {
  return adsr.sustain / 100;
}

function normalizeLpfCutoff(value) {
  const hz = Number(value);
  return Number.isFinite(hz)
    ? clamp(Math.round(hz), LPF_MIN_HZ, LPF_MAX_HZ)
    : LPF_DEFAULT_HZ;
}

function lpfHzToSlider(hz) {
  const ratio = Math.log(normalizeLpfCutoff(hz) / LPF_MIN_HZ) / Math.log(LPF_MAX_HZ / LPF_MIN_HZ);
  return Math.round(clamp(ratio, 0, 1) * LPF_SLIDER_MAX);
}

function lpfSliderToHz(value) {
  const ratio = clamp(Number(value) / LPF_SLIDER_MAX, 0, 1);
  return Math.round(LPF_MIN_HZ * Math.pow(LPF_MAX_HZ / LPF_MIN_HZ, ratio));
}

function formatHz(hz) {
  const value = Math.round(hz);
  return value >= 1000
    ? `${(value / 1000).toFixed(value % 1000 === 0 ? 0 : 1)} kHz`
    : `${value} Hz`;
}

function minTrimGap(layer) {
  if (!layer.originalBuffer || !layer.originalBuffer.length) return MIN_TRIM_GAP;
  return Math.max(MIN_TRIM_GAP, 256 / layer.originalBuffer.length);
}

function loopTiming(layer) {
  if (!layer.originalBuffer) {
    return { trimSeconds: 0, fadeSeconds: 0, loopSeconds: 0 };
  }

  const trimSeconds = Math.max(0, (layer.trimEnd - layer.trimStart) * layer.originalBuffer.duration);
  const fadeSeconds = clamp(layer.crossfadeMs / 1000, 0, trimSeconds * XFADE_MAX_RATIO);
  return {
    trimSeconds,
    fadeSeconds,
    loopSeconds: Math.max(0, trimSeconds - fadeSeconds)
  };
}

function clampCrossfade(layer) {
  const rounded = Math.round(layer.crossfadeMs / XFADE_STEP) * XFADE_STEP;
  if (!layer.originalBuffer) {
    // Keep saved settings intact until a sample is available to validate them.
    layer.crossfadeMs = clamp(rounded, 0, XFADE_MAX_MS);
    return layer.crossfadeMs;
  }

  const maxMs = Math.floor((loopTiming(layer).trimSeconds * 1000 * XFADE_MAX_RATIO) / XFADE_STEP) * XFADE_STEP;
  layer.crossfadeMs = clamp(rounded, 0, Math.min(XFADE_MAX_MS, maxMs));
  return layer.crossfadeMs;
}

function loadAdsr() {
  try {
    const raw = localStorage.getItem(ADSR_STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    Object.keys(ADSR_DEFAULTS).forEach((key) => {
      const value = Number(saved[key]);
      if (!Number.isFinite(value)) return;
      const max = key === "sustain" || key === "curve" ? 100 : 10000;
      const min = key === "curve" ? -100 : 0;
      adsr[key] = clamp(value, min, max);
    });
  } catch (_) {
    // Ignore missing or malformed stored settings.
  }
}

function saveAdsr() {
  try {
    localStorage.setItem(ADSR_STORAGE_KEY, JSON.stringify(adsr));
  } catch (_) {
    // Storage may be unavailable (private mode, restricted context).
  }
}

function loadAudioSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(AUDIO_STORAGE_KEY) || "{}");
    if (saved.outputMode === "mono" || saved.outputMode === "stereo") {
      audioSettings.outputMode = saved.outputMode;
    }
    if (typeof saved.deviceId === "string") audioSettings.deviceId = saved.deviceId;
  } catch (_) {
    // Ignore missing or malformed stored settings.
  }
}

function saveAudioSettings() {
  try {
    localStorage.setItem(AUDIO_STORAGE_KEY, JSON.stringify(audioSettings));
  } catch (_) {
    // Storage may be unavailable (private mode, restricted context).
  }
}

function loadLayerSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(LAYER_STORAGE_KEY) || "[]");
    if (!Array.isArray(saved) || saved.length < MIN_LAYERS) return null;

    return saved.slice(0, MAX_LAYERS).map((item, index) => {
      const fallbackName = DEFAULT_NAMES[index] || `Layer ${index + 1}`;
      const fallbackDb = DEFAULT_DB[index] ?? 0;
      const rawDb = Number(item?.db);
      const db = Number.isFinite(rawDb)
        ? clamp(Math.round(rawDb * 2) / 2, MIN_DB, MAX_DB)
        : fallbackDb;
      const savedActive = typeof item?.isActive === "boolean" ? item.isActive : true;
      const rawStart = Number(item?.trimStart);
      const rawEnd = Number(item?.trimEnd);
      const start = Number.isFinite(rawStart) ? clamp(rawStart, 0, 1 - MIN_TRIM_GAP) : 0;
      const end = Number.isFinite(rawEnd)
        ? clamp(rawEnd, start + MIN_TRIM_GAP, 1)
        : 1;
      const rawFade = Number(item?.crossfadeMs);
      // Older sessions used `hpf`; read those settings as LPF so they survive.
      const savedLpf = item?.lpf || item?.hpf || {};
      return {
        name: typeof item?.name === "string" && item.name.trim() ? item.name : fallbackName,
        db,
        isActive: db <= MIN_DB ? false : savedActive,
        isSolo: typeof item?.isSolo === "boolean" ? item.isSolo : false,
        trimStart: start,
        trimEnd: end,
        crossfadeMs: Number.isFinite(rawFade)
          ? clamp(Math.round(rawFade / XFADE_STEP) * XFADE_STEP, 0, XFADE_MAX_MS)
          : XFADE_DEFAULT_MS,
        lpfEnabled: typeof savedLpf.enabled === "boolean" ? savedLpf.enabled : false,
        lpfCutoffHz: normalizeLpfCutoff(savedLpf.cutoffHz)
      };
    });
  } catch (_) {
    return null;
  }
}

function saveLayerSettings() {
  try {
    const settings = layers.map((layer) => ({
      name: layer.name,
      db: layer.db,
      isActive: layer.isActive,
      isSolo: layer.isSolo,
      trimStart: layer.trimStart,
      trimEnd: layer.trimEnd,
      crossfadeMs: layer.crossfadeMs,
      lpf: {
        enabled: layer.lpfEnabled,
        cutoffHz: layer.lpfCutoffHz
      }
    }));
    localStorage.setItem(LAYER_STORAGE_KEY, JSON.stringify(settings));
  } catch (_) {
    // Storage may be unavailable (private mode, restricted context).
  }
}

function loadHoldDuration() {
  try {
    const saved = JSON.parse(localStorage.getItem(HOLD_STORAGE_KEY) || "{}");
    const ms = Number(saved.holdDuration ?? saved);
    return Number.isFinite(ms) ? clamp(Math.round(ms), 0, 5000) : 1500;
  } catch (_) {
    return 1500;
  }
}

function saveHoldDuration() {
  try {
    localStorage.setItem(HOLD_STORAGE_KEY, JSON.stringify({ holdDuration }));
  } catch (_) {
    // Storage may be unavailable (private mode, restricted context).
  }
}

function formatAdsrValue(key, value) {
  if (key === "sustain") return `${value}%`;
  if (key === "curve") return `${value > 0 ? "+" : ""}${value}%`;
  return `${value} ms`;
}

/** Small envelope preview. The hold segment is shown but not editable here. */
function drawAdsrGraph() {
  if (!el.adsrGraph) return;

  const canvas = el.adsrGraph;
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor((canvas.clientWidth || 246) * dpr));
  const height = Math.max(1, Math.floor((canvas.clientHeight || 78) * dpr));
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");
  context.clearRect(0, 0, width, height);

  const pad = 10 * dpr;
  const innerWidth = width - pad * 2;
  const innerHeight = height - pad * 2;

  const attack = Math.max(0, adsr.attack);
  const decay = Math.max(0, adsr.decay);
  const hold = Math.max(0, holdDuration);
  const release = Math.max(0, adsr.release);
  const total = Math.max(1, attack + decay + hold + release);

  const xAt = (time) => pad + (time / total) * innerWidth;
  const yAt = (level) => pad + (1 - level) * innerHeight;

  // Baseline.
  context.strokeStyle = "#333333";
  context.lineWidth = dpr;
  context.beginPath();
  context.moveTo(pad, yAt(0));
  context.lineTo(width - pad, yAt(0));
  context.stroke();

  // Hold region: visual only, controlled by the topbar Hold Time button.
  const holdStart = xAt(attack + decay);
  const holdEnd = xAt(attack + decay + hold);
  if (holdEnd > holdStart) {
    context.fillStyle = HOLD_FILL;
    context.fillRect(holdStart, pad, holdEnd - holdStart, innerHeight);

    context.setLineDash([3 * dpr, 3 * dpr]);
    context.strokeStyle = HOLD_COLOR;
    context.lineWidth = dpr;
    context.beginPath();
    context.moveTo(holdEnd, pad);
    context.lineTo(holdEnd, height - pad);
    context.stroke();
    context.setLineDash([]);

    if (holdEnd - holdStart > 34 * dpr) {
      context.fillStyle = HOLD_COLOR;
      context.font = `${9 * dpr}px -apple-system, sans-serif`;
      context.textAlign = "center";
      context.fillText("HOLD", (holdStart + holdEnd) / 2, pad + 10 * dpr);
    }
  }

  const sustain = sustainFactor();
  const envelopeSegments = [
    [0, attack, 0, 1],
    [attack, decay, 1, sustain],
    [attack + decay, hold, sustain, sustain],
    [attack + decay + hold, release, sustain, 0]
  ];

  const traceEnvelope = () => {
    context.beginPath();
    context.moveTo(xAt(0), yAt(0));
    envelopeSegments.forEach(([start, duration, fromLevel, toLevel]) => {
      const startX = xAt(start);
      const endX = xAt(start + duration);
      for (let i = 1; i <= CURVE_SAMPLES; i++) {
        const t = i / CURVE_SAMPLES;
        const level = fadeValue(t, fromLevel, toLevel);
        context.lineTo(startX + (endX - startX) * t, yAt(level));
      }
    });
  };

  traceEnvelope();
  context.lineTo(xAt(total), yAt(0));
  context.closePath();
  context.fillStyle = ACCENT_FILL;
  context.fill();

  traceEnvelope();
  context.strokeStyle = ACCENT_COLOR;
  context.lineWidth = 2 * dpr;
  context.lineJoin = "round";
  context.stroke();

  const nodes = [
    [0, 0],
    [attack, 1],
    [attack + decay, sustain],
    [attack + decay + hold, sustain],
    [total, 0]
  ];
  context.fillStyle = ACCENT_COLOR;
  nodes.forEach(([time, level]) => {
    context.beginPath();
    context.arc(xAt(time), yAt(level), 2 * dpr, 0, Math.PI * 2);
    context.fill();
  });

  const segments = [
    ["A", 0, attack],
    ["D", attack, decay],
    ["H", attack + decay, hold],
    ["R", attack + decay + hold, release]
  ];
  context.fillStyle = "#777777";
  context.font = `${9 * dpr}px -apple-system, sans-serif`;
  context.textAlign = "center";
  segments.forEach(([label, start, duration]) => {
    const segmentWidth = xAt(start + duration) - xAt(start);
    if (segmentWidth > 12 * dpr) {
      context.fillText(label, xAt(start) + segmentWidth / 2, height - 2 * dpr);
    }
  });
}

function setEngineStatus(state) {
  const text = {
    active: "ACTIVE",
    holding: "HOLDING",
    releasing: "RELEASING",
    "no-audio": "NO AUDIO",
    loading: "LOADING",
    ready: "READY"
  }[state] || "READY";

  el.engineStatus.textContent = text;
  el.statusLight.classList.toggle("active", state === "active");
  el.statusLight.classList.toggle("fading", state === "holding" || state === "releasing");
}

function hasLiveInput() {
  return midiNotes.size > 0 || midiSustainInputs.size > 0;
}

function hasEngagementInput() {
  return droneOn || hasLiveInput();
}

// --- Audio graph --------------------------------------------- //

function ensureAudio() {
  if (!audio.ctx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      setEngineStatus("no-audio");
      return false;
    }

    audio.ctx = new AudioContextClass();

    audio.master = audio.ctx.createGain();
    audio.master.gain.value = 0.9;

    audio.compressor = audio.ctx.createDynamicsCompressor();
    audio.compressor.threshold.value = -12;
    audio.compressor.knee.value = 18;
    audio.compressor.ratio.value = 4;
    audio.compressor.attack.value = 0.01;
    audio.compressor.release.value = 0.25;

    audio.master.connect(audio.compressor);
    applyOutputRouting();
    if (audioSettings.deviceId) setAudioSink(audioSettings.deviceId);

    layers.forEach(ensureLayerGain);
  }

  if (audio.ctx.state === "suspended") {
    audio.ctx.resume().catch(() => {});
  }

  return true;
}

function sinkIdSupported() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  return !!AudioContextClass && typeof AudioContextClass.prototype.setSinkId === "function";
}

function disconnectOutputNodes() {
  if (!audio.compressor) return;
  try {
    audio.compressor.disconnect();
  } catch (_) {
    // Already disconnected.
  }

  [audio.splitter, audio.merger, ...audio.downmixGains].forEach((node) => {
    if (!node) return;
    try {
      node.disconnect();
    } catch (_) {
      // Already disconnected.
    }
  });

  audio.splitter = null;
  audio.merger = null;
  audio.downmixGains = [];
}

function applyOutputRouting() {
  if (!audio.ctx || !audio.compressor) return;
  disconnectOutputNodes();

  if (audioSettings.outputMode !== "mono") {
    audio.compressor.connect(audio.ctx.destination);
    return;
  }

  // Downmix both channels equally into left and right so mono works everywhere.
  audio.splitter = audio.ctx.createChannelSplitter(2);
  audio.merger = audio.ctx.createChannelMerger(2);
  audio.downmixGains = [audio.ctx.createGain(), audio.ctx.createGain()];
  audio.downmixGains.forEach((gain) => {
    gain.gain.value = 0.5;
  });

  audio.compressor.connect(audio.splitter);
  audio.splitter.connect(audio.downmixGains[0], 0);
  audio.splitter.connect(audio.downmixGains[1], 1);

  audio.downmixGains.forEach((gain) => {
    gain.connect(audio.merger, 0, 0);
    gain.connect(audio.merger, 0, 1);
  });
  audio.merger.connect(audio.ctx.destination);
}

async function setAudioSink(deviceId) {
  if (!audio.ctx || !sinkIdSupported()) return false;
  try {
    await audio.ctx.setSinkId(deviceId || "");
    audio.sinkId = audio.ctx.sinkId || deviceId || "";
    return true;
  } catch (error) {
    console.warn("TextureKeys: could not select audio output device", error);
    return false;
  }
}

async function selectOutputDevice(deviceId) {
  audioSettings.deviceId = deviceId || "";
  saveAudioSettings();
  ensureAudio();
  const applied = await setAudioSink(audioSettings.deviceId);
  if (!applied && audioSettings.deviceId) {
    audioSettings.deviceId = "";
    saveAudioSettings();
  }
  updateOutputUI();
}

function setOutputMode(mode) {
  audioSettings.outputMode = mode === "mono" ? "mono" : "stereo";
  saveAudioSettings();
  if (audio.ctx) applyOutputRouting();
  updateOutputUI();
}

function refreshOutputDevices() {
  if (!el.outputDeviceSelect) return;

  const select = el.outputDeviceSelect;
  select.innerHTML = "";
  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = "System default";
  select.appendChild(defaultOption);

  const canEnumerate = !!(navigator.mediaDevices && navigator.mediaDevices.enumerateDevices);
  const canSelectSink = sinkIdSupported();
  const canChooseDevice = canEnumerate && canSelectSink;
  el.outputSupportNote.hidden = canChooseDevice;
  el.outputSupportNote.textContent = !canSelectSink
    ? "This browser uses the system output only."
    : "Device list is unavailable in this browser context.";

  if (!canEnumerate || !canSelectSink) {
    select.disabled = true;
    if (audioSettings.deviceId) {
      audioSettings.deviceId = "";
      saveAudioSettings();
    }
    updateOutputUI();
    return;
  }

  navigator.mediaDevices.enumerateDevices()
    .then((devices) => {
      const outputs = devices.filter((device) => device.kind === "audiooutput");
      outputs.forEach((device, index) => {
        const option = document.createElement("option");
        option.value = device.deviceId;
        option.textContent = device.label || `Output ${index + 1}`;
        select.appendChild(option);
      });

      select.disabled = false;
      if (!outputs.some((device) => device.deviceId === audioSettings.deviceId)) {
        audioSettings.deviceId = "";
        saveAudioSettings();
      }
      select.value = audioSettings.deviceId;
      updateOutputUI();
    })
    .catch(() => {
      select.disabled = true;
      audioSettings.deviceId = "";
      el.outputSupportNote.hidden = false;
      el.outputSupportNote.textContent = "Device list is unavailable in this browser context.";
      updateOutputUI();
    });
}

function updateOutputUI() {
  if (!el.outputModeInputs?.length || !el.outputDeviceSelect) return;

  el.outputModeInputs.forEach((input) => {
    input.checked = input.value === audioSettings.outputMode;
  });
  el.outputSummary.textContent = audioSettings.outputMode.toUpperCase();

  const options = Array.from(el.outputDeviceSelect.options);
  const selected = options.find((option) => option.value === audioSettings.deviceId);
  if (selected) {
    el.outputDeviceSelect.value = audioSettings.deviceId;
  } else if (audioSettings.deviceId) {
    audioSettings.deviceId = "";
    saveAudioSettings();
  }

  const label = selected ? selected.textContent : "System default";
  el.outputSettingsButton.title = `Output: ${label} (${audioSettings.outputMode})`;
}

function setParamImmediate(param, value) {
  if (!param) return;
  const now = audio.ctx.currentTime;
  // cancelAndHoldAtTime can keep an in-flight setValueCurveAtTime event, which
  // then overlaps the next curve and throws. Clear the whole timeline instead.
  param.cancelScheduledValues(0);
  param.setValueAtTime(value, now);
}

function holdCurrentParam(param, now) {
  const current = param.value;
  // Read the computed level first, then remove every scheduled event so no
  // curve from an earlier gate can overlap the one we are about to schedule.
  param.cancelScheduledValues(0);
  param.setValueAtTime(current, now);
  return current;
}

function fadeExpValue(t, from, to) {
  const x = clamp(t, 0, 1);
  const lead = 0.02;
  let value;

  if (from <= 0 && to <= 0) {
    value = 0;
  } else if (from <= 0) {
    // Quick, inaudible rise out of true zero, then a constant-dB swell.
    if (x < lead) {
      value = FADE_FLOOR * (x / lead);
    } else {
      const position = (x - lead) / (1 - lead);
      value = FADE_FLOOR * Math.pow(to / FADE_FLOOR, position);
    }
  } else if (to <= 0) {
    // Constant-dB fade to the floor, then a final inaudible step to true zero.
    const end = 1 - lead;
    if (x >= end) {
      value = FADE_FLOOR * (1 - (x - end) / lead);
    } else {
      const position = x / end;
      value = from * Math.pow(FADE_FLOOR / from, position);
    }
  } else {
    value = from * Math.pow(to / from, x);
  }

  return clamp(value, 0, 1);
}

function fadeValue(t, from, to) {
  const x = clamp(t, 0, 1);
  const curve = clamp(adsr.curve, -100, 100) / 100;
  const span = to - from;
  const linear = from + span * x;

  if (curve >= 0) {
    const exponential = fadeExpValue(x, from, to);
    return clamp(linear + (exponential - linear) * curve, 0, 1);
  }

  // Negative curve swells ahead of the straight line, then eases back to the
  // target. The sine term adds a small crest without disturbing the endpoints.
  const strength = -curve;
  const swell = span >= 0
    ? 1 - Math.pow(1 - x, 1 + 2 * strength)
    : Math.pow(x, 1 + 2 * strength);
  const bump = (span >= 0 ? 1 : -1) * BUMP_STRENGTH * strength * Math.sin(Math.PI * x);
  return clamp(from + span * (swell + bump), 0, 1.25);
}

function fadeCurve(from, to) {
  const values = new Float32Array(CURVE_SAMPLES);
  for (let i = 0; i < values.length; i++) {
    values[i] = fadeValue(i / (values.length - 1), from, to);
  }
  return values;
}

function scheduleCurve(param, from, to, startTime, seconds) {
  if (!param) return;

  const duration = Math.max(0.005, seconds);

  if (typeof param.setValueCurveAtTime !== "function") {
    if (adsr.curve <= 0) {
      param.setValueAtTime(from, startTime);
      param.linearRampToValueAtTime(to, startTime + duration);
    } else if (to > 0) {
      const start = from > 0 ? from : FADE_FLOOR;
      param.setValueAtTime(start, startTime);
      param.exponentialRampToValueAtTime(to, startTime + duration);
    } else if (from > 0) {
      param.exponentialRampToValueAtTime(FADE_FLOOR, startTime + duration);
      param.setValueAtTime(0, startTime + duration + 0.01);
    } else {
      param.setValueAtTime(0, startTime);
    }
    return;
  }

  param.setValueCurveAtTime(fadeCurve(from, to), startTime, duration);
}

function rampParam(param, value, seconds) {
  if (!param) return;

  const now = audio.ctx.currentTime;
  const current = holdCurrentParam(param, now);
  scheduleCurve(param, current, value, now, seconds);
}

function applyLpfSettings(layer, smooth = false) {
  if (!layer.filter || !audio.ctx) return;

  const bypassHz = Math.min(LPF_BYPASS_HZ, audio.ctx.sampleRate / 2);
  const target = layer.lpfEnabled ? normalizeLpfCutoff(layer.lpfCutoffHz) : bypassHz;
  const now = audio.ctx.currentTime;
  const frequency = layer.filter.frequency;

  // Hold any in-flight glide before scheduling the next value, so a new clip
  // opens the filter immediately instead of inheriting the previous target.
  if (typeof frequency.cancelAndHoldAtTime === "function") {
    frequency.cancelAndHoldAtTime(now);
  } else {
    frequency.cancelScheduledValues(now);
  }

  if (smooth) {
    frequency.setTargetAtTime(target, now, LPF_RAMP_SECONDS);
  } else {
    frequency.setValueAtTime(target, now);
  }
  layer.filter.Q.setValueAtTime(LPF_Q, now);
}

function ensureLayerGain(layer) {
  if (layer.envelope || !audio.ctx) return;

  // Volume/activate/solo live on their own gain node, so changing them never
  // interrupts the ADSR automation running on the envelope gain node.
  const level = audio.ctx.createGain();
  level.gain.value = dbToGain(layer.db) * routeFactor(layer);
  level.connect(audio.master);
  layer.level = level;

  const envelope = audio.ctx.createGain();
  envelope.gain.value = 0;
  envelope.connect(level);
  layer.envelope = envelope;

  // Clip-level low-pass filter. When disabled it sits effectively open at 20 kHz.
  const filter = audio.ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.Q.value = LPF_Q;
  filter.connect(envelope);
  layer.filter = filter;
  applyLpfSettings(layer);

  if (layer.buffer) startSource(layer);
}

function startSource(layer) {
  if (layer.source || !layer.buffer || !audio.ctx) return;

  const source = audio.ctx.createBufferSource();
  source.buffer = layer.buffer;
  source.loop = true;
  source.connect(layer.filter || layer.envelope);

  const startedAt = audio.ctx.currentTime;
  const duration = layer.buffer.duration;
  const offset = duration
    ? ((layer.startOffset % duration) + duration) % duration
    : 0;
  source.start(startedAt, offset);

  layer.source = source;
  layer.startedAt = startedAt;
  source.onended = () => {
    if (layer.source === source) layer.source = null;
  };

  requestPlayheadUpdate();
}

function stopSource(layer) {
  if (!layer.source) return;

  // Remember where to resume so pausing never restarts the sample.
  if (layer.buffer && layer.buffer.duration) {
    const duration = layer.buffer.duration;
    const elapsed = audio.ctx.currentTime - layer.startedAt + layer.startOffset;
    layer.startOffset = ((elapsed % duration) + duration) % duration;
  }

  try {
    layer.source.onended = null;
    layer.source.stop();
  } catch (_) {
    // Already stopped.
  }
  layer.source.disconnect();
  layer.source = null;
  if (layer.els.playhead) layer.els.playhead.style.opacity = "0";
}

function pauseAllSources() {
  layers.forEach((layer) => stopSource(layer));
}

function requestPlayheadUpdate() {
  if (playheadFrame !== null) return;
  lastPlayheadDraw = 0;
  playheadFrame = requestAnimationFrame(updatePlayheads);
}

function updatePlayheads(timestamp) {
  playheadFrame = null;

  const now = typeof timestamp === "number" ? timestamp : performance.now();
  const shouldDraw = now - lastPlayheadDraw >= 1000 / PLAYHEAD_FPS;
  let anyPlaying = false;

  layers.forEach((layer) => {
    const playhead = layer.els.playhead;
    if (!playhead) return;

    if (!audio.ctx || !layer.source || !layer.buffer || !layer.buffer.duration || !layer.originalBuffer) {
      playhead.style.opacity = "0";
      return;
    }

    anyPlaying = true;
    if (!shouldDraw) return;

    const elapsed = audio.ctx.currentTime - layer.startedAt + layer.startOffset;
    const duration = layer.buffer.duration;
    const loopPosition = (((elapsed % duration) + duration) % duration) / duration;
    const timing = loopTiming(layer);
    const sourceSeconds = layer.trimStart * layer.originalBuffer.duration + timing.fadeSeconds
      + loopPosition * timing.loopSeconds;
    const ratio = clamp(sourceSeconds / layer.originalBuffer.duration, 0, 1);
    const width = layer.els.loader.clientWidth || 1;
    const x = Math.max(0, Math.min(width - 2, ratio * width));

    playhead.style.opacity = routeFactor(layer) > 0 ? "0.9" : "0.3";
    playhead.style.transform = `translate3d(${x}px, 0, 0)`;
  });

  if (shouldDraw) lastPlayheadDraw = now;
  if (anyPlaying) playheadFrame = requestAnimationFrame(updatePlayheads);
}

function routeFactor(layer) {
  if (!layer.isActive) return 0;
  const anyoneSoloed = layers.some((item) => item.isSolo);
  return anyoneSoloed && !layer.isSolo ? 0 : 1;
}

function applyLayerGain(layer, seconds = 0.04) {
  if (!layer.level) return;
  rampParam(layer.level.gain, dbToGain(layer.db) * routeFactor(layer), seconds);
}

function applyAllLayerGains(seconds = 0.04) {
  layers.forEach((layer) => applyLayerGain(layer, seconds));
}

function engageLayer(layer, resumeFromTail, now, forceAttack = false) {
  ensureLayerGain(layer);
  if (!layer.envelope) return;

  // Resume from the saved position; gates never restart the sample.
  startSource(layer);

  const param = layer.envelope.gain;
  const sustain = sustainFactor();

  if (resumeFromTail && !forceAttack) {
    // Return to sustain without a new attack; the sample keeps playing.
    rampParam(param, sustain, 0.02);
    return;
  }

  const current = holdCurrentParam(param, now);
  let attackStart = now;
  let attackFrom = current;

  if (forceAttack) {
    // DRONE always opens through ADSR, even if a previous gate's hold or
    // release phase left the envelope partway up. Dip briefly, then attack.
    if (current > 0) {
      scheduleCurve(param, current, 0, now, 0.01);
      attackStart = now + 0.01;
    }
    param.setValueAtTime(0, attackStart);
    attackFrom = 0;
  }

  const attackEnd = attackStart + Math.max(0.005, adsr.attack / 1000);
  const decayEnd = attackEnd + Math.max(0.005, adsr.decay / 1000);

  scheduleCurve(param, attackFrom, 1, attackStart, attackEnd - attackStart);
  scheduleCurve(param, 1, sustain, attackEnd, decayEnd - attackEnd);
}

function engage(resumeFromTail = false, forceAttack = false) {
  if (!ensureAudio()) return;

  // A new gate can arrive while a release countdown is still displayed.
  setEngineStatus("active");
  if (isEngaged && !forceAttack) return;

  isEngaged = true;

  const now = audio.ctx.currentTime;
  layers.forEach((layer) => engageLayer(layer, resumeFromTail, now, forceAttack));
}

function releaseAudio() {
  if (!audio.ctx) return;

  layers.forEach((layer) => {
    if (!layer.envelope) return;
    rampParam(layer.envelope.gain, 0, adsr.release / 1000);
  });
}

// --- Hold / release state machine ---------------------------- //

function cancelAllTimers() {
  if (holdTimer !== null) {
    clearTimeout(holdTimer);
    holdTimer = null;
  }
  if (silenceMonitorInterval !== null) {
    clearInterval(silenceMonitorInterval);
    silenceMonitorInterval = null;
  }
  if (releaseTimer !== null) {
    clearTimeout(releaseTimer);
    releaseTimer = null;
  }
  if (countdownInterval !== null) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
  releaseEndsAt = 0;
}

function updateReleaseCountdown(remainingMs) {
  el.engineStatus.textContent = `HOLDING ${(Math.max(0, remainingMs) / 1000).toFixed(1)}s`;
}

function startReleaseDisplay() {
  setEngineStatus("holding");
  updateReleaseCountdown(releaseAt - performance.now());

  if (countdownInterval !== null) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
  countdownInterval = setInterval(() => {
    updateReleaseCountdown(releaseAt - performance.now());
  }, 50);
}

function startReleaseCountdown() {
  cancelAllTimers();
  if (!isEngaged) return;

  isEngaged = false;
  const releaseMs = adsr.release;
  releaseEndsAt = performance.now() + releaseMs;
  releaseAt = 0;

  // Hold Time has elapsed; the remaining release tail has no numeric countdown.
  setEngineStatus("releasing");
  releaseAudio();

  releaseTimer = setTimeout(() => {
    releaseTimer = null;
    if (countdownInterval !== null) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }
    releaseAt = 0;
    releaseEndsAt = 0;
    if (!isEngaged) {
      pauseAllSources();
      setEngineStatus("ready");
    }
  }, releaseMs + 10);
}

function scheduleSilentRelease() {
  cancelAllTimers();

  // Count down exactly the configured Hold Time.
  releaseAt = performance.now() + holdDuration;
  startReleaseDisplay();

  holdTimer = setTimeout(() => {
    holdTimer = null;
    startReleaseCountdown();
  }, holdDuration);

  // Guard against a gate event being missed by the normal listeners.
  silenceMonitorInterval = setInterval(() => {
    if (hasEngagementInput()) activationChanged();
  }, 60);
}

function activationChanged() {
  updateHoldUI();

  // A gate tapped while a session is decoding still counts: replay it once
  // every sample is ready instead of letting only the first layer sound.
  if (sessionLoading) pendingLoadGate = true;

  if (hasEngagementInput()) {
    const resumeFromTail = releaseEndsAt > 0;
    cancelAllTimers();
    engage(resumeFromTail);
  } else if (isEngaged) {
    scheduleSilentRelease();
  }
}

function toggleDrone() {
  const turningOn = !droneOn;
  droneOn = turningOn;
  updateDroneUI();

  if (turningOn) {
    // A fresh DRONE press always opens through ADSR, even while another gate
    // is held or the previous sound is in its hold/release phase.
    cancelAllTimers();
    isEngaged = false;
    engage(false, true);
    return;
  }

  activationChanged();
}

function startGate(id) {
  if (midiNotes.has(id)) return;
  midiNotes.add(id);
  activationChanged();
}

function endGate(id) {
  if (!midiNotes.delete(id)) return;
  activationChanged();
}

function clearGates() {
  midiNotes.clear();
  midiSustainInputs.clear();
  updateHoldUI();
  activationChanged();
}

// --- UI state ------------------------------------------------ //

function updateHoldUI() {
  const held = midiNotes.has("hold");
  el.holdButton.classList.toggle("pressed", held);
  el.holdLight.classList.toggle("active", held);
}

function updateDroneUI() {
  el.droneButton.classList.toggle("selected", droneOn);
  el.droneButton.setAttribute("aria-pressed", String(droneOn));
  el.droneStatus.textContent = droneOn ? "ON" : "OFF";
}

function setHoldDuration(ms) {
  holdDuration = clamp(Math.round(ms), 0, 5000);
  el.holdTime.value = String(holdDuration);
  el.holdValue.textContent = formatHold(holdDuration);
  el.holdPopoverValue.textContent = `${holdDuration} ms`;

  if (holdTimer !== null) scheduleSilentRelease();
  drawAdsrGraph();
  saveHoldDuration();
}

function syncLayerChrome() {
  el.layerCount.textContent = `${layers.length} ${layers.length === 1 ? "LAYER" : "LAYERS"}`;
  el.layersGrid.style.setProperty("--layer-count", String(layers.length));
  el.removeLayer.disabled = layers.length <= MIN_LAYERS;
  el.addLayer.disabled = layers.length >= MAX_LAYERS;
  layers.forEach((layer) => {
    layer.els.clipEditButton.disabled = !layer.originalBuffer;
  });
}

function updateDbUI(layer) {
  const ratio = (layer.db - MIN_DB) / (MAX_DB - MIN_DB);
  layer.els.fill.style.height = `${clamp(ratio, 0, 1) * 100}%`;
  // The fill grows from the bottom, so the cap position is measured from the top.
  // No clamp here: 0 dB sits at the very top, −∞ at the very bottom.
  layer.els.cap.style.top = `${(1 - clamp(ratio, 0, 1)) * 100}%`;
  layer.els.readout.textContent = formatDb(layer.db);
  layer.els.track.setAttribute("aria-valuenow", String(layer.db));
  layer.els.track.setAttribute("aria-valuetext", formatDb(layer.db));
}

function setLayerActive(layer, active) {
  if (layer.isActive === active) return false;

  layer.isActive = active;
  layer.els.activateButton.classList.toggle("active", active);
  layer.els.activateButton.setAttribute("aria-pressed", String(active));
  layer.els.card.classList.toggle("inactive", !active);
  return true;
}

function setDb(layer, db) {
  const next = clamp(Math.round(db * 2) / 2, MIN_DB, MAX_DB);
  if (next === layer.db) return;

  layer.db = next;
  // -∞ dB mutes the layer completely, so reflect that in the activate control.
  setLayerActive(layer, next > MIN_DB);
  updateDbUI(layer);
  applyLayerGain(layer);
  saveLayerSettings();
}

function buildDbScale(scale) {
  scale.innerHTML = DB_TICKS.map((db) => {
    const ratio = (db - MIN_DB) / (MAX_DB - MIN_DB);
    const top = (1 - ratio) * 100;
    const className = db === 0 ? "top unity" : db === MIN_DB ? "bottom" : "";
    const label = db === MIN_DB ? "−∞" : String(db);
    return `<span class="db-tick ${className}" style="top:${top}%">${label}</span>`;
  }).join("");
}

// --- Layer construction -------------------------------------- //

function createLayer(
  index,
  name,
  db,
  isActive = true,
  isSolo = false,
  trimStart = 0,
  trimEnd = 1,
  crossfadeMs = XFADE_DEFAULT_MS,
  lpfEnabled = false,
  lpfCutoffHz = LPF_DEFAULT_HZ,
  deferAppend = false
) {
  const layerActive = db <= MIN_DB ? false : isActive;
  const id = nextLayerId++;
  const card = document.createElement("article");
  card.className = `layer-card${layerActive ? "" : " inactive"}`;
  card.dataset.layer = String(id);

  card.innerHTML = `
    <div class="layer-header">
      <div class="layer-heading">
        <div class="layer-heading-top">
          <span class="layer-number">0${index + 1}</span>
          <button class="layer-action activate-button${layerActive ? " active" : ""}" type="button"
            aria-pressed="${layerActive}" aria-label="Layer ${index + 1} active">ACTIVE</button>
        </div>
        <div class="layer-name-row">
          <input
            class="layer-name-input"
            type="text"
            value="${name}"
            aria-label="Layer ${index + 1} name"
            maxlength="30"
          />
          <button class="clip-edit-button" type="button" disabled
            aria-label="Edit clip for layer ${index + 1}">CLIP</button>
        </div>
      </div>
    </div>

    <div class="sample-row">
      <div class="sample-name">No sample loaded</div>
    </div>

    <button class="waveform-placeholder sample-loader" type="button"
      aria-label="Load audio sample">
      <span class="sample-add-button" aria-hidden="true">+</span>
      <span class="wave-trim wave-trim-before" aria-hidden="true"></span>
      <span class="wave-trim wave-trim-after" aria-hidden="true"></span>
      <span class="wave-fade wave-fade-start" aria-hidden="true"></span>
      <span class="wave-fade wave-fade-end" aria-hidden="true"></span>
      <span class="playhead" aria-hidden="true"></span>
    </button>
    <div class="sample-change-hint">click to add sample</div>

    <input class="sample-file-input" type="file" accept="audio/*" hidden />

    <div class="fader-section">
      <span class="fader-label">VOLUME</span>
      <div class="fader-unit">
        <div class="db-scale" aria-hidden="true"></div>
        <div
          class="fader-track"
          role="slider"
          tabindex="0"
          aria-label="${name} volume"
          aria-valuemin="${MIN_DB}"
          aria-valuemax="${MAX_DB}"
          aria-valuenow="${db}"
        >
          <div class="fader-fill"></div>
          <div class="fader-cap"></div>
        </div>
      </div>
      <div class="fader-readout" aria-hidden="true"></div>
    </div>

    <div class="layer-buttons">
      <button class="layer-action solo-button${isSolo ? " active" : ""}" type="button"
        aria-pressed="${isSolo}">SOLO</button>
    </div>
  `;

  const els = {
    card,
    nameInput: card.querySelector(".layer-name-input"),
    sampleName: card.querySelector(".sample-name"),
    clipEditButton: card.querySelector(".clip-edit-button"),
    loader: card.querySelector(".sample-loader"),
    sampleHint: card.querySelector(".sample-change-hint"),
    playhead: card.querySelector(".playhead"),
    fileInput: card.querySelector(".sample-file-input"),
    waveTrimBefore: card.querySelector(".wave-trim-before"),
    waveTrimAfter: card.querySelector(".wave-trim-after"),
    waveFadeStart: card.querySelector(".wave-fade-start"),
    waveFadeEnd: card.querySelector(".wave-fade-end"),
    scale: card.querySelector(".db-scale"),
    track: card.querySelector(".fader-track"),
    fill: card.querySelector(".fader-fill"),
    cap: card.querySelector(".fader-cap"),
    readout: card.querySelector(".fader-readout"),
    activateButton: card.querySelector(".activate-button"),
    soloButton: card.querySelector(".solo-button"),
    canvas: null
  };

  const layer = {
    id,
    index,
    name,
    db,
    isActive: layerActive,
    isSolo,
    originalBuffer: null,
    originalFile: null,
    sampleFileName: "",
    samplePeak: 0,
    normalizing: false,
    buffer: null,
    source: null,
    startedAt: 0,
    startOffset: 0,
    trimStart,
    trimEnd,
    crossfadeMs,
    lpfEnabled,
    lpfCutoffHz: normalizeLpfCutoff(lpfCutoffHz),
    envelope: null,
    level: null,
    filter: null,
    card,
    els
  };

  buildDbScale(els.scale);
  bindLayer(layer);
  clampCrossfade(layer);
  updateTrimUI(layer);
  ensureLayerGain(layer);
  // A layer created while the bed is engaged must join it instead of sitting
  // silently at zero until the next gate.
  if (isEngaged && layer.envelope && layer.envelope.gain.value === 0) {
    rampParam(layer.envelope.gain, sustainFactor(), 0.02);
  }
  updateDbUI(layer);

  if (!deferAppend) el.layersGrid.appendChild(card);
  return layer;
}

function addLayer() {
  if (layers.length >= MAX_LAYERS) return;
  const index = layers.length;
  layers.push(createLayer(index, `Layer ${index + 1}`, DEFAULT_DB[index] ?? 0));
  syncLayerChrome();
  saveLayerSettings();
}

function removeLastLayer() {
  if (layers.length <= MIN_LAYERS) return;

  const layer = layers.pop();
  if (activeEditLayer === layer) closeClipEditor();
  stopSource(layer);
  if (layer.filter) layer.filter.disconnect();
  if (layer.envelope) layer.envelope.disconnect();
  if (layer.level) layer.level.disconnect();
  layer.card.remove();
  syncLayerChrome();
  saveLayerSettings();
}

// --- Per-layer event bindings -------------------------------- //

function bindLayer(layer) {
  const { els } = layer;

  els.nameInput.addEventListener("input", () => {
    layer.name = els.nameInput.value || `Layer ${layer.id}`;
    els.track.setAttribute("aria-label", `${layer.name} volume`);
    saveLayerSettings();
  });

  els.loader.addEventListener("click", () => els.fileInput.click());

  els.fileInput.addEventListener("change", (event) => {
    const file = event.target.files && event.target.files[0];
    if (file) loadSample(layer, file);
    event.target.value = "";
  });

  els.loader.addEventListener("dragover", (event) => {
    event.preventDefault();
    els.loader.classList.add("drag-over");
  });

  els.loader.addEventListener("dragleave", () => {
    els.loader.classList.remove("drag-over");
  });

  els.loader.addEventListener("drop", (event) => {
    event.preventDefault();
    els.loader.classList.remove("drag-over");
    const file = event.dataTransfer && event.dataTransfer.files[0];
    if (file && file.type.startsWith("audio/")) loadSample(layer, file);
  });

  els.clipEditButton.addEventListener("click", () => {
    if (!layer.originalBuffer) return;
    openClipEditor(layer);
  });

  let grabOffset = 0;

  els.track.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    try {
      els.track.setPointerCapture(event.pointerId);
    } catch (_) {
      // Capture is an enhancement; dragging still works without it.
    }

    // Grabbing anywhere on the cap keeps it under the pointer instead of
    // jumping to the cap's center; track clicks still jump to that position.
    grabOffset = 0;
    if (event.target === els.cap) {
      const rect = els.cap.getBoundingClientRect();
      grabOffset = event.clientY - (rect.top + rect.height / 2);
    }
    setDbFromPointer(layer, event.clientY - grabOffset);
  });

  els.track.addEventListener("pointermove", (event) => {
    if (!els.track.hasPointerCapture(event.pointerId)) return;
    setDbFromPointer(layer, event.clientY - grabOffset);
  });

  els.track.addEventListener("pointerup", () => {
    grabOffset = 0;
  });

  els.track.addEventListener("pointercancel", () => {
    grabOffset = 0;
  });

  els.track.addEventListener("keydown", (event) => {
    let next = null;
    switch (event.key) {
      case "ArrowUp": next = layer.db + 1; break;
      case "ArrowDown": next = layer.db - 1; break;
      case "PageUp": next = layer.db + 6; break;
      case "PageDown": next = layer.db - 6; break;
      case "Home": next = MIN_DB; break;
      case "End": next = MAX_DB; break;
      default: return;
    }
    event.preventDefault();
    setDb(layer, next);
  });

  els.activateButton.addEventListener("click", () => {
    const nextActive = !layer.isActive;
    if (nextActive && layer.db <= MIN_DB) return;
    setLayerActive(layer, nextActive);
    applyLayerGain(layer);
    saveLayerSettings();
  });

  els.soloButton.addEventListener("click", () => {
    layer.isSolo = !layer.isSolo;
    els.soloButton.classList.toggle("active", layer.isSolo);
    els.soloButton.setAttribute("aria-pressed", String(layer.isSolo));
    applyAllLayerGains();
    saveLayerSettings();
  });
}

function setDbFromPointer(layer, clientY) {
  const rect = layer.els.track.getBoundingClientRect();
  if (!rect.height) return;

  const ratio = clamp(1 - (clientY - rect.top) / rect.height, 0, 1);
  setDb(layer, MIN_DB + ratio * (MAX_DB - MIN_DB));
}

// --- Loop trimming + crossfade ------------------------------- //

function trimDisplay(layer) {
  const gap = minTrimGap(layer);
  const start = clamp(layer.trimStart, 0, 1 - gap);
  const end = clamp(layer.trimEnd, start + gap, 1);
  layer.trimStart = start;
  layer.trimEnd = end;

  const timing = loopTiming(layer);
  const hasSample = !!layer.originalBuffer;
  return {
    startPct: start * 100,
    endPct: end * 100,
    fadePct: hasSample
      ? (timing.fadeSeconds / layer.originalBuffer.duration) * 100
      : 0,
    timing,
    hasSample
  };
}

function updateWaveformTrimVisual(layer) {
  const { els } = layer;
  if (!els.waveTrimBefore) return;

  const { startPct, endPct, fadePct } = trimDisplay(layer);
  els.waveTrimBefore.style.width = `${startPct}%`;
  els.waveTrimAfter.style.width = `${100 - endPct}%`;
  els.waveFadeStart.style.left = `${startPct}%`;
  els.waveFadeStart.style.width = `${fadePct}%`;
  els.waveFadeEnd.style.right = `${100 - endPct}%`;
  els.waveFadeEnd.style.width = `${fadePct}%`;
}

function syncClipEditor(layer) {
  if (!layer || !el.clipPopover || !el.clipTrimBar) return;

  const { startPct, endPct, fadePct, timing, hasSample } = trimDisplay(layer);
  el.clipLayerLabel.textContent = `LAYER ${String(layer.index + 1).padStart(2, "0")}`;
  el.clipSampleName.textContent = layer.sampleFileName || "No sample loaded";
  el.clipTrimBar.classList.toggle("empty", !hasSample);
  el.clipWaveform.classList.toggle("empty", !hasSample);

  el.clipWaveTrimBefore.style.width = `${startPct}%`;
  el.clipWaveTrimAfter.style.width = `${100 - endPct}%`;
  el.clipWaveFadeStart.style.left = `${startPct}%`;
  el.clipWaveFadeStart.style.width = `${fadePct}%`;
  el.clipWaveFadeEnd.style.right = `${100 - endPct}%`;
  el.clipWaveFadeEnd.style.width = `${fadePct}%`;

  el.clipTrimBefore.style.width = `${startPct}%`;
  el.clipTrimAfter.style.width = `${100 - endPct}%`;
  el.clipTrimSelection.style.left = `${startPct}%`;
  el.clipTrimSelection.style.right = `${100 - endPct}%`;
  el.clipFadeStart.style.left = `${startPct}%`;
  el.clipFadeStart.style.width = `${fadePct}%`;
  el.clipFadeEnd.style.right = `${100 - endPct}%`;
  el.clipFadeEnd.style.width = `${fadePct}%`;
  el.clipStartHandle.style.left = `${startPct}%`;
  el.clipEndHandle.style.left = `${endPct}%`;

  el.clipLoopLength.textContent = hasSample
    ? `LOOP ${formatHold(Math.round(timing.loopSeconds * 1000))}`
    : "LOOP —";
  el.clipXfadeValue.textContent = `${Math.round(timing.fadeSeconds * 1000)}ms`;
  const maxFadeMs = hasSample
    ? Math.min(XFADE_MAX_MS, Math.floor(timing.trimSeconds * 1000 * XFADE_MAX_RATIO))
    : XFADE_MAX_MS;
  el.clipXfadeSlider.max = String(maxFadeMs);
  el.clipXfadeSlider.value = String(layer.crossfadeMs);
  el.clipXfadeSlider.disabled = !hasSample;

  el.clipLpfToggle.textContent = layer.lpfEnabled ? "ON" : "OFF";
  el.clipLpfToggle.classList.toggle("active", layer.lpfEnabled);
  el.clipLpfToggle.setAttribute("aria-pressed", String(layer.lpfEnabled));
  el.clipLpfSlider.value = String(lpfHzToSlider(layer.lpfCutoffHz));
  el.clipLpfValue.textContent = layer.lpfEnabled
    ? formatHz(layer.lpfCutoffHz)
    : "OPEN";

  const peak = layer.samplePeak || samplePeak(layer.originalBuffer);
  el.clipPeakValue.textContent = hasSample ? formatPeakDb(peak) : "—";
  el.clipNormalize.disabled = !hasSample || peak <= 0 || peak >= 0.999 || !!layer.normalizing;
}

function updateTrimUI(layer) {
  updateWaveformTrimVisual(layer);
  if (activeEditLayer === layer) syncClipEditor(layer);
}

function closeClipEditor() {
  activeEditLayer = null;
  if (el.clipPopover) el.clipPopover.hidden = true;
}

function closeOtherPopovers(keep = null) {
  if (keep !== "clip") closeClipEditor();
  if (keep !== "hold" && el.holdPopover) el.holdPopover.hidden = true;
  if (keep !== "adsr" && el.adsrPopover) el.adsrPopover.hidden = true;
  if (keep !== "output" && el.outputPopover) el.outputPopover.hidden = true;
  if (keep !== "session" && el.sessionPopover) el.sessionPopover.hidden = true;
  if (keep !== "midi") closeMidiMenu();
  if (keep !== "adsr" && el.adsrButton) el.adsrButton.classList.remove("selected");
  if (keep !== "output" && el.outputSettingsButton) el.outputSettingsButton.classList.remove("selected");
  if (keep !== "session" && el.sessionButton) el.sessionButton.classList.remove("selected");
}

function positionClipEditor() {
  if (!activeEditLayer || !el.clipPopover) return;

  const anchor = activeEditLayer.els.clipEditButton.getBoundingClientRect();
  const popover = el.clipPopover.getBoundingClientRect();
  const left = clamp(anchor.right + 8, 8, Math.max(8, window.innerWidth - popover.width - 8));
  const top = clamp(anchor.top - 4, 8, Math.max(8, window.innerHeight - popover.height - 8));
  el.clipPopover.style.left = `${left}px`;
  el.clipPopover.style.top = `${top}px`;
}

function openClipEditor(layer) {
  if (!layer || !layer.originalBuffer || !el.clipPopover) return;

  activeEditLayer = layer;
  el.clipPopover.hidden = false;
  el.holdPopover.hidden = true;
  el.adsrPopover.hidden = true;
  el.outputPopover.hidden = true;
  el.sessionPopover.hidden = true;
  closeMidiMenu();
  el.adsrButton.classList.remove("selected");
  el.outputSettingsButton.classList.remove("selected");
  el.sessionButton.classList.remove("selected");

  positionClipEditor();
  syncClipEditor(layer);
  drawWaveform(layer, layer.originalBuffer, el.clipWaveformCanvas, el.clipWaveform);
  positionClipEditor();
}

function buildLoopBuffer(layer) {
  layer.buffer = null;
  if (!layer.originalBuffer || !audio.ctx) return;

  const original = layer.originalBuffer;
  const startFrame = clamp(Math.floor(layer.trimStart * original.length), 0, original.length - 2);
  const endFrame = clamp(Math.ceil(layer.trimEnd * original.length), startFrame + 2, original.length);
  const loopFrames = endFrame - startFrame;
  const maxFadeFrames = Math.floor(loopFrames * XFADE_MAX_RATIO);
  const fadeFrames = clamp(
    Math.round(loopTiming(layer).fadeSeconds * original.sampleRate),
    0,
    maxFadeFrames
  );
  const targetFrames = Math.max(2, loopFrames - fadeFrames);
  const bodyFrames = Math.max(1, targetFrames - fadeFrames);
  const bodyStart = startFrame + fadeFrames;
  const buffer = audio.ctx.createBuffer(original.numberOfChannels, targetFrames, original.sampleRate);

  for (let channel = 0; channel < original.numberOfChannels; channel++) {
    const source = original.getChannelData(channel);
    const destination = buffer.getChannelData(channel);

    for (let i = 0; i < bodyFrames; i++) {
      destination[i] = source[bodyStart + i];
    }

    for (let j = 0; j < fadeFrames; j++) {
      const t = fadeFrames === 1 ? 1 : j / (fadeFrames - 1);
      const tailGain = Math.cos((t * Math.PI) / 2);
      const headGain = Math.sin((t * Math.PI) / 2);
      const tailIndex = bodyStart + bodyFrames + j;
      const headIndex = startFrame + j;
      destination[bodyFrames + j] = source[tailIndex] * tailGain + source[headIndex] * headGain;
    }
  }

  layer.buffer = buffer;
}

function commitLoopChanges(layer) {
  if (!layer.originalBuffer || !audio.ctx) {
    updateTrimUI(layer);
    return;
  }

  clampCrossfade(layer);

  const oldDuration = layer.buffer ? layer.buffer.duration : 0;
  let ratio = 0;
  if (oldDuration) {
    const elapsed = layer.source
      ? audio.ctx.currentTime - layer.startedAt + layer.startOffset
      : layer.startOffset;
    ratio = (((elapsed % oldDuration) + oldDuration) % oldDuration) / oldDuration;
  }

  const wasPlaying = !!layer.source;
  stopSource(layer);
  buildLoopBuffer(layer);
  layer.startOffset = layer.buffer ? ratio * layer.buffer.duration : 0;
  if (wasPlaying) startSource(layer);

  updateTrimUI(layer);
  saveLayerSettings();
}

function setTrimHandleValue(layer, handle, value) {
  const gap = minTrimGap(layer);
  const ratio = clamp(value, 0, 1);
  if (handle === "start") {
    layer.trimStart = clamp(Math.min(ratio, layer.trimEnd - gap), 0, 1 - gap);
  } else {
    layer.trimEnd = clamp(Math.max(ratio, layer.trimStart + gap), gap, 1);
  }
  clampCrossfade(layer);
  updateTrimUI(layer);
}

// --- Sample import + waveform preview ------------------------ //

async function loadSample(layer, file) {
  try {
    await applySampleFile(layer, file);
  } catch (error) {
    console.error("TextureKeys: could not decode sample", error);
    layer.els.sampleName.textContent = "Could not load sample";
  }
}

async function applySampleFile(layer, file, options = {}) {
  if (!ensureAudio()) throw new Error("Audio is unavailable.");

  const displayName = options.fileName || file.name || `sample-${layer.id}`;
  layer.els.sampleName.textContent = `Decoding ${displayName}…`;

  const data = await file.arrayBuffer();
  const buffer = await audio.ctx.decodeAudioData(data);

  stopSource(layer);
  layer.originalFile = file;
  layer.originalBuffer = buffer;
  layer.samplePeak = samplePeak(buffer);
  layer.sampleFileName = displayName;
  layer.trimStart = options.trimStart ?? 0;
  layer.trimEnd = options.trimEnd ?? 1;
  layer.crossfadeMs = options.crossfadeMs ?? XFADE_DEFAULT_MS;
  layer.lpfEnabled = options.lpfEnabled ?? false;
  layer.lpfCutoffHz = normalizeLpfCutoff(options.lpfCutoffHz ?? LPF_DEFAULT_HZ);
  clampCrossfade(layer);
  // A new clip opens the filter immediately; live knob changes are smoothed.
  applyLpfSettings(layer);
  buildLoopBuffer(layer);
  layer.startOffset = 0;
  if (isEngaged || releaseEndsAt > 0) startSource(layer);

  if (!options.preserveName) {
    const baseName = displayName.replace(/\.[^/.]+$/, "");
    layer.name = baseName;
    layer.els.nameInput.value = baseName;
    layer.els.track.setAttribute("aria-label", `${baseName} volume`);
  }

  if (!options.silent) saveLayerSettings();

  layer.els.sampleName.textContent = displayName;
  layer.els.loader.classList.add("has-sample");
  layer.els.sampleHint.textContent = "click to change sample";
  layer.els.clipEditButton.disabled = false;
  drawWaveform(layer, buffer);
  updateTrimUI(layer);

  // If the bed is quiet, hold the envelope at zero until the next gate.
  if (!isEngaged && releaseEndsAt === 0 && layer.envelope) {
    setParamImmediate(layer.envelope.gain, 0);
  }

  return buffer;
}

function drawWaveform(
  layer,
  buffer,
  canvas = layer.els.canvas,
  container = layer.els.loader
) {
  if (!canvas && container) {
    canvas = document.createElement("canvas");
    canvas.className = "waveform-canvas";
    container.appendChild(canvas);
    layer.els.canvas = canvas;
  }
  if (!canvas || !container || !buffer) return;

  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(container.clientWidth * dpr));
  const height = Math.max(1, Math.floor(container.clientHeight * dpr));
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");
  context.clearRect(0, 0, width, height);
  context.fillStyle = ACCENT_WAVE;

  const data = buffer.getChannelData(0);
  const buckets = Math.max(1, Math.floor(width / 2));
  const stride = Math.max(1, Math.floor(data.length / buckets));
  const sampleStep = Math.max(1, Math.floor(stride / 8));

  for (let bucket = 0; bucket < buckets; bucket++) {
    let peak = 0;
    const start = bucket * stride;
    for (let i = 0; i < stride && start + i < data.length; i += sampleStep) {
      peak = Math.max(peak, Math.abs(data[start + i]));
    }
    const barHeight = Math.max(dpr, peak * height * 0.86);
    context.fillRect(bucket * 2, (height - barHeight) / 2, Math.max(1, dpr), barHeight);
  }
}

function samplePeak(buffer) {
  if (!buffer) return 0;
  let peak = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < data.length; i++) {
      const abs = Math.abs(data[i]);
      if (abs > peak) peak = abs;
    }
  }
  return peak;
}

function formatPeakDb(peak) {
  if (!peak || peak <= 0) return "SILENCE";
  const db = 20 * Math.log10(peak);
  return `${db > -0.05 ? "0.0" : db.toFixed(1)} dB`;
}

function encodeWavFile(buffer, name) {
  const channels = buffer.numberOfChannels;
  const frames = buffer.length;
  const dataBytes = frames * channels * 2;
  const bytes = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(bytes);
  let offset = 0;
  const writeText = (text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset++, text.charCodeAt(i));
  };

  writeText("RIFF");
  view.setUint32(offset, 36 + dataBytes, true); offset += 4;
  writeText("WAVE");
  writeText("fmt ");
  view.setUint32(offset, 16, true); offset += 4; // PCM chunk size
  view.setUint16(offset, 1, true); offset += 2; // uncompressed PCM
  view.setUint16(offset, channels, true); offset += 2;
  view.setUint32(offset, buffer.sampleRate, true); offset += 4;
  view.setUint32(offset, buffer.sampleRate * channels * 2, true); offset += 4;
  view.setUint16(offset, channels * 2, true); offset += 2;
  view.setUint16(offset, 16, true); offset += 2;
  writeText("data");
  view.setUint32(offset, dataBytes, true); offset += 4;

  const pcm = new Int16Array(bytes, 44);
  for (let channel = 0; channel < channels; channel++) {
    const source = buffer.getChannelData(channel);
    for (let i = 0; i < frames; i++) {
      const value = clamp(source[i], -1, 1);
      pcm[i * channels + channel] = value < 0
        ? Math.round(value * 0x8000)
        : Math.round(value * 0x7fff);
    }
  }

  return new File([bytes], name, { type: "audio/wav" });
}

async function normalizeClip(layer) {
  if (!layer || !layer.originalBuffer || !audio.ctx || layer.normalizing) return;
  const peak = layer.samplePeak || samplePeak(layer.originalBuffer);
  if (peak <= 0 || peak >= 0.999) return;

  layer.normalizing = true;
  const button = el.clipNormalize;
  button.disabled = true;
  button.textContent = "WORKING…";
  // Let the button state paint before the buffer scan and WAV encoding.
  await new Promise((resolve) => requestAnimationFrame(resolve));

  try {
    const gain = 1 / peak;
    const original = layer.originalBuffer;
    const scaled = audio.ctx.createBuffer(original.numberOfChannels, original.length, original.sampleRate);
    for (let channel = 0; channel < original.numberOfChannels; channel++) {
      const source = original.getChannelData(channel);
      const destination = scaled.getChannelData(channel);
      for (let i = 0; i < source.length; i++) destination[i] = source[i] * gain;
    }

    // Replace the buffer without restarting the gesture or losing the playhead.
    const oldDuration = layer.buffer ? layer.buffer.duration : 0;
    let ratio = 0;
    if (oldDuration) {
      const elapsed = layer.source
        ? audio.ctx.currentTime - layer.startedAt + layer.startOffset
        : layer.startOffset;
      ratio = (((elapsed % oldDuration) + oldDuration) % oldDuration) / oldDuration;
    }
    const wasPlaying = !!layer.source;
    stopSource(layer);

    layer.originalBuffer = scaled;
    layer.samplePeak = samplePeak(scaled);
    const baseName = (layer.sampleFileName || "sample.wav").replace(/\.[^/.]+$/, "");
    layer.originalFile = encodeWavFile(scaled, `${baseName}.wav`);
    buildLoopBuffer(layer);
    layer.startOffset = layer.buffer ? ratio * layer.buffer.duration : 0;
    if (wasPlaying) startSource(layer);

    drawWaveform(layer, scaled);
    if (activeEditLayer === layer && !el.clipPopover.hidden) {
      drawWaveform(layer, scaled, el.clipWaveformCanvas, el.clipWaveform);
    }
  } finally {
    layer.normalizing = false;
    button.textContent = "NORMALIZE";
    syncClipEditor(layer);
  }
}

// --- MIDI ---------------------------------------------------- //

function loadMidiSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(MIDI_STORAGE_KEY) || "{}");
    if (typeof saved.all === "boolean") midiSelectAll = saved.all;
    if (Array.isArray(saved.selectedIds)) {
      midiSelectedIds.clear();
      saved.selectedIds.forEach((id) => {
        if (typeof id === "string") midiSelectedIds.add(id);
      });
    }
  } catch (_) {
    // Keep the default (all inputs) if storage is unavailable.
  }
}

function saveMidiSettings() {
  try {
    localStorage.setItem(MIDI_STORAGE_KEY, JSON.stringify({
      all: midiSelectAll,
      selectedIds: Array.from(midiSelectedIds)
    }));
  } catch (_) {
    // Storage may be unavailable; selection still works for this session.
  }
}

function midiDeviceAllowed(id) {
  return midiSelectAll || midiSelectedIds.has(id);
}

function midiGateId(inputId, channel, note) {
  return `m:${encodeURIComponent(inputId)}:${channel}:${note}`;
}

function midiGateInputId(gate) {
  if (typeof gate !== "string" || !gate.startsWith("m:")) return null;
  const end = gate.indexOf(":", 2);
  if (end < 0) return null;
  try {
    return decodeURIComponent(gate.slice(2, end));
  } catch (_) {
    return null;
  }
}

function clearMidiInputGates(id) {
  const prefix = `m:${encodeURIComponent(id)}:`;
  for (const gate of Array.from(midiNotes)) {
    if (gate.startsWith(prefix)) midiNotes.delete(gate);
  }
  midiSustainInputs.delete(id);
}

function clearMidiGates() {
  for (const gate of Array.from(midiNotes)) {
    if (midiGateInputId(gate) !== null) midiNotes.delete(gate);
  }
  midiSustainInputs.clear();
}

function maybeInitMIDI(force = false) {
  if (midiInitialized && !force) return;
  midiInitialized = true;

  if (!navigator.requestMIDIAccess) {
    midiPermissionDenied = false;
    midiAccess = null;
    midiInputList = [];
    updateMidiUI();
    renderMidiDevices();
    return;
  }

  // A forced rescan replaces the access object, so release the old handlers
  // and any gates they were holding before asking for access again.
  if (midiAccess) {
    midiAccess.onstatechange = null;
    midiAccess.inputs.forEach((input) => { input.onmidimessage = null; });
    const hadGates = midiNotes.size > 0 || midiSustainInputs.size > 0;
    clearMidiGates();
    midiAccess = null;
    midiInputList = [];
    if (hadGates) activationChanged();
  }

  navigator.requestMIDIAccess({ sysex: false })
    .then((access) => {
      midiAccess = access;
      midiPermissionDenied = false;
      bindMIDIInputs();
      midiAccess.onstatechange = () => {
        bindMIDIInputs();
        renderMidiDevices();
        updateMidiUI();
      };
      renderMidiDevices();
      updateMidiUI();
    })
    .catch(() => {
      midiPermissionDenied = true;
      midiAccess = null;
      midiInputList = [];
      renderMidiDevices();
      updateMidiUI();
    });
}

function bindMIDIInputs() {
  if (!midiAccess) return;

  let gatesRemoved = false;
  const presentIds = new Set();

  midiAccess.inputs.forEach((input) => {
    const id = input.id || "";
    presentIds.add(id);

    if (midiDeviceAllowed(id)) {
      input.onmidimessage = (event) => onMIDIMessage(event, input);
    } else {
      input.onmidimessage = null;
      const before = midiNotes.size + midiSustainInputs.size;
      clearMidiInputGates(id);
      if (midiNotes.size + midiSustainInputs.size !== before) gatesRemoved = true;
    }
  });

  midiInputList = Array.from(midiAccess.inputs.values()).map((input) => ({
    id: input.id || "",
    name: input.name || "MIDI Input",
    state: input.state || "connected"
  }));

  for (const gate of Array.from(midiNotes)) {
    const id = midiGateInputId(gate);
    if (id !== null && !presentIds.has(id)) {
      midiNotes.delete(gate);
      gatesRemoved = true;
    }
  }
  for (const id of Array.from(midiSustainInputs)) {
    if (!presentIds.has(id)) {
      midiSustainInputs.delete(id);
      gatesRemoved = true;
    }
  }

  if (gatesRemoved) activationChanged();
}

function onMIDIMessage(event, input) {
  const [statusByte, noteOrController, value] = event.data;
  if (statusByte === undefined) return;

  const command = statusByte & 0xf0;
  const channel = statusByte & 0x0f;
  const inputId = input.id || "";
  const gate = midiGateId(inputId, channel, noteOrController);

  if (command === 0x90) {
    if (value > 0) startGate(gate);
    else endGate(gate);
  } else if (command === 0x80) {
    endGate(gate);
  } else if (command === 0xb0 && noteOrController === 64) {
    const down = value >= 64;
    if (down === midiSustainInputs.has(inputId)) return;
    if (down) midiSustainInputs.add(inputId);
    else midiSustainInputs.delete(inputId);
    activationChanged();
  }
}

function midiSummaryText() {
  if (!navigator.requestMIDIAccess) return "N/A";
  if (midiPermissionDenied) return "BLOCKED";
  if (!midiAccess) return "NONE";
  if (midiSelectAll) return midiInputList.length ? "ALL" : "NONE";
  const count = midiInputList.filter((device) => midiSelectedIds.has(device.id)).length;
  return count ? String(count) : "NONE";
}

function updateMidiUI() {
  if (!el.midiButton) return;
  el.midiSummary.textContent = midiSummaryText();
  el.midiButton.setAttribute("aria-pressed", String(!el.midiPopover.hidden));
}

function renderMidiDevices() {
  if (!el.midiDeviceList) return;
  el.midiDeviceList.replaceChildren();

  if (!navigator.requestMIDIAccess) {
    el.midiStatus.textContent = "Web MIDI is not supported here. Keyboard and HOLD still work.";
    return;
  }
  if (midiPermissionDenied) {
    el.midiStatus.textContent = "MIDI access was blocked. Allow it in your browser, then press RESCAN.";
    return;
  }
  if (!midiAccess) {
    el.midiStatus.textContent = "Web MIDI is ready. Connect a device, then press RESCAN.";
    return;
  }

  el.midiStatus.textContent = midiInputList.length
    ? "Select the devices that should trigger the texture bed."
    : "No MIDI inputs found. Connect a device, then press RESCAN.";

  const addRow = (nameText, stateText, checked, onChange, isAll = false) => {
    const row = document.createElement("label");
    row.className = isAll ? "midi-device midi-device-all" : "midi-device";

    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = checked;
    box.addEventListener("change", onChange);

    const info = document.createElement("span");
    info.className = "midi-device-info";
    const name = document.createElement("span");
    name.className = "midi-device-name";
    name.textContent = nameText;
    const state = document.createElement("span");
    state.className = "midi-device-state";
    state.textContent = stateText;
    info.append(name, state);

    row.append(box, info);
    el.midiDeviceList.append(row);
  };

  addRow("ALL INPUTS", midiSelectAll ? "ON" : "CUSTOM", midiSelectAll,
    (event) => setMidiAll(event.target.checked), true);

  midiInputList.forEach((device) => {
    addRow(
      device.name,
      device.state === "connected" ? "CONNECTED" : "DISCONNECTED",
      midiDeviceAllowed(device.id),
      (event) => setMidiDeviceEnabled(device.id, event.target.checked)
    );
  });
}

function applyMidiSelection() {
  saveMidiSettings();
  bindMIDIInputs();
  renderMidiDevices();
  updateMidiUI();
}

function setMidiAll(enabled) {
  midiSelectAll = enabled;
  midiSelectedIds.clear();
  applyMidiSelection();
}

function setMidiDeviceEnabled(id, enabled) {
  if (enabled) {
    if (midiSelectAll) return;
    midiSelectedIds.add(id);
  } else {
    if (midiSelectAll) {
      midiSelectAll = false;
      midiInputList.forEach((device) => {
        if (device.id !== id) midiSelectedIds.add(device.id);
      });
    }
    midiSelectedIds.delete(id);
  }
  applyMidiSelection();
}

function closeMidiMenu() {
  if (el.midiPopover) el.midiPopover.hidden = true;
  if (el.midiBackdrop) el.midiBackdrop.hidden = true;
  if (el.midiButton) {
    el.midiButton.classList.remove("selected");
    el.midiButton.setAttribute("aria-pressed", "false");
  }
}

function openMidiMenu() {
  closeOtherPopovers("midi");
  if (el.midiPopover) el.midiPopover.hidden = false;
  if (el.midiBackdrop) el.midiBackdrop.hidden = false;
  if (el.midiButton) {
    el.midiButton.classList.add("selected");
    el.midiButton.setAttribute("aria-pressed", "true");
  }
  maybeInitMIDI();
  renderMidiDevices();
  updateMidiUI();
}

// --- Session save / load ------------------------------------- //

function setSessionStatus(message) {
  if (el.sessionStatus) el.sessionStatus.textContent = message || "";
}

function safeAudioFileName(layer, index) {
  const fallback = `layer-${String(index + 1).padStart(2, "0")}.wav`;
  const raw = layer.sampleFileName || fallback;
  const base = raw.replace(/\\/g, "/").split("/").pop() || fallback;
  const safe = base.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `audio/${String(index + 1).padStart(2, "0")}-${safe}`;
}

async function collectSession() {
  const layerSettings = [];
  const audioFiles = [];

  for (let index = 0; index < layers.length; index++) {
    const layer = layers[index];
    const audioFile = layer.originalFile ? safeAudioFileName(layer, index) : null;
    if (layer.originalFile) {
      audioFiles.push({
        name: audioFile,
        data: new Uint8Array(await layer.originalFile.arrayBuffer())
      });
    }

    layerSettings.push({
      name: layer.name,
      db: layer.db,
      isActive: layer.isActive,
      isSolo: layer.isSolo,
      trimStart: layer.trimStart,
      trimEnd: layer.trimEnd,
      crossfadeMs: layer.crossfadeMs,
      lpf: {
        enabled: layer.lpfEnabled,
        cutoffHz: layer.lpfCutoffHz
      },
      sampleFileName: layer.sampleFileName || null,
      audioFile
    });
  }

  const session = {
    format: SESSION_FORMAT,
    version: SESSION_VERSION,
    savedAt: new Date().toISOString(),
    settings: {
      adsr: { ...adsr },
      holdDuration,
      audio: { ...audioSettings },
      layerCount: layers.length
    },
    layers: layerSettings
  };

  return {
    session,
    audioFiles,
    json: JSON.stringify(session, null, 2)
  };
}

function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let value = i;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let value = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    value = CRC_TABLE[(value ^ bytes[i]) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

async function makeZip(files) {
  const encoder = new TextEncoder();
  const { time, day } = dosDateTime(new Date());
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  files.forEach((file) => {
    const nameBytes = encoder.encode(file.name);
    const data = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
    const checksum = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, time, true);
    localView.setUint16(12, day, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true);
    local.set(nameBytes, 30);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, time, true);
    centralView.setUint16(14, day, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, data.length, true);
    centralView.setUint32(24, data.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true);
    central.set(nameBytes, 46);

    localParts.push(local, data);
    centralParts.push(central);
    offset += local.length + data.length;
  });

  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  endView.setUint16(20, 0, true);

  return new Blob([...localParts, ...centralParts, end], { type: "application/zip" });
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream !== "function") {
    throw new Error("This browser cannot read compressed ZIP files.");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readZipFiles(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const decoder = new TextDecoder();
  let endOffset = -1;
  const minEnd = Math.max(0, arrayBuffer.byteLength - 22 - 65535);

  for (let offset = arrayBuffer.byteLength - 22; offset >= minEnd; offset--) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw new Error("Not a valid ZIP file.");

  const count = view.getUint16(endOffset + 10, true);
  let centralOffset = view.getUint32(endOffset + 16, true);
  const files = [];

  for (let i = 0; i < count; i++) {
    if (view.getUint32(centralOffset, true) !== 0x02014b50) {
      throw new Error("The ZIP directory could not be read.");
    }

    const method = view.getUint16(centralOffset + 10, true);
    const compressedSize = view.getUint32(centralOffset + 20, true);
    const nameLength = view.getUint16(centralOffset + 28, true);
    const extraLength = view.getUint16(centralOffset + 30, true);
    const commentLength = view.getUint16(centralOffset + 32, true);
    const localOffset = view.getUint32(centralOffset + 42, true);
    const name = decoder.decode(new Uint8Array(arrayBuffer, centralOffset + 46, nameLength));

    if (view.getUint32(localOffset, true) !== 0x04034b50) {
      throw new Error("The ZIP file contains an invalid entry.");
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    let data = new Uint8Array(arrayBuffer, dataStart, compressedSize);
    if (method === 8) data = await inflateRaw(data);
    else if (method !== 0) throw new Error(`Unsupported ZIP compression (${method}).`);

    files.push({ name, data });
    centralOffset += 46 + nameLength + extraLength + commentLength;
  }

  return files;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function writeDirectoryFiles(handle, files) {
  for (const file of files) {
    const parts = file.name.split("/").filter(Boolean);
    let directory = handle;
    for (const part of parts.slice(0, -1)) {
      directory = await directory.getDirectoryHandle(part, { create: true });
    }
    const fileHandle = await directory.getFileHandle(parts[parts.length - 1], { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(file.data);
    await writable.close();
  }
}

async function readDirectoryFiles(handle, prefix = "") {
  const files = [];
  for await (const entry of handle.values()) {
    const name = `${prefix}${entry.name}`;
    if (entry.kind === "directory") {
      files.push(...await readDirectoryFiles(entry, `${name}/`));
    } else if (entry.kind === "file") {
      files.push({ name, file: await entry.getFile() });
    }
  }
  return files;
}

function normalizeSession(raw) {
  if (!raw || raw.format !== SESSION_FORMAT || Number(raw.version) !== SESSION_VERSION) {
    throw new Error("This is not a TextureKeys session file.");
  }
  if (!Array.isArray(raw.layers) || raw.layers.length < MIN_LAYERS || raw.layers.length > MAX_LAYERS) {
    throw new Error("The session must contain 1–8 layers.");
  }

  const settings = raw.settings || {};
  const savedAdsr = settings.adsr || {};
  const nextAdsr = { ...ADSR_DEFAULTS };
  ADSR_SLIDER_KEYS.forEach((key) => {
    const value = Number(savedAdsr[key]);
    if (!Number.isFinite(value)) return;
    const max = key === "sustain" || key === "curve" ? 100 : 10000;
    const min = key === "curve" ? -100 : 0;
    nextAdsr[key] = clamp(value, min, max);
  });

  const holdMs = Number(settings.holdDuration);
  const savedAudio = settings.audio || {};
  const outputMode = savedAudio.outputMode === "mono" ? "mono" : "stereo";

  return {
    adsr: nextAdsr,
    holdDuration: Number.isFinite(holdMs) ? clamp(Math.round(holdMs), 0, 5000) : 1500,
    audio: {
      deviceId: typeof savedAudio.deviceId === "string" ? savedAudio.deviceId : "",
      outputMode
    },
    layers: raw.layers.map((item, index) => {
      const fallbackName = DEFAULT_NAMES[index] || `Layer ${index + 1}`;
      const rawDb = Number(item?.db);
      const db = Number.isFinite(rawDb)
        ? clamp(Math.round(rawDb * 2) / 2, MIN_DB, MAX_DB)
        : (DEFAULT_DB[index] ?? 0);
      const rawStart = Number(item?.trimStart);
      const rawEnd = Number(item?.trimEnd);
      const trimStart = Number.isFinite(rawStart) ? clamp(rawStart, 0, 1 - MIN_TRIM_GAP) : 0;
      const trimEnd = Number.isFinite(rawEnd) ? clamp(rawEnd, trimStart + MIN_TRIM_GAP, 1) : 1;
      const rawFade = Number(item?.crossfadeMs);
      const savedActive = typeof item?.isActive === "boolean" ? item.isActive : true;
      // Older sessions used `hpf`; read those settings as LPF so they survive.
      const savedLpf = item?.lpf || item?.hpf || {};

      return {
        name: typeof item?.name === "string" && item.name.trim() ? item.name.slice(0, 30) : fallbackName,
        db,
        isActive: db <= MIN_DB ? false : savedActive,
        isSolo: typeof item?.isSolo === "boolean" ? item.isSolo : false,
        trimStart,
        trimEnd,
        crossfadeMs: Number.isFinite(rawFade)
          ? clamp(Math.round(rawFade / XFADE_STEP) * XFADE_STEP, 0, XFADE_MAX_MS)
          : XFADE_DEFAULT_MS,
        lpfEnabled: typeof savedLpf.enabled === "boolean" ? savedLpf.enabled : false,
        lpfCutoffHz: normalizeLpfCutoff(savedLpf.cutoffHz),
        sampleFileName: typeof item?.sampleFileName === "string" ? item.sampleFileName : null,
        audioFile: typeof item?.audioFile === "string" ? normalizeSessionPath(item.audioFile) : null
      };
    })
  };
}

function normalizeSessionPath(path) {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

async function applySession(raw, audioFiles) {
  const session = normalizeSession(raw);

  cancelAllTimers();
  // Keep physically held gates (HOLD button, keys, MIDI notes/pedal) so a
  // session loaded mid-gesture does not drop the sound. DRONE is reset below.
  droneOn = false;
  isEngaged = false;
  sessionLoading = true;
  closeClipEditor();
  pauseAllSources();
  updateHoldUI();
  updateDroneUI();
  setEngineStatus("loading");

  // Keep the old cards visible until every new sample is decoded, so a
  // partially loaded scene cannot look ready.
  const oldLayers = layers.slice();
  oldLayers.forEach((layer) => {
    stopSource(layer);
    if (layer.filter) layer.filter.disconnect();
    if (layer.envelope) layer.envelope.disconnect();
    if (layer.level) layer.level.disconnect();
  });
  layers = [];

  session.layers.forEach((settings, index) => {
    layers.push(createLayer(
      index,
      settings.name,
      settings.db,
      settings.isActive,
      settings.isSolo,
      settings.trimStart,
      settings.trimEnd,
      settings.crossfadeMs,
      settings.lpfEnabled,
      settings.lpfCutoffHz,
      true
    ));
  });

  Object.assign(adsr, session.adsr);
  ADSR_SLIDER_KEYS.forEach((key) => {
    el.adsrInputs[key].value = String(adsr[key]);
    el.adsrValues[key].textContent = formatAdsrValue(key, adsr[key]);
  });
  saveAdsr();
  drawAdsrGraph();

  Object.assign(audioSettings, session.audio);
  saveAudioSettings();
  if (audio.ctx) applyOutputRouting();
  updateOutputUI();

  setHoldDuration(session.holdDuration);

  let missingAudio = 0;
  for (let index = 0; index < session.layers.length; index++) {
    const settings = session.layers[index];
    const layer = layers[index];
    if (!settings.audioFile) continue;

    const file = audioFiles.get(settings.audioFile);
    if (!file) {
      missingAudio++;
      layer.els.sampleName.textContent = "Audio not found — reload sample";
      continue;
    }

    try {
      await applySampleFile(layer, file, {
        fileName: settings.sampleFileName || settings.audioFile.split("/").pop(),
        trimStart: settings.trimStart,
        trimEnd: settings.trimEnd,
        crossfadeMs: settings.crossfadeMs,
        lpfEnabled: settings.lpfEnabled,
        lpfCutoffHz: settings.lpfCutoffHz,
        preserveName: true,
        silent: true
      });
    } catch (error) {
      missingAudio++;
      console.warn("TextureKeys: could not restore a session sample", error);
      layer.els.sampleName.textContent = "Could not restore audio";
    }
  }

  saveLayerSettings();

  // Swap in the finished scene only now; redraw waveforms because the cards
  // were detached while decoding.
  oldLayers.forEach((layer) => layer.card.remove());
  layers.forEach((layer) => el.layersGrid.appendChild(layer.card));
  layers.forEach((layer) => {
    if (layer.originalBuffer) drawWaveform(layer, layer.originalBuffer);
  });
  syncLayerChrome();

  sessionLoading = false;
  // Replay a gate that was held through the load, or one that was tapped while
  // the samples were still decoding.
  if (hasEngagementInput()) {
    activationChanged();
  } else if (pendingLoadGate) {
    pendingLoadGate = false;
    engage(false, true);
  } else {
    setEngineStatus("ready");
  }
  pendingLoadGate = false;

  return missingAudio;
}

function demoAudioPath(file, index) {
  const safe = file.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `audio/${String(index + 1).padStart(2, "0")}-${safe}`;
}

function buildDemoSession() {
  return {
    format: SESSION_FORMAT,
    version: SESSION_VERSION,
    settings: {
      adsr: { ...DEMO_ADSR },
      holdDuration: 1500,
      // Keep the listener's current output device and mono/stereo choice.
      audio: { ...audioSettings },
      layerCount: DEMO_FILES.length
    },
    layers: DEMO_FILES.map((item, index) => ({
      name: item.name,
      db: item.db,
      isActive: true,
      isSolo: false,
      trimStart: 0,
      trimEnd: 1,
      crossfadeMs: XFADE_DEFAULT_MS,
      lpf: { enabled: false, cutoffHz: LPF_DEFAULT_HZ },
      sampleFileName: item.file,
      audioFile: demoAudioPath(item.file, index)
    }))
  };
}

async function loadDemoScene() {
  if (demoLoading) return;
  demoLoading = true;
  sessionLoading = true;
  pendingLoadGate = false;
  setSessionStatus("Loading demo scene…");
  setEngineStatus("loading");

  try {
    const session = buildDemoSession();
    const fetched = await Promise.all(DEMO_FILES.map(async (item, index) => {
      const response = await fetch(`AudioFiles/${encodeURIComponent(item.file)}`);
      if (!response.ok) throw new Error(`Could not fetch ${item.file} (${response.status}).`);
      const blob = await response.blob();
      const file = new File([blob], item.file, { type: "audio/wav" });
      return [session.layers[index].audioFile, file];
    }));

    const audioFiles = new Map(fetched);
    const missing = await applySession(session, audioFiles);
    setSessionStatus(missing
      ? `Demo scene loaded with ${missing} missing sample${missing === 1 ? "" : "s"}.`
      : "Demo scene loaded — five ambient layers ready.");
  } catch (error) {
    console.error("TextureKeys: could not load demo scene", error);
    setSessionStatus(error.message || "Could not load the demo scene.");
  } finally {
    demoLoading = false;
    sessionLoading = false;
    pendingLoadGate = false;
  }
}

function sessionJsonFromFiles(files) {
  const entry = files.find((file) => normalizeSessionPath(file.name).toLowerCase() === "session.json");
  if (!entry) throw new Error("The folder needs a session.json file.");
  return entry;
}

async function sessionFilesFromFolderInput(input) {
  const files = Array.from(input.files || []).map((file) => ({
    name: normalizeSessionPath(file.webkitRelativePath || file.name),
    file
  }));
  if (!files.length) throw new Error("No folder was selected.");
  return files;
}

async function saveSessionZip() {
  try {
    const collected = await collectSession();
    const encoder = new TextEncoder();
    const zip = await makeZip([
      { name: "session.json", data: encoder.encode(collected.json) },
      ...collected.audioFiles
    ]);
    downloadBlob(zip, "texturekeys-session.zip");
    setSessionStatus("ZIP saved. JSON + audio are inside.");
  } catch (error) {
    console.error("TextureKeys: could not save session ZIP", error);
    setSessionStatus("Could not save the session.");
  }
}

async function saveSessionFolder() {
  if (typeof window.showDirectoryPicker !== "function") {
    await saveSessionZip();
    setSessionStatus("Folder picker unavailable — saved a ZIP instead.");
    return;
  }

  try {
    const handle = await window.showDirectoryPicker();
    const collected = await collectSession();
    const encoder = new TextEncoder();
    await writeDirectoryFiles(handle, [
      { name: "session.json", data: encoder.encode(collected.json) },
      ...collected.audioFiles
    ]);
    setSessionStatus("Session folder saved.");
  } catch (error) {
    if (error && error.name === "AbortError") {
      setSessionStatus("Save cancelled.");
      return;
    }
    console.error("TextureKeys: could not save session folder", error);
    setSessionStatus("Could not save the session folder.");
  }
}

async function loadSessionFiles(files) {
  sessionLoading = true;
  pendingLoadGate = false;
  setEngineStatus("loading");
  try {
    const jsonEntry = sessionJsonFromFiles(files);
    const parsed = JSON.parse(await jsonEntry.file.text());
    const audioFiles = new Map();
    files.forEach(({ name, file }) => {
      audioFiles.set(normalizeSessionPath(name), file);
    });

    const missing = await applySession(parsed, audioFiles);
    setSessionStatus(missing
      ? `Session loaded; ${missing} audio file${missing === 1 ? "" : "s"} missing.`
      : "Session loaded.");
  } catch (error) {
    console.error("TextureKeys: could not load session", error);
    setSessionStatus(error.message || "Could not load the session.");
  } finally {
    sessionLoading = false;
    pendingLoadGate = false;
  }
}

async function loadSessionZip(file) {
  try {
    const files = (await readZipFiles(await file.arrayBuffer())).map((entry) => ({
      name: normalizeSessionPath(entry.name),
      file: new File([entry.data], entry.name.split("/").pop() || "file", { type: "application/octet-stream" })
    }));
    await loadSessionFiles(files);
  } catch (error) {
    console.error("TextureKeys: could not load session ZIP", error);
    setSessionStatus(error.message || "Could not load the ZIP.");
  }
}

async function loadSessionFolder() {
  if (typeof window.showDirectoryPicker === "function") {
    try {
      const handle = await window.showDirectoryPicker();
      const files = await readDirectoryFiles(handle);
      await loadSessionFiles(files);
    } catch (error) {
      if (error && error.name === "AbortError") {
        setSessionStatus("Load cancelled.");
        return;
      }
      console.error("TextureKeys: could not load session folder", error);
      setSessionStatus(error.message || "Could not load the folder.");
    }
    return;
  }

  el.sessionFolderInput.click();
}

// --- Global UI bindings -------------------------------------- //

function bindGlobalControls() {
  el.sessionButton.addEventListener("click", () => {
    const opening = el.sessionPopover.hidden;
    if (opening) closeOtherPopovers("session");
    el.sessionPopover.hidden = !opening;
    el.sessionButton.classList.toggle("selected", opening);
  });

  el.closeSessionSettings.addEventListener("click", () => {
    el.sessionPopover.hidden = true;
    el.sessionButton.classList.remove("selected");
  });

  el.sessionSaveFolder.addEventListener("click", saveSessionFolder);
  el.sessionSaveZip.addEventListener("click", saveSessionZip);
  el.sessionLoadFolder.addEventListener("click", loadSessionFolder);
  el.sessionLoadZip.addEventListener("click", () => el.sessionZipInput.click());
  el.sessionLoadDemo.addEventListener("click", loadDemoScene);

  el.sessionFolderInput.addEventListener("change", async () => {
    try {
      const files = await sessionFilesFromFolderInput(el.sessionFolderInput);
      await loadSessionFiles(files);
    } catch (error) {
      setSessionStatus(error.message || "Could not load the folder.");
    }
    el.sessionFolderInput.value = "";
  });

  el.sessionZipInput.addEventListener("change", async () => {
    const file = el.sessionZipInput.files && el.sessionZipInput.files[0];
    if (file) await loadSessionZip(file);
    el.sessionZipInput.value = "";
  });

  el.closeClipEditor.addEventListener("click", closeClipEditor);

  let trimming = null;

  const trimMove = (event) => {
    const layer = activeEditLayer;
    if (!trimming || !layer || !layer.originalBuffer) return;
    const rect = el.clipTrimBar.getBoundingClientRect();
    if (!rect.width) return;
    setTrimHandleValue(layer, trimming, (event.clientX - rect.left) / rect.width);
  };

  const endTrim = () => {
    const layer = activeEditLayer;
    if (!trimming || !layer) return;
    trimming = null;
    commitLoopChanges(layer);
  };

  const bindTrimHandle = (handle, button) => {
    button.addEventListener("pointerdown", (event) => {
      if (!activeEditLayer || !activeEditLayer.originalBuffer) return;
      event.preventDefault();
      event.stopPropagation();
      trimming = handle;
      try {
        el.clipTrimBar.setPointerCapture(event.pointerId);
      } catch (_) {
        // Capture is an enhancement; dragging still works without it.
      }
    });

    button.addEventListener("keydown", (event) => {
      const layer = activeEditLayer;
      if (!layer || !layer.originalBuffer) return;
      const step = event.shiftKey ? 0.05 : 0.01;
      const current = handle === "start" ? layer.trimStart : layer.trimEnd;
      let next = null;

      switch (event.key) {
        case "ArrowLeft": next = current - step; break;
        case "ArrowRight": next = current + step; break;
        case "Home": next = handle === "start" ? 0 : layer.trimStart + minTrimGap(layer); break;
        case "End": next = handle === "start" ? layer.trimEnd - minTrimGap(layer) : 1; break;
        default: return;
      }

      event.preventDefault();
      setTrimHandleValue(layer, handle, next);
      commitLoopChanges(layer);
    });
  };

  bindTrimHandle("start", el.clipStartHandle);
  bindTrimHandle("end", el.clipEndHandle);

  window.addEventListener("pointermove", trimMove);
  window.addEventListener("pointerup", endTrim);
  window.addEventListener("pointercancel", endTrim);

  el.clipTrimBar.addEventListener("dblclick", () => {
    const layer = activeEditLayer;
    if (!layer || !layer.originalBuffer) return;
    layer.trimStart = 0;
    layer.trimEnd = 1;
    clampCrossfade(layer);
    commitLoopChanges(layer);
  });

  el.clipXfadeSlider.addEventListener("input", () => {
    const layer = activeEditLayer;
    if (!layer || !layer.originalBuffer) return;
    layer.crossfadeMs = Number(el.clipXfadeSlider.value);
    clampCrossfade(layer);
    updateTrimUI(layer);
  });

  el.clipXfadeSlider.addEventListener("change", () => {
    if (!activeEditLayer) return;
    commitLoopChanges(activeEditLayer);
  });

  el.clipLpfToggle.addEventListener("click", () => {
    const layer = activeEditLayer;
    if (!layer) return;
    layer.lpfEnabled = !layer.lpfEnabled;
    applyLpfSettings(layer, true);
    syncClipEditor(layer);
    saveLayerSettings();
  });

  el.clipLpfSlider.addEventListener("input", () => {
    const layer = activeEditLayer;
    if (!layer) return;
    layer.lpfCutoffHz = lpfSliderToHz(el.clipLpfSlider.value);
    layer.lpfEnabled = true;
    applyLpfSettings(layer, true);
    syncClipEditor(layer);
    saveLayerSettings();
  });

  el.clipNormalize.addEventListener("click", () => {
    if (activeEditLayer) normalizeClip(activeEditLayer);
  });

  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!el.midiPopover.hidden) {
      closeMidiMenu();
      return;
    }
    if (!el.clipPopover.hidden) {
      closeClipEditor();
      return;
    }
    if (!el.sessionPopover.hidden) {
      el.sessionPopover.hidden = true;
      el.sessionButton.classList.remove("selected");
    }
    if (!el.outputPopover.hidden) {
      el.outputPopover.hidden = true;
      el.outputSettingsButton.classList.remove("selected");
    }
    if (!el.adsrPopover.hidden) {
      el.adsrPopover.hidden = true;
      el.adsrButton.classList.remove("selected");
    }
    if (!el.holdPopover.hidden) el.holdPopover.hidden = true;
  });

  el.outputSettingsButton.addEventListener("click", () => {
    const opening = el.outputPopover.hidden;
    if (opening) closeOtherPopovers("output");
    el.outputPopover.hidden = !opening;
    el.outputSettingsButton.classList.toggle("selected", opening);
    if (opening) refreshOutputDevices();
  });

  el.closeOutputSettings.addEventListener("click", () => {
    el.outputPopover.hidden = true;
    el.outputSettingsButton.classList.remove("selected");
  });

  el.outputDeviceSelect.addEventListener("change", () => {
    selectOutputDevice(el.outputDeviceSelect.value);
  });

  el.outputModeInputs.forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked) setOutputMode(input.value);
    });
  });

  el.holdSettingsButton.addEventListener("click", () => {
    const opening = el.holdPopover.hidden;
    if (opening) closeOtherPopovers("hold");
    el.holdPopover.hidden = !opening;
  });

  el.closeHoldSettings.addEventListener("click", () => {
    el.holdPopover.hidden = true;
  });

  el.adsrButton.addEventListener("click", () => {
    const opening = el.adsrPopover.hidden;
    if (opening) closeOtherPopovers("adsr");
    el.adsrPopover.hidden = !opening;
    el.adsrButton.classList.toggle("selected", opening);
    if (opening) drawAdsrGraph();
  });

  el.closeAdsrSettings.addEventListener("click", () => {
    el.adsrPopover.hidden = true;
    el.adsrButton.classList.remove("selected");
  });

  el.midiButton.addEventListener("click", () => {
    if (el.midiPopover.hidden) openMidiMenu();
    else closeMidiMenu();
  });

  el.closeMidiSettings.addEventListener("click", closeMidiMenu);
  el.midiBackdrop.addEventListener("click", closeMidiMenu);
  el.midiRescan.addEventListener("click", () => {
    maybeInitMIDI(true);
    renderMidiDevices();
  });

  document.addEventListener("pointerdown", (event) => {
    const target = event.target;

    if (!el.holdPopover.hidden &&
        !el.holdPopover.contains(target) &&
        !el.holdSettingsButton.contains(target)) {
      el.holdPopover.hidden = true;
    }

    if (!el.adsrPopover.hidden &&
        !el.adsrPopover.contains(target) &&
        !el.adsrButton.contains(target)) {
      el.adsrPopover.hidden = true;
      el.adsrButton.classList.remove("selected");
    }

    if (!el.outputPopover.hidden &&
        !el.outputPopover.contains(target) &&
        !el.outputSettingsButton.contains(target)) {
      el.outputPopover.hidden = true;
      el.outputSettingsButton.classList.remove("selected");
    }

    if (!el.sessionPopover.hidden &&
        !el.sessionPopover.contains(target) &&
        !el.sessionButton.contains(target)) {
      el.sessionPopover.hidden = true;
      el.sessionButton.classList.remove("selected");
    }

    if (!el.clipPopover.hidden &&
        !el.clipPopover.contains(target) &&
        !(target.closest && target.closest(".clip-edit-button"))) {
      closeClipEditor();
    }

    if (!el.midiPopover.hidden &&
        !el.midiPopover.contains(target) &&
        !el.midiButton.contains(target)) {
      closeMidiMenu();
    }
  });

  el.holdTime.addEventListener("input", () => {
    setHoldDuration(Number(el.holdTime.value));
  });

  ADSR_SLIDER_KEYS.forEach((key) => {
    el.adsrInputs[key].addEventListener("input", () => {
      adsr[key] = Number(el.adsrInputs[key].value);
      el.adsrValues[key].textContent = formatAdsrValue(key, adsr[key]);
      saveAdsr();
      drawAdsrGraph();
    });
  });

  el.droneButton.addEventListener("click", toggleDrone);

  el.addLayer.addEventListener("click", addLayer);
  el.removeLayer.addEventListener("click", removeLastLayer);

  el.holdButton.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    try {
      el.holdButton.setPointerCapture(event.pointerId);
    } catch (_) {
      // Capture is an enhancement; the gate still engages.
    }
    startGate("hold");
  });
  el.holdButton.addEventListener("pointerup", () => endGate("hold"));
  el.holdButton.addEventListener("pointercancel", () => endGate("hold"));

  window.addEventListener("keydown", (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.target.isContentEditable) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return;
    if (!KEY_GATES.has(event.code)) return;

    if (event.code === "Space") event.preventDefault();
    if (event.repeat) return;
    startGate(`k:${event.code}`);
  });

  window.addEventListener("keyup", (event) => {
    if (!KEY_GATES.has(event.code)) return;
    endGate(`k:${event.code}`);
  });

  window.addEventListener("blur", clearGates);

  window.addEventListener("resize", () => {
    layers.forEach((layer) => {
      if (layer.buffer) drawWaveform(layer, layer.buffer);
    });
    if (activeEditLayer && !el.clipPopover.hidden) {
      drawWaveform(
        activeEditLayer,
        activeEditLayer.originalBuffer,
        el.clipWaveformCanvas,
        el.clipWaveform
      );
    }
    drawAdsrGraph();
    positionClipEditor();
  });

  window.addEventListener("pointerdown", maybeInitMIDI, { once: true });
  window.addEventListener("keydown", maybeInitMIDI, { once: true });
}

// --- Boot ---------------------------------------------------- //

function init() {
  el.layersGrid = document.getElementById("layers-grid");
  if (!el.layersGrid) {
    throw new Error("TextureKeys: layers-grid element was not found.");
  }

  el.engineStatus = document.getElementById("engine-status");
  el.statusLight = document.getElementById("status-light");
  el.outputSettingsButton = document.getElementById("output-settings-button");
  el.outputSummary = document.getElementById("output-summary");
  el.outputPopover = document.getElementById("output-popover");
  el.closeOutputSettings = document.getElementById("close-output-settings");
  el.outputDeviceSelect = document.getElementById("output-device");
  el.outputModeInputs = Array.from(document.querySelectorAll('input[name="output-mode"]'));
  el.outputSupportNote = document.getElementById("output-support-note");

  el.midiButton = document.getElementById("midi-button");
  el.midiSummary = document.getElementById("midi-summary");
  el.midiPopover = document.getElementById("midi-popover");
  el.midiBackdrop = document.getElementById("midi-backdrop");
  el.closeMidiSettings = document.getElementById("close-midi-settings");
  el.midiDeviceList = document.getElementById("midi-device-list");
  el.midiStatus = document.getElementById("midi-status");
  el.midiRescan = document.getElementById("midi-rescan");

  el.holdSettingsButton = document.getElementById("hold-settings-button");
  el.holdValue = document.getElementById("hold-value");
  el.droneButton = document.getElementById("drone-button");
  el.droneStatus = document.getElementById("drone-status");
  el.layerCount = document.getElementById("layer-count");
  el.addLayer = document.getElementById("add-layer");
  el.removeLayer = document.getElementById("remove-layer");
  el.holdButton = document.getElementById("hold-button");
  el.holdLight = document.getElementById("hold-light");
  el.holdPopover = document.getElementById("hold-popover");
  el.closeHoldSettings = document.getElementById("close-hold-settings");
  el.holdPopoverValue = document.getElementById("hold-popover-value");
  el.holdTime = document.getElementById("hold-time");

  el.sessionButton = document.getElementById("session-button");
  el.sessionPopover = document.getElementById("session-popover");
  el.closeSessionSettings = document.getElementById("close-session-settings");
  el.sessionSaveFolder = document.getElementById("session-save-folder");
  el.sessionSaveZip = document.getElementById("session-save-zip");
  el.sessionLoadFolder = document.getElementById("session-load-folder");
  el.sessionLoadZip = document.getElementById("session-load-zip");
  el.sessionLoadDemo = document.getElementById("session-load-demo");
  el.sessionFolderInput = document.getElementById("session-folder-input");
  el.sessionZipInput = document.getElementById("session-zip-input");
  el.sessionStatus = document.getElementById("session-status");

  el.clipPopover = document.getElementById("clip-popover");
  el.closeClipEditor = document.getElementById("close-clip-editor");
  el.clipLayerLabel = document.getElementById("clip-layer-label");
  el.clipSampleName = document.getElementById("clip-sample-name");
  el.clipWaveform = document.getElementById("clip-waveform");
  el.clipWaveformCanvas = document.getElementById("clip-waveform-canvas");
  el.clipWaveTrimBefore = document.getElementById("clip-wave-trim-before");
  el.clipWaveTrimAfter = document.getElementById("clip-wave-trim-after");
  el.clipWaveFadeStart = document.getElementById("clip-wave-fade-start");
  el.clipWaveFadeEnd = document.getElementById("clip-wave-fade-end");
  el.clipTrimBar = document.getElementById("clip-trim-bar");
  el.clipTrimBefore = document.getElementById("clip-trim-before");
  el.clipTrimAfter = document.getElementById("clip-trim-after");
  el.clipTrimSelection = document.getElementById("clip-trim-selection");
  el.clipFadeStart = document.getElementById("clip-fade-start");
  el.clipFadeEnd = document.getElementById("clip-fade-end");
  el.clipStartHandle = document.getElementById("clip-handle-start");
  el.clipEndHandle = document.getElementById("clip-handle-end");
  el.clipLoopLength = document.getElementById("clip-loop-length");
  el.clipXfadeSlider = document.getElementById("clip-xfade");
  el.clipXfadeValue = document.getElementById("clip-xfade-value");
  el.clipLpfToggle = document.getElementById("clip-lpf-toggle");
  el.clipLpfSlider = document.getElementById("clip-lpf");
  el.clipLpfValue = document.getElementById("clip-lpf-value");
  el.clipNormalize = document.getElementById("clip-normalize");
  el.clipPeakValue = document.getElementById("clip-peak-value");

  el.adsrButton = document.getElementById("adsr-button");
  el.adsrPopover = document.getElementById("adsr-popover");
  el.closeAdsrSettings = document.getElementById("close-adsr-settings");
  el.adsrGraph = document.getElementById("adsr-graph");
  el.adsrInputs = {};
  el.adsrValues = {};
  ADSR_SLIDER_KEYS.forEach((key) => {
    el.adsrInputs[key] = document.getElementById(`adsr-${key}`);
    el.adsrValues[key] = document.getElementById(`adsr-${key}-value`);
  });

  loadAdsr();
  ADSR_SLIDER_KEYS.forEach((key) => {
    el.adsrInputs[key].value = String(adsr[key]);
    el.adsrValues[key].textContent = formatAdsrValue(key, adsr[key]);
  });

  const initialLayers = loadLayerSettings() || DEFAULT_NAMES.map((name, index) => ({
    name,
    db: DEFAULT_DB[index] ?? 0,
    isActive: true,
    isSolo: false
  }));

  initialLayers.forEach((settings, index) => {
    layers.push(createLayer(
      index,
      settings.name,
      settings.db,
      settings.isActive,
      settings.isSolo,
      settings.trimStart,
      settings.trimEnd,
      settings.crossfadeMs,
      settings.lpfEnabled,
      settings.lpfCutoffHz
    ));
  });

  loadAudioSettings();
  loadMidiSettings();
  updateOutputUI();
  updateMidiUI();
  bindGlobalControls();
  syncLayerChrome();
  holdDuration = loadHoldDuration();
  setHoldDuration(holdDuration);
  updateDroneUI();
  setEngineStatus("ready");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
