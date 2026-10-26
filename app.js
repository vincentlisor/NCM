/* NCM 107 Reviewer - app logic (vanilla JS, no build step needed) */
(function () {
  "use strict";

  /* ---------- helpers ---------- */
  const $ = (s, r) => (r || document).querySelector(s);
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
  };
  const shuffle = (arr) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const TYPE_LABEL = { mc: "Multiple choice", id: "Identification", enum: "Enumeration" };
  const TOPIC_ORDER = ["Toddler", "Preschool", "School-Age", "Adolescent", "Play", "Pain Assessment"];
  const LETTERS = ["A", "B", "C", "D", "E", "F"];

  /* ---------- text matching ---------- */
  function norm(s) {
    return String(s)
      .toLowerCase()
      .replace(/\u00bd/g, " 1/2")
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9/ ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  function lev(a, b) {
    const m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[n];
  }
  // Identification: exact, whole-word containment, or small typo tolerance
  function checkId(user, answers) {
    const n = norm(user);
    if (!n) return false;
    return answers.some((a) => {
      const x = norm(a);
      if (n === x) return true;
      if (x.length >= 4 && (" " + n + " ").includes(" " + x + " ")) return true;
      const tol = x.length >= 9 ? 2 : x.length >= 5 ? 1 : 0;
      return tol > 0 && lev(n, x) <= tol;
    });
  }
  // Enumeration: each typed line may match one unused answer item via keywords
  function checkEnum(inputs, items) {
    const used = new Set();
    return inputs.map((raw) => {
      const n = norm(raw);
      if (!n) return { empty: true, ok: false, idx: -1 };
      for (let i = 0; i < items.length; i++) {
        if (used.has(i)) continue;
        const hit = items[i].k.some((k) => {
          const kk = norm(k);
          if (n.includes(kk)) return true;
          return kk.length >= 6 && lev(n, kk) <= 1;
        });
        if (hit) { used.add(i); return { empty: false, ok: true, idx: i }; }
      }
      return { empty: false, ok: false, idx: -1 };
    });
  }

  /* ---------- state ---------- */
  const state = {
    selTopics: new Set(),
    selTypes: new Set(["mc", "id", "enum"]),
    queue: [],
    i: 0,
    score: 0,
    answered: false,
    results: [],
    cur: null,
    showAll: false,
  };

  const screens = { setup: $("#screen-setup"), quiz: $("#screen-quiz"), result: $("#screen-result") };
  function show(name) {
    Object.keys(screens).forEach((k) => { screens[k].hidden = k !== name; });
    window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
  }

  /* ---------- theme ---------- */
  function applyTheme(t) {
    document.documentElement.setAttribute("data-theme", t);
    $("#themeIcon").innerHTML = t === "dark" ? "&#9728;" : "&#9790;";
  }
  (function initTheme() {
    let t = store.get("ncm107_theme");
    if (!t) t = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    applyTheme(t);
    $("#themeToggle").addEventListener("click", () => {
      const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
      applyTheme(next);
      store.set("ncm107_theme", next);
    });
  })();

  /* ---------- setup screen ---------- */
  const topics = TOPIC_ORDER.filter((t) => QUESTIONS.some((q) => q.topic === t));
  QUESTIONS.forEach((q) => { if (!topics.includes(q.topic)) topics.push(q.topic); });
  topics.forEach((t) => state.selTopics.add(t));

  function buildChips() {
    const tc = $("#topicChips");
    tc.innerHTML = "";
    topics.forEach((t, i) => {
      const n = QUESTIONS.filter((q) => q.topic === t).length;
      const id = "topic" + i;
      const div = document.createElement("div");
      div.className = "chip";
      div.innerHTML = `<input type="checkbox" id="${id}" value="${esc(t)}" checked><label for="${id}">${esc(t)} <small>${n}</small></label>`;
      div.querySelector("input").addEventListener("change", (e) => {
        e.target.checked ? state.selTopics.add(t) : state.selTopics.delete(t);
        refreshAvailable();
      });
      tc.appendChild(div);
    });
    const yc = $("#typeChips");
    yc.innerHTML = "";
    Object.keys(TYPE_LABEL).forEach((k) => {
      const n = QUESTIONS.filter((q) => q.type === k).length;
      const div = document.createElement("div");
      div.className = "chip";
      div.innerHTML = `<input type="checkbox" id="type_${k}" value="${k}" checked><label for="type_${k}">${TYPE_LABEL[k]} <small>${n}</small></label>`;
      div.querySelector("input").addEventListener("change", (e) => {
        e.target.checked ? state.selTypes.add(k) : state.selTypes.delete(k);
        refreshAvailable();
      });
      yc.appendChild(div);
    });
  }

  function pool() {
    return QUESTIONS.filter((q) => state.selTopics.has(q.topic) && state.selTypes.has(q.type));
  }
  function refreshAvailable() {
    const n = pool().length;
    const sel = $("#countSelect");
    const prev = sel.value;
    const options = [10, 25, 50, 100].filter((x) => x < n);
    sel.innerHTML = "";
    options.forEach((x) => sel.insertAdjacentHTML("beforeend", `<option value="${x}">${x} questions</option>`));
    sel.insertAdjacentHTML("beforeend", `<option value="all">All (${n})</option>`);
    if ([...sel.options].some((o) => o.value === prev)) sel.value = prev; else sel.value = "all";
    $("#availableMsg").textContent = n ? `${n} question${n === 1 ? "" : "s"} match your selection.` : "Select at least one topic and one question type.";
    $("#btnStart").disabled = n === 0;
  }

  function refreshStats() {
    $("#statTotal").textContent = QUESTIONS.length;
    $("#statTopics").textContent = topics.length;
    const best = store.get("ncm107_best");
    $("#statBest").textContent = best ? best.pct + "%" : "\u2013";
  }

  $("#selAllTopics").addEventListener("click", () => {
    topics.forEach((t) => state.selTopics.add(t));
    document.querySelectorAll("#topicChips input").forEach((i) => (i.checked = true));
    refreshAvailable();
  });
  $("#selNoTopics").addEventListener("click", () => {
    state.selTopics.clear();
    document.querySelectorAll("#topicChips input").forEach((i) => (i.checked = false));
    refreshAvailable();
  });

  /* ---------- start / quiz ---------- */
  function startSession(list, label) {
    state.queue = list;
    state.i = 0;
    state.score = 0;
    state.results = [];
    state.sessionLabel = label || "";
    show("quiz");
    renderQuestion();
  }
  $("#btnStart").addEventListener("click", () => {
    let list = pool();
    if ($("#shuffleToggle").checked) list = shuffle(list);
    const c = $("#countSelect").value;
    if (c !== "all") list = list.slice(0, parseInt(c, 10));
    startSession(list, "standard");
  });

  function renderQuestion() {
    const q = state.queue[state.i];
    state.answered = false;
    state.cur = { q };
    $("#qCounter").textContent = `Question ${state.i + 1} of ${state.queue.length}`;
    $("#liveScore").textContent = `Score: ${state.score}`;
    const pct = (state.i / state.queue.length) * 100;
    $("#progressBar").style.width = pct + "%";
    $("#progressWrap").setAttribute("aria-valuenow", Math.round(pct));
    $("#topicBadge").textContent = q.topic;
    $("#typeBadge").textContent = TYPE_LABEL[q.type];
    $("#qText").textContent = q.q;
    const area = $("#answerArea");
    area.innerHTML = "";
    const fb = $("#feedback");
    fb.hidden = true;
    fb.className = "feedback";
    fb.innerHTML = "";
    $("#btnNext").hidden = true;
    $("#btnCheck").hidden = q.type === "mc";
    $("#btnSkip").hidden = q.type === "mc";
    $("#btnCheck").disabled = false;
    $("#btnSkip").disabled = false;

    if (q.type === "mc") {
      $("#qHint").textContent = "Choose the best answer.";
      const opts = shuffle([{ t: q.a, ok: true }].concat(q.w.map((t) => ({ t, ok: false }))));
      state.cur.opts = opts;
      opts.forEach((o, idx) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "choice";
        b.innerHTML = `<span class="letter">${LETTERS[idx]}</span><span class="ctext">${esc(o.t)}</span><span class="mark" aria-hidden="true"></span>`;
        b.addEventListener("click", () => answerMC(idx));
        area.appendChild(b);
      });
    } else if (q.type === "id") {
      $("#qHint").textContent = "Type your answer. Spelling does not need to be perfect.";
      const inp = document.createElement("input");
      inp.type = "text";
      inp.className = "text-input";
      inp.id = "idInput";
      inp.autocomplete = "off";
      inp.autocapitalize = "off";
      inp.spellcheck = false;
      inp.placeholder = "Your answer";
      inp.setAttribute("aria-label", "Your answer");
      area.appendChild(inp);
      setTimeout(() => inp.focus(), 30);
    } else {
      const need = q.need;
      const total = q.items.length;
      $("#qHint").textContent = need < total ? `Enter any ${need} answers (one per box).` : `Enter ${need} answers (one per box, any order).`;
      const list = document.createElement("div");
      list.className = "enum-list";
      for (let i = 0; i < need; i++) {
        const row = document.createElement("div");
        row.className = "enum-row";
        row.innerHTML = `<span class="num">${i + 1}</span><input type="text" class="text-input enum-input" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Answer ${i + 1}" aria-label="Answer ${i + 1}">`;
        list.appendChild(row);
      }
      area.appendChild(list);
      setTimeout(() => { const f = area.querySelector("input"); if (f) f.focus(); }, 30);
    }
  }

  function setFeedback(ok, correctHTML, q) {
    const fb = $("#feedback");
    fb.hidden = false;
    fb.className = "feedback " + (ok ? "ok" : "bad");
    fb.innerHTML =
      `<h4>${ok ? "\u2713 Correct!" : "\u2717 Not quite"}</h4>` +
      (correctHTML ? `<p class="correct-line">${correctHTML}</p>` : "") +
      `<p class="explain">${esc(q.e)}</p>` +
      `<p class="src">From your notes: ${esc(q.topic)} (${esc(q.page)})</p>`;
  }

  function finishQuestion(ok, userText, answerText) {
    const q = state.cur.q;
    state.answered = true;
    if (ok) state.score++;
    state.results.push({ q, ok, user: userText, answer: answerText });
    $("#liveScore").textContent = `Score: ${state.score}`;
    $("#btnCheck").hidden = true;
    $("#btnSkip").hidden = true;
    const next = $("#btnNext");
    next.hidden = false;
    next.innerHTML = state.i === state.queue.length - 1 ? "See results &rarr;" : "Next question &rarr;";
    setTimeout(() => next.focus(), 30);
    const pct = ((state.i + 1) / state.queue.length) * 100;
    $("#progressBar").style.width = pct + "%";
  }

  /* multiple choice */
  function answerMC(idx) {
    if (state.answered) return;
    const q = state.cur.q;
    const opts = state.cur.opts;
    const buttons = [...document.querySelectorAll("#answerArea .choice")];
    buttons.forEach((b, i) => {
      b.disabled = true;
      const mark = b.querySelector(".mark");
      if (opts[i].ok) { b.classList.add("correct"); mark.textContent = "\u2713"; }
      else if (i === idx) { b.classList.add("wrong"); mark.textContent = "\u2717"; }
      else b.classList.add("dim");
    });
    const ok = opts[idx].ok;
    setFeedback(ok, ok ? "" : `Correct answer: <strong>${esc(q.a)}</strong>`, q);
    finishQuestion(ok, opts[idx].t, q.a);
  }

  /* identification */
  function answerID(reveal) {
    if (state.answered) return;
    const q = state.cur.q;
    const inp = $("#idInput");
    const val = inp.value.trim();
    if (!reveal && !val) { inp.focus(); return; }
    const ok = !reveal && checkId(val, q.a);
    inp.readOnly = true;
    if (val) inp.classList.add(ok ? "correct" : "wrong");
    const area = $("#answerArea");
    if (!ok) {
      const box = document.createElement("div");
      box.className = "answer-box green";
      box.innerHTML = `<small>Correct answer</small>${esc(q.show)}`;
      area.appendChild(box);
    }
    setFeedback(ok, ok ? `Correct answer: <strong>${esc(q.show)}</strong>` : "", q);
    finishQuestion(ok, val || "(no answer)", q.show);
  }

  /* enumeration */
  function answerEnum(reveal) {
    if (state.answered) return;
    const q = state.cur.q;
    const inputs = [...document.querySelectorAll("#answerArea .enum-input")];
    const values = inputs.map((i) => i.value.trim());
    if (!reveal && values.every((v) => !v)) { inputs[0].focus(); return; }
    const res = checkEnum(reveal ? values.map(() => "") : values, q.items);
    const usedIdx = new Set();
    let matched = 0;
    inputs.forEach((inp, i) => {
      inp.readOnly = true;
      if (!res[i].empty) {
        inp.classList.add(res[i].ok ? "correct" : "wrong");
        if (res[i].ok) { matched++; usedIdx.add(res[i].idx); }
      }
    });
    const ok = !reveal && matched >= q.need;
    const area = $("#answerArea");
    const missed = q.items.filter((_, i) => !usedIdx.has(i));
    if (!ok) {
      const stack = document.createElement("div");
      stack.className = "answer-stack";
      const title = q.need < q.items.length ? "Accepted answers you did not give" : "Answers you missed";
      stack.innerHTML = missed.map((m) => `<div class="answer-box green missed"><small>${title}</small>${esc(m.show)}</div>`).join("");
      area.appendChild(stack);
    }
    const allAns = q.items.map((m) => m.show).join("; ");
    const line = ok
      ? `You got ${matched} of ${q.need}.`
      : `You got ${matched} of ${q.need}. Full answer: <strong>${esc(allAns)}</strong>`;
    setFeedback(ok, line, q);
    finishQuestion(ok, values.filter(Boolean).join("; ") || "(no answer)", allAns + (q.need < q.items.length ? ` (any ${q.need})` : ""));
  }

  $("#btnCheck").addEventListener("click", () => {
    const q = state.cur.q;
    q.type === "id" ? answerID(false) : answerEnum(false);
  });
  $("#btnSkip").addEventListener("click", () => {
    const q = state.cur.q;
    q.type === "id" ? answerID(true) : answerEnum(true);
  });
  $("#btnNext").addEventListener("click", () => {
    if (state.i >= state.queue.length - 1) return showResults();
    state.i++;
    renderQuestion();
  });
  $("#btnQuit").addEventListener("click", () => {
    if (state.results.length === 0 || confirm("Quit this session? Your progress will be lost.")) goHome();
  });

  document.addEventListener("keydown", (e) => {
    if (screens.quiz.hidden) return;
    const q = state.cur && state.cur.q;
    if (!q) return;
    const tag = (document.activeElement && document.activeElement.tagName) || "";
    if (e.key === "Enter") {
      if (state.answered) { e.preventDefault(); $("#btnNext").click(); }
      else if (q.type !== "mc") {
        if (tag === "INPUT" && q.type === "enum") {
          const inputs = [...document.querySelectorAll("#answerArea .enum-input")];
          const idx = inputs.indexOf(document.activeElement);
          if (idx > -1 && idx < inputs.length - 1) { e.preventDefault(); inputs[idx + 1].focus(); return; }
        }
        e.preventDefault();
        $("#btnCheck").click();
      }
    } else if (q.type === "mc" && !state.answered && tag !== "INPUT") {
      const n = parseInt(e.key, 10);
      const l = LETTERS.indexOf(e.key.toUpperCase());
      const idx = n >= 1 && n <= state.cur.opts.length ? n - 1 : l;
      if (idx > -1 && idx < state.cur.opts.length) answerMC(idx);
    }
  });

  /* ---------- results ---------- */
  function showResults() {
    show("result");
    const total = state.results.length;
    const correct = state.results.filter((r) => r.ok).length;
    const pct = total ? Math.round((correct / total) * 100) : 0;
    $("#ring").style.setProperty("--p", pct);
    $("#ringPct").textContent = pct + "%";
    $("#ringText").textContent = `${correct} / ${total}`;
    let title = "Keep practicing!", msg = "Review the missed questions below, then try again.";
    if (pct >= 90) { title = "Outstanding!"; msg = "You know your notes very well. Keep it up!"; }
    else if (pct >= 75) { title = "Great job!"; msg = "You are almost there. Review the few items you missed."; }
    else if (pct >= 50) { title = "Good effort!"; msg = "You have the basics. Focus on the topics with lower scores."; }
    $("#resultTitle").textContent = title;
    $("#resultMsg").textContent = msg;

    if (total >= 10) {
      const best = store.get("ncm107_best");
      if (!best || pct >= best.pct) store.set("ncm107_best", { pct, date: new Date().toISOString() });
    }

    // topic breakdown
    const by = {};
    state.results.forEach((r) => {
      const t = r.q.topic;
      by[t] = by[t] || { c: 0, n: 0 };
      by[t].n++;
      if (r.ok) by[t].c++;
    });
    $("#topicBreakdown").innerHTML = Object.keys(by)
      .sort((a, b) => topics.indexOf(a) - topics.indexOf(b))
      .map((t) => {
        const p = Math.round((by[t].c / by[t].n) * 100);
        return `<div class="bd-row"><div class="bd-top"><span>${esc(t)}</span><span>${by[t].c}/${by[t].n} (${p}%)</span></div><div class="bd-bar"><div class="bd-fill" style="width:${p}%"></div></div></div>`;
      })
      .join("");

    const missed = state.results.filter((r) => !r.ok).length;
    $("#btnRetryMissed").hidden = missed === 0;
    state.showAll = missed === 0;
    renderReview();
    refreshStats();
  }

  function renderReview() {
    const list = state.showAll ? state.results : state.results.filter((r) => !r.ok);
    const missed = state.results.filter((r) => !r.ok).length;
    $("#reviewTitle").textContent = state.showAll ? "All questions" : "Questions to review (" + missed + ")";
    $("#btnToggleReview").textContent = state.showAll ? "Show missed only" : "Show all questions";
    $("#btnToggleReview").hidden = missed === 0;
    $("#reviewList").innerHTML = list.length
      ? list.map((r) =>
          `<div class="review-item ${r.ok ? "ok" : "bad"}">
            <div class="rq">${esc(r.q.q)}</div>
            ${r.ok ? "" : `<div class="rline your">Your answer: ${esc(r.user)}</div>`}
            <div class="rline right">${r.ok ? "\u2713 " : ""}Correct answer: ${esc(r.answer)}</div>
            <p class="rexp">${esc(r.q.e)} <em>(${esc(r.q.topic)}, ${esc(r.q.page)})</em></p>
          </div>`).join("")
      : `<p class="empty">Perfect score - nothing to review!</p>`;
  }
  $("#btnToggleReview").addEventListener("click", () => { state.showAll = !state.showAll; renderReview(); });
  $("#btnRetryMissed").addEventListener("click", () => {
    const missedQs = state.results.filter((r) => !r.ok).map((r) => r.q);
    if (missedQs.length) startSession(shuffle(missedQs), "retry");
  });
  $("#btnNew").addEventListener("click", goHome);

  function goHome() {
    refreshStats();
    show("setup");
  }

  /* ---------- init ---------- */
  buildChips();
  refreshAvailable();
  refreshStats();
  show("setup");
})();
