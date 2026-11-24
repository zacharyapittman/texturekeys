// TextureKeys interface prototype: dynamic layers, global hold and MIDI activation.

const INITIAL_LAYERS = [
  { name: "Layer One", db: -6 },
  { name: "Layer Two", db: -12 },
  { name: "Layer Three", db: -18 },
  { name: "Layer Four", db: -24 }
];

const MIN_LAYERS = 1;
const MAX_LAYERS = 8;
const NEW_LAYER_DB = -60;
const TICKS = [0, -3, -6, -12, -18, -24, -36, -60];

const layersGrid = document.getElementById("layers-grid");
const layerCount = document.getElementById("layer-count");
const addLayerButton = document.getElementById("add-layer");
const removeLayerButton = document.getElementById("remove-layer");

if (!layersGrid) throw new Error("TextureKeys: layers-grid element was not found.");

const layers = [];

function positionFromDb(db) {
  return Math.sqrt(Math.abs(db) / 60);
}

function dbFromPosition(position) {
  return -60 * position * position;
}

function formatDb(db) {
  return db <= -59.5 ? "−∞ dB" : `${db.toFixed(1)} dB`;
}

function drawFader(layer) {
  const trackHeight = layer.track.clientHeight;
  if (!trackHeight) return;

  const inset = 8;
  const usableHeight = Math.max(1, trackHeight - inset * 2);
  const y = inset + positionFromDb(layer.db) * usableHeight;

  layer.cap.style.top = `${y}px`;
  layer.fill.style.height = `${trackHeight - y}px`;
  layer.readout.textContent = formatDb(layer.db);
  layer.track.setAttribute("aria-valuenow", layer.db.toFixed(1));
  layer.track.setAttribute("aria-valuetext", formatDb(layer.db));

  layer.scale.replaceChildren();
  TICKS.forEach((tick, index) => {
    const mark = document.createElement("span");
    mark.className = "db-tick";
    if (index === 0) mark.classList.add("top");
    if (index === TICKS.length - 1) mark.classList.add("bottom");
    if (tick === 0) mark.classList.add("unity");
    mark.style.top = `${inset + positionFromDb(tick) * usableHeight}px`;
    mark.textContent = tick === -60 ? "−∞" : String(tick);
    layer.scale.appendChild(mark);
  });
}

function setFaderFromPointer(layer, clientY) {
  const rect = layer.track.getBoundingClientRect();
  const inset = 8;
  const usableHeight = Math.max(1, rect.height - inset * 2);
  const position = Math.max(0, Math.min(1, (clientY - rect.top - inset) / usableHeight));
  layer.db = position >= 0.999 ? -60 : dbFromPosition(position);
  drawFader(layer);
}

function updateLayerCount() {
  const count = layers.length;
  layerCount.textContent = `${count} ${count === 1 ? "LAYER" : "LAYERS"}`;
  layersGrid.style.setProperty("--layer-count", count);
  addLayerButton.disabled = count >= MAX_LAYERS;
  removeLayerButton.disabled = count <= MIN_LAYERS;
}

function createLayer(settings) {
  const number = layers.length + 1;
  const card = document.createElement("article");
  card.className = "layer-card";
  card.dataset.layer = number;

  card.innerHTML = `
    <div class="layer-header">
      <div class="layer-heading">
        <span class="layer-number">${String(number).padStart(2, "0")}</span>
        <h2></h2>
      </div>
      <button class="sample-button" type="button">+ LOAD SAMPLE</button>
    </div>
    <div class="sample-name">No sample loaded</div>
    <div class="waveform-placeholder">LOAD AUDIO SAMPLE</div>
    <div class="fader-section">
      <span class="fader-label">VOLUME</span>
      <div class="fader-unit">
        <div class="db-scale" aria-hidden="true"></div>
        <div class="fader-track" role="slider" tabindex="0"
          aria-valuemin="-60" aria-valuemax="0" aria-orientation="vertical">
          <div class="fader-fill"></div>
          <div class="fader-cap"></div>
        </div>
      </div>
      <div class="fader-readout"></div>
    </div>
    <div class="layer-buttons">
      <button class="layer-action mute-button" type="button" aria-pressed="false">MUTE</button>
      <button class="layer-action solo-button" type="button" aria-pressed="false">SOLO</button>
    </div>
  `;

  card.querySelector("h2").textContent = settings.name;
  card.querySelector(".fader-track").setAttribute("aria-label", `${settings.name} volume`);
  layersGrid.appendChild(card);

  const layer = {
    card,
    name: settings.name,
    db: settings.db,
    muted: false,
    solo: false,
    track: card.querySelector(".fader-track"),
    cap: card.querySelector(".fader-cap"),
    fill: card.querySelector(".fader-fill"),
    readout: card.querySelector(".fader-readout"),
    scale: card.querySelector(".db-scale"),
    muteButton: card.querySelector(".mute-button"),
    soloButton: card.querySelector(".solo-button")
  };

  layer.track.addEventListener("pointerdown", event => {
    event.preventDefault();
    layer.track.setPointerCapture(event.pointerId);
    setFaderFromPointer(layer, event.clientY);
  });

  layer.track.addEventListener("pointermove", event => {
    if (layer.track.hasPointerCapture(event.pointerId)) {
      setFaderFromPointer(layer, event.clientY);
    }
  });

  layer.track.addEventListener("keydown", event => {
    let nextDb = layer.db;
    if (event.key === "ArrowUp" || event.key === "ArrowRight") nextDb = Math.min(0, layer.db + 1);
    else if (event.key === "ArrowDown" || event.key === "ArrowLeft") nextDb = Math.max(-60, layer.db - 1);
    else if (event.key === "PageUp") nextDb = Math.min(0, layer.db + 6);
    else if (event.key === "PageDown") nextDb = Math.max(-60, layer.db - 6);
    else if (event.key === "Home") nextDb = 0;
    else if (event.key === "End") nextDb = -60;
    else return;
    event.preventDefault();
    layer.db = nextDb;
    drawFader(layer);
  });

  layer.muteButton.addEventListener("click", () => {
    layer.muted = !layer.muted;
    layer.muteButton.classList.toggle("active", layer.muted);
    layer.card.classList.toggle("muted", layer.muted);
    layer.muteButton.setAttribute("aria-pressed", String(layer.muted));
  });

  layer.soloButton.addEventListener("click", () => {
    layer.solo = !layer.solo;
    layer.soloButton.classList.toggle("active", layer.solo);
    layer.soloButton.setAttribute("aria-pressed", String(layer.solo));
  });

  layers.push(layer);
  drawFader(layer);
  updateLayerCount();
  return layer;
}

function addLayer() {
  if (layers.length >= MAX_LAYERS) return;
  const nextNumber = layers.length + 1;
  createLayer({ name: `Layer ${nextNumber}`, db: NEW_LAYER_DB });
}

function removeLayer() {
  if (layers.length <= MIN_LAYERS) return;
  const layer = layers.pop();
  layer.card.remove();
  updateLayerCount();
}

INITIAL_LAYERS.forEach(createLayer);
addLayerButton.addEventListener("click", addLayer);
removeLayerButton.addEventListener("click", removeLayer);
updateLayerCount();

// Global activation and hold timer.
const holdButton = document.getElementById("hold-button");
const holdLight = document.getElementById("hold-light");
const statusLight = document.getElementById("status-light");
const engineStatus = document.getElementById("engine-status");
const latchButton = document.getElementById("latch-button");
const latchStatus = document.getElementById("latch-status");

let touchHeld = false;
let latchEnabled = false;
let holdDuration = 1500;
let holdTimer = null;
let countdownTimer = null;
let releaseEndsAt = 0;
const midiNotes = new Set();
let sustainDown = false;

function hasLiveInput() {
  return touchHeld || midiNotes.size > 0 || sustainDown;
}

function clearReleaseTimers() {
  if (holdTimer !== null) clearTimeout(holdTimer);
  if (countdownTimer !== null) clearInterval(countdownTimer);
  holdTimer = null;
  countdownTimer = null;
  releaseEndsAt = 0;
}

function updateIndicators(state) {
  const live = hasLiveInput();
  holdLight.classList.toggle("active", live);
  holdButton.classList.toggle("pressed", live);
  statusLight.classList.toggle("active", live || latchEnabled);
  statusLight.classList.toggle("fading", state === "fading");

  if (live) engineStatus.textContent = "ACTIVE";
  else if (latchEnabled) engineStatus.textContent = "LATCHED";
  else if (state === "fading") {
    const remaining = Math.max(0, releaseEndsAt - Date.now());
    engineStatus.textContent = `RELEASING ${(remaining / 1000).toFixed(1)}s`;
  } else engineStatus.textContent = "READY";
}

function startReleaseTimer() {
  clearReleaseTimers();

  if (latchEnabled || hasLiveInput()) {
    updateIndicators("active");
    return;
  }
  if (holdDuration <= 0) {
    updateIndicators("idle");
    return;
  }

  releaseEndsAt = Date.now() + holdDuration;
  updateIndicators("fading");

  countdownTimer = setInterval(() => {
    if (hasLiveInput() || latchEnabled) {
      clearReleaseTimers();
      updateIndicators("active");
      return;
    }
    if (Date.now() >= releaseEndsAt) {
      clearReleaseTimers();
      updateIndicators("idle");
    } else {
      updateIndicators("fading");
    }
  }, 100);

  holdTimer = setTimeout(() => {
    clearReleaseTimers();
    if (!hasLiveInput() && !latchEnabled) updateIndicators("idle");
  }, holdDuration);
}

function activationChanged() {
  if (hasLiveInput()) {
    clearReleaseTimers();
    updateIndicators("active");
  } else {
    startReleaseTimer();
  }
}

// Touchscreen Hold.
holdButton.addEventListener("pointerdown", event => {
  event.preventDefault();
  holdButton.setPointerCapture(event.pointerId);
  touchHeld = true;
  activationChanged();
});

function releaseTouchHold() {
  if (!touchHeld) return;
  touchHeld = false;
  activationChanged();
}

holdButton.addEventListener("pointerup", releaseTouchHold);
holdButton.addEventListener("pointercancel", releaseTouchHold);
holdButton.addEventListener("lostpointercapture", releaseTouchHold);

// Latch.
latchButton.addEventListener("click", () => {
  latchEnabled = !latchEnabled;
  latchStatus.textContent = latchEnabled ? "ON" : "OFF";
  latchButton.classList.toggle("selected", latchEnabled);
  activationChanged();
});

// Hold Time popover.
const holdSettingsButton = document.getElementById("hold-settings-button");
const holdPopover = document.getElementById("hold-popover");
const closeHoldSettings = document.getElementById("close-hold-settings");
const holdTimeSlider = document.getElementById("hold-time");
const holdValue = document.getElementById("hold-value");
const holdPopoverValue = document.getElementById("hold-popover-value");

function updateHoldDisplay() {
  holdValue.textContent = `${(holdDuration / 1000).toFixed(1)}s`;
  holdPopoverValue.textContent = `${holdDuration} ms`;
}

holdSettingsButton.addEventListener("click", () => {
  holdPopover.hidden = !holdPopover.hidden;
});
closeHoldSettings.addEventListener("click", () => {
  holdPopover.hidden = true;
});
document.addEventListener("pointerdown", event => {
  if (!holdPopover.hidden &&
      !holdPopover.contains(event.target) &&
      !holdSettingsButton.contains(event.target)) {
    holdPopover.hidden = true;
  }
});
holdTimeSlider.addEventListener("input", () => {
  holdDuration = Number(holdTimeSlider.value);
  updateHoldDisplay();
  if (!hasLiveInput() && !latchEnabled && holdTimer !== null) startReleaseTimer();
});
updateHoldDisplay();

// MIDI input: any held piano note or sustain pedal activates the global engine.
async function connectMidi() {
  if (!navigator.requestMIDIAccess) return;

  try {
    const midi = await navigator.requestMIDIAccess();

    function attachInput(input) {
      input.onmidimessage = event => {
        const [status, data1, data2] = event.data;
        const command = status & 0xf0;
        const noteId = `${input.id}-${data1}`;

        if (command === 0x90 && data2 > 0) {
          midiNotes.add(noteId);
          activationChanged();
        } else if (command === 0x80 || (command === 0x90 && data2 === 0)) {
          midiNotes.delete(noteId);
          activationChanged();
        } else if (command === 0xb0 && data1 === 64) {
          sustainDown = data2 >= 64;
          activationChanged();
        }
      };
    }

    midi.inputs.forEach(attachInput);
    midi.onstatechange = event => {
      if (event.port.type === "input" && event.port.state === "connected") {
        attachInput(event.port);
      }
      if (event.port.type === "input" && event.port.state === "disconnected") {
        midiNotes.clear();
        sustainDown = false;
        activationChanged();
      }
    };
  } catch (error) {
    console.warn("TextureKeys could not access MIDI:", error);
  }
}

connectMidi();
updateIndicators("idle");

if ("ResizeObserver" in window) {
  const resizeObserver = new ResizeObserver(() => layers.forEach(drawFader));
  layers.forEach(layer => resizeObserver.observe(layer.track));
}
