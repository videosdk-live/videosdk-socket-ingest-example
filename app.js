/**
 * VideoSDK Custom Socket Ingestion browser example.
 *
 * Demonstrates the full custom WebSocket (videosdk protocol) surface:
 *   - Create an ingest session (POST /v2/ingest/sessions)   [local testing only]
 *   - Connect the WebSocket and send the `start` frame
 *   - Capture the microphone, resample to 8 kHz mono PCM16, send `media` frames
 *   - Play room audio received as `media` frames
 *   - Pub/sub messaging: subscribe / unsubscribe / publish / receive
 *   - Send `stop` to end the session
 *
 * Audio format: 16-bit signed PCM, little-endian, 8 kHz mono, base64 encoded.
 */

const API_BASE = "https://api.videosdk.live";
const TARGET_RATE = 8000; // Hz
const FRAME_SAMPLES = 160; // 20 ms at 8 kHz
const PLAY_PRIME_SAMPLES = TARGET_RATE * 0.12; // buffer ~120 ms before playback starts

// ---- State ----
let ws = null;
let audioCtx = null;
let micStream = null;
let micSource = null;
let processor = null;
let silentGain = null;
let playNode = null;
let playBuf = new Float32Array(0);
let playPrimed = false;
let pendingOut = new Int16Array(0);
const subscribedTopics = new Set();

// ---- Helpers ----
const $ = (id) => document.getElementById(id);

function log(message, type = "info") {
  const line = document.createElement("div");
  line.className = `log-line log-${type}`;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  $("log").prepend(line);
}

function send(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function setConnected(on) {
  $("btnConnect").disabled = on;
  $("btnStop").disabled = !on;
  $("btnMic").disabled = !on;
  $("btnSubscribe").disabled = !on;
  $("btnUnsubscribe").disabled = !on;
  $("btnPublish").disabled = !on;
  $("status").textContent = on ? "Connected" : "Disconnected";
}

// ---- 1. Ingest session (local testing only; do NOT ship a token to the browser) ----
async function createSession() {
  const token = ((window.CONFIG && window.CONFIG.token) || "").trim();
  const roomId = $("roomId").value.trim();
  if (!token || token === "PASTE_YOUR_VIDEOSDK_TOKEN_HERE") {
    log("Set your VideoSDK token in config.js first.", "error");
    return;
  }
  if (!roomId) {
    log("Room ID is required.", "error");
    return;
  }

  const body = { roomId };
  const name = $("participantName").value.trim();
  if (name) body.participant = { name };

  try {
    log("Creating ingest session...");
    const res = await fetch(`${API_BASE}/v2/ingest/sessions`, {
      method: "POST",
      headers: {
        Authorization: `${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);

    $("wsUrl").value = data.data.wsUrl;
    log(
      `Session created. callId=${data.data.callId}, expiresIn=${data.data.expiresIn}s`,
      "success"
    );
  } catch (err) {
    log(
      `Failed to create session: ${err.message}. If this is a CORS error, create the session on your backend and paste the wsUrl below.`,
      "error"
    );
  }
}

// ---- 2. Connect ----
async function connect() {
  const wsUrl = $("wsUrl").value.trim();
  if (!wsUrl) {
    log("Enter or create a wsUrl first.", "error");
    return;
  }
  if (ws) {
    log("Already connected.", "error");
    return;
  }

  // Run the context at 8 kHz so playback buffers match the audio rate and are
  // not resampled per-frame (which causes clicks). The browser resamples the
  // microphone to this rate for us.
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: TARGET_RATE,
    });
  } catch {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  await audioCtx.resume();
  startPlayback();

  ws = new WebSocket(wsUrl);
  ws.onopen = () => {
    log("WebSocket open. Sending start frame.", "success");
    send({ event: "start" });
    setConnected(true);
    subscribedTopics.forEach((topic) => send({ event: "subscribe", topic }));
  };
  ws.onmessage = (event) => handleMessage(event.data);
  ws.onclose = (event) => {
    log(
      `WebSocket closed (code ${event.code}${event.reason ? ", " + event.reason : ""
      }).`,
      "error"
    );
    cleanup();
  };
  ws.onerror = () => log("WebSocket error.", "error");
}

function handleMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  if (msg.event === "media" && msg.payload) {
    enqueuePlayback(base64ToInt16(msg.payload));
  } else if (msg.event === "message") {
    const d = msg.data || {};
    log(`[${msg.topic}] ${d.senderName || d.senderId || "unknown"}: ${d.message}`, "message");
  }
}

function stopSession() {
  send({ event: "stop" });
  if (ws) ws.close();
  cleanup();
}

function cleanup() {
  stopMic();
  stopPlayback();
  if (ws) {
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
  }
  ws = null;
  setConnected(false);
}

// ---- Microphone capture -> 8 kHz mono PCM16 -> media frames ----
async function startMic() {
  if (!audioCtx) {
    log("Connect first.", "error");
    return;
  }
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
  } catch (err) {
    log(`Microphone error: ${err.message}`, "error");
    return;
  }

  micSource = audioCtx.createMediaStreamSource(micStream);
  const captureBufferSize = audioCtx.sampleRate <= 8000 ? 512 : 2048;
  processor = audioCtx.createScriptProcessor(captureBufferSize, 1, 1);
  silentGain = audioCtx.createGain();
  silentGain.gain.value = 0; // keep the graph alive without echoing to speakers

  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    const down = downsample(input, audioCtx.sampleRate, TARGET_RATE);
    pendingOut = concatInt16(pendingOut, floatToInt16(down));

    while (pendingOut.length >= FRAME_SAMPLES) {
      const frame = pendingOut.slice(0, FRAME_SAMPLES);
      pendingOut = pendingOut.slice(FRAME_SAMPLES);
      send({ event: "media", payload: int16ToBase64(frame) });
    }
  };

  micSource.connect(processor);
  processor.connect(silentGain);
  silentGain.connect(audioCtx.destination);

  $("btnMic").textContent = "Stop Microphone";
  log("Microphone streaming started.", "success");
}

function stopMic() {
  if (processor) {
    processor.disconnect();
    processor.onaudioprocess = null;
    processor = null;
  }
  if (silentGain) {
    silentGain.disconnect();
    silentGain = null;
  }
  if (micSource) {
    micSource.disconnect();
    micSource = null;
  }
  if (micStream) {
    micStream.getTracks().forEach((track) => track.stop());
    micStream = null;
  }
  pendingOut = new Int16Array(0);
  if ($("btnMic")) $("btnMic").textContent = "Start Microphone";
}

// ---- 3. Messaging (pub/sub) ----
function subscribe() {
  const topic = $("topic").value.trim();
  if (!topic) return;
  subscribedTopics.add(topic);
  send({ event: "subscribe", topic });
  log(`Subscribed to "${topic}".`);
}

function unsubscribe() {
  const topic = $("topic").value.trim();
  if (!topic) return;
  subscribedTopics.delete(topic);
  send({ event: "unsubscribe", topic });
  log(`Unsubscribed from "${topic}".`);
}

function publish() {
  const topic = $("topic").value.trim();
  const text = $("messageText").value.trim();
  if (!topic || !text) return;
  send({ event: "message", topic, data: text });
  log(`Published to "${topic}": ${text}`);
  $("messageText").value = "";
}

// ---- Audio utilities ----
function downsample(float32, inRate, outRate) {
  if (inRate === outRate) return Float32Array.from(float32);
  const ratio = inRate / outRate;
  const outLength = Math.floor(float32.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const idx = i * ratio;
    const i0 = Math.floor(idx);
    const i1 = Math.min(i0 + 1, float32.length - 1);
    const frac = idx - i0;
    out[i] = float32[i0] * (1 - frac) + float32[i1] * frac;
  }
  return out;
}

function floatToInt16(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function concatInt16(a, b) {
  const out = new Int16Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function int16ToBase64(int16) {
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToInt16(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2));
}

// Continuous playback. Incoming 8 kHz samples are queued and drained by a
// single playback node, so jitter produces smooth silence instead of the
// per-buffer clicks you get from scheduling many small AudioBufferSources.
function enqueuePlayback(int16) {
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 0x8000;
  const merged = new Float32Array(playBuf.length + float32.length);
  merged.set(playBuf, 0);
  merged.set(float32, playBuf.length);
  playBuf = merged;
}

function startPlayback() {
  if (!audioCtx || playNode) return;
  const step = TARGET_RATE / audioCtx.sampleRate; // 1 when the context is 8 kHz
  let readPos = 0;

  playNode = audioCtx.createScriptProcessor(1024, 0, 1);
  playNode.onaudioprocess = (event) => {
    const out = event.outputBuffer.getChannelData(0);

    // Jitter buffer: wait for a little audio before starting / after underrun.
    if (!playPrimed) {
      if (playBuf.length < PLAY_PRIME_SAMPLES) {
        out.fill(0);
        return;
      }
      playPrimed = true;
      readPos = 0;
    }

    for (let i = 0; i < out.length; i++) {
      const i0 = Math.floor(readPos);
      if (i0 + 1 < playBuf.length) {
        const frac = readPos - i0;
        out[i] = playBuf[i0] * (1 - frac) + playBuf[i0 + 1] * frac;
        readPos += step;
      } else {
        out[i] = 0; // underrun: output silence and re-prime
        playPrimed = false;
      }
    }

    const consumed = Math.floor(readPos);
    if (consumed > 0) {
      playBuf = playBuf.slice(consumed);
      readPos -= consumed;
    }
  };
  playNode.connect(audioCtx.destination);
}

function stopPlayback() {
  if (playNode) {
    playNode.disconnect();
    playNode.onaudioprocess = null;
    playNode = null;
  }
  playBuf = new Float32Array(0);
  playPrimed = false;
}

// ---- Wire up ----
window.addEventListener("DOMContentLoaded", () => {
  $("btnCreate").addEventListener("click", createSession);
  $("btnConnect").addEventListener("click", connect);
  $("btnStop").addEventListener("click", stopSession);
  $("btnMic").addEventListener("click", () => (micStream ? stopMic() : startMic()));
  $("btnSubscribe").addEventListener("click", subscribe);
  $("btnUnsubscribe").addEventListener("click", unsubscribe);
  $("btnPublish").addEventListener("click", publish);

  if (window.CONFIG && window.CONFIG.roomId) {
    $("roomId").value = window.CONFIG.roomId;
  }
  setConnected(false);
});
