
const holdSlider = document.getElementById("holdTime");
const holdValue = document.getElementById("holdValue");
const latchButton = document.getElementById("latchButton");
const latchDetail = document.getElementById("latchDetail");
const holdButton = document.getElementById("holdButton");
const engineStatus = document.getElementById("engineStatus");
const engineDetail = document.getElementById("engineDetail");
const statusIndicator = document.getElementById("statusIndicator");

const masterVolume = document.getElementById("masterVolume");
const masterValue = document.getElementById("masterValue");

let latchOn = false;
let touchHold = false;
let heldKeys = new Set();
let holdTimer = null;
let timerEnd = null;
let timerInterval = null;

let engineState = "inactive";

function isInputActive() {
  return heldKeys.size > 0 || touchHold;
}

function clearHoldTimer() {
  if (holdTimer) {
    clearTimeout(holdTimer);
    holdTimer = null;
  }

  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }

  timerEnd = null;
}

function setEngineState(state, detail) {
  engineState = state;

  document.body.classList.remove("active", "timer");

  if (state === "active") {
    document.body.classList.add("active");
  }

  if (state === "timer") {
    document.body.classList.add("timer");
  }

  engineStatus.textContent = {
    active: "ENGINE ACTIVE",
    timer: "HOLD TIMER",
    releasing: "RELEASING",
    inactive: "ENGINE INACTIVE"
  }[state];

  engineDetail.textContent = detail;

  statusIndicator.title = state;
}

function activateEngine(detail = "Texture controls active") {
  clearHoldTimer();
  setEngineState("active", detail);
}

function beginHoldTimer() {
  if (latchOn || isInputActive()) {
    return;
  }

  clearHoldTimer();

  const duration = Number(holdSlider.value);

  if (duration === 0) {
    setEngineState("releasing", "Hold complete");
    setTimeout(() => {
      if (!latchOn && !isInputActive()) {
        setEngineState("inactive", "Ready for activation");
      }
    }, 250);
    return;
  }

  timerEnd = Date.now() + duration;
  setEngineState("timer", `Fading in ${duration} ms`);

  timerInterval = setInterval(() => {
    const remaining = Math.max(0, timerEnd - Date.now());

    engineDetail.textContent = `Fading in ${Math.ceil(remaining)} ms`;

    if (remaining <= 0) {
      clearHoldTimer();
    }
  }, 20);

  holdTimer = setTimeout(() => {
    holdTimer = null;

    if (!latchOn && !isInputActive()) {
      setEngineState("releasing", "Hold complete");

      setTimeout(() => {
        if (!latchOn && !isInputActive() && engineState === "releasing") {
          setEngineState("inactive", "Ready for activation");
        }
      }, 250);
    }
  }, duration);
}

function updateActivation() {
  if (latchOn) {
    activateEngine("Latch enabled · Infinite sustain");
    return;
  }

  if (isInputActive()) {
    let detail = "Keyboard held";

    if (touchHold && heldKeys.size > 0) {
      detail = "Touch + keyboard held";
    } else if (touchHold) {
      detail = "Touch Hold active";
    }

    activateEngine(detail);
    return;
  }

  if (engineState === "active") {
    beginHoldTimer();
  }
}

// Global Hold Time
holdSlider.addEventListener("input", () => {
  holdValue.textContent = holdSlider.value;

  if (engineState === "timer") {
    beginHoldTimer();
  }
});

// Latch
latchButton.addEventListener("click", () => {
  latchOn = !latchOn;
  latchButton.classList.toggle("active", latchOn);
  latchButton.setAttribute("aria-pressed", String(latchOn));

  latchDetail.textContent = latchOn
    ? "Infinite sustain on"
    : "Infinite sustain off";

  updateActivation();
});

// Touch / Mouse Hold
holdButton.addEventListener("pointerdown", (event) => {
  event.preventDefault();

  touchHold = true;
  holdButton.classList.add("pressed");

  try {
    holdButton.setPointerCapture(event.pointerId);
  } catch (_) {}

  updateActivation();
});

function releaseTouchHold() {
  if (!touchHold) return;

  touchHold = false;
  holdButton.classList.remove("pressed");
  updateActivation();
}

holdButton.addEventListener("pointerup", releaseTouchHold);
holdButton.addEventListener("pointercancel", releaseTouchHold);
holdButton.addEventListener("lostpointercapture", releaseTouchHold);

// Computer keyboard
window.addEventListener("keydown", (event) => {
  if (event.repeat) return;

  if (
    event.target instanceof HTMLElement &&
    (event.target.isContentEditable ||
      ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName))
  ) {
    return;
  }

  // Ignore modifier keys and common browser shortcuts.
  if (event.metaKey || event.ctrlKey || event.altKey) return;

  heldKeys.add(event.code);
  updateActivation();
});

window.addEventListener("keyup", (event) => {
  heldKeys.delete(event.code);
  updateActivation();
});

// Prevent stuck notes if window loses focus.
window.addEventListener("blur", () => {
  heldKeys.clear();
  touchHold = false;
  holdButton.classList.remove("pressed");
  updateActivation();
});

// Master volume
masterVolume.addEventListener("input", () => {
  masterValue.textContent = `${masterVolume.value}%`;
});

// Layer controls
document.querySelectorAll(".layer-card").forEach((card) => {
  const enableButton = card.querySelector(".enable-button");
  const muteButton = card.querySelector(".mute-button");
  const soloButton = card.querySelector(".solo-button");
  const volumeSlider = card.querySelector(".layer-volume");
  const volumeValue = card.querySelector(".layer-volume-value");

  enableButton.addEventListener("click", () => {
    enableButton.classList.toggle("active");
    card.classList.toggle("disabled");
  });

  muteButton.addEventListener("click", () => {
    muteButton.classList.toggle("active");
  });

  soloButton.addEventListener("click", () => {
    soloButton.classList.toggle("active");

    const anySolo = [...document.querySelectorAll(".solo-button")]
      .some((button) => button.classList.contains("active"));

    document.querySelectorAll(".layer-card").forEach((otherCard) => {
      const otherSolo = otherCard.querySelector(".solo-button")
        .classList.contains("active");

      otherCard.classList.toggle("solo-dim", anySolo && !otherSolo);
    });
  });

  volumeSlider.addEventListener("input", () => {
    volumeValue.textContent = `${volumeSlider.value}%`;
  });
});

// Initial state
setEngineState("inactive", "Ready for activation");
masterValue.textContent = `${masterVolume.value}%`;
holdValue.textContent = holdSlider.value;
