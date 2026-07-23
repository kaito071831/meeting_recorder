// permission.js — マイク許可を一度だけ取得する（拡張オリジンに付与）。
// MV3 の offscreen document からは getUserMedia の許可プロンプトを出せないため、
// この拡張ページで getUserMedia({audio:true}) を呼び、拡張オリジンにマイク許可を
// 与えておく。以後は同一オリジンの offscreen document がマイクを利用できる。

"use strict";

const btn = document.getElementById("grant");
const result = document.getElementById("result");

function show(msg, isError) {
  result.hidden = false;
  result.textContent = msg;
  result.style.color = isError ? "var(--danger)" : "var(--ok)";
}

btn.addEventListener("click", async () => {
  btn.disabled = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // 許可を得たら即座にトラックを停止（デバイスを保持しない）
    stream.getTracks().forEach((t) => t.stop());
    show("マイクを許可しました。このタブは閉じて構いません。ツールバーの拡張アイコンから録音できます。", false);
  } catch (e) {
    show("マイク許可に失敗しました: " + (e.message || e) + "。ブラウザの許可設定をご確認ください。", true);
    btn.disabled = false;
  }
});
