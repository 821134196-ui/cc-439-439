'use strict';
// 服务端渲染（无构建、无前端框架）。配色：临床白 / 墨蓝 #16324f / 湖绿 #2a9d8f
const { yuan, statusText } = require('./services');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const yn = (v) => v ? '是' : '否';
const dt = (s) => (s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '—');
const shortDt = (s) => (s ? new Date(s).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '—');
const money = (f) => `¥${yuan(f ?? 0)}`;

const NAV = [
  ['/', '床位图'], ['/requests', '申请队列'], ['/rentals', '使用时间线'],
  ['/returns', '归还核验'], ['/cleaning', '消毒批次'], ['/deposits', '押金结算'],
  ['/transfers', '病区调拨'],
];

function layout(active, title, body, ctx = {}) {
  const flash = ctx.flash || {};
  const staff = ctx.staff;
  return `<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · 陪护床位与消毒交接</title>
<style>${CSS}</style></head><body>
<header class="topbar">
  <div class="brand"><span class="logo">十</span>
    <div><div class="brand-title">陪护床位与消毒交接系统</div>
    <div class="brand-sub">Hospital Escort-Bed &amp; Decontamination Handover · 演示数据已匿名</div></div>
  </div>
  <form class="staffbox" method="post" action="/switch-staff">
    <span class="staff-label">当前操作员</span>
    <select name="staffId" onchange="this.form.submit()">
      ${ctx.staffList.map((s) => `<option value="${s.id}" ${staff && s.id === staff.id ? 'selected' : ''}>${esc(s.code)} ${esc(s.name)}${s.is_admin ? '（总务·跨病区）' : ''}</option>`).join('')}
    </select>
  </form>
</header>
<nav class="tabs">
  ${NAV.map(([href, label]) => `<a class="tab ${href === active ? 'on' : ''}" href="${href}">${label}</a>`).join('')}
</nav>
<main class="wrap">
 ${flash.ok ? `<div class="flash ok">✓ ${esc(flash.ok)}</div>` : ''}
 ${flash.err ? `<div class="flash err">⚠ ${esc(flash.err)}</div>` : ''}
 ${body}
</main>
<footer class="foot">本地演示 · SQLite（${esc(ctx.dbFile || 'data/care.db')}）· 交接照片存于 data/photos · 押金由进程内模拟适配器处理 · 患者与家属均为匿名资料</footer>
${ctx.scripts || ''}
</body></html>`;
}

const badge = (text, cls) => `<span class="badge ${cls}">${esc(text)}</span>`;

function reqStatusBadge(s) {
  const map = { queued: 'gray', confirmed: 'teal', allocated: 'blue', declined: 'red', completed: 'dark', cancelled: 'gray' };
  return badge(statusText(s), map[s] || 'gray');
}
function cleanBadge(b) {
  if (b.is_maintenance || b.open_repairs > 0) return badge('维修中', 'amber');
  if (b.isolated) return badge('污染隔离', 'red');
  if (!b.is_clean) return badge('待消毒', 'gray');
  if (b.occupied) return badge('清洁·占用中', 'blue');
  return badge('清洁·可用', 'teal');
}

// ---------- 床位图 ----------
function mapView(ctx) {
  const cards = ctx.wards.map((w) => {
    const clean = w.beds.filter((b) => b.allocatable).length;
    const occ = w.beds.filter((b) => b.occupied).length;
    const dirty = w.beds.filter((b) => !b.is_clean && !b.isolated && !(b.is_maintenance || b.open_repairs)).length;
    const iso = w.beds.filter((b) => b.isolated).length;
    const maint = w.beds.filter((b) => b.is_maintenance || b.open_repairs).length;
    return `<section class="ward">
      <div class="ward-head">
        <h2>${esc(w.code)} · ${esc(w.name)}</h2>
        <div class="ward-stats">
          <span class="pill teal">可用 ${clean}</span>
          <span class="pill blue">占用 ${occ}</span>
          <span class="pill gray">待消毒 ${dirty}</span>
          <span class="pill red">隔离 ${iso}</span>
          <span class="pill amber">维修 ${maint}</span>
        </div>
      </div>
      <div class="bedgrid">
        ${w.beds.map((b) => bedCard(b, w)).join('')}
      </div></section>`;
  }).join('');
  return `
  <div class="pagehead"><h1>病区床位图</h1><p class="hint">床位卡同时呈现 <b>清洁状态</b>、<b>占用状态</b> 与 <b>维修/隔离/调拨</b>；点击床位查看配件台账与操作。</p></div>
  <div class="legend">${legend()}</div>
  ${cards}`;
}
function legend() {
  return [['清洁·可用', 'teal'], ['清洁·占用中', 'blue'], ['待消毒', 'gray'], ['污染隔离', 'red'], ['维修中', 'amber']]
    .map(([t, c]) => `<span class="lg"><i class="sw ${c}"></i>${t}</span>`).join('');
}
function bedCard(b, w) {
  const cls = b.is_maintenance || b.open_repairs ? 'maint' : b.isolated ? 'iso' : !b.is_clean ? 'dirty' : b.occupied ? 'occ' : 'clean';
  return `<a class="bed ${cls}" href="/beds/${b.id}">
    <div class="bed-top"><b>${esc(b.code)}</b>${cleanBadge(b)}</div>
    <div class="bed-spec">${esc(b.spec)}</div>
    ${b.occupied && b.active_rental ? `<div class="bed-occ">占用 · ${esc(b.active_rental.applicant_label)}</div>
      <div class="bed-rental">${esc(b.active_rental.code)}</div>` : '<div class="bed-free">空闲</div>'}
    ${b.in_transfer ? '<div class="bed-tag">调拨交接中</div>' : ''}
    ${b.open_repairs ? `<div class="bed-tag amber">维修单 ×${b.open_repairs}</div>` : ''}
  </a>`;
}

// ---------- 床位详情 ----------
function bedDetail(ctx) {
  const { b, ward, accessories, repairs, batches, rental, photos, canAct } = ctx;
  const v = b;
  return `<div class="pagehead"><h1>床位 ${esc(ward.code)} · ${esc(b.code)} <small>${esc(b.spec)}</small></h1>
    <p><a href="/">← 返回床位图</a></p></div>
  <div class="cards-row">
    <div class="panel"><h3>状态</h3>
      <table class="kv"><tr><th>清洁</th><td>${v.is_clean ? badge('已清洁', 'teal') : badge('待消毒', 'gray')}</td></tr>
      <tr><th>占用</th><td>${v.occupied ? '是 · ' + esc(v.active_rental.applicant_label) : '否'}</td></tr>
      <tr><th>污染隔离</th><td>${v.isolated ? badge('隔离中', 'red') : '否'}</td></tr>
      <tr><th>维修</th><td>${(v.is_maintenance || v.open_repairs) ? badge('维修中', 'amber') : '正常'}</td></tr>
      <tr><th>调拨</th><td>${v.in_transfer ? '交接中' : '无'}</td></tr>
      <tr><th>可预约</th><td>${v.allocatable ? badge('可预约', 'teal') : badge('不可预约', 'red')}</td></tr></table>
    </div>
    <div class="panel"><h3>固定配件台账（归还核对基准）</h3>
      <table class="grid"><thead><tr><th>配件</th><th>应有数量</th></tr></thead><tbody>
      ${accessories.map((a) => `<tr><td>${esc(a.item)}</td><td class="num">${a.expected_qty}</td></tr>`).join('')}
      </tbody></table>
    </div>
  </div>

  ${canAct ? `<div class="panel"><h3>登记操作</h3>
    <div class="actions">
      ${!(v.is_maintenance || v.open_repairs) && !v.occupied ? `
      <form method="post" action="/beds/${b.id}/repair" class="inline">
        <input name="issue" placeholder="维修故障描述" required>
        <button class="btn amber">登记维修（阻断预约）</button></form>` : ''}
      ${(!v.is_clean || v.isolated) && !v.occupied ? `
      <form method="post" action="/beds/${b.id}/cleaning" class="inline">
        <select name="method"><option>紫外线</option><option>含氯擦拭</option><option>臭氧</option></select>
        <label class="chk"><input type="checkbox" name="contamination" value="1"> 污染消毒</label>
        <button class="btn teal">开消毒批次</button></form>` : ''}
      ${v.is_clean && !v.occupied ? '<span class="muted">床位已清洁且空闲，可在申请队列中分配。</span>' : ''}
    </div></div>` : `<div class="flash err">你未被授权本病区，以下操作仅可查看。</div>`}

  <div class="cards-row">
    <div class="panel"><h3>维修记录</h3>
      <table class="grid"><thead><tr><th>单号</th><th>故障</th><th>状态</th><th>费用</th><th>操作</th></tr></thead><tbody>
      ${repairs.map((r) => `<tr><td>${esc(r.code)}</td><td>${esc(r.issue)}</td>
        <td>${r.status === 'done' ? badge('已修复', 'teal') : badge('维修中', 'amber')}</td>
        <td class="num">${money(r.cost_fen)}</td>
        <td>${r.status !== 'done' && canAct ? `<form method="post" action="/repairs/${r.id}/close" class="inline">
          <button class="btn small">修复完成</button></form>` : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">无</td></tr>'}
      </tbody></table>
    </div>
    <div class="panel"><h3>消毒批次</h3>
      <table class="grid"><thead><tr><th>批次</th><th>方式</th><th>污染</th><th>状态</th><th>完成时间</th></tr></thead><tbody>
      ${batches.map((c) => `<tr><td>${esc(c.code)}</td><td>${esc(c.method)}</td>
        <td>${c.contamination ? badge('污染', 'red') : '常规'}</td><td>${cleaningBadge(c.status)}</td><td>${shortDt(c.finished_at)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">无</td></tr>'}
      </tbody></table>
    </div>
  </div>
  ${photoSection('bed', b.id, photos, canAct)}`;
}

function cleaningBadge(s) {
  return ({ queued: badge('排队中', 'gray'), running: badge('进行中', 'blue'),
    completed: badge('已完成', 'teal'), failed: badge('失败', 'red') })[s] || badge(s, 'gray');
}

// ---------- 申请队列 ----------
function requestsView(ctx) {
  const rows = ctx.requests.map((r) => {
    const can = ctx.wardAuth.has(r.ward_id);
    let actions = '';
    if (r.status === 'queued') {
      actions = can ? `<form method="post" action="/requests/${r.id}/confirm" class="inline"><button class="btn teal small">确认并锁定时段</button></form>
        <form method="post" action="/requests/${r.id}/decline" class="inline"><input name="reason" placeholder="驳回原因"><button class="btn ghost small">驳回</button></form>` : noPerm();
    } else if (r.status === 'confirmed') {
      const opts = ctx.allocatableByWard.get(r.ward_id)?.filter((b) => b.spec === r.spec_required) || [];
      actions = can ? `<form method="post" action="/requests/${r.id}/allocate" class="inline">
          <button class="btn blue small">自动分配</button>
          <select name="bedId" title="指定床位（可选）">
            <option value="">自动选床</option>
            ${opts.map((b) => `<option value="${b.id}">${esc(b.code)}（${esc(b.spec)}）</option>`).join('')}
          </select></form>` : noPerm();
    } else if (r.status === 'allocated') {
      actions = `<a class="btn small ghost" href="/rentals/${r.rental_id}">查看使用单</a>`;
    }
    return `<tr>
      <td class="mono">${esc(r.code)}</td>
      <td>${esc(r.applicant_label)}<div class="sub">${esc(r.anon_code)} · ${esc(r.relation)}</div></td>
      <td>${esc(r.ward_code)}<div class="sub">${esc(r.ward_name)}</div></td>
      <td>${esc(r.spec_required)}</td>
      <td class="nowrap">${shortDt(r.planned_start)}<br><span class="muted">至 ${shortDt(r.planned_end)}</span></td>
      <td>${reqStatusBadge(r.status)}</td>
      <td class="actions-cell">${actions}</td></tr>`;
  }).join('');
  return `<div class="pagehead"><h1>申请队列</h1><p class="hint">申请确认后锁定规划时段；已确认申请可自动或指定分配。跨病区操作将被权限拦截。</p></div>
  <table class="grid wide"><thead><tr><th>申请单号</th><th>申请人（匿名）</th><th>病区</th><th>规格</th><th>规划时段</th><th>状态</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table>`;
}
const noPerm = () => '<span class="tagperm" title="无本病区权限">🔒 非本病区</span>';

// ---------- 使用时间线 ----------
function rentalsView(ctx) {
  const rows = ctx.rentals.map((r) => `<tr>
    <td class="mono"><a href="/rentals/${r.id}">${esc(r.code)}</a></td>
    <td>${esc(r.ward_code)} · ${esc(r.bed_code)}</td>
    <td>${esc(r.applicant_label)}</td>
    <td class="nowrap">${shortDt(r.start_at)}<br><span class="muted">计划至 ${shortDt(r.planned_end_at)}</span></td>
    <td>${r.actual_end_at ? shortDt(r.actual_end_at) : '—'}</td>
    <td>${r.status === 'active' ? badge('使用中', 'blue') : badge('已归还', 'teal')}${r.finalized ? badge('已结算', 'dark') : ''}${r.isolated_return ? badge('污染归还', 'red') : ''}</td>
    <td><a class="btn small ghost" href="/rentals/${r.id}">时间线</a></td></tr>`).join('');
  return `<div class="pagehead"><h1>使用时段</h1><p class="hint">每张床位的使用时段在分配成功时锁定；点击单号查看完整交接时间线。</p></div>
  <table class="grid wide"><thead><tr><th>使用单号</th><th>床位</th><th>申请人</th><th>开始/计划结束</th><th>实际归还</th><th>状态</th><th></th></tr></thead><tbody>${rows}</tbody></table>
  <h2 class="mt">全局交接事件流</h2>${eventFeed(ctx.timeline)}`;
}

function rentalDetail(ctx) {
  const { r, can, check, events, swaps, swapTargets, photos } = ctx;
  return `<div class="pagehead"><h1>使用单 ${esc(r.code)}</h1>
    <p><a href="/rentals">← 返回使用时段</a></p></div>
  <div class="cards-row">
    <div class="panel"><h3>基本信息</h3>
      <table class="kv">
        <tr><th>申请人</th><td>${esc(r.applicant_label)} <span class="muted">（${esc(r.anon_code)}）</span></td></tr>
        <tr><th>床位</th><td>${esc(r.ward_code)} · ${esc(r.bed_code)}（${esc(r.spec)}）</td></tr>
        <tr><th>开始</th><td>${dt(r.start_at)}</td></tr>
        <tr><th>计划结束</th><td>${dt(r.planned_end_at)}</td></tr>
        <tr><th>实际归还</th><td>${r.actual_end_at ? dt(r.actual_end_at) : '使用中'}</td></tr>
        <tr><th>状态</th><td>${r.status === 'active' ? badge('使用中', 'blue') : badge('已归还', 'teal')} ${r.finalized ? badge('已结算·不可重开', 'dark') : ''}</td></tr>
      </table></div>
    <div class="panel"><h3>操作</h3><div class="actions">
      ${r.status === 'active' && can ? `
        <a class="btn blue" href="/returns/${r.id}">归还核验</a>
        <form method="post" action="/rentals/${r.id}/swap" class="inline">
          <select name="toBedId" required ${swapTargets.length ? '' : 'disabled'}>
            <option value="">临时换床（同病区同规格）</option>
            ${swapTargets.map((b) => `<option value="${b.id}">${esc(b.code)}</option>`).join('')}
          </select>
          <input name="reason" placeholder="换床原因" required>
          <button class="btn ghost">换床</button></form>` : ''}
      ${r.status === 'active' && !can ? noPerm() : ''}
      ${r.status === 'returned' && !r.finalized ? (can ? `<a class="btn teal" href="/deposits?settle=${r.id}">前往押金结算</a>` : noPerm()) : ''}
      ${r.finalized ? '<span class="muted">订单已结算关闭；迟到归还不能重开订单，需另走线下登记。</span>' : ''}
    </div>
    ${swaps.length ? `<h3 class="mt">临时换床记录</h3><table class="grid"><thead><tr><th>时间</th><th>由</th><th>至</th><th>原因</th><th>护士</th></tr></thead><tbody>
      ${swaps.map((s) => `<tr><td>${shortDt(s.created_at)}</td><td>${esc(s.from_code)}</td><td>${esc(s.to_code)}</td><td>${esc(s.reason)}</td><td>${esc(s.nurse_name)}</td></tr>`).join('')}
      </tbody></table>` : ''}
    </div>
  </div>
  ${check ? `<h2 class="mt">归还核验结果</h2>${checkSummary(check)}` : ''}
  <h2 class="mt">使用时间线</h2>${eventFeed(events)}
  ${photoSection('return', r.id, photos, can)}`;
}

function checkSummary(check) {
  const groups = [
    ['床架（含床垫）', ['frame', 'mattress']],
    ['床品', ['linen']],
    ['配件', ['accessory']],
  ];
  return `<div class="check-cols">
    ${groups.map(([title, cats]) => {
      const items = check.items.filter((i) => cats.includes(i.category));
      return `<div class="check-col"><h3>${title}</h3><table class="grid">
        <thead><tr><th>项目</th><th>应有</th><th>实际</th><th>结果</th><th>处理原因</th></tr></thead><tbody>
        ${items.map((i) => `<tr class="${i.result === 'ok' ? '' : 'abn'}"><td>${esc(i.item)}</td>
          <td class="num">${i.expected_qty}</td><td class="num">${i.actual_qty}</td>
          <td>${resultBadge(i.result)}</td><td>${i.action_reason ? esc(i.action_reason) : '<span class="muted">—</span>'}</td></tr>`).join('')}
        </tbody></table></div>`;
    }).join('')}
  </div>
  <p class="mt">核验结论：${check.summary_result === 'pass' ? badge('通过', 'teal') : badge('不通过·转处置', 'red')}
   · 核验护士 ${esc(check.nurse_name)} · ${shortDt(check.checked_at)} ${check.note ? '· ' + esc(check.note) : ''}</p>`;
}
function resultBadge(r) {
  return ({ ok: badge('正常', 'teal'), missing: badge('缺失', 'red'), damaged: badge('损坏', 'amber'),
    contaminated: badge('污染', 'red') })[r] || badge(r, 'gray');
}

function eventFeed(events) {
  const label = {
    request_created: '申请创建', request_confirmed: '确认并锁定时段', request_declined: '驳回申请',
    allocated: '分配床位并收取押金', bed_swapped: '临时换床', returned: '归还核验',
    overtime: '使用超时', cleaning_queued: '消毒批次排队', cleaning_started: '消毒开始',
    cleaning_completed: '消毒完成·床位恢复可用', cleaning_failed: '消毒失败·补开批次',
    repair_opened: '登记维修·阻断预约', repair_closed: '维修完成',
    transfer_proposed: '发起调拨', transfer_handed_over: '调出方交出', transfer_received: '接收方确认接收',
    transfer_rejected: '调拨驳回', settled: '押金结算关闭订单',
    deposit_charge: '收取押金', deposit_refund: '退还押金', deposit_deduct: '押金扣除',
    deposit_topup: '差异补缴',
  };
  return `<ul class="timeline">
    ${events.map((e) => `<li><span class="t-dot ${dot(e.type)}"></span>
      <div class="t-body"><div class="t-head"><b>${esc(label[e.type] || e.type)}</b>
        <span class="t-time">${shortDt(e.at)}${e.actor_name ? ' · ' + esc(e.actor_name) : ''}</span></div>
        ${eventDetail(e)}</div></li>`).join('')}
  </ul>`;
}
function eventDetail(e) {
  const d = e.detailObj || {};
  const bits = [];
  if (d.bed) bits.push(`床位 ${d.bed}`);
  if (d.code) bits.push(d.code);
  if (d.from && d.to) bits.push(`${d.from} → ${d.to}`);
  if (d.overtime_min) bits.push(`超时 ${d.overtime_min} 分钟${d.fee_fen ? `，费用 ${money(d.fee_fen)}` : ''}`);
  if (d.deposited != null) bits.push(`押金 ${money(d.deposited)}，扣 ${money(d.deduct)}，退 ${money(d.refund)}`);
  if (d.amount_fen) bits.push(`${money(d.amount_fen)}${d.duplicated ? '（幂等重复，未重复入账）' : ''}`);
  if (d.reason) bits.push(String(d.reason));
  if (d.retry) bits.push(`补开批次 ${d.retry}`);
  if (d.qty && d.spec) bits.push(`${d.spec} × ${d.qty}`);
  if (d.charges && d.charges.length) bits.push(d.charges.map((c) => `${c.label} ${money(c.fen)}`).join('；'));
  return bits.length ? `<div class="t-detail">${bits.map(esc).join(' · ')}</div>` : '';
}
function dot(type) {
  if (type.startsWith('cleaning_failed') || type.includes('fail')) return 'red';
  if (type.includes('return') || type.includes('repair_opened') || type === 'overtime' || type.includes('declined')) return 'amber';
  if (type.includes('completed') || type.includes('settled') || type.includes('received')) return 'teal';
  return 'blue';
}

// ---------- 归还核验列表 / 表单 ----------
function returnsView(ctx) {
  const active = ctx.active.map((r) => `<tr>
    <td class="mono">${esc(r.code)}</td><td>${esc(r.ward_code)} · ${esc(r.bed_code)}</td>
    <td>${esc(r.applicant_label)}</td><td class="nowrap">${shortDt(r.start_at)}<br><span class="muted">至 ${shortDt(r.planned_end_at)}</span></td>
    <td>${ctx.wardAuth.has(r.ward_id) ? `<a class="btn blue small" href="/returns/${r.id}">开始核验</a>` : noPerm()}</td></tr>`).join('');
  return `<div class="pagehead"><h1>归还核验</h1><p class="hint">归还时将 <b>床架（含床垫）</b>、<b>床品</b>、<b>配件</b> 分三列逐项核对；异常项必须填写处理原因。污染归还触发隔离消毒，床架损坏自动转维修。</p></div>
  <h2>待归还使用单</h2>
  <table class="grid"><thead><tr><th>使用单</th><th>床位</th><th>申请人</th><th>使用时段</th><th></th></tr></thead><tbody>${active || '<tr><td colspan="5" class="muted">暂无使用中单据</td></tr>'}</tbody></table>
  <h2 class="mt">历史核验记录</h2>
  <table class="grid"><thead><tr><th>核验单</th><th>使用单</th><th>床位</th><th>护士</th><th>结论</th><th>时间</th><th></th></tr></thead><tbody>
  ${ctx.checks.map((c) => `<tr><td class="mono">#${c.id}</td><td class="mono">${esc(c.rental_code)}</td><td>${esc(c.bed_code)}</td>
    <td>${esc(c.nurse_name)}</td><td>${c.summary_result === 'pass' ? badge('通过', 'teal') : badge('不通过', 'red')}${c.frame_result !== 'ok' ? badge('床架异常', 'amber') : ''}</td>
    <td>${shortDt(c.checked_at)}</td><td><a class="btn small ghost" href="/rentals/${c.rental_id}">详情</a></td></tr>`).join('')}
  </tbody></table>`;
}

function returnForm(ctx) {
  const { r, accessories, can } = ctx;
  if (!can) return `<div class="flash err">你未被授权 ${esc(r.ward_code)} 病区，无法执行归还核验。</div><p><a href="/returns">返回</a></p>`;
  const linenRows = ['床单', '被套', '枕套', '薄被', '枕芯'].map((l) => itemRow('linen', l, 1, 1)).join('');
  const accRows = accessories.map((a) => itemRow('accessory', a.item, a.expected_qty, a.expected_qty)).join('');
  return `<div class="pagehead"><h1>归还核验 · ${esc(r.code)}</h1>
    <p>${esc(r.ward_code)} · ${esc(r.bed_code)}（${esc(r.spec)}） · 申请人 ${esc(r.applicant_label)} · <a href="/rentals/${r.id}">取消返回</a></p></div>
  <form method="post" action="/returns/${r.id}" id="retform">
  <div class="check-cols">
    <div class="check-col"><h3>床架（含床垫）</h3>
      <table class="grid"><thead><tr><th>项目</th><th>检查结果</th><th>处理原因（异常必填）</th></tr></thead><tbody>
        <tr><td>床架</td><td>${resultSelect('frameResult', '床架')}</td><td><input name="frameReason" placeholder="如：护栏支臂变形"></td></tr>
        <tr><td>床垫</td><td>${resultSelect('mattressResult', '床垫', true)}</td><td><input name="mattressReason" placeholder="如：面料划破 / 体液污染"></td></tr>
      </tbody></table></div>
    <div class="check-col"><h3>床品</h3>
      <table class="grid"><thead><tr><th>项目</th><th>应有</th><th>实际</th><th>结果</th><th>处理原因</th></tr></thead><tbody>${linenRows}</tbody></table></div>
    <div class="check-col"><h3>配件（按台账数量）</h3>
      <table class="grid"><thead><tr><th>项目</th><th>应有</th><th>实际</th><th>结果</th><th>处理原因</th></tr></thead><tbody>${accRows}</tbody></table></div>
  </div>
  <div class="panel mt">
    <label class="chk"><input type="checkbox" name="isolated" value="1"> 本次归还存在污染，需<b>污染隔离</b>并启用含氯擦拭消毒</label><br>
    <label>备注 <input name="note" class="wide-input" placeholder="整体情况说明"></label><br>
    <button class="btn blue big">提交归还核验（自动开消毒批次 / 必要时转维修）</button>
  </div></form>`;
}
function itemRow(cat, item, expected, actual) {
  const name = `${cat}__${item}`;
  return `<tr data-row>
    <td>${esc(item)}</td>
    <td class="num">${expected}<input type="hidden" name="${name}__exp" value="${expected}"></td>
    <td class="num"><input type="number" min="0" max="${expected}" name="${name}__act" value="${actual}" class="qty"></td>
    <td>${resultSelect(name + '__res', item, cat !== 'frame')}</td>
    <td><input name="${name}__reason" placeholder="异常处理原因" class="reason-input"></td></tr>`;
}
function resultSelect(n, item, allowContam) {
  return `<select name="${n}" data-result>
    <option value="ok">正常</option>
    <option value="missing">缺失</option>
    <option value="damaged">损坏</option>
    ${allowContam ? '<option value="contaminated">污染</option>' : ''}
  </select>`;
}

// ---------- 消毒批次 ----------
function cleaningView(ctx) {
  const groups = ['running', 'queued', 'failed', 'completed'].map((s) => {
    const list = ctx.batches.filter((b) => b.status === s);
    if (!list.length) return '';
    const title = { running: '进行中', queued: '排队中', failed: '失败（已自动补开）', completed: '已完成' }[s];
    return `<h2 class="mt">${title} <span class="muted">(${list.length})</span></h2>
      <table class="grid"><thead><tr><th>批次</th><th>病区/床位</th><th>方式</th><th>类型</th><th>操作员</th><th>开始</th><th>结束</th><th>操作</th></tr></thead><tbody>
      ${list.map((b) => `<tr><td class="mono">${esc(b.code)}</td><td>${esc(b.ward_code)} · ${esc(b.bed_code)}</td>
        <td>${esc(b.method)}</td><td>${b.contamination ? badge('污染', 'red') : '常规'}</td>
        <td>${esc(b.operator_name || '—')}</td><td>${shortDt(b.started_at)}</td><td>${shortDt(b.finished_at)}</td>
        <td class="actions-cell">${cleaningActions(b, ctx.wardAuth.has(b.ward_id))}</td></tr>`).join('')}
      </tbody></table>`;
  }).join('');
  return `<div class="pagehead"><h1>消毒批次</h1><p class="hint">仅「已完成」批次的床位重新变为清洁可用；失败批次记录原因并自动补开，床位在完成前保持隔离/不可预约。</p></div>${groups || '<p class="muted">暂无批次</p>'}`;
}
function cleaningActions(b, can) {
  if (!can) return noPerm();
  if (b.status === 'queued') return `<form method="post" action="/cleaning/${b.id}/start" class="inline"><button class="btn small teal">开始</button></form>`;
  if (b.status === 'running') return `<form method="post" action="/cleaning/${b.id}/complete" class="inline"><button class="btn small teal">完成（恢复可用）</button></form>
    <form method="post" action="/cleaning/${b.id}/fail" class="inline"><input name="reason" placeholder="失败原因" required><button class="btn small amber">登记失败</button></form>`;
  return '—';
}

// ---------- 押金结算 ----------
function depositsView(ctx) {
  const { deposits, unsettled, settleHint, wardAuth } = ctx;
  const sum = (k) => deposits.filter((d) => d.kind === k).reduce((a, d) => a + d.amount_fen, 0);
  return `<div class="pagehead"><h1>押金结算</h1><p class="hint">押金由进程内模拟适配器处理；所有流水带<b>幂等键</b>，重复提交不会重复入账。结算后订单关闭，迟到归还不能重开。</p></div>
  <div class="stat-row">
    ${statCard('收取 + 补缴', money(sum('charge') + sum('topup')), 'teal')}
    ${statCard('扣除赔偿', money(sum('deduct')), 'amber')}
    ${statCard('已退还', money(sum('refund')), 'blue')}
    ${statCard('流水笔数', deposits.length, 'dark')}
  </div>
  ${settleHint ? `<div class="flash ok">${esc(settleHint)}</div>` : ''}
  <h2>待结算（已归还未结算）</h2>
  <table class="grid"><thead><tr><th>使用单</th><th>床位</th><th>申请人</th><th>归还时间</th><th></th></tr></thead><tbody>
  ${unsettled.map((r) => `<tr><td class="mono">${esc(r.code)}</td><td>${esc(r.ward_code)} · ${esc(r.bed_code)}</td>
    <td>${esc(r.applicant_label)}</td><td>${shortDt(r.actual_end_at)}</td>
    <td>${wardAuth.has(r.ward_id) ? `<form method="post" action="/rentals/${r.id}/settle" class="inline"><button class="btn teal small">结算押金</button></form>` : noPerm()}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">无</td></tr>'}
  </tbody></table>
  <h2 class="mt">押金流水（模拟适配器）</h2>
  <table class="grid wide"><thead><tr><th>流水号</th><th>类型</th><th>使用单</th><th>金额</th><th>原因</th><th>网关参考</th><th>时间</th></tr></thead><tbody>
  ${deposits.map((d) => `<tr><td class="mono">${esc(d.code)}</td><td>${depositKind(d.kind)}</td>
    <td class="mono">${esc(d.rental_code || '—')}<div class="sub">${esc(d.request_code)}</div></td>
    <td class="num">${money(d.amount_fen)}</td><td>${esc(d.reason)}</td>
    <td class="mono muted">${esc(d.adapter_ref)}</td><td class="nowrap">${shortDt(d.created_at)}</td></tr>`).join('')}
  </tbody></table>`;
}
function depositKind(k) {
  return ({ charge: badge('收取押金', 'blue'), refund: badge('退还', 'teal'),
    deduct: badge('扣除', 'amber'), topup: badge('差异补缴', 'red') })[k] || badge(k, 'gray');
}
function statCard(label, value, cls) {
  return `<div class="stat ${cls}"><div class="stat-v">${value}</div><div class="stat-l">${esc(label)}</div></div>`;
}

// ---------- 病区调拨 ----------
function transfersView(ctx) {
  const { transfers, wardAuth, staff } = ctx;
  const row = (t) => {
    const canFrom = staff.is_admin || t.from_nurse_id === staff.id;
    const canTo = staff.is_admin || t.to_nurse_id === staff.id;
    let act = '';
    if (t.status === 'proposed') act = canFrom ? `<form method="post" action="/transfers/${t.id}/handover" class="inline"><button class="btn small blue">交出（数量 ${t.qty}）</button></form>` : noPerm();
    if (t.status === 'handed_over') act = canTo ? `<form method="post" action="/transfers/${t.id}/receive" class="inline"><button class="btn small teal">确认接收</button></form>` : noPerm();
    if (['proposed', 'handed_over'].includes(t.status))
      act += (canFrom || canTo) ? `<form method="post" action="/transfers/${t.id}/reject" class="inline"><input name="reason" placeholder="驳回原因"><button class="btn small ghost">驳回</button></form>` : '';
    return `<tr><td class="mono">${esc(t.code)}</td>
      <td>${esc(t.from_ward_name)}<div class="sub">责任人 ${esc(t.from_nurse_name || '—')}</div></td>
      <td>${esc(t.to_ward_name)}<div class="sub">责任人 ${esc(t.to_nurse_name || '—')}</div></td>
      <td>${esc(t.spec)}<div class="sub">交接数量 <b>${t.qty}</b></div></td>
      <td>${esc(t.bed_codes || t.beds?.map((b) => b.code).join('、') || '')}</td>
      <td>${transferBadge(t.status)}</td>
      <td class="nowrap">${shortDt(t.handed_at || t.created_at)}</td><td class="actions-cell">${act}</td></tr>`;
  };
  return `<div class="pagehead"><h1>病区调拨</h1><p class="hint">调拨必须记录<b>交接数量</b>与<b>双方责任人</b>，经「提议 → 交出 → 接收」两阶段完成；交接中的床位冻结、不可预约；接收后重新编号并须重新消毒。</p></div>
  ${transferForm(ctx)}
  <h2 class="mt">调拨单</h2>
  <table class="grid wide"><thead><tr><th>单号</th><th>调出院区 / 交出人</th><th>调入病区 / 接收人</th><th>规格·数量</th><th>床位</th><th>状态</th><th>最近时间</th><th>操作</th></tr></thead>
  <tbody>${transfers.map(row).join('')}</tbody></table>`;
}
function transferBadge(s) {
  return ({ proposed: badge('待交出', 'gray'), handed_over: badge('待接收', 'blue'),
    received: badge('已接收', 'teal'), rejected: badge('已驳回', 'red') })[s] || badge(s, 'gray');
}
function transferForm(ctx) {
  if (!ctx.staff.is_admin && ctx.wardAuth.size === 0) return '';
  const wards = ctx.wards;
  return `<div class="panel"><h3>发起调拨</h3><form method="post" action="/transfers" id="xferform">
    <div class="form-grid">
      <label>调出院区<select name="fromWardId" id="fromW">${wards.map((w) => `<option value="${w.id}">${esc(w.code)} ${esc(w.name)}</option>`).join('')}</select></label>
      <label>调入病区<select name="toWardId" id="toW">${wards.map((w) => `<option value="${w.id}">${esc(w.code)} ${esc(w.name)}</option>`).join('')}</select></label>
      <label>规格<select name="spec"><option>平板床</option><option>单摇床</option><option>双摇床</option></select></label>
      <label>接收责任人<select name="toNurseId">${ctx.staffList.filter((s) => !s.is_admin).map((s) => `<option value="${s.id}">${esc(s.name)}（${esc(s.title)}）</option>`).join('')}</select></label>
    </div>
    <div id="bedpick" class="bedpick"><span class="muted">选择病区与规格后点选空闲床位（即交接数量）：</span></div>
    <button class="btn teal">提交调拨提议（交出人为当前操作员）</button>
  </form></div>`;
}

// ---------- 照片区 ----------
function photoSection(refType, refId, photos, canUpload) {
  return `<div class="panel mt"><h3>交接照片（本地目录 data/photos）</h3>
    <div class="photos">${(photos || []).map((p) => `<figure><img src="/photo/${p.id}" alt="${esc(p.filename)}">
      <figcaption>${esc(p.filename)}<br><span class="muted">${(p.size / 1024).toFixed(1)} KB · ${shortDt(p.uploaded_at)}</span></figcaption></figure>`).join('') || '<span class="muted">暂无照片</span>'}</div>
    ${canUpload ? `<form method="post" action="/photos/${refType}/${refId}" enctype="multipart/form-data" class="inline mt">
      <input type="file" name="photo" accept="image/*" required><button class="btn small ghost">上传交接照片</button></form>` : ''}
  </div>`;
}

// ---------- 样式 ----------
const CSS = `
:root{--ink:#16324f;--ink2:#24486b;--teal:#2a9d8f;--teal-d:#1f7a6f;--bg:#f4f8fb;--line:#dce6ee;--mut:#6a8296;}
*{box-sizing:border-box}body{margin:0;font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif;background:var(--bg);color:var(--ink);}
a{color:var(--teal-d);text-decoration:none}a:hover{text-decoration:underline}
.topbar{background:var(--ink);color:#fff;display:flex;justify-content:space-between;align-items:center;padding:12px 22px;}
.brand{display:flex;gap:12px;align-items:center}.logo{background:var(--teal);width:38px;height:38px;border-radius:9px;display:grid;place-items:center;font-size:22px;font-weight:700}
.brand-title{font-size:17px;font-weight:700}.brand-sub{font-size:11px;color:#9fc0d4;margin-top:2px}
.staffbox{display:flex;align-items:center;gap:8px}.staff-label{font-size:12px;color:#bcd2e2}
select,input,button{font:inherit}select,input[type=text],input:not([type]),input.qty,.wide-input{border:1px solid var(--line);border-radius:6px;padding:6px 8px;background:#fff;color:var(--ink)}
.staffbox select{padding:6px 10px;border-radius:7px}
.tabs{display:flex;background:#fff;border-bottom:1px solid var(--line);padding:0 14px;overflow-x:auto}
.tab{padding:13px 18px;color:var(--mut);font-size:14px;border-bottom:3px solid transparent;white-space:nowrap}
.tab:hover{text-decoration:none;color:var(--ink)}.tab.on{color:var(--ink);border-bottom-color:var(--teal);font-weight:700}
.wrap{max-width:1280px;margin:0 auto;padding:22px}
.foot{text-align:center;color:var(--mut);font-size:12px;padding:26px}
h1{font-size:21px;margin:0}h1 small{font-size:13px;color:var(--mut);font-weight:400}h2{font-size:16px}.mt{margin-top:22px}h3{margin:0 0 10px;font-size:14px;color:var(--ink2)}
.pagehead{margin-bottom:16px}.hint{color:var(--mut);font-size:13px;margin:6px 0 0}
.flash{padding:11px 15px;border-radius:8px;margin-bottom:16px;font-size:14px}.flash.ok{background:#e6f6f3;color:var(--teal-d);border:1px solid #b6e3dc}
.flash.err{background:#fdecea;color:#a63226;border:1px solid #f3c3bd}
.ward{background:#fff;border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin-bottom:18px}
.ward-head{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:14px}
.ward-head h2{margin:0;font-size:16px}.ward-stats{display:flex;gap:7px;flex-wrap:wrap}
.pill{font-size:12px;padding:3px 10px;border-radius:20px;font-weight:600}.pill.teal{background:#e6f6f3;color:var(--teal-d)}.pill.blue{background:#e8f0f8;color:var(--ink)}.pill.gray{background:#eef2f5;color:var(--mut)}.pill.red{background:#fdecea;color:#a63226}.pill.amber{background:#fdf1e3;color:#a55d12}
.legend{display:flex;gap:18px;flex-wrap:wrap;margin-bottom:14px;font-size:12px;color:var(--mut)}.lg{display:flex;align-items:center;gap:6px}.sw{width:13px;height:13px;border-radius:3px;display:inline-block}.sw.teal{background:var(--teal)}.sw.blue{background:var(--ink)}.sw.gray{background:#b6c4cf}.sw.red{background:#c0392b}.sw.amber{background:#e67e22}
.bedgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(158px,1fr));gap:11px}
.bed{display:block;background:#fff;border:1.5px solid var(--line);border-radius:10px;padding:11px 12px;color:var(--ink);transition:.12s;position:relative}
.bed:hover{text-decoration:none;box-shadow:0 4px 14px rgba(22,50,79,.1);transform:translateY(-1px)}
.bed.clean{border-left:5px solid var(--teal)}.bed.occ{border-left:5px solid var(--ink);background:#f7fafd}
.bed.dirty{border-left:5px solid #b6c4cf;background:#fafbfc}.bed.iso{border-left:5px solid #c0392b;background:#fff8f7}
.bed.maint{border-left:5px solid #e67e22;background:#fffbf6}
.bed-top{display:flex;justify-content:space-between;align-items:center}.bed-top b{font-size:15px}.bed-spec{font-size:12px;color:var(--mut);margin:3px 0 8px}
.bed-occ{font-size:12px;color:var(--ink);font-weight:600}.bed-rental{font-size:11px;color:var(--mut)}.bed-free{font-size:12px;color:var(--teal-d);font-weight:600}
.bed-tag{margin-top:6px;font-size:11px;color:#a55d12}.bed-tag.amber{color:#a55d12}
.badge{display:inline-block;font-size:11px;padding:2px 8px;border-radius:11px;font-weight:600;white-space:nowrap}
.badge.teal{background:#e6f6f3;color:var(--teal-d)}.badge.blue{background:#e8f0f8;color:var(--ink)}.badge.gray{background:#eef2f5;color:var(--mut)}
.badge.red{background:#fdecea;color:#a63226}.badge.amber{background:#fdf1e3;color:#a55d12}.badge.dark{background:var(--ink);color:#fff}
table.grid{width:100%;border-collapse:collapse;background:#fff;font-size:13px}
table.grid th,table.grid td{border:1px solid var(--line);padding:8px 10px;text-align:left;vertical-align:middle}
table.grid thead th{background:#eef4f8;color:var(--ink2);font-weight:600;font-size:12px}
table.grid tbody tr:nth-child(even){background:#fafcfe}.num{text-align:right;font-variant-numeric:tabular-nums}.nowrap{white-space:nowrap}.mono{font-family:ui-monospace,Menlo,monospace;font-size:12px}.sub{font-size:11px;color:var(--mut)}
.wide{min-width:900px}
.panel{background:#fff;border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin-bottom:16px}
.cards-row{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media(max-width:900px){.cards-row,.check-cols{grid-template-columns:1fr!important}}
table.kv{width:100%;font-size:13px}table.kv th{text-align:left;width:88px;color:var(--mut);font-weight:500;padding:5px 0}table.kv td{padding:5px 0}
.actions{display:flex;flex-direction:column;gap:9px;align-items:flex-start}.inline{display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap}
.btn{display:inline-block;border:0;border-radius:7px;padding:8px 14px;background:var(--teal);color:#fff;cursor:pointer;font-size:13px;font-weight:600}
.btn:hover{filter:brightness(.95);text-decoration:none;color:#fff}.btn.blue{background:var(--ink)}.btn.teal{background:var(--teal)}.btn.amber{background:#e67e22}.btn.ghost{background:#fff;color:var(--ink2);border:1px solid var(--line)}
.btn.small{padding:5px 10px;font-size:12px}.btn.big{padding:11px 22px;font-size:14px;margin-top:12px}
.chk{font-size:13px;display:inline-flex;gap:6px;align-items:center}.muted{color:var(--mut)}.tagperm{font-size:12px;color:var(--mut)}
.actions-cell{white-space:nowrap}
.timeline{list-style:none;margin:8px 0 0;padding:0;border-left:2px solid var(--line)}
.timeline li{position:relative;padding:0 0 16px 22px}.t-dot{position:absolute;left:-7px;top:3px;width:12px;height:12px;border-radius:50%;background:var(--ink);border:2px solid #fff;box-shadow:0 0 0 2px var(--line)}
.t-dot.teal{background:var(--teal)}.t-dot.amber{background:#e67e22}.t-dot.red{background:#c0392b}
.t-head{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}.t-time{font-size:11px;color:var(--mut)}.t-detail{font-size:12px;color:var(--ink2);background:#fff;border:1px solid var(--line);border-radius:7px;padding:6px 9px;margin-top:4px;display:inline-block}
.check-cols{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px}.check-col{background:#fff;border:1px solid var(--line);border-radius:12px;padding:14px}
.check-col h3{border-bottom:2px solid var(--teal);padding-bottom:7px}tr.abn{background:#fff6f4!important}
.qty{width:56px}.reason-input{width:100%;min-width:120px}.wide-input{min-width:320px;width:60%}
.stat-row{display:grid;grid-template-columns:repeat(4,1fr);gap:13px;margin-bottom:18px}.stat{border-radius:12px;padding:15px 18px;color:#fff}.stat.teal{background:var(--teal)}.stat.amber{background:#e67e22}.stat.blue{background:var(--ink)}.stat.dark{background:var(--ink2)}
.stat-v{font-size:23px;font-weight:700}.stat-l{font-size:12px;opacity:.9;margin-top:3px}
.photos{display:flex;gap:13px;flex-wrap:wrap}.photos figure{margin:0;width:180px;border:1px solid var(--line);border-radius:9px;overflow:hidden;background:#fff}
.photos img{width:100%;height:118px;object-fit:cover;display:block;background:#eef2f5}.photos figcaption{font-size:10px;padding:6px 8px;color:var(--ink2);word-break:break-all}
.form-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:12px}.form-grid label{display:flex;flex-direction:column;gap:5px;font-size:12px;color:var(--mut)}
.bedpick{margin-bottom:12px}.bedpick .bp{display:inline-block;border:1px solid var(--line);border-radius:6px;padding:5px 10px;margin:3px;cursor:pointer;font-size:12px;background:#fff}
.bedpick .bp.sel{background:var(--ink);color:#fff;border-color:var(--ink)}
`;

// 供调拨页前端 JS（床位多选）注入
const TRANSFER_JS = `
<script>
(function(){
  var fromW=document.getElementById('fromW'),toW=document.getElementById('toW'),spec=document.querySelector('#xferform select[name=spec]'),box=document.getElementById('bedpick');
  async function load(){
    if(!fromW)return;
    var r=await fetch('/api/allocatable?wardId='+fromW.value+'&spec='+encodeURIComponent(spec.value));
    var beds=await r.json();
    box.innerHTML=beds.length?'':'<span class=muted>该病区该规格暂无空闲（清洁/未维修/未占用/未调拨）床位</span>';
    beds.forEach(function(b){var e=document.createElement('label');e.className='bp';e.innerHTML='<input type=checkbox name=bedId value="'+b.id+'" style=display:none>'+b.code;
      e.querySelector('input').addEventListener('change',function(){e.classList.toggle('sel',this.checked)});box.appendChild(e);});
  }
  if(fromW){fromW.addEventListener('change',load);spec.addEventListener('change',load);load();}
  document.getElementById('retform')?.addEventListener('submit',function(ev){
    var bad=[];this.querySelectorAll('[data-row]').forEach(function(tr){
      var res=tr.querySelector('[data-result]').value;var reason=tr.querySelector('.reason-input').value.trim();
      if(res!=='ok'&&!reason){bad.push(tr.cells[0].textContent);}
    });
    var fr=this.frameResult.value, mr=this.mattressResult.value;
    if(fr!=='ok'&&!this.frameReason.value.trim())bad.push('床架');
    if(mr!=='ok'&&!this.mattressReason.value.trim())bad.push('床垫');
    if(bad.length){ev.preventDefault();alert('以下异常项必须填写处理原因：'+bad.join('、'));}
  });
})();
</script>`;

module.exports = { layout, mapView, bedDetail, requestsView, rentalsView, rentalDetail, returnsView, returnForm,
  cleaningView, depositsView, transfersView, checkSummary, esc, TRANSFER_JS };
