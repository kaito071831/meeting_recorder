// offscreen.js — 実録音・アップロード・SSE 受信。
// static/capture.js の録音／アップロード／SSE ロジックを移植し、ストリーム取得のみ
// getDisplayMedia → tabCapture（streamId 経由の getUserMedia）へ差し替えたもの。
// タブ音声（相手）＋タブ映像＋マイク（自分）を 3 つの MediaRecorder で別々に録音し、
// 停止時に mic/tab/screen.webm をバックエンドへ POST → /process の SSE を読み、
// 進捗を background 経由で popup へ流す。話者分離のため文字起こし用の音声は合成しない。

"use strict";

// ── background への通知 ────────────────────────────────────
function toBackground(msg) {
  return chrome.runtime
    .sendMessage({ target: "background_from_offscreen", ...msg })
    .catch(() => {});
}

// ── 録音状態 ──────────────────────────────────────────────
let recorders = [];
let chunks = { mic: [], tab: [], screen: [] };
let streams = [];
let mixCtx = null; // 録画用ミックスの AudioContext（stop で close）
let playbackCtx = null; // タブ音声の再生維持用 AudioContext（stop で close）
let backend = "http://localhost:8000";
let meta = { title: "", provider: "claude", model: "" };
let micStream = null;

// マイクのミュート切替: track.enabled で無効化するだけなのでレコーダーは
// 止めず、ミュート中は無音（タブ音声とのタイムラインもずれない）として録音され続ける。
function setMicMuted(muted) {
  if (micStream) {
    micStream.getAudioTracks().forEach((t) => (t.enabled = !muted));
  }
}

function pickMime() {
  const prefer = "audio/webm;codecs=opus";
  if (window.MediaRecorder && MediaRecorder.isTypeSupported(prefer)) return prefer;
  if (MediaRecorder.isTypeSupported("audio/webm")) return "audio/webm";
  return "";
}

function pickVideoMime() {
  const prefer = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  for (const m of prefer) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}

async function startRecording(streamId, meetingMeta, backendUrl) {
  backend = backendUrl || backend;
  meta = { ...meta, ...meetingMeta };
  chunks = { mic: [], tab: [], screen: [] };
  recorders = [];
  streams = [];

  // タブ音声＋タブ映像: tabCapture の streamId を chromeMediaSource:'tab' で取得
  let tabAvStream;
  try {
    tabAvStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
        },
      },
      video: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
        },
      },
    });
  } catch (e) {
    toBackground({
      type: "recording_error",
      message: "タブ音声・映像の取得に失敗しました: " + (e.message || e),
    });
    return;
  }

  const tabAudioTracks = tabAvStream.getAudioTracks();
  if (tabAudioTracks.length === 0) {
    tabAvStream.getTracks().forEach((t) => t.stop());
    toBackground({
      type: "recording_error",
      message: "タブの音声が取得できませんでした。",
    });
    return;
  }
  // タブ音声のみのストリーム（tab.webm 録音・ミックス入力用）
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
    tabAvStream.getTracks().forEach((t) => t.stop());
    toBackground({
      type: "recording_error",
      message:
        "マイクにアクセスできませんでした。拡張のマイク許可ページで許可してください: " +
        (e.message || e),
    });
    return;
  }

  // tabCapture 中はタブのローカル再生がミュートされるため、destination へ
  // 再接続して会議音声をユーザーに聞こえ続けさせる。
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    playbackCtx = new AudioCtx();
    playbackCtx
      .createMediaStreamSource(tabStream)
      .connect(playbackCtx.destination);
    if (playbackCtx.state === "suspended") playbackCtx.resume();
  } catch (e) {
    playbackCtx = null; // 再生維持に失敗しても録音は継続
  }

  // tabAvStream（映像＋タブ音声）・tabStream・micStream を後始末対象に
  streams = [tabAvStream, tabStream, micStream];

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
  // タブ映像トラックと束ねた新しいストリームを録画ソースにする。
  // 失敗時はタブ映像＋タブ音声のみ（tabAvStream）へフォールバック。
  const videoMime = pickVideoMime();
  const screenOpts = videoMime ? { mimeType: videoMime } : {};
  let recordStream = tabAvStream;
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    mixCtx = new AudioCtx();
    const mixDest = mixCtx.createMediaStreamDestination();
    mixCtx.createMediaStreamSource(micStream).connect(mixDest);
    mixCtx.createMediaStreamSource(tabStream).connect(mixDest);
    if (mixCtx.state === "suspended") mixCtx.resume();
    recordStream = new MediaStream([
      ...tabAvStream.getVideoTracks(),
      ...mixDest.stream.getAudioTracks(),
    ]);
  } catch (e) {
    if (mixCtx) {
      mixCtx.close().catch(() => {});
      mixCtx = null;
    }
    recordStream = tabAvStream;
  }
  const screenRec = new MediaRecorder(recordStream, screenOpts);
  screenRec.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.screen.push(e.data);
  };

  recorders = [micRec, tabRec, screenRec];

  // タブ映像が終了（タブが閉じられた等）したら録音を確定させる
  tabAvStream.getVideoTracks().forEach((t) => {
    t.addEventListener("ended", () => {
      if (recorders.some((r) => r.state !== "inactive")) stopRecording();
    });
  });

  // 3レコーダーを同時に start（timeslice 1000ms でチャンク化）
  micRec.start(1000);
  tabRec.start(1000);
  screenRec.start(1000);
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

async function stopRecording() {
  await stopAllRecorders();

  // ストリーム・AudioContext の後始末
  streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  if (mixCtx) {
    mixCtx.close().catch(() => {});
    mixCtx = null;
  }
  if (playbackCtx) {
    playbackCtx.close().catch(() => {});
    playbackCtx = null;
  }
  micStream = null;

  const micBlob = new Blob(chunks.mic, { type: "audio/webm" });
  const tabBlob = new Blob(chunks.tab, { type: "audio/webm" });
  const screenBlob = new Blob(chunks.screen, { type: "video/webm" });

  try {
    await uploadAndProcess(micBlob, tabBlob, screenBlob);
  } catch (e) {
    // SSE 読み取り中の例外等をここで必ず捕捉する。捕捉し損なうと
    // processing_done が届かず background が processing 状態のまま固まり、
    // popup の停止／新規録音ボタンが永久に無効化されたままになる。
    toBackground({
      type: "progress",
      event: {
        stage: "error",
        message: "処理中にエラーが発生しました: " + (e.message || e),
      },
    });
  }

  // 処理完了（成功・失敗いずれでも）。background に offscreen document のクローズを依頼。
  toBackground({ type: "processing_done" });
}

// ── アップロード＆処理 ────────────────────────────────────
async function uploadAndProcess(micBlob, tabBlob, screenBlob) {
  const fd = new FormData();
  if (micBlob.size > 0) fd.append("mic", micBlob, "mic.webm");
  if (tabBlob.size > 0) fd.append("tab", tabBlob, "tab.webm");
  const hasScreen = !!(screenBlob && screenBlob.size > 0);
  if (hasScreen) fd.append("screen", screenBlob, "screen.webm");
  fd.append("title", meta.title || "");
  fd.append("provider", meta.provider || "claude");
  fd.append("model", meta.model || "");

  let meetingId;
  try {
    const resp = await fetch(`${backend}/api/meetings`, {
      method: "POST",
      body: fd,
    });
    if (!resp.ok) throw new Error("upload failed");
    const data = await resp.json();
    meetingId = data.meeting_id;
  } catch (e) {
    toBackground({
      type: "progress",
      event: { stage: "error", message: "アップロードに失敗しました: " + e.message },
    });
    return;
  }
  toBackground({ type: "uploaded_meta", meetingId, hasScreen });

  await subscribeProgress(meetingId);
}

async function subscribeProgress(meetingId) {
  const resp = await fetch(`${backend}/api/meetings/${meetingId}/process`, {
    method: "POST",
  });
  if (!resp.ok) {
    throw new Error(`進捗取得に失敗しました（status ${resp.status}）`);
  }
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
      toBackground({ type: "progress", event: payload });
    }
  }
}

// ── background からの指示を受ける ──────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== "offscreen") return false;
  if (msg.type === "offscreen_start") {
    startRecording(msg.streamId, msg.meta || {}, msg.backend);
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === "offscreen_stop") {
    stopRecording();
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === "offscreen_set_mic_muted") {
    setMicMuted(!!msg.muted);
    sendResponse({ ok: true });
    return true;
  }
  return false;
});
