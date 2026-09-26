(function () {
  const app = document.getElementById("app");
  const emptyAnswers = () => new Array(QUESTIONS.length).fill(null);
  let state = { step: "start", qIndex: 0, answers: emptyAnswers(), result: null };

  /* ---------------- history (browser back/forward) ----------------
     画面遷移のたびに pushState し、ブラウザの戻る/進むボタンや
     アプリ内の「戻る」ボタン(history.back())と状態を同期させる。
     ------------------------------------------------------------- */
  function goTo(nextState) {
    state = Object.assign({}, state, nextState);
    history.pushState(state, "");
    render();
  }

  // updates the CURRENT history entry (no new step) - used when editing an
  // answer on the question you're already on, so going back to it later
  // (via history.back() or the in-app 戻る button) restores the latest choice
  function updateCurrent(partial) {
    state = Object.assign({}, state, partial);
    history.replaceState(state, "");
    render();
  }

  window.addEventListener("popstate", (e) => {
    state = e.state || { step: "start", qIndex: 0, answers: emptyAnswers(), result: null };
    render();
  });

  function render() {
    if (state.step === "quiz") renderQuiz();
    else if (state.step === "result") renderResult();
    else renderStart();
  }

  /* ---------------- scoring logic ----------------
     15問の回答 → 属性の投票 → 全属性を [票数desc, 直近の回答desc] で順位付け
     → 1位が主属性、1位と2位の差(突出度)でレア度決定：
       突出度0点 → ノーマル・ブレンド6:4（2位の属性ごとに専用キャラが1体）
       突出度1点 → ノーマル・ブレンド7:3（2位の属性ごとに専用キャラが1体）
       突出度2〜3点 → レア（主属性のみ、3体から回答合計で選出）
       突出度4点以上 → 激レア（主属性のみ、2体・なぞのみ1体から回答合計で選出）
     ブレンド帯は「2位の属性が何か」で1体が一意に決まるため、乱数選出は使わない。
     ------------------------------------------------ */
  function computeResult(answers) {
    const chosenAttrPerQ = QUESTIONS.map((q, i) => q.choices[answers[i]].attr);

    const votes = {};
    ATTRIBUTES.forEach((a) => (votes[a.key] = 0));
    chosenAttrPerQ.forEach((a) => votes[a]++);

    // 同着(または僅差)の解決順 = 票数が多い方が上位、同数なら直近に選ばれた方が上位
    const ranked = ATTRIBUTES.map((a) => a.key).sort((x, y) => {
      if (votes[y] !== votes[x]) return votes[y] - votes[x];
      return chosenAttrPerQ.lastIndexOf(y) - chosenAttrPerQ.lastIndexOf(x);
    });

    const winner = ranked[0];
    const runnerUp = ranked[1];
    const margin = votes[winner] - votes[runnerUp];
    const pool = CHARACTERS[winner];
    const sum = answers.reduce((a, b) => a + b, 0);

    let rarity;
    let character;
    let blend = null;

    if (margin === 0) {
      rarity = "normal";
      character = pool.blend0[runnerUp];
      blend = { ratio: [6, 4], secondary: runnerUp };
    } else if (margin === 1) {
      rarity = "normal";
      character = pool.blend1[runnerUp];
      blend = { ratio: [7, 3], secondary: runnerUp };
    } else if (margin <= 3) {
      rarity = "rare";
      character = pool.rare[sum % pool.rare.length];
    } else {
      rarity = "sr";
      character = pool.sr[sum % pool.sr.length];
    }

    const order = ATTRIBUTES.map((a) => a.key);
    const i = order.indexOf(winner);
    const goodAttrs = [];
    const badAttrs = [];
    order.forEach((k, j) => {
      if (j === i) return;
      const d = Math.min(Math.abs(i - j), 8 - Math.abs(i - j));
      if (d === 2) goodAttrs.push(k);
      if (d === 4) badAttrs.push(k);
    });

    // 属性ではなく、その属性に属する具体的な1体を相性相手として選ぶ。
    // シードは結果キャラ自身の名前から算出する固定値なので、
    // 誰が診断しても「同じキャラなら常に同じ相性相手」になる（回答内容には依存しない）。
    // 自分の主属性(winner)がブレンドに含まれるキャラは除外する
    // -- 例えば「どっしり6:バクハツ4」の人にとって、バクハツ属性の中でも
    // 「バクハツ×どっしり」のキャラを相性相手に出すと自己矛盾になるため。
    // キャラ名だけだと属性をまたいで同名キャラが存在しうる（例："たまに勢いで動く人"）ため、
    // 属性名も合わせてシードにして一意性を担保する
    const compatSeed = hashStr(winner + "::" + character.name);
    const good = goodAttrs.map((k) => ({ attr: k, character: pickCompatCharacter(k, winner, compatSeed) }));
    const bad = badAttrs.map((k) => ({ attr: k, character: pickCompatCharacter(k, winner, compatSeed) }));

    return { attr: winner, rarity, character, blend, good, bad, votes, globalNo: globalNo(winner, character) };
  }

  // 文字列 → 固定の非負整数。相性相手選出のシードに使う(結果キャラの名前が変わらない限り常に同じ値)
  function hashStr(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
      h = (h * 31 + s.charCodeAt(i)) >>> 0;
    }
    return h;
  }

  function pickCompatCharacter(targetAttrKey, excludeOtherKey, seed) {
    const pool = CHARACTERS[targetAttrKey];
    const others = ATTRIBUTES.map((a) => a.key).filter((k) => k !== targetAttrKey);
    const candidates = [];
    others.forEach((k) => {
      if (k === excludeOtherKey) return;
      candidates.push(pool.blend0[k]);
      candidates.push(pool.blend1[k]);
    });
    candidates.push(...pool.rare, ...pool.sr);
    return candidates[seed % candidates.length];
  }

  // 属性内の通し番号 + 前の属性群の合計から、151体中の何番目かを求める
  function attrTotal(attrKey) {
    const pool = CHARACTERS[attrKey];
    const others = ATTRIBUTES.length - 1;
    return others * 2 + pool.rare.length + pool.sr.length;
  }

  function globalNo(attrKey, character) {
    const order = ATTRIBUTES.map((a) => a.key);
    let no = 0;
    for (const key of order) {
      if (key === attrKey) break;
      no += attrTotal(key);
    }
    const pool = CHARACTERS[attrKey];
    const others = ATTRIBUTES.map((a) => a.key).filter((k) => k !== attrKey);
    const flat = [...others.map((k) => pool.blend0[k]), ...others.map((k) => pool.blend1[k]), ...pool.rare, ...pool.sr];
    return no + flat.indexOf(character) + 1;
  }

  function attrMetaOf(key) {
    return ATTRIBUTES.find((a) => a.key === key);
  }

  // 相性相手として選ばれた「具体的な1体」を表示するチップ
  function matchChipHtml(match) {
    const m = attrMetaOf(match.attr);
    return `<div class="compat-chip">
      <div class="chip-icon" style="--attr:${m.hex}"><svg viewBox="0 0 100 100">${SHAPES[m.shape]}</svg></div>
      <div class="chip-text">
        <span class="chip-name">${match.character.name}</span>
        <span class="chip-sub">${m.emoji} ${m.key}属性</span>
      </div>
    </div>`;
  }

  // ノーマル(点差0/1)のときだけ表示する、主属性×2位属性のブレンド比率バー
  function blendBarHtml(primaryKey, blend) {
    const p = attrMetaOf(primaryKey);
    const s = attrMetaOf(blend.secondary);
    const [pPct, sPct] = blend.ratio.map((n) => (n / 10) * 100);
    return `
      <div class="blend-bar">
        <div class="blend-fill" style="width:${pPct}%;--attr:${p.hex}"></div>
        <div class="blend-fill" style="width:${sPct}%;--attr:${s.hex}"></div>
      </div>
      <p class="blend-caption">${p.emoji} ${p.key} ${blend.ratio[0]} : ${blend.ratio[1]} ${s.emoji} ${s.key}</p>
    `;
  }

  // horizontal bar chart of the 8 attributes' vote counts, sorted by count desc.
  // every bar is directly labeled (name + count) so identity never relies on
  // color alone - the winning attribute's row is bolded.
  function voteChartHtml(votes, winnerKey) {
    const rows = ATTRIBUTES.map((a) => ({ ...a, count: votes[a.key] })).sort((a, b) => b.count - a.count);
    const total = QUESTIONS.length;
    return rows
      .map((a) => {
        const pct = Math.round((a.count / total) * 100);
        const isWinner = a.key === winnerKey;
        return `
          <div class="vote-row${isWinner ? " winner" : ""}">
            <span class="vote-name"><span class="vote-dot" style="--attr:${a.hex}"></span>${a.key}</span>
            <div class="vote-track"><div class="vote-fill" style="width:${pct}%;--attr:${a.hex}"></div></div>
            <span class="vote-count">${a.count}</span>
          </div>
        `;
      })
      .join("");
  }

  /* ---------------- rendering ---------------- */
  function renderStart() {
    app.innerHTML = `
      <div class="wrap start-screen">
        <p class="start-eyebrow">Personality Type Quiz</p>
        <h1 class="start-title">151タイプ性格診断</h1>
        <p class="start-lede">15個の質問に答えると、151パターンの中からあなたにぴったりの1体が見つかります。</p>
        <p class="start-count">全15問・所要時間 約2分</p>
        <button class="btn-start" id="btnStart">はじめる</button>
        <button class="link-roster" id="btnRoster">151体の図鑑を見る</button>
      </div>
    `;
    document.getElementById("btnStart").addEventListener("click", startQuiz);
    document.getElementById("btnRoster").addEventListener("click", showRoster);
  }

  function startQuiz() {
    goTo({ step: "quiz", qIndex: 0, answers: emptyAnswers(), result: null });
  }

  function renderQuiz() {
    const q = QUESTIONS[state.qIndex];
    const selected = state.answers[state.qIndex];
    const progressPct = ((state.qIndex + (selected !== null ? 1 : 0)) / QUESTIONS.length) * 100;
    const isLast = state.qIndex === QUESTIONS.length - 1;

    app.innerHTML = `
      <div class="wrap">
        <div class="progress-track"><div class="progress-fill" style="width:${progressPct}%"></div></div>
        <div class="progress-label"><span>質問 ${state.qIndex + 1}</span><span>${state.qIndex + 1} / ${QUESTIONS.length}</span></div>
        <p class="question-text">${q.text}</p>
        <div class="choice-list">
          ${q.choices
            .map(
              (c, i) =>
                `<button class="choice-btn${selected === i ? " selected" : ""}" data-i="${i}"><span class="choice-letter">${String.fromCharCode(65 + i)}</span>${c.text}</button>`
            )
            .join("")}
        </div>
        <div class="quiz-nav">
          <button class="btn-ghost" id="btnBack">← 戻る</button>
          <button class="btn-primary btn-next" id="btnNext" ${selected === null ? "disabled" : ""}>${isLast ? "結果を見る" : "次へ →"}</button>
        </div>
      </div>
    `;

    app.querySelectorAll(".choice-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const answers = state.answers.slice();
        answers[state.qIndex] = parseInt(btn.dataset.i, 10);
        updateCurrent({ answers });
      });
    });

    document.getElementById("btnBack").addEventListener("click", () => {
      history.back();
    });

    document.getElementById("btnNext").addEventListener("click", () => {
      if (state.answers[state.qIndex] === null) return;
      if (!isLast) {
        goTo({ qIndex: state.qIndex + 1 });
      } else {
        goTo({ step: "result", result: computeResult(state.answers) });
      }
    });
  }

  function renderResult() {
    const r = state.result;
    const attrMeta = attrMetaOf(r.attr);
    const rarityLabel = { normal: "☆☆☆ ノーマル", rare: "★★☆ レア", sr: "★★★ 激レア" }[r.rarity];
    const rateNote = { normal: "出現率 約82%", rare: "出現率 約18%", sr: "出現率 1%未満" }[r.rarity];

    app.innerHTML = `
      <div class="wrap">
        <article class="result-card ${r.rarity === "sr" ? "sr" : ""}">
          <div class="result-top">
            <p class="result-eyebrow">診断結果</p>
            <span class="rarity-pill ${r.rarity}">${rarityLabel}</span>
          </div>

          <div class="badge" style="--attr:${attrMeta.hex}"><svg viewBox="0 0 100 100">${SHAPES[attrMeta.shape]}</svg></div>
          <p class="cat-no">No.${r.globalNo} / 151</p>
          <p class="rate-note">${rateNote}</p>

          <h2 class="result-name">${r.character.name}</h2>
          <span class="attr-pill" style="--attr:${attrMeta.hex}">${attrMeta.emoji} ${attrMeta.key}属性</span>
          <p class="result-blurb">${r.character.blurb}</p>
          ${r.blend ? blendBarHtml(r.attr, r.blend) : ""}
          <p class="similar-note">似ている登場人物：<strong>${r.character.similar.name}</strong>（${r.character.similar.work}）</p>

          <div class="divider"></div>

          <div class="compat-mini">
            <p class="compat-label">◎ 相性が良いキャラ</p>
            <div class="compat-chips">${r.good.map(matchChipHtml).join("")}</div>
            <p class="compat-label" style="margin-top:2px;">✕ 相性が悪いキャラ</p>
            <div class="compat-chips">${r.bad.map(matchChipHtml).join("")}</div>
          </div>

          <div class="divider"></div>

          <details class="result-details">
            <summary>詳細を見る（15問の回答から見た属性の投票分布）</summary>
            <div class="vote-chart">${voteChartHtml(r.votes, r.attr)}</div>
          </details>

          <div class="divider"></div>

          <div class="ad-slot">
            <span class="ad-slot-label">広告</span>
            <span class="ad-slot-size">バナー広告（モックアップ）</span>
          </div>

          <button class="btn-primary" id="btnShare">結果をシェアする</button>
          <div class="btn-row">
            <button class="btn-ghost" id="btnRetry">もう一度診断する</button>
            <button class="btn-ghost" id="btnRosterFromResult">図鑑を見る</button>
          </div>
          <button class="link-muted" id="btnBackFromResult" style="background:none;border:none;cursor:pointer;">← 最後の質問に戻る</button>
        </article>
      </div>
    `;

    document.getElementById("btnShare").addEventListener("click", () => shareResult(r, attrMeta, rarityLabel));
    document.getElementById("btnRetry").addEventListener("click", startQuiz);
    document.getElementById("btnRosterFromResult").addEventListener("click", showRoster);
    document.getElementById("btnBackFromResult").addEventListener("click", () => history.back());
  }

  function shareResult(r, attrMeta, rarityLabel) {
    const shareText = `${attrMeta.key}属性の${r.character.name}でした！（${rarityLabel}）\n151タイプ性格診断`;
    if (navigator.share) {
      // ユーザーが共有シートを閉じた場合(AbortError)はエラー表示しない。
      // それ以外の失敗(非対応環境など)はコピーへフォールバックする。
      navigator.share({ title: "151タイプ性格診断", text: shareText, url: location.href }).catch((err) => {
        if (err && err.name === "AbortError") return;
        copyToClipboard(shareText);
      });
    } else {
      copyToClipboard(shareText);
    }
  }

  function copyToClipboard(shareText) {
    const payload = `${shareText}\n${location.href}`;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard
        .writeText(payload)
        .then(() => showToast("結果をコピーしました"))
        .catch(() => showToast("コピーに失敗しました（HTTPS環境でお試しください）"));
    } else {
      showToast("この端末では自動コピーに対応していません");
    }
  }

  function showToast(msg) {
    let toast = document.getElementById("toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "toast";
      toast.className = "toast";
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.add("show");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.remove("show"), 2200);
  }

  /* ---------------- roster panel ---------------- */
  function renderRosterHTML() {
    return ATTRIBUTES.map((a) => {
      const g = CHARACTERS[a.key];
      const others = ATTRIBUTES.map((x) => x.key).filter((k) => k !== a.key);
      const rows = [
        ...others.map((k) => ({ ...g.blend0[k], stars: "☆☆☆", note: `点差0・${k}寄り` })),
        ...others.map((k) => ({ ...g.blend1[k], stars: "☆☆☆", note: `点差1・${k}寄り` })),
        ...g.rare.map((c) => ({ ...c, stars: "★★☆", note: "レア" })),
        ...g.sr.map((c) => ({ ...c, stars: "★★★", note: "激レア" })),
      ];
      return `
        <div class="roster-group">
          <h3><span class="roster-dot" style="--attr:${a.hex}"></span>${a.emoji} ${a.key}属性（${rows.length}体）</h3>
          ${rows.map((c) => `<div class="roster-row"><span>${c.name}<span class="roster-note">（${c.similar.name}）</span></span><span class="roster-star">${c.stars}</span></div>`).join("")}
        </div>
      `;
    }).join("");
  }

  function showRoster() {
    const overlay = document.createElement("div");
    overlay.className = "roster-overlay";
    overlay.innerHTML = `
      <div class="roster-panel">
        <div class="roster-top"><h2>151体図鑑</h2><button class="roster-close" id="rosterClose" aria-label="閉じる">×</button></div>
        ${renderRosterHTML()}
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.remove();
    });
    overlay.querySelector("#rosterClose").addEventListener("click", () => overlay.remove());
  }

  // ページの再読み込み(F5等)でも、ブラウザが保持している history.state があれば
  // それを復元する(＝クイズ途中や結果画面のままリロードしても続きから表示される)。
  // 無ければ(初回アクセス等)スタート画面の状態を新規に積む。
  if (history.state && history.state.step) {
    state = history.state;
  } else {
    history.replaceState(state, "");
  }
  render();
})();
