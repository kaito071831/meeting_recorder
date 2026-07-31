// popup.js — 操作 UI。
// static/index.html + capture.js の UI 部分を縮約したもの。録音・処理の実体は
// background（状態集約）＋ offscreen（録音）にあり、popup はその状態を表示・操作する
// だけ。popup は開閉するため、状態は毎回 background から取得して復元する。

"use strict";

const BACKEND = "http://localhost:8000";

const els = {
  title: document.getElementById("title"),
  provider: document.getElementById("provider"),
  model: document.getElementById("model"),
  start: document.getElementById("start"),
  stop: document.getElementById("stop"),
  muteMic: document.getElementById("mute-mic"),
  timer: document.getElementById("timer"),
  statusList: document.getElementById("status-list"),
  resultCard: document.getElementById("result-card"),
  minutesOutput: document.getElementById("minutes-output"),
  downloadMinutes: document.getElementById("download-minutes"),
  downloadTranscript: document.getElementById("download-transcript"),
  downloadScreen: document.getElementById("download-screen"),
  permNote: document.getElementById("perm-note"),
  openPermission: document.getElementById("open-permission"),
  forceReset: document.getElementById("force-reset"),
  editSpeakers: document.getElementById("edit-speakers"),
  speakerRenameForm: document.getElementById("speaker-rename-form"),
  speakerInputs: document.getElementById("speaker-inputs"),
  saveSpeakers: document.getElementById("save-speakers"),
  cancelSpeakers: document.getElementById("cancel-speakers"),
};

// ── 進捗ラベル（capture.js と同一）────────────────────────
const STAGE_LABELS = {
  uploaded: "アップロード完了",
  transcribing_mic: "文字起こし中（自分／マイク）",
  transcribing_tab: "文字起こし中（相手・参加者／タブ音声）",
  diarizing: "話者を分離中",
  merging: "時系列マージ中",
  generating_minutes: "議事録を生成中",
  done: "完了",
};

// ── background との通信 ────────────────────────────────────
function sendBg(type, extra) {
  return chrome.runtime.sendMessage({ target: "background", type, ...extra });
}

// ── プロバイダ一覧の読込 ──────────────────────────────────
let providersInfo = { claude: false, ollama: [] };

async function loadProviders() {
  try {
    const resp = await fetch(`${BACKEND}/api/providers`);
    providersInfo = await resp.json();
  } catch (e) {
    providersInfo = { claude: false, ollama: [] };
    els.title.disabled = true;
  }
  els.provider.innerHTML = "";
  if (providersInfo.claude) {
    els.provider.appendChild(new Option("Claude (claude-opus-4-8)", "claude"));
  }
  if (providersInfo.ollama && providersInfo.ollama.length > 0) {
    els.provider.appendChild(new Option("Ollama (ローカル)", "ollama"));
  }
  if (els.provider.options.length === 0) {
    els.provider.appendChild(
      new Option("バックエンド未起動 / プロバイダなし", "")
    );
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
    els.model.disabled = true;
    els.model.appendChild(new Option("(既定)", ""));
  }
}

els.provider.addEventListener("change", updateModelOptions);

// ── マイク許可の確認 ──────────────────────────────────────
async function checkMicPermission() {
  try {
    const status = await navigator.permissions.query({ name: "microphone" });
    els.permNote.hidden = status.state === "granted";
  } catch (e) {
    // permissions API 非対応時は未確定として案内を表示
    els.permNote.hidden = false;
  }
}

els.openPermission.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL("permission.html") });
});

// ── 状態の描画 ────────────────────────────────────────────
let timerId = null;
let currentMeetingId = null;
let hasScreen = false;
let detectedSpeakerNumbers = [];

// トランスクリプトの行頭ラベルから「相手・参加者N」の番号を抽出する
// （capture.js と同一ロジック。話者分離が2人以上検出したときだけ現れる）。
function detectSpeakerNumbers(transcriptMd) {
  const re = /^\[[^\]]+\]\s+相手・参加者(\d+):/gm;
  const numbers = new Set();
  let m;
  while ((m = re.exec(transcriptMd)) !== null) {
    numbers.add(Number(m[1]));
  }
  return [...numbers].sort((a, b) => a - b);
}

function startTimerFrom(startedAt) {
  stopTimer();
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

function renderProgress(events) {
  els.statusList.innerHTML = "";
  const lastIdx = events.length - 1;
  events.forEach((ev, idx) => {
    if (ev.stage === "error") {
      const li = document.createElement("li");
      li.textContent = "エラー: " + (ev.message || "");
      li.className = "error";
      els.statusList.appendChild(li);
      return;
    }
    const li = document.createElement("li");
    let text = STAGE_LABELS[ev.stage] || ev.stage;
    if (ev.progress && typeof ev.progress.end === "number") {
      text += `（〜${Math.floor(ev.progress.end)}秒）`;
    }
    li.textContent = text;
    // 最新イベントのみ active、それ以外は done（done ステージは done のまま）
    li.className = idx === lastIdx && ev.stage !== "done" ? "active" : "done";
    els.statusList.appendChild(li);
  });
}

function render(state) {
  // ボタン・タイマー
  if (state.status === "recording") {
    els.start.disabled = true;
    els.stop.disabled = false;
    els.muteMic.disabled = false;
    startTimerFrom(state.startedAt || Date.now());
  } else if (state.status === "processing") {
    els.start.disabled = true;
    els.stop.disabled = true;
    els.muteMic.disabled = true;
    stopTimer();
  } else {
    // idle / done / error
    els.start.disabled = els.provider.value === "" ? true : false;
    els.stop.disabled = true;
    els.muteMic.disabled = true;
    stopTimer();
  }

  // マイクミュート表示
  els.muteMic.textContent = state.micMuted ? "🎤 ミュート解除" : "🎤 ミュート";
  els.muteMic.classList.toggle("active", !!state.micMuted);

  // フォーム値の復元（録音・処理中はユーザーが触れないので同期）
  if (state.status === "recording" || state.status === "processing") {
    if (state.title) els.title.value = state.title;
  }

  // 進捗
  renderProgress(state.events || []);

  // 結果
  currentMeetingId = state.meetingId;
  hasScreen = state.hasScreen;
  if (state.status === "done" && state.minutesMd) {
    els.minutesOutput.textContent = state.minutesMd;
    if (hasScreen && currentMeetingId) {
      els.downloadScreen.href = `${BACKEND}/api/meetings/${currentMeetingId}/screen`;
      els.downloadScreen.hidden = false;
    } else {
      els.downloadScreen.hidden = true;
    }
    detectedSpeakerNumbers = detectSpeakerNumbers(state.transcriptMd || "");
    if (els.editSpeakers) els.editSpeakers.hidden = detectedSpeakerNumbers.length < 2;
    els.resultCard.hidden = false;
  } else {
    els.resultCard.hidden = true;
    if (els.speakerRenameForm) els.speakerRenameForm.hidden = true;
  }
}

async function refreshState() {
  try {
    const resp = await sendBg("get_state");
    if (resp && resp.ok) render(resp.state);
  } catch (e) {
    /* background 未起動時は無視 */
  }
}

// background からの状態更新通知
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target === "popup" && msg.type === "state_updated") {
    render(msg.state);
  }
});

// ── 操作 ──────────────────────────────────────────────────
els.start.addEventListener("click", async () => {
  els.start.disabled = true;
  const meta = {
    title: els.title.value || "",
    provider: els.provider.value || "claude",
    model: els.model.value || "",
  };
  const resp = await sendBg("start", { meta });
  if (!resp || !resp.ok) {
    alert("録音を開始できませんでした: " + ((resp && resp.error) || "不明なエラー"));
    els.start.disabled = false;
    return;
  }
});

els.stop.addEventListener("click", async () => {
  els.stop.disabled = true;
  await sendBg("stop");
});

els.muteMic.addEventListener("click", async () => {
  els.muteMic.disabled = true;
  await sendBg("toggle_mic_mute");
  els.muteMic.disabled = false;
});

els.forceReset.addEventListener("click", async (e) => {
  e.preventDefault();
  if (!confirm("進捗をリセットします。録音中・処理中の音声や結果は失われます。よろしいですか？")) {
    return;
  }
  await sendBg("reset");
  await refreshState();
});

// ── ダウンロード ──────────────────────────────────────────
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
  const resp = await fetch(`${BACKEND}/api/meetings/${currentMeetingId}/transcript`);
  const data = await resp.json();
  download("transcript.md", data.transcript_md);
});

// ── 話者名のリネーム ──────────────────────────────────────
async function buildSpeakerInputs() {
  els.speakerInputs.innerHTML = "";
  let existing = {};
  if (currentMeetingId) {
    try {
      const resp = await fetch(`${BACKEND}/api/meetings/${currentMeetingId}/speakers`);
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
      const resp = await fetch(`${BACKEND}/api/meetings/${currentMeetingId}/speakers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mapping),
      });
      if (!resp.ok) throw new Error("保存に失敗しました");
      const data = await resp.json();
      els.minutesOutput.textContent = data.minutes_md;
      els.speakerRenameForm.hidden = true;
      // background の永続状態にも反映しないと popup 再オープン時に古い議事録へ戻ってしまう
      await sendBg("update_result", {
        minutesMd: data.minutes_md,
        transcriptMd: data.transcript_md,
      });
    } catch (e) {
      alert(e.message || "話者名の保存に失敗しました");
    } finally {
      els.saveSpeakers.disabled = false;
    }
  });
}

// ── 初期化 ────────────────────────────────────────────────
(async () => {
  await loadProviders();
  await checkMicPermission();
  await refreshState();
})();
