/* 陪护床位与消毒交接系统 —— 前端逻辑（原生 JS，无依赖） */
"use strict";

const state = {
  meta: { wards: [], nurses: [], beds: [] },
  currentNurseId: null,
  view: "bedmap",
  returnTarget: null,   // {assignmentId}
  settleTarget: null,
  swapTarget: null,
};

const CAT_LABEL = { frame: "床架", mattress: "床垫", linen: "床品", accessory: "配件" };
const CAT_ORDER = ["frame", "mattress", "linen", "accessory"];
const STATE_LABEL = { ok: "正常", missing: "数量缺失", damaged: "损坏", contaminated: "污染" };
const CLEAN_LABEL = { clean: "已清洁", dirty: "待清洁", isolated: "污染隔离" };

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const yuan = (fen) => (Number(fen || 0) / 100).toFixed(2);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uuid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : "k-" + Date.now() + "-" + Math.random().toString(16).slice(2));

async function api(path, body) {
  const opt = body
    ? { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body) }
    : {};
  const res = await fetch(path, opt);
  const data = await res.json().catch(() => ({ ok: false, error: "响应解析失败" }));
  if (!data.ok) {
    const err = new Error(data.error || "操作失败");
    err.code = data.code;
    throw err;
  }
  return data;
}

function toast(msg, isError = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (isError ? " error" : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), 3200);
}

function currentNurse() {
  return state.meta.nurses.find(n => n.id === state.currentNurseId);
}

/* ---------------- 初始化与导航 ---------------- */

async function init() {
  state.meta = await api("/api/meta");
  const saved = Number(localStorage.getItem("nurseId"));
  state.currentNurseId =
    state.meta.nurses.some(n => n.id === saved) ? saved : state.meta.nurses[0].id;
  renderNursePicker();
  $("#nurseSelect").addEventListener("change", e => {
    state.currentNurseId = Number(e.target.value);
    localStorage.setItem("nurseId", state.currentNurseId);
    renderNursePicker();
    refreshAll();
  });
  $$("#tabs .tab").forEach(btn => btn.addEventListener("click", () => {
    showView(btn.dataset.view);
  }));
  bindModals();
  await refreshAll();
}

function showView(view) {
  state.view = view;
  $$("#tabs .tab").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  $$(".view").forEach(v => v.classList.toggle("active", v.id === "view-" + view));
  refreshAll();
}

function renderNursePicker() {
  const sel = $("#nurseSelect");
  sel.innerHTML = state.meta.nurses.map(n =>
    `<option value="${n.id}" ${n.id === state.currentNurseId ? "selected" : ""}>
      ${esc(n.name)}（${esc(n.ward_name)}）</option>`).join("");
  const n = currentNurse();
  $("#nurseWard").textContent = n ? n.ward_name : "";
}

async function refreshAll() {
  // 床位图与异常始终刷新（多个视图复用）
  const [bm, ex] = await Promise.all([
    api("/api/bedmap"), api("/api/exceptions"),
  ]);
  state.bedmap = bm.wards;
  state.exceptions = ex.exceptions;
  state.meta.beds = bm.wards.flatMap(w => w.beds.map(b => ({ ...b })));
  renderBedMap();
  renderExceptions();
  if (state.view === "queue") await renderQueue();
  if (state.view === "timeline") await renderTimeline();
  if (state.view === "return") await renderReturnView();
  if (state.view === "batch") await renderBatchView();
  if (state.view === "deposit") await renderDepositView();
}

/* ---------------- 病区床位图 ---------------- */

function bedBlocked(b) {
  return b.cleaning_status !== "clean" || b.maintenance === "maintenance" || b.occupied;
}

function renderBedMap() {
  $("#bedmap").innerHTML = state.bedmap.map(w => {
    const free = w.beds.filter(b => !bedBlocked(b)).length;
    const dirty = w.beds.filter(b => b.cleaning_status === "dirty").length;
    const isolated = w.beds.filter(b => b.cleaning_status === "isolated").length;
    const maint = w.beds.filter(b => b.maintenance === "maintenance").length;
    const occupied = w.beds.filter(b => b.occupied).length;
    return `
    <div class="ward-block">
      <div class="ward-head">
        <div><span class="wname">${esc(w.name)}</span><span class="wcode">${esc(w.code)}</span></div>
        <div class="ward-stats">可分配 ${free} · 使用 ${occupied} · 待清洁 ${dirty}
          · 隔离 ${isolated} · 维修 ${maint} / 共 ${w.beds.length}</div>
      </div>
      <div class="bed-cards">
        ${w.beds.map(b => bedCard(b)).join("")}
      </div>
    </div>`;
  }).join("");

  $$("#bedmap [data-maint-open]").forEach(btn =>
    btn.addEventListener("click", () => openMaintenance(Number(btn.dataset.maintOpen))));
  $$("#bedmap [data-maint-close]").forEach(btn =>
    btn.addEventListener("click", () => closeMaintenance(Number(btn.dataset.maintClose))));
}

function bedCard(b) {
  const blocked = bedBlocked(b);
  const badges = [
    `<span class="badge ${b.cleaning_status}">${CLEAN_LABEL[b.cleaning_status]}</span>`,
    `<span class="badge ${b.occupied ? "occupied" : "clean"}">${b.occupied ? "使用中" : "空闲"}</span>`,
    `<span class="badge ${b.maintenance === "maintenance" ? "maintenance" : "clean"}">` +
      `${b.maintenance === "maintenance" ? "维修中" : "床况正常"}</span>`,
  ].join("");
  const canWard = currentNurse() && currentNurse().ward_id === b.ward_id;
  const maintBtn = b.maintenance === "maintenance"
    ? (canWard ? `<button class="btn" data-maint-close="${b.id}">修复完工</button>` : "")
    : (!b.occupied && canWard
       ? `<button class="btn ghost" data-maint-open="${b.id}">报修</button>` : "");
  return `
  <div class="bed-card ${b.cleaning_status} ${blocked ? "blocked" : ""}">
    <div class="bed-top">
      <div><div class="bed-code">${esc(b.code)}</div>
        <div class="bed-spec">${esc(b.spec)}</div></div>
    </div>
    <div class="badges">${badges}</div>
    ${b.note ? `<div class="bed-note">${esc(b.note)}</div>` : ""}
    ${maintBtn ? `<div class="card-actions">${maintBtn}</div>` : ""}
  </div>`;
}

function renderExceptions() {
  const label = {
    swap: "临时换床", deposit_diff: "押金差异", linen_missing: "床品/配件缺失",
    isolation: "污染隔离", overdue: "使用超时", disinfect_failed: "消毒失败",
  };
  $("#exceptionList").innerHTML = state.exceptions.slice(0, 12).map(e => `
    <div class="ex-row ${e.type}">
      <span class="ex-type">${label[e.type] || e.type}</span>
      <span>${esc(e.note)}${e.ward_name ? ` · ${esc(e.ward_name)}` : ""}</span>
      <span class="ex-time">${esc(e.created_at)}</span>
    </div>`).join("") || `<p class="muted">暂无异常记录。</p>`;
}

async function openMaintenance(bedId) {
  const reason = prompt("报修原因（维修中的床位不得被预约）：", "床架折叠故障");
  if (reason === null) return;
  try {
    await api("/api/maintenance/open", {
      bed_id: bedId, reason: reason || "床具故障",
      opened_by: currentNurse().name,
    });
    toast("已转入维修，床位已锁定");
    refreshAll();
  } catch (e) { toast(e.message, true); }
}
async function closeMaintenance(bedId) {
  try {
    await api("/api/maintenance/close", { bed_id: bedId });
    toast("维修工单已关闭，床位恢复正常（仍需清洁合格才可预约）");
    refreshAll();
  } catch (e) { toast(e.message, true); }
}

/* ---------------- 申请队列 ---------------- */

async function renderQueue() {
  const { requests: rows } = await api("/api/queue");
  if (!rows.length) {
    $("#queueList").innerHTML = `<div class="card muted">当前没有待处理申请。</div>`;
    return;
  }
  const nurse = currentNurse();
  $("#queueList").innerHTML = rows.map(r => {
    const sameWard = nurse.ward_id === r.ward_id;
    const candidates = state.meta.beds.filter(b =>
      b.ward_id === r.ward_id && b.spec === r.spec && !bedBlocked(b));
    const opts = candidates.map(b =>
      `<option value="${b.id}">${esc(b.code)} · ${CLEAN_LABEL[b.cleaning_status]}</option>`).join("");
    return `
    <div class="card" data-req="${r.id}">
      <div class="card-row">
        <span class="card-title">${esc(r.code)}</span>
        <span class="status-pill queued">待处理</span>
        <div class="kv"><span class="k">匿名申请人</span><span class="v">${esc(r.patient_tag)}（${esc(r.relation)}）</span></div>
        <div class="kv"><span class="k">申请病区</span><span class="v">${esc(r.ward_name)}</span></div>
        <div class="kv"><span class="k">规格</span><span class="v">${esc(r.spec)}</span></div>
        <div class="kv"><span class="k">计划时段</span>
          <span class="v">${esc(r.expected_start.slice(5, 16))} → ${esc(r.expected_end.slice(5, 16))}</span></div>
      </div>
      ${r.note ? `<p class="muted" style="margin-top:8px">${esc(r.note)}</p>` : ""}
      ${!sameWard ? `<p class="warn" style="margin-top:10px">当前执行人不属于该病区，无权分配。</p>` : ""}
      <div class="card-actions">
        <select data-bed style="min-width:170px">
          ${opts || `<option value="">无可用床位（清洁阻断 / 维修 / 占用）</option>`}
        </select>
        <button class="btn primary" data-assign ${(!sameWard || !candidates.length) ? "disabled" : ""}>
          确认并锁定时段</button>
      </div>
    </div>`;
  }).join("");

  $$("#queueList [data-assign]").forEach(btn =>
    btn.addEventListener("click", async () => {
      const card = btn.closest(".card");
      const reqId = Number(card.dataset.req);
      const bedId = Number(card.querySelector("[data-bed]").value);
      if (!bedId) return;
      btn.disabled = true;
      try {
        const res = await api("/api/assign", {
          request_id: reqId, bed_id: bedId,
          nurse_id: state.currentNurseId,
          idempotency_key: uuid(),
        });
        toast(`已分配 ${res.code}，冻结押金 ${yuan(res.deposit_fen)} 元`);
        refreshAll();
      } catch (e) {
        toast(e.message, true);
        btn.disabled = false;
      }
    }));
}

/* ---------------- 使用时间线 ---------------- */

async function renderTimeline() {
  const { assignments: rows } = await api("/api/timeline");
  $("#timelineList").innerHTML = rows.map(a => timelineCard(a)).join("")
    || `<div class="card muted">暂无订单。</div>`;
  bindOrderActions("#timelineList");
}

function statusPill(status) {
  const map = { active: "使用中", returned: "已归还待结算", settled: "已结算" };
  return `<span class="status-pill ${status}">${map[status] || status}</span>`;
}

function timelineCard(a) {
  const d = a.deposit || {};
  const steps = [
    { t: a.start_at, text: `开始使用 · ${esc(a.bed_code)}（执行人 ${esc(a.nurse_name)}）`, ok: true },
  ];
  if (a.actual_end_at) {
    steps.push({ t: a.actual_end_at,
      text: `归还核验${a.return && a.return.late ? " · 使用超时" : ""}`,
      warn: a.return && (a.return.late === 1) });
  }
  if (d.settled) steps.push({ t: d.settled_at, text: "押金结算完成，订单锁定", ok: true });
  const nurse = currentNurse();
  const canWard = nurse && nurse.ward_id === a.ward_id;
  let actions = "";
  if (a.status === "active" && canWard) {
    actions = `
      <button class="btn primary" data-return="${a.id}">归还核验</button>
      <button class="btn" data-swap="${a.id}">临时换床</button>`;
  }
  if (a.status === "returned" && canWard) {
    actions = `<button class="btn ink" data-settle="${a.id}">押金结算</button>`;
  }
  return `
  <div class="card">
    <div class="card-row">
      <span class="card-title">${esc(a.code)}</span>
      ${statusPill(a.status)}
      <div class="kv"><span class="k">匿名申请人</span><span class="v">${esc(a.patient_tag)}</span></div>
      <div class="kv"><span class="k">病区 / 床位</span><span class="v">${esc(a.ward_name)} · ${esc(a.bed_code)}</span></div>
      <div class="kv"><span class="k">押金（冻结/扣/退）</span>
        <span class="v">${yuan(d.hold)} / ${yuan(d.deducted)} / ${yuan(d.refunded)} 元</span></div>
    </div>
    <div class="timeline-track">
      ${steps.map(s => `
        <div class="tl-item ${s.warn ? "warn" : ""}">
          <span class="tl-time">${esc((s.t || "").slice(5, 16))}</span>${esc(s.text)}
        </div>`).join("")}
    </div>
    ${a.return ? returnGrid(a.return) : ""}
    ${actions ? `<div class="card-actions">${actions}</div>` : ""}
  </div>`;
}

function returnGrid(ret) {
  const cell = (label, st, reason) => `
    <div class="rg-cell ${st}">
      <div class="rg-label">${label}</div>
      <div class="rg-state state-${st}">${STATE_LABEL[st]}</div>
      <div class="rg-reason">${esc(reason || "—")}</div>
    </div>`;
  return `
  <div class="return-grid">
    ${cell("床架", ret.frame_status, ret.frame_reason)}
    ${cell("床垫", ret.mattress_status, ret.mattress_reason)}
    ${cell("床品", ret.linen_status, ret.linen_reason)}
    ${cell("配件", ret.accessory_status, ret.accessory_reason)}
  </div>
  <div class="card-row" style="margin-top:8px">
    ${ret.photo_path ? `<img class="thumb" src="/photos/${esc(PathName(ret.photo_path))}" alt="交接照片">` : ""}
    <span class="muted">核验时间 ${esc(ret.returned_at)}${ret.late ? " · <b style='color:var(--warn)'>使用超时</b>" : ""}</span>
  </div>`;
}
function PathName(p) { return p.split(/[\\/]/).pop(); }

/* ---------------- 归还核验视图 ---------------- */

async function renderReturnView() {
  const { assignments: rows } = await api("/api/timeline");
  const active = rows.filter(a => a.status === "active");
  const nurse = currentNurse();
  if (!active.length) {
    $("#returnList").innerHTML = `<div class="card muted">当前没有使用中的订单。</div>`;
    return;
  }
  $("#returnList").innerHTML = active.map(a => {
    const canWard = nurse.ward_id === a.ward_id;
    return `
    <div class="card">
      <div class="card-row">
        <span class="card-title">${esc(a.code)}</span>
        <span class="status-pill active">使用中</span>
        <div class="kv"><span class="k">床位</span><span class="v">${esc(a.bed_code)} · ${esc(a.spec)}</span></div>
        <div class="kv"><span class="k">申请人</span><span class="v">${esc(a.patient_tag)}</span></div>
        <div class="kv"><span class="k">计划截止</span><span class="v">${esc(a.planned_end_at.slice(5, 16))}</span></div>
        ${canWard ? `<button class="btn primary" data-return="${a.id}">开始归还核验</button>`
                  : `<span class="muted">非本病区订单</span>`}
      </div>
    </div>`;
  }).join("");
  bindOrderActions("#returnList");
}

async function openReturnModal(assignmentId) {
  const data = await api(`/api/assignment/${assignmentId}`);
  state.returnTarget = assignmentId;
  $("#rmOrderCode").textContent =
    `${data.assignment.code} · ${data.assignment.bed_code} · ${data.assignment.patient_tag}`;
  $("#rmPhoto").value = "";
  $("#rmPhotoHint").textContent = "";

  const groups = Object.fromEntries(CAT_ORDER.map(c => [c, []]));
  data.items.forEach(it => groups[it.category].push(it));
  $("#rmColumns").innerHTML = CAT_ORDER.map(cat => `
    <div class="rc-col" data-cat="${cat}">
      <div class="rc-head"><span>${CAT_LABEL[cat]}</span><span class="rc-state">待核对</span></div>
      <div class="rc-body">
        ${groups[cat].map(it => `
          <div class="rc-item" data-item="${it.id}" data-expected="${it.qty_expected}">
            <div class="rc-item-name">
              <span>${esc(it.item_name)}</span>
              <span class="muted">应发 ${it.qty_expected}</span>
            </div>
            <label class="muted">归还数量
              <input type="number" min="0" max="${it.qty_expected}" value="${it.qty_expected}" data-qty>
            </label>
            <select data-cond>
              <option value="ok">正常</option>
              <option value="missing">缺失</option>
              <option value="damaged">损坏</option>
              <option value="contaminated">污染</option>
            </select>
            <input type="text" data-reason placeholder="异常处理原因（必填）" hidden>
          </div>`).join("")}
      </div>
      <div class="rc-sum">待核对</div>
    </div>`).join("");

  $$("#rmColumns .rc-item").forEach(item => {
    const cond = item.querySelector("[data-cond]");
    const reason = item.querySelector("[data-reason]");
    const qty = item.querySelector("[data-qty]");
    const refresh = () => {
      const abnormal = cond.value !== "ok" ||
        Number(qty.value) < Number(item.dataset.expected);
      reason.hidden = !abnormal;
      if (!abnormal) reason.value = "";
      item.classList.toggle("abnormal", abnormal);
      refreshColState(item.closest(".rc-col"));
    };
    cond.addEventListener("change", refresh);
    qty.addEventListener("input", refresh);
  });
  $("#returnModal").classList.remove("hidden");
}

function refreshColState(col) {
  const rank = { ok: 0, missing: 1, damaged: 2, contaminated: 3 };
  let worst = "ok";
  const reasons = [];
  col.querySelectorAll(".rc-item").forEach(item => {
    const cond = item.querySelector("[data-cond]");
    const qty = item.querySelector("[data-qty]");
    let st = cond.value;
    if (Number(qty.value) < Number(item.dataset.expected)) st = "missing";
    if (rank[st] > rank[worst]) worst = st;
    if (st !== "ok") {
      const name = item.querySelector(".rc-item-name span").textContent;
      reasons.push(`${name}：${item.querySelector("[data-reason]").value || STATE_LABEL[st]}`);
    }
  });
  const stateEl = col.querySelector(".rc-state");
  const sumEl = col.querySelector(".rc-sum");
  stateEl.textContent = STATE_LABEL[worst];
  sumEl.textContent = reasons.length ? reasons.join("；") : "全部正常";
  sumEl.className = "rc-sum" + (worst !== "ok" ? " bad" : "");
}

async function submitReturn() {
  const items = {};
  let bad = false;
  $$("#rmColumns .rc-item").forEach(item => {
    const id = item.dataset.item;
    const expected = Number(item.dataset.expected);
    let qty = Number(item.querySelector("[data-qty]").value);
    const cond = item.querySelector("[data-cond]").value;
    const reason = item.querySelector("[data-reason]").value.trim();
    if (Number.isNaN(qty) || qty < 0 || qty > expected) { bad = true; }
    const abnormal = cond !== "ok" || qty < expected;
    if (abnormal && !reason) bad = true;
    items[id] = { qty_returned: qty, condition: cond, reason };
  });
  if (bad) { toast("请补全异常项原因，并确认归还数量（不得超过应发数量）", true); return; }

  let photoB64 = "", photoName = "";
  const file = $("#rmPhoto").files[0];
  if (file) {
    photoB64 = await fileToB64(file);
    photoName = file.name;
  }
  try {
    const res = await api("/api/return", {
      assignment_id: state.returnTarget,
      nurse_id: state.currentNurseId,
      items, photo_b64: photoB64, photo_name: photoName,
    });
    const warn = [];
    if (res.late) warn.push("使用超时");
    if (res.bed_cleaning === "isolated") warn.push("床位污染已隔离");
    toast(`核验完成，床位转为${CLEAN_LABEL[res.bed_cleaning]}，等待消毒批次` +
          (warn.length ? "（" + warn.join("，") + "）" : ""));
    closeModal();
    refreshAll();
  } catch (e) { toast(e.message, true); }
}

function fileToB64(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(",")[1] || "");
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

/* ---------------- 消毒批次 ---------------- */

async function renderBatchView() {
  const beds = state.meta.beds.filter(b => b.cleaning_status !== "clean");
  const nurse = currentNurse();
  $("#pendingBeds").innerHTML = beds.map(b => {
    const canWard = nurse.ward_id === b.ward_id;
    return `
    <div class="card">
      <div class="card-row">
        <span class="card-title">${esc(b.code)}</span>
        <span class="badge ${b.cleaning_status}">${CLEAN_LABEL[b.cleaning_status]}</span>
        <div class="kv"><span class="k">规格</span><span class="v">${esc(b.spec)}</span></div>
        <div class="kv"><span class="k">状态</span>
          <span class="v">${b.maintenance === "maintenance" ? "维修中" : "待消毒"}</span></div>
        <button class="btn primary" data-batch="${b.id}" ${canWard ? "" : "disabled"}>
          创建消毒批次</button>
        ${!canWard ? `<span class="muted">非本病区</span>` : ""}
      </div>
    </div>`;
  }).join("") || `<div class="card muted">没有待消毒床位。</div>`;

  $$("#pendingBeds [data-batch]").forEach(btn =>
    btn.addEventListener("click", async () => {
      try {
        const res = await api("/api/batch/create", {
          bed_id: Number(btn.dataset.batch),
          nurse_id: state.currentNurseId,
          operator: currentNurse().name,
        });
        toast(`已创建批次 ${res.code}`);
        refreshAll();
      } catch (e) { toast(e.message, true); }
    }));

  const { batches } = await api("/api/batches");
  $("#batchList").innerHTML = batches.map(bt => {
    const running = bt.status === "in_progress" || bt.status === "pending";
    const canWard = nurse.ward_id === bt.ward_id;
    return `
    <div class="card">
      <div class="card-row">
        <span class="card-title">${esc(bt.code)}</span>
        <span class="status-pill ${bt.status}">${
          { pending: "待开始", in_progress: "进行中", passed: "合格", failed: "失败" }[bt.status]}</span>
        <div class="kv"><span class="k">床位</span><span class="v">${esc(bt.bed_code || "—")}</span></div>
        <div class="kv"><span class="k">病区</span><span class="v">${esc(bt.ward_name)}</span></div>
        <div class="kv"><span class="k">操作员</span><span class="v">${esc(bt.operator)}</span></div>
        <div class="kv"><span class="k">开始 / 结束</span>
          <span class="v">${esc((bt.started_at || "").slice(5, 16))} → ${esc((bt.finished_at || "进行中").slice(5, 16))}</span></div>
      </div>
      <p class="muted" style="margin-top:6px">${esc(bt.note || "")}</p>
      ${running ? `<div class="card-actions">
        <button class="btn primary" data-pass="${bt.id}" ${canWard ? "" : "disabled"}>消毒合格（床位恢复可约）</button>
        <button class="btn danger" data-fail="${bt.id}" ${canWard ? "" : "disabled"}>消毒失败（继续阻断）</button>
      </div>` : ""}
    </div>`;
  }).join("") || `<div class="card muted">暂无批次。</div>`;

  $$("#batchList [data-pass]").forEach(btn =>
    btn.addEventListener("click", () => finishBatch(Number(btn.dataset.pass), true)));
  $$("#batchList [data-fail]").forEach(btn =>
    btn.addEventListener("click", () => finishBatch(Number(btn.dataset.fail), false)));
}

async function finishBatch(id, passed) {
  const note = passed ? "" :
    prompt("消毒失败原因（床位将继续阻断，等待返工）：", "采样培养不合格");
  if (!passed && note === null) return;
  try {
    await api("/api/batch/finish", { batch_id: id, passed, note });
    toast(passed ? "消毒合格，床位重新可预约" : "已登记消毒失败，床位保持阻断");
    refreshAll();
  } catch (e) { toast(e.message, true); }
}

/* ---------------- 押金结算与调拨 ---------------- */

async function renderDepositView() {
  const { assignments } = await api("/api/timeline");
  const unsettled = assignments.filter(a => a.status === "returned");
  const settled = assignments.filter(a => a.status === "settled");
  $("#depositList").innerHTML = `
    <h2 class="section-title">待结算（已归还）</h2>
    ${unsettled.length ? unsettled.map(depositCard).join("")
      : `<div class="card muted">没有待结算订单。</div>`}
    <h2 class="section-title">已结算台账</h2>
    ${settled.length ? settled.map(depositCard).join("")
      : `<div class="card muted">暂无已结算订单。</div>`}`;
  bindOrderActions("#depositList");
  renderTransferForm();
  const { transfers } = await api("/api/transfers");
  $("#transferList").innerHTML = transfers.map(t => `
    <div class="card">
      <div class="card-row">
        <span class="card-title">${esc(t.code)}</span>
        <div class="kv"><span class="k">调出 → 调入</span>
          <span class="v">${esc(t.from_ward_name)} → ${esc(t.to_ward_name)}</span></div>
        <div class="kv"><span class="k">物品 / 数量</span>
          <span class="v">${esc(t.item_type)} × ${t.qty}</span></div>
        <div class="kv"><span class="k">责任人</span><span class="v">${esc(t.responsible_person)}</span></div>
        <div class="kv"><span class="k">交接时间</span><span class="v">${esc(t.handed_at.slice(5, 16))}</span></div>
      </div>
      <p class="muted" style="margin-top:6px">${esc(t.note)}</p>
    </div>`).join("");
}

function depositCard(a) {
  const d = a.deposit || {};
  const nurse = currentNurse();
  const canWard = nurse.ward_id === a.ward_id;
  return `
  <div class="card">
    <div class="card-row">
      <span class="card-title">${esc(a.code)}</span>
      ${statusPill(a.status)}
      <div class="kv"><span class="k">床位</span><span class="v">${esc(a.bed_code)}</span></div>
      <div class="kv"><span class="k">申请人</span><span class="v">${esc(a.patient_tag)}</span></div>
    </div>
    <div class="deposit-grid">
      <div class="dp-box"><div class="k">冻结押金</div><div class="v">¥${yuan(d.hold)}</div></div>
      <div class="dp-box"><div class="k">已扣减</div><div class="v">¥${yuan(d.deducted)}</div></div>
      <div class="dp-box"><div class="k">已退还</div><div class="v">¥${yuan(d.refunded)}</div></div>
      <div class="dp-box ${d.settled ? "settled" : ""}">
        <div class="k">${d.settled ? "状态" : "待退余额"}</div>
        <div class="v">${d.settled ? "已锁定" : "¥" + yuan(d.balance)}</div></div>
    </div>
    ${a.status === "returned"
      ? `<div class="card-actions">
           <button class="btn ink" data-settle="${a.id}" ${canWard ? "" : "disabled"}>
             结算并退还余额</button>
           ${!canWard ? `<span class="muted">非本病区，无权结算</span>` : ""}
         </div>
         <p class="muted">床品缺失/损坏/超时可在结算时扣减；重复提交由幂等键保护。</p>`
      : `<p class="muted">${d.settled_at ? "结算于 " + esc(d.settled_at) : ""}，迟到归还不能重开订单。</p>`}
  </div>`;
}

function renderTransferForm() {
  if ($("#transferForm")) return;
  const w = state.meta.wards;
  const n = currentNurse();
  const html = `
  <h2 class="section-title">病区调拨（交接数量与责任人）</h2>
  <div class="card" id="transferForm">
    <div class="card-row">
      <label class="form-row">调出病区
        <select id="tfFrom">${w.map(x => `<option value="${x.id}" ${x.id === n.ward_id ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select>
      </label>
      <label class="form-row">调入病区
        <select id="tfTo">${w.map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join("")}</select>
      </label>
      <label class="form-row">数量
        <input type="number" id="tfQty" min="1" value="1" style="width:90px">
      </label>
      <label class="form-row">责任人（交出/接收）
        <input type="text" id="tfPerson" placeholder="如：周护士 / 郑护士" style="width:220px">
      </label>
      <button class="btn primary" id="tfSubmit">执行调拨</button>
    </div>
    <p class="muted" style="margin-top:8px">仅可由调出病区执行人发起；仅移动空闲、已清洁、非维修床位，数量不足将被拒绝。</p>
  </div>`;
  $("#depositList").insertAdjacentHTML("afterbegin", html);
  $("#tfSubmit").addEventListener("click", async () => {
    try {
      const res = await api("/api/transfer", {
        from_ward_id: Number($("#tfFrom").value),
        to_ward_id: Number($("#tfTo").value),
        qty: Number($("#tfQty").value),
        responsible_person: $("#tfPerson").value.trim(),
        nurse_id: state.currentNurseId,
      });
      toast(`调拨 ${res.code} 完成：${res.moved.join("、")}`);
      refreshAll();
    } catch (e) { toast(e.message, true); }
  });
}

/* ---------------- 换床 / 结算弹窗 ---------------- */

async function openSwapModal(assignmentId) {
  const data = await api(`/api/assignment/${assignmentId}`);
  state.swapTarget = assignmentId;
  const busy = new Set((await api("/api/timeline")).assignments
    .filter(a => a.status === "active").map(a => a.bed_id));
  const opts = state.meta.beds
    .filter(b => b.ward_id === data.assignment.ward_id
      && b.id !== data.assignment.bed_id
      && b.spec === data.assignment.spec
      && b.maintenance === "ok" && b.cleaning_status === "clean"
      && !busy.has(b.id))
    .map(b => `<option value="${b.id}">${esc(b.code)}</option>`).join("");
  $("#swapBed").innerHTML = opts || `<option value="">无可用同规格清洁床位</option>`;
  $("#swapReason").value = "";
  $("#swapSubmit").disabled = !opts;
  $("#swapModal").classList.remove("hidden");
}

async function submitSwap() {
  const toBed = Number($("#swapBed").value);
  if (!toBed) return;
  try {
    await api("/api/swap", {
      assignment_id: state.swapTarget,
      to_bed_id: toBed,
      nurse_id: state.currentNurseId,
      reason: $("#swapReason").value.trim() || "临时换床",
    });
    toast("换床成功，原床已转待清洁");
    closeModal();
    refreshAll();
  } catch (e) { toast(e.message, true); }
}

function openSettleModal(assignmentId) {
  state.settleTarget = assignmentId;
  api(`/api/assignment/${assignmentId}`).then(data => {
    const d = data.deposit;
    $("#smSummary").innerHTML = `
      <div class="deposit-grid">
        <div class="dp-box"><div class="k">冻结</div><div class="v">¥${yuan(d.hold)}</div></div>
        <div class="dp-box"><div class="k">已扣</div><div class="v">¥${yuan(d.deducted)}</div></div>
        <div class="dp-box"><div class="k">已退</div><div class="v">¥${yuan(d.refunded)}</div></div>
        <div class="dp-box"><div class="k">待退</div><div class="v">¥${yuan(d.balance)}</div></div>
      </div>`;
    $("#smDeduct").value = "0";
    $("#smReason").value = "";
    $("#settleModal").classList.remove("hidden");
  });
}

async function submitSettle() {
  try {
    const res = (await api("/api/settle", {
      assignment_id: state.settleTarget,
      deduct_yuan: Number($("#smDeduct").value || 0),
      deduct_reason: $("#smReason").value.trim(),
    })).deposit;
    toast(`结算完成：累计退还 ¥${yuan(res.refunded)}，扣减 ¥${yuan(res.deducted)}；订单已锁定`);
    closeModal();
    refreshAll();
  } catch (e) { toast(e.message, true); }
}

/* ---------------- 事件绑定 ---------------- */

function bindOrderActions(scope) {
  $$(`${scope} [data-return]`).forEach(b =>
    b.addEventListener("click", () => openReturnModal(Number(b.dataset.return))));
  $$(`${scope} [data-swap]`).forEach(b =>
    b.addEventListener("click", () => openSwapModal(Number(b.dataset.swap))));
  $$(`${scope} [data-settle]`).forEach(b =>
    b.addEventListener("click", () => openSettleModal(Number(b.dataset.settle))));
}

function closeModal() {
  $$(".modal").forEach(m => m.classList.add("hidden"));
}

function bindModals() {
  $("#rmSubmit").addEventListener("click", submitReturn);
  $("#swapSubmit").addEventListener("click", submitSwap);
  $("#smSubmit").addEventListener("click", submitSettle);
  $$(".modal").forEach(m => m.addEventListener("click", e => {
    if (e.target === m) closeModal();
  }));
  $("#rmPhoto").addEventListener("change", e => {
    $("#rmPhotoHint").textContent = e.target.files[0] ? `已选择：${e.target.files[0].name}` : "";
  });
}

init().catch(e => toast("初始化失败：" + e.message, true));
