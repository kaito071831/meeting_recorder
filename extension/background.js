// background.js — MV3 service worker。
// popup と offscreen document の間のメッセージルータ兼、録音・処理状態の集約点。
// popup は開閉するため、状態は chrome.storage.local に保存し、offscreen（実録音）は
// service worker が寝ても動き続ける。popup 再オープン時は storage から状態を復元する。

"use strict";

const BACKEND = "http://localhost:8000";
const OFFSCREEN_PATH = "offscreen.html";

// ── 状態管理（chrome.storage.local に集約）──────────────────
const INITIAL_STATE = {
  status: "idle", // idle | recording | processing | done | error
  title: "",
  provider: "",
  model: "",
  micMuted: false,
  startedAt: 0, // 録音開始時刻（popup のタイマー復元用）
  meetingId: null,
  hasScreen: false,
  minutesMd: "",
  transcriptMd: "",
  error: "",
  events: [], // SSE 由来の進捗イベント列（popup の進捗リスト復元用）
};

async function getState() {
  const { state } = await chrome.storage.local.get("state");
  return { ...INITIAL_STATE, ...(state || {}) };
}

async function setState(patch) {
  const next = { ...(await getState()), ...patch };
  await chrome.storage.local.set({ state: next });
  // popup が開いていれば通知（閉じていれば送信失敗するが無害）
  chrome.runtime
    .sendMessage({ target: "popup", type: "state_updated", state: next })
    .catch(() => {});
  return next;
}

// ── offscreen document のライフサイクル ─────────────────────
async function hasOffscreen() {
  if (chrome.offscreen && chrome.offscreen.hasDocument) {
    return chrome.offscreen.hasDocument();
  }
  // 古い API 向けフォールバック
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["USER_MEDIA"],
    justification:
      "会議タブの音声とマイクを録音し、ローカルバックエンドへ送信するため。",
  });
}

async function closeOffscreen() {
  if (await hasOffscreen()) {
    await chrome.offscreen.closeDocument().catch(() => {});
  }
}

// ── 録音開始 ────────────────────────────────────────────────
async function startRecording(meta) {
  // 対象タブ（アクティブ・現在ウィンドウ）を取得
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (!tab) {
    throw new Error("対象タブが見つかりません。会議タブをアクティブにしてください。");
  }
  const url = tab.url || "";
  if (!/^https?:\/\//.test(url)) {
    throw new Error(
      "このタブは録音できません（chrome:// や拡張ページなど）。会議の Web タブを開いてアクティブにしてください。"
    );
  }

  // タブ音声・映像の streamId を取得（offscreen で消費）
  const streamId = await new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }, (id) => {
      if (chrome.runtime.lastError || !id) {
        reject(
          new Error(
            (chrome.runtime.lastError &&
              chrome.runtime.lastError.message) ||
              "タブ音声の取得に失敗しました。"
          )
        );
        return;
      }
      resolve(id);
    });
  });

  await ensureOffscreen();

  // 状態を録音中に更新してから offscreen に開始指示
  await setState({
    status: "recording",
    title: meta.title || "",
    provider: meta.provider || "",
    model: meta.model || "",
    micMuted: false,
    startedAt: Date.now(),
    meetingId: null,
    hasScreen: false,
    minutesMd: "",
    transcriptMd: "",
    error: "",
    events: [],
  });

  await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "offscreen_start",
    streamId,
    backend: BACKEND,
    meta: {
      title: meta.title || "",
      provider: meta.provider || "",
      model: meta.model || "",
    },
  });
}

// ── 録音停止（処理へ移行）──────────────────────────────────
async function stopRecording() {
  await setState({ status: "processing" });
  await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "offscreen_stop",
  });
}

// ── メッセージルータ ────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // popup → background
  if (msg.target === "background") {
    (async () => {
      try {
        if (msg.type === "get_state") {
          sendResponse({ ok: true, state: await getState() });
          return;
        }
        if (msg.type === "start") {
          await startRecording(msg.meta || {});
          sendResponse({ ok: true });
          return;
        }
        if (msg.type === "stop") {
          await stopRecording();
          sendResponse({ ok: true });
          return;
        }
        if (msg.type === "toggle_mic_mute") {
          const state = await getState();
          const muted = !state.micMuted;
          await chrome.runtime.sendMessage({
            target: "offscreen",
            type: "offscreen_set_mic_muted",
            muted,
          });
          await setState({ micMuted: muted });
          sendResponse({ ok: true, micMuted: muted });
          return;
        }
        if (msg.type === "reset") {
          // 何らかの理由で処理が停止・応答不能になった場合の強制リセット。
          // offscreen document を破棄して状態を idle に戻す。
          await closeOffscreen().catch(() => {});
          await setState({ ...INITIAL_STATE });
          sendResponse({ ok: true });
          return;
        }
        sendResponse({ ok: false, error: "unknown message" });
      } catch (e) {
        await setState({ status: "error", error: String(e.message || e) });
        await closeOffscreen().catch(() => {});
        sendResponse({ ok: false, error: String(e.message || e) });
      }
    })();
    return true; // 非同期レスポンス
  }

  // offscreen → background
  if (msg.target === "background_from_offscreen") {
    (async () => {
      if (msg.type === "recording_error") {
        await setState({ status: "error", error: msg.message || "録音エラー" });
        await closeOffscreen();
      } else if (msg.type === "progress") {
        // SSE 由来の進捗イベントを蓄積
        const state = await getState();
        const events = state.events.slice();
        events.push(msg.event);
        const patch = { events };
        if (msg.event.stage === "done") {
          patch.status = "done";
          patch.minutesMd = msg.event.minutes_md || "";
          patch.transcriptMd = msg.event.transcript_md || "";
        } else if (msg.event.stage === "error") {
          patch.status = "error";
          patch.error = msg.event.message || "処理エラー";
        }
        await setState(patch);
      } else if (msg.type === "uploaded_meta") {
        await setState({
          meetingId: msg.meetingId,
          hasScreen: !!msg.hasScreen,
        });
      } else if (msg.type === "processing_done") {
        await closeOffscreen();
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  return false;
});
