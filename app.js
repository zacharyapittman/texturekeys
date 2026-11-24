
const layerSettings = [
  { name: "Layer One", db: -6 },
  { name: "Layer Two", db: -12 },
  { name: "Layer Three", db: -18 },
  { name: "Layer Four", db: -24 }
];

const layersGrid = document.getElementById("layers-grid");

if (!layersGrid) {
  throw new Error("TextureKeys: layers-grid element was not found.");
}

const layers = layerSettings.map((settings, index) => {
  const card = document.createElement("article");
  card.className = "layer-card";
  card.dataset.layer = index + 1;

  card.innerHTML = `
    <div class="layer-header">
      <div class="layer-heading">
        <span class="layer-number">0${index + 1}</span>
        <h2>${settings.name}</h2>
      </div>
      <button class="sample-button" type="button">+ LOAD SAMPLE</button>
    </div>

    <div class="sample-name">No sample loaded</div>
    <div class="waveform-placeholder">LOAD AUDIO SAMPLE</div>

    <div class="fader-section">
      <span class="fader-label">VOLUME</span>

      <div class="fader-unit">
        <div class="db-scale" aria-hidden="true"></div>

        <div class="fader-track"
          role="slider"
          tabindex="0"
          aria-label="${settings.name} volume"
          aria-valuemin="-60"
          aria-valuemax="0"
          aria-orientation="vertical">
          <div class="fader-fill"></div>
          <div class="fader-cap"></div>
        </div>
      </div>

      <div class="fader-readout"></div>
    </div>

    <div class="layer-buttons">
      <button class="layer-action mute-button" type="button"
        aria-pressed="false">MUTE</button>
      <button class="layer-action solo-button" type="button"
        aria-pressed="false">SOLO</button>
    </div>
  `;

  layersGrid.appendChild(card);

  return {
    card,
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
});

// Fader scale

const TICKS = [0, -3, -6, -12, -18, -24, -36, -60];

function positionFromDb(db) {
  return Math.sqrt(Math.abs(db) / 60);
}

function dbFromPosition(position) {
  return -60 * position * position;
}

function formatDb(db) {
  if (db <= -59.5) return "−∞ dB";
  return `${db.toFixed(1)} dB`;
}

function drawFader(layer) {
  const trackHeight = layer.track.clientHeight;

  if (!trackHeight) return;

  const position = positionFromDb(layer.db);

  // Keep the cap fully inside the track.
  const inset = 8;
  const usableHeight = trackHeight - inset * 2;
  const y = inset + position * usableHeight;

  layer.cap.style.top = `${y}px`;
  layer.fill.style.height = `${trackHeight - y}px`;

  layer.readout.textContent = formatDb(layer.db);

  layer.track.setAttribute("aria-valuenow", layer.db.toFixed(1));
  layer.track.setAttribute("aria-valuetext", formatDb(layer.db));

  layer.scale.innerHTML = "";

  TICKS.forEach((tick, index) => {
    const mark = document.createElement("span");
    mark.className = "db-tick";

    if (index === 0) mark.classList.add("top");
    if (index === TICKS.length - 1) mark.classList.add("bottom");
    if (tick === 0) mark.classList.add("unity");

    const tickPosition = positionFromDb(tick);
    mark.style.top = `${inset + tickPosition * usableHeight}px`;
    mark.textContent = tick === -60 ? "−∞" : String(tick);

    layer.scale.appendChild(mark);
  });
}

function setFaderFromPointer(layer, clientY) {
  const rect = layer.track.getBoundingClientRect();
  const inset = 8;
  const usableHeight = rect.height - inset * 2;

  const position = Math.max(
    0,
    Math.min(1, (clientY - rect.top - inset) / usableHeight)
  );

  layer.db = position >= 0.999 ? -60 : dbFromPosition(position);

  drawFader(layer);
}

// Initialize faders and layer buttons.

layers.forEach(layer => {
  drawFader(layer);

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

    if (event.key === "ArrowUp" || event.key === "ArrowRight") {
      nextDb = Math.min(0, layer.db + 1);
    } else if (event.key === "ArrowDown" || event.key === "ArrowLeft") {
      nextDb = Math.max(-60, layer.db - 1);
    } else if (event.key === "PageUp") {
      nextDb = Math.min(0, layer.db + 6);
    } else if (event.key === "PageDown") {
      nextDb = Math.max(-60, layer.db - 6);
    } else if (event.key === "Home") {
      nextDb = 0;
    } else if (event.key === "End") {
      nextDb = -60;
    } else {
      return;
    }

    event.preventDefault();
    layer.db = nextDb;
    drawFader(layer);
  });

  layer.muteButton.addEventListener("click", () => {
    layer.muted = !layer.muted;
    layer.muteButton.classList.toggle("active", layer.muted);
    layer.card.classList.toggle("muted", layer.muted);
    layer.muteButton.setAttribute("aria-pressed", layer.muted);
  });

  layer.soloButton.addEventListener("click", () => {
    layer.solo = !layer.solo;
    layer.soloButton.classList.toggle("active", layer.solo);
    layer.soloButton.setAttribute("aria-pressed", layer.solo);
  });
});

// Global activation and hold timer

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
let midiNotes = new Set();
let sustainDown = false;

function hasLiveInput() {
  return touchHeld || midiNotes.size > 0 || sustainDown;
}

function cancelHoldTimer() {
  if (holdTimer !== null) {
    clearTimeout(holdTimer);
    holdTimer = null;
  }
}

function updateIndicators(state) {
  const live = hasLiveInput();

  holdLight.classList.toggle("active", live);
  holdButton.classList.toggle("pressed", live);

  statusLight.classList.toggle("active", live || latchEnabled);
  statusLight.classList.toggle("fading", state === "fading");

  if (live) {
    engineStatus.textContent = "ACTIVE";
  } else if (latchEnabled) {
    engineStatus.textContent = "LATCHED";
  } else if (state === "fading") {
    engineStatus.textContent = "RELEASING";
  } else {
    engineStatus.textContent = "READY";
  }
}

function startReleaseTimer() {
  cancelHoldTimer();

  if (latchEnabled || hasLiveInput()) {
    updateIndicators("active");
    return;
  }

  if (holdDuration === 0) {
    updateIndicators("idle");
    return;
  }

  updateIndicators("fading");

  holdTimer = setTimeout(() => {
    holdTimer = null;

    if (!hasLiveInput() && !latchEnabled) {
      updateIndicators("idle");
    }
  }, holdDuration);
}

function activationChanged() {
  if (hasLiveInput()) {
    cancelHoldTimer();
    updateIndicators("active");
  } else {
    startReleaseTimer();
  }
}

// Touchscreen Hold

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

// Latch

latchButton.addEventListener("click", () => {
  latchEnabled = !latchEnabled;

  latchStatus.textContent = latchEnabled ? "ON" : "OFF";
  latchButton.classList.toggle("selected", latchEnabled);

  activationChanged();
});

// Hold Time popover

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
  if (
    !holdPopover.hidden &&
    !holdPopover.contains(event.target) &&
    !holdSettingsButton.contains(event.target)
  ) {
    holdPopover.hidden = true;
  }
});

holdTimeSlider.addEventListener("input", () => {
  holdDuration = Number(holdTimeSlider.value);
  updateHoldDisplay();

  if (!hasLiveInput() && !latchEnabled && holdTimer !== null) {
    startReleaseTimer();
  }
});

updateHoldDisplay();

// MIDI input

async function connectMidi() {
  if (!navigator.requestMIDIAccess) {
    return;
  }

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
        } else if (
          command === 0x80 ||
          (command === 0x90 && data2 === 0)
        ) {
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
      if (
        event.port.type === "input" &&
        event.port.state === "connected"
      ) {
        attachInput(event.port);
      }

      if (
        event.port.type === "input" &&
        event.port.state === "disconnected"
      ) {
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

// Redraw faders if their dimensions change.

if ("ResizeObserver" in window) {
  const resizeObserver = new ResizeObserver(() => {
    layers.forEach(drawFader);
  });

  layers.forEach(layer => resizeObserver.observe(layer.track));
}
