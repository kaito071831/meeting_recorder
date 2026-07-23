// キャプチャUI: getDisplayMedia(タブ映像＋タブ音声=相手) + getUserMedia(マイク=自分) を
// 3つの MediaRecorder で別々に録音し、停止時にアップロードして SSE で進捗表示する。
// 話者分離のため音声トラックは合成しない（ソースベース）。共有タブの映像は
// タブ音声とあわせて画面録画（screen.webm、参照用）として保存する。

"use strict";

const els = {
  title: document.getElementById("title"),
  provider: document.getElementById("provider"),
  model: document.getElementById("model"),
  start: document.getElementById("start"),
  stop: document.getElementById("stop"),
  timer: document.getElementById("timer"),
  micLevel: document.getElementById("mic-level"),
  tabLevel: document.getElementById("tab-level"),
  statusList: document.getElementById("status-list"),
  resultCard: document.getElementById("result-card"),
  minutesOutput: document.getElementById("minutes-output"),
  downloadMinutes: document.getElementById("download-minutes"),
  downloadTranscript: document.getElementById("download-transcript"),
  downloadScreen: document.getElementById("download-screen"),
};

// ── 進捗表示 ──────────────────────────────────────────────
const STAGE_LABELS = {
  uploaded: "アップロード完了",
  transcribing_mic: "文字起こし中（自分／マイク）",
  transcribing_tab: "文字起こし中（相手・参加者／タブ音声）",
  merging: "時系列マージ中",
  generating_minutes: "議事録を生成中",
  done: "完了",
};

const statusItems = {};

function setStatus(key, label, state) {
  let li = statusItems[key];
  if (!li) {
    li = document.createElement("li");
    els.statusList.appendChild(li);
    statusItems[key] = li;
  }
  li.textContent = label;
  li.className = state || "";
}

function clearStatus() {
  els.statusList.innerHTML = "";
  for (const k of Object.keys(statusItems)) delete statusItems[k];
}

// ── プロバイダ一覧の読込 ──────────────────────────────────
let providersInfo = { claude: false, ollama: [] };

async function loadProviders() {
  try {
    const resp = await fetch("/api/providers");
    providersInfo = await resp.json();
  } catch (e) {
    providersInfo = { claude: false, ollama: [] };
  }
  els.provider.innerHTML = "";
  if (providersInfo.claude) {
    els.provider.appendChild(new Option("Claude (claude-opus-4-8)", "claude"));
  }
  if (providersInfo.ollama && providersInfo.ollama.length > 0) {
    els.provider.appendChild(new Option("Ollama (ローカル)", "ollama"));
  }
  if (els.provider.options.length === 0) {
    els.provider.appendChild(new Option("利用可能なプロバイダなし", ""));
    els.start.disabled = true;
  }
  updateModelOptions();
}

function updateModelOptions() {
  els.model.innerHTML = "";
  if (els.provider.value === "ollama") {
    els.model.disabled = false;
    for (const m of providersInfo.ollama) {
      els.model.appendChild(new Option(m, m));
    }
  } else {
    // Claude は既定モデル固定（サーバ側で解決）
    els.model.disabled = true;
    els.model.appendChild(new Option("(既定)", ""));
  }
}

els.provider.addEventListener("change", updateModelOptions);

// ── レベルメーター ────────────────────────────────────────
function attachMeter(stream, fillEl) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const ctx = new AudioCtx();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const buf = new Uint8Array(analyser.frequencyBinCount);
  let running = true;

  function tick() {
    if (!running) return;
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / buf.length);
    fillEl.style.width = Math.min(100, rms * 300).toFixed(0) + "%";
    requestAnimationFrame(tick);
  }
  tick();

  return () => {
    running = false;
    fillEl.style.width = "0%";
    ctx.close().catch(() => {});
  };
}

// ── 録音状態 ──────────────────────────────────────────────
let recorders = [];
let chunks = { mic: [], tab: [], screen: [] };
let streams = [];
let meterStops = [];
let timerId = null;
let startedAt = 0;

function pickMime() {
  const prefer = "audio/webm;codecs=opus";
  if (window.MediaRecorder && MediaRecorder.isTypeSupported(prefer)) return prefer;
  if (MediaRecorder.isTypeSupported("audio/webm")) return "audio/webm";
  return "";
}

function pickVideoMime() {
  const prefer = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  for (const m of prefer) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}

function startTimer() {
  startedAt = Date.now();
  timerId = setInterval(() => {
    const s = Math.floor((Date.now() - startedAt) / 1000);
    const mm = String(Math.floor(s / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    els.timer.textContent = `${mm}:${ss}`;
  }, 500);
}

function stopTimer() {
  if (timerId) clearInterval(timerId);
  timerId = null;
}

async function start() {
  clearStatus();
  els.resultCard.hidden = true;
  chunks = { mic: [], tab: [], screen: [] };
  recorders = [];
  streams = [];
  meterStops = [];

  // タブ音声（相手）: getDisplayMedia は video:true が必須。
  let displayStream;
  try {
    displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
    });
  } catch (e) {
    alert("画面共有がキャンセルされました。会議タブの共有が必要です。");
    return;
  }

  const tabAudioTracks = displayStream.getAudioTracks();
  if (tabAudioTracks.length === 0) {
    // タブ音声の共有忘れを検出してブロック
    displayStream.getTracks().forEach((t) => t.stop());
    alert(
      "タブの音声が共有されていません。もう一度「録音開始」を押し、共有ダイアログで会議タブを選び『タブの音声も共有』にチェックを入れてください。"
    );
    return;
  }
  // 画面録画用に displayStream（映像＋タブ音声）を保持する。
  // タブ音声は tab.webm 録音・レベルメーター用に別ストリームとしても使う
  // （音声トラックは複数の MediaStream / Recorder / Analyser から同時に消費できる）。
  const tabStream = new MediaStream(tabAudioTracks);

  // マイク（自分）
  let micStream;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (e) {
    displayStream.getTracks().forEach((t) => t.stop());
    alert("マイクにアクセスできませんでした。マイクの許可を確認してください。");
    return;
  }

  // displayStream（映像＋タブ音声）も後始末対象に含める
  streams = [displayStream, tabStream, micStream];
  meterStops = [
    attachMeter(micStream, els.micLevel),
    attachMeter(tabStream, els.tabLevel),
  ];

  const mime = pickMime();
  const opts = mime ? { mimeType: mime } : {};

  const micRec = new MediaRecorder(micStream, opts);
  const tabRec = new MediaRecorder(tabStream, opts);
  micRec.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.mic.push(e.data);
  };
  tabRec.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.tab.push(e.data);
  };

  // 画面録画（映像＋タブ音声）
  const videoMime = pickVideoMime();
  const screenOpts = videoMime ? { mimeType: videoMime } : {};
  const screenRec = new MediaRecorder(displayStream, screenOpts);
  screenRec.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.screen.push(e.data);
  };

  recorders = [micRec, tabRec, screenRec];

  // ブラウザの「共有を停止」ボタンで映像が終了したら録音も確定させる
  displayStream.getVideoTracks().forEach((t) => {
    t.addEventListener("ended", () => {
      if (!els.stop.disabled) stop();
    });
  });

  // 共有 t0: 3レコーダーを同時に start（timeslice 1000ms でチャンク化）
  micRec.start(1000);
  tabRec.start(1000);
  screenRec.start(1000);

  startTimer();
  els.start.disabled = true;
  els.stop.disabled = false;
}

function stopAllRecorders() {
  return Promise.all(
    recorders.map(
      (rec) =>
        new Promise((resolve) => {
          if (rec.state === "inactive") return resolve();
          rec.onstop = () => resolve();
          rec.stop();
        })
    )
  );
}

async function stop() {
  els.stop.disabled = true;
  stopTimer();
  await stopAllRecorders();

  // ストリーム・メーターの後始末
  meterStops.forEach((fn) => fn());
  streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));

  const micBlob = new Blob(chunks.mic, { type: "audio/webm" });
  const tabBlob = new Blob(chunks.tab, { type: "audio/webm" });
  const screenBlob = new Blob(chunks.screen, { type: "video/webm" });

  await uploadAndProcess(micBlob, tabBlob, screenBlob);

  els.start.disabled = false;
}

// ── アップロード＆処理 ────────────────────────────────────
let currentMeetingId = null;
let hasScreen = false;

async function uploadAndProcess(micBlob, tabBlob, screenBlob) {
  clearStatus();
  setStatus("upload", "アップロード中…", "active");

  const fd = new FormData();
  if (micBlob.size > 0) fd.append("mic", micBlob, "mic.webm");
  if (tabBlob.size > 0) fd.append("tab", tabBlob, "tab.webm");
  hasScreen = !!(screenBlob && screenBlob.size > 0);
  if (hasScreen) fd.append("screen", screenBlob, "screen.webm");
  fd.append("title", els.title.value || "");
  fd.append("provider", els.provider.value || "claude");
  fd.append("model", els.model.value || "");

  let meetingId;
  try {
    const resp = await fetch("/api/meetings", { method: "POST", body: fd });
    if (!resp.ok) throw new Error("upload failed");
    const data = await resp.json();
    meetingId = data.meeting_id;
    currentMeetingId = meetingId;
  } catch (e) {
    setStatus("upload", "アップロードに失敗しました: " + e.message, "error");
    return;
  }
  setStatus("upload", "アップロード完了", "done");

  await subscribeProgress(meetingId);
}

async function subscribeProgress(meetingId) {
  const resp = await fetch(`/api/meetings/${meetingId}/process`, {
    method: "POST",
  });
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const parts = buffer.split("\n\n");
    buffer = parts.pop(); // 未完了分は次回に持ち越し
    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith("data:")) continue;
      const payload = JSON.parse(line.slice(5).trim());
      handleEvent(payload);
    }
  }
}

let lastStageKey = null;

function handleEvent(ev) {
  const stage = ev.stage;
  if (stage === "error") {
    setStatus("error", "エラー: " + ev.message, "error");
    return;
  }

  const label = STAGE_LABELS[stage] || stage;

  // 直前の active ステージを done に切り替える
  if (lastStageKey && lastStageKey !== stage && statusItems[lastStageKey]) {
    if (lastStageKey !== "done") {
      statusItems[lastStageKey].className = "done";
    }
  }

  if (stage === "done") {
    setStatus(stage, label, "done");
    showResult(ev.minutes_md);
    return;
  }

  // progress 情報があれば秒数を添える
  let text = label;
  if (ev.progress && typeof ev.progress.end === "number") {
    text += `（〜${Math.floor(ev.progress.end)}秒）`;
  }
  setStatus(stage, text, "active");
  lastStageKey = stage;
}

// ── 結果表示・ダウンロード ────────────────────────────────
function showResult(minutesMd) {
  els.minutesOutput.textContent = minutesMd;
  // 録画がある会議のみ「録画をダウンロード」を有効化（動画が大きいため
  // fetch でメモリに載せず、ブラウザのダウンロードに委ねる直リンク）。
  if (els.downloadScreen) {
    if (hasScreen && currentMeetingId) {
      els.downloadScreen.href = `/api/meetings/${currentMeetingId}/screen`;
      els.downloadScreen.hidden = false;
    } else {
      els.downloadScreen.hidden = true;
    }
  }
  els.resultCard.hidden = false;
}

function download(filename, text) {
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

els.downloadMinutes.addEventListener("click", () => {
  download("minutes.md", els.minutesOutput.textContent);
});

els.downloadTranscript.addEventListener("click", async () => {
  if (!currentMeetingId) return;
  const resp = await fetch(`/api/meetings/${currentMeetingId}/transcript`);
  const data = await resp.json();
  download("transcript.md", data.transcript_md);
});

els.start.addEventListener("click", start);
els.stop.addEventListener("click", stop);

// Chrome/Edge 以外の簡易判定
if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
  document.getElementById("browser-note").innerHTML =
    "このブラウザは画面共有APIに対応していません。<strong>Chrome または Edge</strong> をご利用ください。";
  els.start.disabled = true;
}

loadProviders();
