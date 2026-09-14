"use strict";

/* ============================================================
   DOM ELEMENTS
   ============================================================ */

const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");

const localPlaceholder = document.getElementById("localPlaceholder");
const remotePlaceholder = document.getElementById("remotePlaceholder");

const startButton = document.getElementById("startButton");
const stopButton = document.getElementById("stopButton");
const nextButton = document.getElementById("nextButton");
const recordButton = document.getElementById("recordButton");

const chatToggleButton = document.getElementById("chatToggleButton");
const reportButton = document.getElementById("reportButton");

const statusElement = document.getElementById("status");
const onlineCountElement = document.getElementById("onlineCountText");

const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");
const chatMessages = document.getElementById("chatMessages");
const sendChatButton = document.getElementById("sendChatButton");

const reportModalBackdrop = document.getElementById("reportModalBackdrop");
const cancelReportButton = document.getElementById("cancelReportButton");
const submitReportButton = document.getElementById("submitReportButton");

const recordingStatus = document.getElementById("recordingStatus");
const recordingTime = document.getElementById("recordingTime");

const recordingResultBackdrop = document.getElementById("recordingResultBackdrop");
const recordingResultText = document.getElementById("recordingResultText");
const recordingLocalNote = document.getElementById("recordingLocalNote");
const recordingPreview = document.getElementById("recordingPreview");
const downloadRecordingButton = document.getElementById("downloadRecordingButton");
const deleteRecordingButton = document.getElementById("deleteRecordingButton");
const platformOptions = document.getElementById("platformOptions");
const platformFormatNote = document.getElementById("platformFormatNote");


/* ============================================================
   WEBRTC CONFIGURATION
   ============================================================ */

const rtcConfiguration = {
  iceServers: [
    { urls: "stun:free.expressturn.com:3478" },
    {
      urls: [
        "turn:free.expressturn.com:3478?transport=udp",
        "turn:free.expressturn.com:3478?transport=tcp"
      ],
      username: "000000002103732653",
      credential: "rgTyOIK/8pVvQzdnm7e5jave1MA="
    }
  ],
  iceTransportPolicy: "all"
};


/* ============================================================
   STATE
   ============================================================ */

let localStream = null;
let peerConnection = null;
let socket = null;
let chatChannel = null;
let pendingIceCandidates = [];
let hasStartedCamera = false;
let isMatched = false;
let chatEnabled = true;

// Anonymous browser ID used only for moderation and admin actions.
// It contains no name, email, IP address, or other personal data.
let browserUserId = localStorage.getItem("lela_browser_id");
if (!browserUserId || !/^[A-Za-z0-9_-]{16,128}$/.test(browserUserId)) {
  if (window.crypto && crypto.randomUUID) {
    browserUserId = crypto.randomUUID().replace(/-/g, "");
  } else {
    browserUserId = `${Date.now()}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;
  }
  localStorage.setItem("lela_browser_id", browserUserId);
}

// Local-only encounter recording state.
// Recording bytes are never sent to the server.
let mediaRecorder = null;
let recordingChunks = [];
let recordingCanvas = null;
let recordingContext = null;
let recordingCanvasStream = null;
let recordingAnimationFrame = null;
let recordingTimer = null;
let recordingStartedAt = 0;
let recordingElapsedMs = 0;

let recordingAudioContext = null;
let recordingAudioDestination = null;
let recordingAudioSources = [];

let completedRecordingBlob = null;
let completedRecordingUrl = null;
let completedRecordingDurationSeconds = 0;
let selectedExportPlatform = "tiktok";
let exportInProgress = false;

/* ============================================================
   DEBUG & STATUS
   ============================================================ */

function debug(...args) {
  console.log("[HEY]", ...args);
}

function setStatus(message) {
  statusElement.textContent = message;
  debug(message);
}


/* ============================================================
   UI STATE HELPERS
   ============================================================ */

function updateVideoPlaceholders() {
  localPlaceholder.style.display = localStream ? "none" : "flex";
  remotePlaceholder.style.display = remoteVideo.srcObject ? "none" : "flex";
}

function updateMatchButtons() {
  nextButton.disabled = !isMatched;
  reportButton.disabled = !isMatched;
  chatToggleButton.disabled = !isMatched;
  recordButton.disabled = !isMatched;
  updateRecordButton();

  if (isMatched) {
    chatToggleButton.innerHTML = chatEnabled
      ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg> Chat: ON`
      : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg> Chat: OFF`;
  }
}

function updateStopButton() {
  stopButton.disabled = !hasStartedCamera;
}

/* Applies the chat ON/OFF state to the chat panel:
   - blocks typing when OFF (disabled input, no sends)
   - greys out input row & message history
   - both users can still type while chat is ON on their side */
function applyChatState() {
  const chatPanel = document.querySelector(".chat-panel");
  if (chatPanel) {
    chatPanel.classList.toggle("chat-off", !chatEnabled);
  }
  chatInput.disabled = !chatEnabled;
  chatInput.placeholder = chatEnabled ? "Type a message..." : "Chat is off";
}


/* ============================================================
   LOCAL-ONLY VIDEO RECORDING
   ============================================================

   - Record starts immediately when the user presses Record.
   - No permission/consent popup is used.
   - The same button becomes Stop + live timer.
   - Stop Recording or Stop Camera finalizes the recording.
   - Next does NOT stop or pause the recording.
   - The saved clip contains only the two video feeds.
   - No recording badge, timer, chat overlay, or watermark is burned into the video.
   - The finished Blob is local to this browser until saved/deleted.
   ============================================================ */

function setRecordingIndicators(show) {
  if (!recordingStatus) {
    return;
  }

  recordingStatus.classList.toggle("show", show);

  if (!show && recordingTime) {
    recordingTime.textContent = "00:00";
  }
}


function getRecordingElapsedSeconds() {
  let elapsed = recordingElapsedMs;

  if (
    mediaRecorder &&
    mediaRecorder.state === "recording" &&
    recordingStartedAt
  ) {
    elapsed += Date.now() - recordingStartedAt;
  }

  return elapsed / 1000;
}

function formatRecordingTime(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const minutes =
    Math.floor(total / 60)
      .toString()
      .padStart(2, "0");
  const secs =
    (total % 60)
      .toString()
      .padStart(2, "0");

  return `${minutes}:${secs}`;
}

function updateRecordingTimer() {
  if (!mediaRecorder) {
    return;
  }

  const formatted =
    formatRecordingTime(
      getRecordingElapsedSeconds()
    );

  if (recordingTime) {
    recordingTime.textContent = formatted;
  }

  if (
    mediaRecorder.state ===
    "recording"
  ) {
    recordButton.textContent =
      `⏹ Stop ${formatted}`;

    recordButton.classList.add(
      "recording"
    );

    recordButton.disabled = false;
  }
}

function updateRecordButton() {
  if (!recordButton) {
    return;
  }

  if (
    mediaRecorder &&
    mediaRecorder.state === "recording"
  ) {
    const formatted =
      formatRecordingTime(
        getRecordingElapsedSeconds()
      );

    recordButton.textContent =
      `⏹ Stop ${formatted}`;

    recordButton.classList.add(
      "recording"
    );

    recordButton.disabled =
      false;

    return;
  }

  recordButton.textContent =
    "🔴 Record";

  recordButton.classList.remove(
    "recording"
  );

  recordButton.disabled =
    !isMatched;
}

function chooseRecordingFormat() {
  const candidates = [
    {
      mimeType: "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
      extension: "mp4"
    },
    {
      mimeType: "video/mp4",
      extension: "mp4"
    },
    {
      mimeType: "video/webm;codecs=vp9,opus",
      extension: "webm"
    },
    {
      mimeType: "video/webm;codecs=vp8,opus",
      extension: "webm"
    },
    {
      mimeType: "video/webm",
      extension: "webm"
    }
  ];

  const supported = candidates.find((item) =>
    MediaRecorder.isTypeSupported(item.mimeType)
  );

  return supported || {
    mimeType: "video/webm",
    extension: "webm"
  };
}


function drawRecordingFrame() {
  if (!recordingContext || !recordingCanvas) {
    return;
  }

  const width = recordingCanvas.width;
  const height = recordingCanvas.height;
  const gap = Math.round(width * 0.015);
  const cardWidth = Math.floor((width - gap) / 2);

  // Clean recording: only the two video feeds.
  // No recording badge, timer, chat overlay, or Hey watermark
  // is burned into the exported video.
  recordingContext.fillStyle = "#080a12";
  recordingContext.fillRect(0, 0, width, height);

  drawVideoToCanvas(
    remoteVideo,
    0,
    0,
    cardWidth,
    height
  );

  drawVideoToCanvas(
    localVideo,
    cardWidth + gap,
    0,
    cardWidth,
    height
  );

  // Keep drawing while MediaRecorder is active.
  if (mediaRecorder && mediaRecorder.state === "recording") {
    recordingAnimationFrame = requestAnimationFrame(
      drawRecordingFrame
    );
  }
}

function drawVideoToCanvas(
  video,
  x,
  y,
  width,
  height
) {
  if (
    !video ||
    video.readyState < 2 ||
    !video.videoWidth ||
    !video.videoHeight
  ) {
    recordingContext.fillStyle =
      "#121526";

    recordingContext.fillRect(
      x,
      y,
      width,
      height
    );

    return;
  }

  const sourceRatio =
    video.videoWidth /
    video.videoHeight;

  const targetRatio =
    width /
    height;

  let sx = 0;
  let sy = 0;
  let sw =
    video.videoWidth;

  let sh =
    video.videoHeight;

  if (sourceRatio > targetRatio) {
    sw =
      Math.round(
        video.videoHeight *
          targetRatio
      );

    sx =
      Math.round(
        (video.videoWidth -
          sw) / 2
      );

  } else {
    sh =
      Math.round(
        video.videoWidth /
          targetRatio
      );

    sy =
      Math.round(
        (video.videoHeight -
          sh) / 2
      );
  }

  recordingContext.drawImage(
    video,
    sx,
    sy,
    sw,
    sh,
    x,
    y,
    width,
    height
  );
}

function setupRecordingAudio() {
  const AudioContextClass =
    window.AudioContext ||
    window.webkitAudioContext;

  if (!AudioContextClass) {
    return null;
  }

  try {
    recordingAudioContext =
      new AudioContextClass();

    recordingAudioDestination =
      recordingAudioContext
        .createMediaStreamDestination();

    recordingAudioSources = [];

    const addStream =
      (stream) => {
        if (
          !stream ||
          !stream.getAudioTracks()
            .length
        ) {
          return;
        }

        try {
          const source =
            recordingAudioContext
              .createMediaStreamSource(
                stream
              );

          source.connect(
            recordingAudioDestination
          );

          recordingAudioSources.push(
            source
          );

        } catch (error) {
          console.warn(
            "[HEY] Could not add audio source:",
            error
          );
        }
      };

    addStream(localStream);
    addStream(
      remoteVideo.srcObject
    );

    if (
      recordingAudioContext.state ===
      "suspended"
    ) {
      recordingAudioContext
        .resume()
        .catch(() => {});
    }

    return (
      recordingAudioDestination
        .stream
        .getAudioTracks()[0] ||
      null
    );

  } catch (error) {
    console.warn(
      "[HEY] Could not create recording audio:",
      error
    );

    recordingAudioContext = null;
    recordingAudioDestination = null;
    recordingAudioSources = [];

    return null;
  }
}

async function startLocalRecording() {
  if (!isMatched) {
    return;
  }

  /*
    Never start a second recorder.
  */
  if (
    mediaRecorder &&
    (
      mediaRecorder.state ===
        "recording" ||
      mediaRecorder.state ===
        "paused"
    )
  ) {
    return;
  }

  if (!window.MediaRecorder) {
    alert(
      "Recording is not supported by this browser."
    );

    return;
  }

  if (
    !HTMLCanvasElement.prototype
      .captureStream
  ) {
    alert(
      "This browser cannot record the Hey video view."
    );

    return;
  }

  try {
    recordingCanvas =
      document.createElement(
        "canvas"
      );

    recordingCanvas.width =
      1280;

    recordingCanvas.height =
      720;

    recordingContext =
      recordingCanvas.getContext(
        "2d"
      );

    if (!recordingContext) {
      throw new Error(
        "Could not create recording canvas."
      );
    }

    recordingCanvasStream =
      recordingCanvas.captureStream(
        30
      );

    const audioTrack =
      setupRecordingAudio();

    if (audioTrack) {
      recordingCanvasStream.addTrack(
        audioTrack
      );
    }

    const recordingFormat =
      chooseRecordingFormat();

    try {
      mediaRecorder =
        new MediaRecorder(
          recordingCanvasStream,
          {
            mimeType:
              recordingFormat.mimeType,
            videoBitsPerSecond:
              3500000
          }
        );
    } catch (firstError) {
      console.warn(
        "[HEY] Preferred recording format unavailable; falling back to browser default:",
        firstError
      );

      mediaRecorder =
        new MediaRecorder(
          recordingCanvasStream,
          {
            videoBitsPerSecond:
              3500000
          }
        );
    }

    recordingChunks = [];
    recordingElapsedMs = 0;
    recordingStartedAt =
      Date.now();

    mediaRecorder.addEventListener(
      "dataavailable",
      (event) => {
        if (
          event.data &&
          event.data.size > 0
        ) {
          recordingChunks.push(
            event.data
          );
        }
      }
    );

    mediaRecorder.addEventListener(
      "error",
      (event) => {
        console.error(
          "[HEY] MediaRecorder error:",
          event.error || event
        );
      }
    );

    mediaRecorder.addEventListener(
      "stop",
      finishLocalRecording,
      { once: true }
    );

    /*
      Generate chunks frequently so the final
      preview can be built immediately.
    */
    mediaRecorder.start(500);

    setRecordingIndicators(true);

    updateRecordButton();

    sendMessage({
      type: "recording-started"
    });

    setStatus(
      "🔴 Recording encounter..."
    );

    recordingTimer =
      setInterval(
        updateRecordingTimer,
        250
      );

    drawRecordingFrame();

  } catch (error) {
    console.error(
      "[HEY] Could not start recording:",
      error
    );

    cleanupRecordingResources();

    mediaRecorder = null;
    recordingChunks = [];
    recordingStartedAt = 0;
    recordingElapsedMs = 0;

    setRecordingIndicators(false);

    updateRecordButton();

    alert(
      "Could not start recording on this browser."
    );
  }
}

function stopLocalRecording() {
  if (!mediaRecorder) {
    return;
  }

  if (
    mediaRecorder.state ===
      "recording" &&
    recordingStartedAt
  ) {
    recordingElapsedMs +=
      Date.now() -
      recordingStartedAt;
  }

  recordingStartedAt = 0;

  try {
    /*
      Ask the recorder to flush its last chunk.
    */
    if (
      mediaRecorder.state ===
      "recording"
    ) {
      mediaRecorder.requestData();
    }
  } catch (error) {
    console.warn(
      "[HEY] Could not flush final chunk:",
      error
    );
  }

  try {
    if (
      mediaRecorder.state !==
      "inactive"
    ) {
      mediaRecorder.stop();
    }
  } catch (error) {
    console.error(
      "[HEY] Could not stop recorder:",
      error
    );

    finishLocalRecording();

    return;
  }

  clearInterval(
    recordingTimer
  );

  recordingTimer = null;

  setRecordingIndicators(
    false
  );

  sendMessage({
    type: "recording-stopped"
  });

  setStatus(
    "Finishing recording..."
  );
}

function cleanupRecordingResources() {
  if (recordingAnimationFrame) {
    cancelAnimationFrame(
      recordingAnimationFrame
    );
  }

  recordingAnimationFrame = null;

  clearInterval(
    recordingTimer
  );

  recordingTimer = null;

  recordingAudioSources
    .forEach((source) => {
      try {
        source.disconnect();
      } catch (error) {}
    });

  recordingAudioSources = [];

  if (recordingAudioContext) {
    try {
      recordingAudioContext.close();
    } catch (error) {}
  }

  recordingAudioContext = null;
  recordingAudioDestination = null;
  recordingCanvasStream = null;
  recordingCanvas = null;
  recordingContext = null;
}

function formatBytes(bytes) {
  if (!bytes) {
    return "0 B";
  }

  const units = [
    "B",
    "KB",
    "MB",
    "GB"
  ];

  let size = bytes;
  let unitIndex = 0;

  while (
    size >= 1024 &&
    unitIndex <
      units.length - 1
  ) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(
    size >= 10 ||
      unitIndex === 0
      ? 0
      : 1
  )} ${units[unitIndex]}`;
}

function openRecordingResult(
  blob,
  durationSeconds
) {
  completedRecordingBlob =
    blob;

  completedRecordingDurationSeconds =
    Math.max(
      0,
      Math.round(
        durationSeconds
      )
    );

  if (completedRecordingUrl) {
    URL.revokeObjectURL(
      completedRecordingUrl
    );
  }

  completedRecordingUrl =
    URL.createObjectURL(
      blob
    );

  recordingPreview.src =
    completedRecordingUrl;

  recordingPreview.load();

  const durationText =
    formatRecordingTime(
      completedRecordingDurationSeconds
    );

  const formatLabel =
    blob.type.includes("mp4")
      ? "MP4"
      : "WebM";

  recordingResultText.textContent =
    `${durationText} encounter • ${formatBytes(
      blob.size
    )} • ${formatLabel} video • created locally on this device.`;

  recordingLocalNote.innerHTML =
    "🔒 <strong>Not uploaded.</strong> The recording is only in this browser right now. Tap <strong>Save to device</strong> to choose where you want the video stored.";

  selectedExportPlatform = "tiktok";
  updatePlatformSelection();

  downloadRecordingButton.textContent =
    "⬇ Download for TikTok";

  recordingResultBackdrop.classList.add(
    "show"
  );

  /*
    Do not autoplay with sound.
    The user has normal video controls to preview it.
  */
  recordingPreview.muted =
    false;
}

const EXPORT_PLATFORMS = {
  tiktok: {
    label: "TikTok",
    width: 1080,
    height: 1920,
    layout: "vertical",
    filename: "hey-tiktok",
    note: "Vertical 9:16 • optimized for short-form video"
  },
  instagram: {
    label: "Instagram Reels",
    width: 1080,
    height: 1920,
    layout: "vertical",
    filename: "hey-instagram-reel",
    note: "Vertical 9:16 • optimized for Reels"
  },
  shorts: {
    label: "YouTube Shorts",
    width: 1080,
    height: 1920,
    layout: "vertical",
    filename: "hey-youtube-short",
    note: "Vertical 9:16 • optimized for Shorts"
  },
  youtube: {
    label: "YouTube",
    width: 1920,
    height: 1080,
    layout: "horizontal",
    filename: "hey-youtube",
    note: "Horizontal 16:9 • standard YouTube video"
  },
  original: {
    label: "Original",
    width: 1280,
    height: 720,
    layout: "original",
    filename: "hey-encounter",
    note: "Original recording format"
  }
};

function updatePlatformSelection() {
  const config = EXPORT_PLATFORMS[selectedExportPlatform];
  if (!config) return;

  if (platformOptions) {
    platformOptions
      .querySelectorAll(".platform-option")
      .forEach((button) => {
        button.classList.toggle(
          "selected",
          button.dataset.platform === selectedExportPlatform
        );
      });
  }

  if (platformFormatNote) {
    platformFormatNote.textContent = config.note;
  }

  if (downloadRecordingButton && !exportInProgress) {
    downloadRecordingButton.textContent =
      `⬇ Download for ${config.label}`;
  }
}

function chooseExportRecordingFormat() {
  const candidates = [
    {
      mimeType: "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
      extension: "mp4"
    },
    {
      mimeType: "video/mp4",
      extension: "mp4"
    },
    {
      mimeType: "video/webm;codecs=vp9,opus",
      extension: "webm"
    },
    {
      mimeType: "video/webm;codecs=vp8,opus",
      extension: "webm"
    },
    {
      mimeType: "video/webm",
      extension: "webm"
    }
  ];

  return candidates.find((item) =>
    MediaRecorder.isTypeSupported(item.mimeType)
  ) || {
    mimeType: "video/webm",
    extension: "webm"
  };
}

function drawExportSourceFrame(ctx, video, config) {
  const width = config.width;
  const height = config.height;
  ctx.fillStyle = "#080a12";
  ctx.fillRect(0, 0, width, height);

  if (!video.videoWidth || !video.videoHeight) {
    return;
  }

  if (config.layout === "original") {
    drawCoverSource(ctx, video, 0, 0, width, height);
    return;
  }

  /*
    The original encounter recording is a clean horizontal canvas:
      left half  = stranger
      right half = you

    Social exports rebuild that clean source into the target aspect ratio.
  */
  const sourceHalfWidth = video.videoWidth / 2;

  if (config.layout === "vertical") {
    const gap = 18;
    const panelHeight = Math.floor((height - gap) / 2);

    drawSourceCropCover(
      ctx,
      video,
      0,
      0,
      sourceHalfWidth,
      video.videoHeight,
      0,
      0,
      width,
      panelHeight
    );

    drawSourceCropCover(
      ctx,
      video,
      sourceHalfWidth,
      0,
      sourceHalfWidth,
      video.videoHeight,
      0,
      panelHeight + gap,
      width,
      height - panelHeight - gap
    );

    return;
  }

  // 16:9 YouTube export: keep both people side-by-side.
  drawCoverSource(ctx, video, 0, 0, width, height);
}

function drawCoverSource(ctx, video, dx, dy, dw, dh) {
  drawSourceCropCover(
    ctx,
    video,
    0,
    0,
    video.videoWidth,
    video.videoHeight,
    dx,
    dy,
    dw,
    dh
  );
}

function drawSourceCropCover(
  ctx,
  video,
  sx,
  sy,
  sw,
  sh,
  dx,
  dy,
  dw,
  dh
) {
  const sourceRatio = sw / sh;
  const targetRatio = dw / dh;

  let cropWidth = sw;
  let cropHeight = sh;
  let cropX = sx;
  let cropY = sy;

  if (sourceRatio > targetRatio) {
    cropWidth = sh * targetRatio;
    cropX = sx + (sw - cropWidth) / 2;
  } else if (sourceRatio < targetRatio) {
    cropHeight = sw / targetRatio;
    cropY = sy + (sh - cropHeight) / 2;
  }

  ctx.drawImage(
    video,
    cropX,
    cropY,
    cropWidth,
    cropHeight,
    dx,
    dy,
    dw,
    dh
  );
}

async function createPlatformRecording(config) {
  if (!completedRecordingBlob) {
    throw new Error("No completed recording is available.");
  }

  if (config.layout === "original") {
    return completedRecordingBlob;
  }

  if (!window.MediaRecorder) {
    throw new Error("This browser cannot create a platform-specific video export.");
  }

  const sourceUrl = URL.createObjectURL(completedRecordingBlob);
  const sourceVideo = document.createElement("video");
  sourceVideo.src = sourceUrl;
  sourceVideo.playsInline = true;
  sourceVideo.muted = true;
  sourceVideo.preload = "auto";

  try {
    await new Promise((resolve, reject) => {
      sourceVideo.addEventListener("loadedmetadata", resolve, { once: true });
      sourceVideo.addEventListener("error", () => reject(new Error("Could not read the local recording.")), { once: true });
    });

    await sourceVideo.play();

    const canvas = document.createElement("canvas");
    canvas.width = config.width;
    canvas.height = config.height;
    const ctx = canvas.getContext("2d", { alpha: false });

    if (!ctx) {
      throw new Error("Could not create the export canvas.");
    }

    const canvasStream = canvas.captureStream(30);

    // Prefer the original recording's audio from the playback stream.
    let audioAdded = false;
    const captureStream =
      typeof sourceVideo.captureStream === "function"
        ? sourceVideo.captureStream()
        : typeof sourceVideo.mozCaptureStream === "function"
          ? sourceVideo.mozCaptureStream()
          : null;

    if (captureStream) {
      captureStream.getAudioTracks().forEach((track) => {
        try {
          canvasStream.addTrack(track.clone());
          audioAdded = true;
        } catch (e) {}
      });
    }

    let audioContext = null;
    let audioSource = null;
    let audioDestination = null;

    if (!audioAdded) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) {
        try {
          audioContext = new AudioContextClass();
          audioSource = audioContext.createMediaElementSource(sourceVideo);
          audioDestination = audioContext.createMediaStreamDestination();
          audioSource.connect(audioDestination);
          audioDestination.stream.getAudioTracks().forEach((track) => {
            canvasStream.addTrack(track);
          });
          if (audioContext.state === "suspended") {
            await audioContext.resume();
          }
        } catch (e) {
          console.warn("[HEY] Export audio track unavailable:", e);
        }
      }
    }

    const format = chooseExportRecordingFormat();
    let recorder;

    try {
      recorder = new MediaRecorder(canvasStream, {
        mimeType: format.mimeType,
        videoBitsPerSecond: config.layout === "vertical" ? 4500000 : 5000000
      });
    } catch (e) {
      recorder = new MediaRecorder(canvasStream, {
        videoBitsPerSecond: config.layout === "vertical" ? 4500000 : 5000000
      });
    }

    const chunks = [];

    recorder.addEventListener("dataavailable", (event) => {
      if (event.data && event.data.size > 0) {
        chunks.push(event.data);
      }
    });

    const done = new Promise((resolve, reject) => {
      recorder.addEventListener("stop", resolve, { once: true });
      recorder.addEventListener("error", () => reject(new Error("Platform export failed.")), { once: true });
    });

    const drawLoop = () => {
      if (!sourceVideo.paused && !sourceVideo.ended) {
        drawExportSourceFrame(ctx, sourceVideo, config);
        requestAnimationFrame(drawLoop);
      }
    };

    recorder.start(500);
    drawLoop();

    await new Promise((resolve) => {
      if (sourceVideo.ended) {
        resolve();
        return;
      }
      sourceVideo.addEventListener("ended", resolve, { once: true });
    });

    if (recorder.state !== "inactive") {
      recorder.stop();
    }

    await done;

    if (audioContext) {
      try { await audioContext.close(); } catch (e) {}
    }

    if (!chunks.length) {
      throw new Error("The browser returned no export video data.");
    }

    return new Blob(chunks, {
      type: recorder.mimeType || format.mimeType || "video/webm"
    });
  } finally {
    try { sourceVideo.pause(); } catch (e) {}
    sourceVideo.removeAttribute("src");
    sourceVideo.load();
    URL.revokeObjectURL(sourceUrl);
  }
}

async function saveBlobToDevice(blob, baseFilename) {
  const isMp4 = blob.type.includes("mp4");
  const extension = isMp4 ? "mp4" : "webm";
  const mimeType = isMp4 ? "video/mp4" : "video/webm";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${baseFilename}-${timestamp}.${extension}`;

  if (typeof window.showSaveFilePicker === "function") {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [
          {
            description: "Hey encounter video",
            accept: {
              [mimeType]: [`.${extension}`]
            }
          }
        ]
      });

      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();

      return { saved: true, extension };
    } catch (error) {
      if (error && error.name === "AbortError") {
        return { saved: false, cancelled: true };
      }
      console.warn("[HEY] Save picker unavailable; using normal download:", error);
    }
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();

  window.setTimeout(() => URL.revokeObjectURL(url), 3000);

  return { saved: true, extension };
}

async function saveCompletedRecording() {
  if (!completedRecordingBlob || exportInProgress) {
    if (!completedRecordingBlob) {
      setStatus("There is no completed recording to save.");
    }
    return;
  }

  const config = EXPORT_PLATFORMS[selectedExportPlatform];
  if (!config) return;

  exportInProgress = true;
  downloadRecordingButton.disabled = true;
  downloadRecordingButton.textContent = "⏳ Preparing video...";

  try {
    const exportBlob = await createPlatformRecording(config);

    if (!exportBlob || !exportBlob.size) {
      throw new Error("The browser created an empty video file.");
    }

    const result = await saveBlobToDevice(
      exportBlob,
      config.filename
    );

    if (result.cancelled) {
      return;
    }

    setStatus(
      `${config.label} video saved to your device.`
    );

    closeAndClearRecordingResult();

  } catch (error) {
    console.error("[HEY] Export/download error:", error);

    setStatus(
      "Could not prepare the video for download. The original recording is still available."
    );

    alert(
      "Sorry, this browser could not prepare that platform format. Try Original instead."
    );

  } finally {
    exportInProgress = false;
    downloadRecordingButton.disabled = false;
    updatePlatformSelection();
  }
}

function clearCompletedRecordingData() {
  if (recordingPreview) {
    recordingPreview.pause();
    recordingPreview.removeAttribute("src");
    recordingPreview.load();
  }

  if (completedRecordingUrl) {
    URL.revokeObjectURL(completedRecordingUrl);
  }

  completedRecordingBlob = null;
  completedRecordingUrl = null;
  completedRecordingDurationSeconds = 0;
}

function closeAndClearRecordingResult() {
  clearCompletedRecordingData();
  recordingResultBackdrop.classList.remove("show");
}

function deleteCompletedRecording() {
  closeAndClearRecordingResult();

  setStatus(
    "Recording deleted."
  );
}

function finishLocalRecording() {
  /*
    Capture all chunks that have already arrived.
  */

  const recorderMimeType =
    mediaRecorder?.mimeType ||
    "video/webm";

  const chunks =
    recordingChunks;

  recordingChunks = [];

  const durationSeconds =
    getRecordingElapsedSeconds();

  const blob =
    new Blob(
      chunks,
      {
        type:
          recorderMimeType
      }
    );

  mediaRecorder = null;

  clearInterval(
    recordingTimer
  );

  recordingTimer = null;

  if (recordingAnimationFrame) {
    cancelAnimationFrame(
      recordingAnimationFrame
    );
  }

  recordingAnimationFrame = null;

  cleanupRecordingResources();

  setRecordingIndicators(
    false
  );

  recordingStartedAt = 0;
  recordingElapsedMs = 0;

  updateRecordButton();

  if (!blob.size) {
    setStatus(
      "Recording finished, but the browser returned no video data."
    );

    return;
  }

  openRecordingResult(
    blob,
    durationSeconds
  );

  setStatus(
    "Your encounter is ready. Preview it, save it, or delete it."
  );
}

/* ============================================================
   WEBSOCKET SIGNALING
   ============================================================ */

function connectToSignalingServer() {
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const socketUrl = `${protocol}//${window.location.host}`;

  debug("Connecting to signaling server:", socketUrl);
  socket = new WebSocket(socketUrl);

  socket.addEventListener("open", () => {
    debug("Connected to signaling server");

    sendMessage({
      type: "identify",
      userId: browserUserId
    });
    if (hasStartedCamera) {
      setStatus("Connected. Looking for someone...");
    }
  });

  socket.addEventListener("message", async (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message.type === "banned") {
        setStatus("This account is currently banned.");
        hasStartedCamera = false;
        isMatched = false;
        updateMatchButtons();
        updateStopButton();

        if (localStream) {
          localStream.getTracks().forEach(track => {
            try { track.stop(); } catch {}
          });
        }
        localStream = null;
        localVideo.srcObject = null;
        remoteVideo.srcObject = null;
        updateVideoPlaceholders();

        return;
      }

      if (message.type === "report-submitted") {
        setStatus(`Report #${message.reportId} submitted.`);
        return;
      }

      if (message.type === "online-count") {
        if (onlineCountElement) {
          const count = Number.isFinite(Number(message.count)) ? Number(message.count) : 0;
          onlineCountElement.textContent = `${count}`;
        }
        return;
      }
      await handleSignalingMessage(message);
    } catch (error) {
      console.error("[HEY] Error handling server message:", error);
    }
  });

  socket.addEventListener("close", () => {
    socket = null;
    if (hasStartedCamera) {
      setStatus("Signaling server disconnected. Please try again.");
    }
  });

  socket.addEventListener("error", (error) => {
    console.error("[HEY] WebSocket error:", error);
  });
}

function sendMessage(message) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
    return true;
  }
  return false;
}


/* ============================================================
   CAMERA & WEBRTC LOGIC
   ============================================================ */

async function startCamera() {
  if (hasStartedCamera) return;

  try {
    setStatus("Requesting camera and microphone...");
    const stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true
    });

    localStream = stream;
    localVideo.srcObject = localStream;
    hasStartedCamera = true;
    startButton.disabled = true;

    updateStopButton();
    updateVideoPlaceholders();
    connectToSignalingServer();

    if (socket && socket.readyState === WebSocket.OPEN) {
      createPeerConnection();
      sendMessage({ type: "ready" });
      setStatus("Looking for someone...");
    } else {
      setStatus("Connecting to server...");
      const waitForSocket = setInterval(() => {
        if (!hasStartedCamera) {
          clearInterval(waitForSocket);
          return;
        }
        if (socket && socket.readyState === WebSocket.OPEN) {
          clearInterval(waitForSocket);
          createPeerConnection();
          sendMessage({ type: "ready" });
          setStatus("Looking for someone...");
        }
      }, 100);
    }
  } catch (error) {
    console.error("[HEY] Camera/microphone error:", error);
    hasStartedCamera = false;
    startButton.disabled = false;
    updateStopButton();
    setStatus("Could not access camera/microphone.");
    alert("Please allow camera and microphone access to proceed.");
  }
}

function createPeerConnection() {
  if (peerConnection) {
    try { peerConnection.close(); } catch (e) {}
  }

  pendingIceCandidates = [];
  peerConnection = new RTCPeerConnection(rtcConfiguration);

  if (localStream) {
    localStream.getTracks().forEach((track) => {
      peerConnection.addTrack(track, localStream);
    });
  }

  peerConnection.addEventListener("track", (event) => {
    if (event.streams && event.streams[0]) {
      remoteVideo.srcObject = event.streams[0];
      updateVideoPlaceholders();
    }
  });

  peerConnection.addEventListener("icecandidate", (event) => {
    if (event.candidate) {
      sendMessage({ type: "ice-candidate", candidate: event.candidate });
    }
  });

  peerConnection.addEventListener("iceconnectionstatechange", () => {
    if (!peerConnection) return;
    const state = peerConnection.iceConnectionState;
    if (state === "checking") setStatus("Connecting to stranger...");
    if (state === "connected" || state === "completed") setStatus("Connected!");
    if (state === "failed") setStatus("Video connection failed.");
  });

  peerConnection.addEventListener("datachannel", (event) => {
    setupChatChannel(event.channel);
  });
}

async function createOffer() {
  if (!peerConnection) return;
  try {
    if (!chatChannel) {
      const channel = peerConnection.createDataChannel("chat");
      setupChatChannel(channel);
    }
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    sendMessage({ type: "offer", offer: peerConnection.localDescription });
  } catch (error) {
    console.error("[HEY] Error creating offer:", error);
  }
}

async function handleOffer(offer) {
  if (!peerConnection) createPeerConnection();
  try {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    await processPendingIceCandidates();
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    sendMessage({ type: "answer", answer: peerConnection.localDescription });
  } catch (error) {
    console.error("[HEY] Error handling offer:", error);
  }
}

async function handleAnswer(answer) {
  if (!peerConnection) return;
  try {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
    await processPendingIceCandidates();
  } catch (error) {
    console.error("[HEY] Error handling answer:", error);
  }
}

async function handleIceCandidate(candidate) {
  if (!peerConnection) return;
  if (!peerConnection.remoteDescription || !peerConnection.remoteDescription.type) {
    pendingIceCandidates.push(candidate);
    return;
  }
  try {
    await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (error) {
    console.error("[HEY] Error adding candidate:", error);
  }
}

async function processPendingIceCandidates() {
  if (!peerConnection || !peerConnection.remoteDescription) return;
  const candidates = pendingIceCandidates;
  pendingIceCandidates = [];
  for (const candidate of candidates) {
    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {}
  }
}

async function handleSignalingMessage(message) {
  switch (message.type) {
    case "waiting":
      isMatched = false;
      updateMatchButtons();
      setStatus("Waiting for a stranger...");
      break;
    case "matched":
      isMatched = true;
      chatEnabled = true;

      clearChat();
      applyChatState();

      if (!peerConnection) {
        createPeerConnection();
      }

      updateMatchButtons();
      updateRecordButton();

      setStatus(
        "Matched! Connecting..."
      );

      break;
    case "create-offer":
      await createOffer();
      break;
    case "offer":
      await handleOffer(message.offer);
      break;
    case "answer":
      await handleAnswer(message.answer);
      break;
    case "ice-candidate":
      await handleIceCandidate(message.candidate);
      break;
    case "peer-disconnected":
      handlePeerDisconnected();
      break;
  }
}

function handlePeerDisconnected() {
  debug("Stranger disconnected.");

  /*
    Recording continues.
    The stranger area will show its placeholder until
    the next person connects.
  */

  isMatched = false;

  closeChatChannel();
  clearChat();

  if (peerConnection) {
    try {
      peerConnection.close();
    } catch (e) {}
  }

  peerConnection = null;
  pendingIceCandidates = [];

  remoteVideo.srcObject = null;

  updateVideoPlaceholders();
  updateMatchButtons();
  updateRecordButton();

  if (hasStartedCamera) {
    createPeerConnection();

    sendMessage({
      type: "ready"
    });

    setStatus(
      mediaRecorder
        ? "Stranger left. Recording continues while you find someone new..."
        : "Stranger left. Looking for someone new..."
    );
  }
}

function stopVideoChat() {
  /*
    Finalize any active recording.
    The result screen will appear after MediaRecorder
    emits its final Blob.
  */

  if (mediaRecorder) {
    stopLocalRecording();
  }

  sendMessage({
    type: "stop"
  });

  isMatched = false;
  updateMatchButtons();

  closeChatChannel();
  clearChat();

  if (localStream) {
    localStream
      .getTracks()
      .forEach((track) => {
        try {
          track.stop();
        } catch (error) {}
      });
  }

  localStream = null;

  if (peerConnection) {
    try {
      peerConnection.close();
    } catch (e) {}
  }

  peerConnection = null;

  remoteVideo.srcObject = null;
  localVideo.srcObject = null;

  hasStartedCamera = false;
  startButton.disabled = false;

  updateStopButton();
  updateVideoPlaceholders();

  if (!mediaRecorder) {
    setStatus(
      "Stopped. Click Start Camera when ready."
    );
  }
}

function nextStranger() {
  if (!hasStartedCamera) {
    return;
  }

  /*
    IMPORTANT:
    Next does NOT stop or pause recording.
    The same recording keeps running through the next match.
  */

  sendMessage({
    type: "skip"
  });

  isMatched = false;

  closeChatChannel();
  clearChat();

  if (peerConnection) {
    try {
      peerConnection.close();
    } catch (e) {}
  }

  peerConnection = null;
  remoteVideo.srcObject = null;

  updateVideoPlaceholders();
  updateMatchButtons();
  updateRecordButton();

  setStatus(
    mediaRecorder
      ? "Recording continues. Looking for someone new..."
      : "Looking for someone new..."
  );
}

/* ============================================================
   IN-VIDEO CHAT LOGIC & SMOOTH SCROLLING
   ============================================================ */

function setupChatChannel(channel) {
  chatChannel = channel;
  chatChannel.addEventListener("open", () => {
    chatEnabled = true;
    applyChatState();
    updateMatchButtons();
  });
  chatChannel.addEventListener("close", () => {
    chatChannel = null;
  });
  chatChannel.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message.type === "chat" && typeof message.text === "string") {
        addChatMessage(message.text, false);
      }
    } catch (e) {}
  });
}

function closeChatChannel() {
  if (chatChannel) {
    try { chatChannel.close(); } catch (e) {}
    chatChannel = null;
  }
}

function sendChatMessage() {
  // Guard: no typing/sending while chat is OFF, no channel, or not matched
  if (!chatEnabled) return;
  if (!chatChannel || chatChannel.readyState !== "open") return;
  if (chatInput.disabled) return;

  const text = chatInput.value.trim();
  if (!text) return;

  try {
    chatChannel.send(JSON.stringify({ type: "chat", text }));
    addChatMessage(text, true);
    chatInput.value = "";
  } catch (e) {}
}

/* mine=true  → purple bubble on the RIGHT (your message)
   mine=false → dark bubble on the LEFT  (stranger's message) */
function addChatMessage(text, mine) {
  const messageElement = document.createElement("div");
  messageElement.className = `chat-message ${mine ? "mine" : "theirs"}`;
  messageElement.textContent = text;

  chatMessages.appendChild(messageElement);

  // Trigger Smooth Auto-Scroll to bottom
  requestAnimationFrame(() => {
    chatMessages.scrollTo({
      top: chatMessages.scrollHeight,
      behavior: 'smooth'
    });
  });
}

function clearChat() {
  chatMessages.innerHTML = "";
}

function toggleChat() {
  chatEnabled = !chatEnabled;
  applyChatState();
  updateMatchButtons();
}


/* ============================================================
   REPORT MODAL & HOTKEYS
   ============================================================ */

function openReportModal() {
  if (isMatched) reportModalBackdrop.classList.add("show");
}

function closeReportModal() {
  reportModalBackdrop.classList.remove("show");
}

function submitReport() {
  if (!isMatched) { closeReportModal(); return; }
  const selected = document.querySelector('input[name="reportReason"]:checked');
  if (!selected) {
    alert("Please select a reason for the report.");
    return;
  }
  sendMessage({ type: "report", reason: selected.value });
  closeReportModal();
  alert("Thank you. Your report has been submitted.");
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && isMatched && hasStartedCamera) {
    nextStranger();
  }
});


/* ============================================================
   EVENT LISTENERS
   ============================================================ */

startButton.addEventListener("click", startCamera);
stopButton.addEventListener("click", stopVideoChat);
nextButton.addEventListener("click", nextStranger);
recordButton.addEventListener(
  "click",
  async () => {
    if (!isMatched) {
      return;
    }

    /*
      Before recording:
        🔴 Record

      During recording:
        ⏹ Stop 00:14

      Pressing the same button during recording
      ALWAYS stops the current recording.
    */

    if (
      mediaRecorder &&
      mediaRecorder.state ===
        "recording"
    ) {
      stopLocalRecording();
      return;
    }

    await startLocalRecording();
  }
);

chatToggleButton.addEventListener("click", toggleChat);
reportButton.addEventListener("click", openReportModal);
cancelReportButton.addEventListener("click", closeReportModal);
submitReportButton.addEventListener("click", submitReport);

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  sendChatMessage();
});

reportModalBackdrop.addEventListener("click", (event) => {
  if (event.target === reportModalBackdrop) closeReportModal();
});

platformOptions?.addEventListener("click", (event) => {
  const button = event.target.closest(".platform-option");
  if (!button || exportInProgress) return;

  selectedExportPlatform = button.dataset.platform || "original";
  updatePlatformSelection();
});

downloadRecordingButton.addEventListener(
  "click",
  saveCompletedRecording
);

deleteRecordingButton.addEventListener(
  "click",
  deleteCompletedRecording
);


/* ============================================================
   INITIALIZATION
   ============================================================ */

updateMatchButtons();
updateStopButton();
updateRecordButton();
updateVideoPlaceholders();
applyChatState();
setStatus("Click Start Camera to begin");
connectToSignalingServer();
