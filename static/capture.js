// キャプチャUI: getDisplayMedia(タブ映像＋タブ音声=相手) + getUserMedia(マイク=自分) を
// 3つの MediaRecorder で別々に録音し、停止時にアップロードして SSE で進捗表示する。
// 話者分離のため文字起こし用の音声トラックは合成しない（ソースベース）。共有タブの
// 映像は、マイク＋タブ音声をミックスした音声とあわせて画面録画（screen.webm、参照用・
// 映像＋全音声）として保存する。

"use strict";

const els = {
  title: document.getElementById("title"),
  provider: document.getElementById("provider"),
  model: document.getElementById("model"),
  start: document.getElementById("start"),
  stop: document.getElementById("stop"),
  muteMic: document.getElementById("mute-mic"),
  timer: document.getElementById("timer"),
  micLevel: document.getElementById("mic-level"),
  tabLevel: document.getElementById("tab-level"),
  statusList: document.getElementById("status-list"),
  resultCard: document.getElementById("result-card"),
  minutesOutput: document.getElementById("minutes-output"),
  downloadMinutes: document.getElementById("download-minutes"),
  downloadTranscript: document.getElementById("download-transcript"),
  downloadScreen: document.getElementById("download-screen"),
  editSpeakers: document.getElementById("edit-speakers"),
  speakerRenameForm: document.getElementById("speaker-rename-form"),
  speakerInputs: document.getElementById("speaker-inputs"),
  saveSpeakers: document.getElementById("save-speakers"),
  cancelSpeakers: document.getElementById("cancel-speakers"),
};

// ── 進捗表示 ──────────────────────────────────────────────
const STAGE_LABELS = {
  uploaded: "アップロード完了",
  transcribing_mic: "文字起こし中（自分／マイク）",
  transcribing_tab: "文字起こし中（相手・参加者／タブ音声）",
  diarizing: "話者を分離中",
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
let mixCtx = null; // 録画用のミックス AudioContext（stop で close）
let timerId = null;
let startedAt = 0;
let micStream = null;
let micMuted = false;

// マイクのミュート切替: track.enabled で無効化するだけなのでレコーダーは
// 止めず、ミュート中は無音（レベルメーターも自動的に0）として録音され続ける。
// タブ音声側のタイムラインとずれないようにするための方式。
function setMicMuted(muted) {
  micMuted = muted;
  if (micStream) {
    micStream.getAudioTracks().forEach((t) => (t.enabled = !muted));
  }
  els.muteMic.textContent = muted ? "🎤 ミュート解除" : "🎤 ミュート";
  els.muteMic.classList.toggle("active", muted);
}

els.muteMic.addEventListener("click", () => setMicMuted(!micMuted));

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

  // 画面録画（映像＋ミックス音声＝タブ音声＋自分マイク）。
  // WebAudio の MediaStreamAudioDestinationNode でマイク＋タブ音声をミックスし、
  // 共有タブの映像トラックと束ねた新しいストリームを録画ソースにする。
  // ミックス生成に失敗したら従来どおり displayStream（映像＋タブ音声のみ）へフォールバック。
  const videoMime = pickVideoMime();
  const screenOpts = videoMime ? { mimeType: videoMime } : {};
  let recordStream = displayStream;
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    mixCtx = new AudioCtx();
    const mixDest = mixCtx.createMediaStreamDestination();
    mixCtx.createMediaStreamSource(micStream).connect(mixDest);
    mixCtx.createMediaStreamSource(tabStream).connect(mixDest);
    if (mixCtx.state === "suspended") mixCtx.resume(); // 取り込みのため running に
    recordStream = new MediaStream([
      ...displayStream.getVideoTracks(),
      ...mixDest.stream.getAudioTracks(),
    ]);
  } catch (e) {
    // ミックス失敗時は映像＋タブ音声のみで録画（最低限、従来同等）
    if (mixCtx) {
      mixCtx.close().catch(() => {});
      mixCtx = null;
    }
    recordStream = displayStream;
  }
  const screenRec = new MediaRecorder(recordStream, screenOpts);
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
  els.muteMic.disabled = false;
  setMicMuted(false);
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
  els.muteMic.disabled = true;
  stopTimer();
  await stopAllRecorders();

  // ストリーム・メーターの後始末
  meterStops.forEach((fn) => fn());
  streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  if (mixCtx) {
    mixCtx.close().catch(() => {});
    mixCtx = null;
  }
  micStream = null;
  setMicMuted(false);

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
    currentTranscriptMd = ev.transcript_md || "";
    showResult(ev.minutes_md, detectSpeakerNumbers(currentTranscriptMd));
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
let currentTranscriptMd = "";
let detectedSpeakerNumbers = [];

// トランスクリプトの行頭ラベルから「相手・参加者N」の番号を抽出する
// （リネーム前提の番号ラベルのみ対象。話者分離が2人以上検出したときだけ現れる）。
function detectSpeakerNumbers(transcriptMd) {
  const re = /^\[[^\]]+\]\s+相手・参加者(\d+):/gm;
  const numbers = new Set();
  let m;
  while ((m = re.exec(transcriptMd)) !== null) {
    numbers.add(Number(m[1]));
  }
  return [...numbers].sort((a, b) => a - b);
}

function showResult(minutesMd, speakerNumbers) {
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
  detectedSpeakerNumbers = speakerNumbers || [];
  if (els.editSpeakers) {
    els.editSpeakers.hidden = detectedSpeakerNumbers.length < 2;
  }
  if (els.speakerRenameForm) els.speakerRenameForm.hidden = true;
  els.resultCard.hidden = false;
}

// ── 話者名のリネーム ──────────────────────────────────────
async function buildSpeakerInputs() {
  els.speakerInputs.innerHTML = "";
  let existing = {};
  if (currentMeetingId) {
    try {
      const resp = await fetch(`/api/meetings/${currentMeetingId}/speakers`);
      if (resp.ok) existing = await resp.json();
    } catch (e) {
      /* 取得失敗時は空欄のまま表示 */
    }
  }
  for (const n of detectedSpeakerNumbers) {
    const field = document.createElement("div");
    field.className = "field";
    const label = document.createElement("label");
    label.textContent = `相手・参加者${n}`;
    label.setAttribute("for", `speaker-input-${n}`);
    const input = document.createElement("input");
    input.type = "text";
    input.id = `speaker-input-${n}`;
    input.placeholder = `相手・参加者${n}`;
    input.value = existing[String(n)] || "";
    field.appendChild(label);
    field.appendChild(input);
    els.speakerInputs.appendChild(field);
  }
}

if (els.editSpeakers) {
  els.editSpeakers.addEventListener("click", async () => {
    const opening = els.speakerRenameForm.hidden;
    if (opening) await buildSpeakerInputs();
    els.speakerRenameForm.hidden = !opening;
  });
}

if (els.cancelSpeakers) {
  els.cancelSpeakers.addEventListener("click", () => {
    els.speakerRenameForm.hidden = true;
  });
}

if (els.saveSpeakers) {
  els.saveSpeakers.addEventListener("click", async () => {
    if (!currentMeetingId) return;
    const mapping = {};
    for (const n of detectedSpeakerNumbers) {
      const input = document.getElementById(`speaker-input-${n}`);
      const value = input ? input.value.trim() : "";
      if (value) mapping[String(n)] = value;
    }
    els.saveSpeakers.disabled = true;
    try {
      const resp = await fetch(`/api/meetings/${currentMeetingId}/speakers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mapping),
      });
      if (!resp.ok) throw new Error("保存に失敗しました");
      const data = await resp.json();
      currentTranscriptMd = data.transcript_md || currentTranscriptMd;
      els.minutesOutput.textContent = data.minutes_md;
      els.speakerRenameForm.hidden = true;
    } catch (e) {
      alert(e.message || "話者名の保存に失敗しました");
    } finally {
      els.saveSpeakers.disabled = false;
    }
  });
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
