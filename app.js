const MODE = "web"; // "artifact" (claude.ai, saved with db) or "web" (Vercel, saved in this browser)
const DAYN = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
const LS_KEY = "pltrack.v1", LS_SEL = "pltrack.sel", LS_API = "pltrack.apikey";
const SPEEDS = [1,1.25,1.5,1.75,2];
const WEB_APP = "https://playlist-progress-tracker-lime.vercel.app/";
const webLinkFor = u => { const id = playlistIdFrom(u); return WEB_APP + (id ? "?for=claude&list=" + encodeURIComponent(id) : "?for=claude"); };
const S = { list: [], sel: null, filter: "upcoming", open: {}, draft: null, confirmDelete: false, renaming: false };
let db = null;

/* ---------- helpers ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const pad = n => String(n).padStart(2,"0");
const isoD = d => d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate());
const parseD = s => { const [y,m,d] = s.split("-").map(Number); return new Date(y, m-1, d); };
const todayIso = () => isoD(new Date());
const addDays = (s, n) => { const d = parseD(s); d.setDate(d.getDate()+n); return isoD(d); };
const diffDays = (a, b) => Math.round((parseD(b) - parseD(a)) / 864e5);
const fmtDate = s => parseD(s).toLocaleDateString(undefined, { weekday:"short", day:"numeric", month:"short" });
const fmtDateLong = s => parseD(s).toLocaleDateString(undefined, { weekday:"short", day:"numeric", month:"short", year:"numeric" });
function fmtDur(sec, long){
  sec = Math.round(sec); const h = Math.floor(sec/3600), m = Math.floor(sec%3600/60), s = sec%60;
  if (long) return (h ? h+"h " : "") + (h||m ? m+"m" : s+"s");
  return (h ? h+":"+pad(m) : m) + ":" + pad(s);
}
function parseLen(str){
  str = String(str||"").trim().toLowerCase(); if (!str) return 0;
  if (/^[\d:]+$/.test(str)) { const p = str.split(":").map(Number); let s = 0; for (const x of p) s = s*60 + (x||0); if (p.length === 1) s *= 60; return s; }
  let s = 0; const re = /(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minutes?|s|sec|secs|seconds?)/g; let m;
  while ((m = re.exec(str))) { const v = parseFloat(m[1]); s += m[2][0]==="h" ? v*3600 : m[2][0]==="m" ? v*60 : v; }
  return Math.round(s);
}
function playlistIdFrom(u){
  u = String(u||"").trim(); const m = u.match(/[?&]list=([\w-]+)/); if (m) return m[1];
  if (/^(PL|UU|OL|FL|RD|LL)[\w-]{10,}$/.test(u)) return u; return "";
}
const uid = () => Math.random().toString(36).slice(2,10) + Date.now().toString(36).slice(-4);
function toast(msg){ const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, 2200); }
const lsGet = k => { try { return localStorage.getItem(k); } catch(e){ return null; } };
const lsSet = (k,v) => { try { localStorage.setItem(k,v); } catch(e){} };
const cur = () => S.list.find(p => p.id === S.sel);

/* ---------- model ---------- */
function defaultSettings(){ return { speed: 1, minutesPerDay: 60, days: [true,true,true,true,true,true,true], startDate: todayIso() }; }
function hydrate(o){
  const p = Object.assign({ title:"Untitled playlist", url:"", channel:"", source:"manual", videos:[], done:[], plan:[], settings: defaultSettings(), createdAt: Date.now() }, o);
  p.settings = Object.assign(defaultSettings(), p.settings || {});
  p.doneSet = new Set(p.done || []);
  return p;
}
function serialize(p){ const o = Object.assign({}, p); delete o.doneSet; o.done = [...p.doneSet].sort((a,b)=>a-b); o.updatedAt = Date.now(); return o; }
function budgetSec(s){ return Math.max(60, (Number(s.minutesPerDay)||0) * 60 * (Number(s.speed)||1)); }
function allocate(p, fromIso, keepPast){
  const s = p.settings; if (!s.days.some(Boolean)) s.days = s.days.map(() => true);
  let kept = [];
  if (keepPast) kept = (p.plan||[]).filter(d => d.date < fromIso).map(d => ({ date: d.date, items: d.items.filter(i => p.doneSet.has(i)) })).filter(d => d.items.length);
  const keptSet = new Set(kept.flatMap(d => d.items));
  const budget = budgetSec(s), days = [];
  let date = parseD(fromIso), day = null, used = 0;
  const watch = d => s.days[(d.getDay()+6)%7];
  const next = () => { let g = 0; while (!watch(date) && g++ < 8) date.setDate(date.getDate()+1); day = { date: isoD(date), items: [] }; days.push(day); used = 0; date.setDate(date.getDate()+1); };
  p.videos.forEach((v, i) => {
    if (keptSet.has(i)) return;
    const dur = p.doneSet.has(i) ? 0 : v[1];
    if (!day || (used > 0 && used + dur > budget * 1.1)) next();
    day.items.push(i); used += dur;
  });
  p.plan = kept.concat(days);
}
function replanFrom(p){ const t = todayIso(); const from = p.settings.startDate > t ? p.settings.startDate : t; allocate(p, from, true); }
function stats(p){
  const t = todayIso(), sp = Number(p.settings.speed)||1;
  const total = p.videos.reduce((a,v)=>a+v[1],0);
  let watched = 0; p.doneSet.forEach(i => { if (p.videos[i]) watched += p.videos[i][1]; });
  const dayDone = d => d.items.every(i => p.doneSet.has(i));
  const plan = p.plan || [];
  const doneDays = plan.filter(dayDone).length;
  const leftDays = plan.filter(d => !dayDone(d) && d.date >= t).length;
  const lateDays = plan.filter(d => !dayDone(d) && d.date < t);
  const lateVids = lateDays.reduce((a,d)=>a + d.items.filter(i=>!p.doneSet.has(i)).length, 0);
  const lastOpen = [...plan].reverse().find(d => !dayDone(d));
  const finish = plan.length ? plan[plan.length-1].date : null;
  return { total, watched, remaining: total - watched, pct: total ? watched/total : 0, sp,
    planDays: plan.length, doneDays, leftDays: leftDays + lateDays.length, lateDays: lateDays.length, lateVids, finish,
    calLeft: finish ? Math.max(0, diffDays(t, finish) + 1) : 0, allDone: total > 0 && watched >= total, doneCount: p.doneSet.size, lastOpen };
}

/* ---------- storage ---------- */
function saveLocal(){ lsSet(LS_KEY, JSON.stringify(S.list.map(serialize))); if (S.sel) lsSet(LS_SEL, S.sel); }
const pending = new Map(); const writing = new Set();
function setSaveState(txt){ const el = $("#saveState span"); if (el) el.textContent = txt; }
function persist(p){
  saveLocal();
  if (!db) { setSaveState(MODE === "web" ? "Saved in this browser" : "Saved"); return; }
  setSaveState("Saving…");
  clearTimeout(pending.get(p.id));
  pending.set(p.id, setTimeout(() => flush(p.id), 500));
}
async function flush(id){
  if (writing.has(id)) { pending.set(id, setTimeout(() => flush(id), 400)); return; }
  const p = S.list.find(x => x.id === id); if (!p) return;
  writing.add(id);
  try { await db.doc("playlists/" + id).set(serialize(p)); setSaveState("Saved"); }
  catch (e) { setSaveState("Saved on this device only"); console.warn(e); }
  finally { writing.delete(id); }
}
async function removeStored(id){
  saveLocal();
  if (db) { try { await db.doc("playlists/" + id).delete(); } catch(e){ console.warn(e); } }
}
function loadLocal(){
  try { const raw = lsGet(LS_KEY); if (raw) S.list = JSON.parse(raw).map(hydrate); } catch(e){ S.list = []; }
  const sel = lsGet(LS_SEL); S.sel = S.list.some(p => p.id === sel) ? sel : (S.list[0]?.id || null);
}
async function connectDb(){
  if (MODE !== "artifact" || !window.claude?.use) return;
  try { db = await window.claude.use("db"); } catch(e){ db = null; }
  if (!db) { setSaveState("Saved on this device only"); return; }
  try {
    const snap = await db.collection("playlists").get();
    const remote = snap.docs.map(d => hydrate(Object.assign({}, d.data(), { id: d.id })));
    const byId = new Map(remote.map(p => [p.id, p]));
    // keep anything that exists only on this device, and push it up
    const localOnly = S.list.filter(p => !byId.has(p.id));
    for (const p of S.list) { const r = byId.get(p.id); if (r && (p.updatedAt||0) > (r.updatedAt||0)) byId.set(p.id, p); }
    S.list = [...byId.values(), ...localOnly].sort((a,b) => (a.createdAt||0) - (b.createdAt||0));
    if (!S.list.some(p => p.id === S.sel)) S.sel = S.list[0]?.id || null;
    saveLocal(); render();
    for (const p of localOnly) await db.doc("playlists/" + p.id).set(serialize(p));
    setSaveState("Saved");
  } catch (e) { console.warn(e); setSaveState("Saved on this device only"); }
}

/* ---------- rendering ---------- */
function ringSvg(pct, size, stroke){
  const r = (100 - stroke)/2, c = 2*Math.PI*r;
  return `<svg viewBox="0 0 100 100" aria-hidden="true"><circle class="bgc" cx="50" cy="50" r="${r}" stroke-width="${stroke}"/><circle class="fgc" cx="50" cy="50" r="${r}" stroke-width="${stroke}" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${(c*(1-Math.min(1,pct))).toFixed(2)}"/></svg>`;
}
function renderSide(){
  const items = S.list.map(p => {
    const st = stats(p);
    return `<button class="pl-item ${p.id===S.sel?"on":""}" data-act="select" data-id="${p.id}">
      <span class="mini-ring ring ${st.allDone?"complete":""}" style="width:30px;height:30px">${ringSvg(st.pct,30,14)}</span>
      <span class="txt"><span class="nm" style="display:block">${esc(p.title)}</span><span class="sub mono">${Math.round(st.pct*100)}% · ${st.allDone ? "finished" : st.leftDays + " days left"}</span></span></button>`;
  }).join("");
  $("#side").innerHTML = `<div class="side-label">Playlists</div>${items}<button class="pl-item add-item" data-act="new">+ Add playlist</button>`;
}
function render(){
  renderSide();
  const main = $("#main");
  if (S.sel === "__new" || !S.list.length) { main.innerHTML = renderAdd(); bindAdd(); return; }
  const p = cur(); if (!p) { S.sel = S.list[0].id; return render(); }
  main.innerHTML = renderPlaylist(p);
}
function renderPlaylist(p){
  const st = stats(p), s = p.settings, t = todayIso();
  const pct = Math.round(st.pct*1000)/10;
  const pctTxt = pct % 1 === 0 ? String(pct) : pct.toFixed(1);
  const dayPct = st.planDays ? st.doneDays / st.planDays : 0;
  const link = p.url ? `<div class="linkrow"><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.url)}</a><button class="btn ghost" data-act="copylink" style="padding:4px 8px;font-size:12px">Copy</button></div>` : "";
  const head = `<section class="card">
    <div class="pl-head"><div class="grow">
      <p class="eyebrow">${p.source === "youtube" ? "YouTube playlist" : "Playlist"}${p.channel ? " · " + esc(p.channel) : ""}</p>
      ${S.renaming ? `<div class="hm" style="max-width:520px"><input type="text" id="renameInput" value="${esc(p.title)}" aria-label="Playlist name"><button class="btn primary" data-act="renameSave">Save</button><button class="btn ghost" data-act="renameCancel">Cancel</button></div>` : `<h2 class="title">${esc(p.title)}</h2>`}
      <div class="meta"><span><b class="mono">${p.videos.length}</b> videos</span><span>Length <b class="mono">${fmtDur(st.total,true)}</b></span><span>At ${s.speed}x <b class="mono">${fmtDur(st.total/st.sp,true)}</b></span><span><b class="mono">${st.doneCount}</b> watched</span></div>
      ${link}
    </div>
    <div class="head-actions"><button class="btn" data-act="rename">Rename</button><button class="btn danger" data-act="askDelete">Delete</button></div></div>
    ${S.confirmDelete ? `<div class="confirm-row"><span>Delete this playlist and all its progress?</span><button class="btn danger" data-act="doDelete">Delete for good</button><button class="btn ghost" data-act="cancelDelete">Keep it</button></div>` : ""}
  </section>`;
  const ring = `<section class="card ring-card">
    <p class="eyebrow" style="align-self:flex-start">Watched</p>
    <div class="ring ${st.allDone?"complete":""}" role="img" aria-label="${pctTxt} percent watched">${ringSvg(st.pct,170,9)}
      <div class="center"><div class="pct mono">${pctTxt}<small>%</small></div><div class="lbl">${st.doneCount} of ${p.videos.length} videos</div></div></div>
    <div class="ring-sub"><b class="mono">${fmtDur(st.watched,true)}</b> watched · <b class="mono">${fmtDur(st.remaining/st.sp,true)}</b> left at ${s.speed}x</div>
  </section>`;
  const daysCard = `<section class="card">
    <p class="eyebrow">Days left</p>
    <div class="days-big"><span class="n mono">${st.allDone ? 0 : st.leftDays}</span><span class="u">study ${st.leftDays===1?"day":"days"} to go</span></div>
    <div class="bar ${st.allDone?"done":""}" role="progressbar" aria-valuemin="0" aria-valuemax="${st.planDays}" aria-valuenow="${st.doneDays}" aria-label="Study days completed"><i style="width:${(dayPct*100).toFixed(1)}%"></i></div>
    <div class="bar-legend"><span class="mono">${st.doneDays} / ${st.planDays} days done</span><span class="mono">${Math.round(dayPct*100)}%</span></div>
    <dl class="kv">
      <dt>Finish date</dt><dd class="mono">${st.allDone ? "Finished" : (st.lastOpen ? fmtDateLong(st.lastOpen.date) : "—")}</dd>
      <dt>Calendar days left</dt><dd class="mono">${st.allDone ? 0 : (st.lastOpen ? Math.max(0, diffDays(t, st.lastOpen.date)+1) : 0)}</dd>
      <dt>Started</dt><dd class="mono">${fmtDateLong(p.plan[0]?.date || s.startDate)}</dd>
    </dl>
    ${st.lateDays ? `<div class="alert"><span>${st.lateVids} video${st.lateVids===1?"":"s"} from ${st.lateDays} past day${st.lateDays===1?"":"s"} not done yet</span><button class="btn" data-act="reschedule">Reschedule from today</button></div>` : ""}
  </section>`;
  const speedRows = SPEEDS.concat(SPEEDS.includes(Number(s.speed)) ? [] : [Number(s.speed)]).sort((a,b)=>a-b).map(x =>
    `<tr class="${x===Number(s.speed)?"cur":""}"><td>${x.toFixed(2)}x</td><td class="mono">${fmtDur(st.total/x)}</td><td class="mono">${fmtDur(st.remaining/x)}</td></tr>`).join("");
  const speeds = `<section class="card speeds"><p class="eyebrow">Length at each speed</p>
    <table><thead><tr><td style="font-size:12px;color:var(--muted)">Speed</td><td style="font-size:12px;color:var(--muted)">Total</td><td style="font-size:12px;color:var(--muted);text-align:right">Remaining</td></tr></thead><tbody>${speedRows}</tbody></table></section>`;
  const mins = Number(s.minutesPerDay)||0;
  const settings = `<section class="card"><div class="plan-head"><h3 class="sec grow">Watch schedule</h3></div>
    <div class="settings-grid">
      <div class="field"><label for="setSpeed">Playback speed</label><div class="hm"><input type="number" id="setSpeed" min="0.25" max="4" step="0.25" value="${s.speed}"><span>x</span></div></div>
      <div class="field"><span class="flabel">Time per day</span><div class="hm"><input type="number" id="setH" min="0" max="16" value="${Math.floor(mins/60)}" aria-label="Hours per day"><span>h</span><input type="number" id="setM" min="0" max="59" step="5" value="${mins%60}" aria-label="Minutes per day"><span>m</span></div></div>
      <div class="field"><label for="setStart">Start date</label><input type="date" id="setStart" value="${s.startDate}"></div>
      <div class="field span-all"><span class="flabel">Watching days</span><div class="daychips">${DAYN.map((d,i)=>`<button class="daychip ${s.days[i]?"on":""}" data-act="toggleDay" data-i="${i}" aria-pressed="${s.days[i]}">${d}</button>`).join("")}</div></div>
    </div>
    <p class="hint">Changes rebuild the plan from today. Past days and ticked videos stay as they are.</p></section>`;
  const dayDone = d => d.items.every(i => p.doneSet.has(i));
  let list = p.plan.map((d, n) => ({ d, n }));
  if (S.filter === "upcoming") list = list.filter(x => !dayDone(x.d) || x.d.date === t);
  if (S.filter === "done") list = list.filter(x => dayDone(x.d));
  const plan = `<section class="card"><div class="plan-head"><div class="grow"><h3 class="sec">Daily plan</h3><div class="hint" style="margin-top:4px">Tick a day to mark all its videos, or tick videos one by one.</div></div>
      <div class="seg" role="tablist">${[["upcoming","To do"],["all","All days"],["done","Completed"]].map(([k,l])=>`<button role="tab" aria-selected="${S.filter===k}" class="${S.filter===k?"on":""}" data-act="filter" data-f="${k}">${l}</button>`).join("")}</div></div>
    <div class="days">${list.length ? list.map(x => renderDay(p, x.d, x.n, t)).join("") : `<div class="empty" style="padding:22px"><p style="margin:0">${S.filter==="done" ? "No completed days yet. Tick today's videos to see them here." : "Every day is done. Great work."}</p></div>`}</div></section>`;
  return head + `<div class="widgets">${ring}${daysCard}${speeds}</div>` + settings + plan;
}
function renderDay(p, d, n, t){
  const doneN = d.items.filter(i => p.doneSet.has(i)).length, all = doneN === d.items.length, some = doneN > 0 && !all;
  const late = !all && d.date < t, isToday = d.date === t;
  const open = S.open[p.id + d.date] ?? (isToday || late);
  const secs = d.items.reduce((a,i)=>a + p.videos[i][1], 0) / (Number(p.settings.speed)||1);
  const chip = isToday ? `<span class="chip today">Today</span>` : late ? `<span class="chip late">Behind</span>` : all ? `<span class="chip done">Done</span>` : "";
  const vids = open ? `<ul class="vids">${d.items.map(i => { const v = p.videos[i], on = p.doneSet.has(i);
      const href = v[2] ? `https://www.youtube.com/watch?v=${encodeURIComponent(v[2])}${p.playlistId?"&list="+encodeURIComponent(p.playlistId)+"&index="+(i+1):""}` : "";
      return `<li class="vid ${on?"checked":""}"><input type="checkbox" class="cb" data-act="vid" data-i="${i}" ${on?"checked":""} id="v${i}"><span class="ix mono">#${i+1}</span><label class="vt" for="v${i}">${esc(v[0])}</label><span class="vd mono">${fmtDur(v[1]/(Number(p.settings.speed)||1))}</span>${href?`<a class="play" href="${href}" target="_blank" rel="noopener">Watch</a>`:""}</li>`; }).join("")}</ul>` : "";
  return `<div class="day ${open?"open":""} ${isToday?"today":""} ${late?"overdue":""} ${all?"complete":""}">
    <div class="dayhead" data-act="openDay" data-date="${d.date}" tabindex="0" role="button" aria-expanded="${open}">
      <input type="checkbox" class="cb" data-act="dayCheck" data-date="${d.date}" ${all?"checked":""} ${some?"data-ind=\"1\"":""} aria-label="Mark day ${n+1} done">
      <div class="when"><div class="d1">Day ${n+1} <span style="font-weight:500;color:var(--muted)">· ${fmtDate(d.date)}</span> ${chip}</div>
        <div class="d2 mono">${d.items.length} video${d.items.length===1?"":"s"} · #${d.items[0]+1}${d.items.length>1?"–#"+(d.items[d.items.length-1]+1):""} · ${fmtDur(secs,true)} at ${p.settings.speed}x</div></div>
      <span class="daycount mono">${doneN}/${d.items.length}</span>
      <svg class="caret" viewBox="0 0 20 20" aria-hidden="true"><path d="M7 4l6 6-6 6z"/></svg>
    </div>${vids}</div>`;
}
function afterRender(){ document.querySelectorAll('.cb[data-ind]').forEach(c => c.indeterminate = true); }

/* ---------- add playlist ---------- */
function renderAdd(){
  const D = S.draft || (S.draft = { tab: "fetch", url:"", from:"", to:"", title:"", count:"", length:"", fetched:null, status:"", statusKind:"", settings: defaultSettings() });
  const s = D.settings, mins = s.minutesPerDay;
  const first = !S.list.length;
  return `${first ? `<section class="card empty"><p class="eyebrow">Get started</p><h2 class="title">Track a playlist, one day at a time</h2><p>Add a YouTube playlist and its name, videos and length fill in from the link. Pick your speed and how long you watch each day. You get a day-by-day checklist, a progress ring and a countdown of days left. Everything is saved, so you can close this and pick up later.</p><button class="btn" data-act="example">Load an example</button></section>` : ""}
  <section class="card"><h3 class="sec">Add a playlist</h3>
    <div class="tabs seg" role="tablist" style="width:max-content"><button role="tab" class="${D.tab==="fetch"?"on":""}" data-act="tab" data-t="fetch">From YouTube link</button><button role="tab" class="${D.tab==="manual"?"on":""}" data-act="tab" data-t="manual">Enter manually</button></div>
    <div class="form-grid" style="margin-top:14px">
      <div class="field span-all"><label for="fUrl">Playlist link${D.tab==="fetch" ? " (name, videos and length fill in automatically)" : ""}</label><input type="url" id="fUrl" placeholder="https://www.youtube.com/playlist?list=PL…" value="${esc(D.url)}"></div>
      ${D.tab === "fetch" ? `
        <div class="field"><label for="fFrom">Start at video (optional)</label><input type="number" id="fFrom" min="1" placeholder="1" value="${esc(D.from)}"></div>
        <div class="field"><label for="fTo">End at video (optional)</label><input type="number" id="fTo" min="1" placeholder="last" value="${esc(D.to)}"></div>
        <div class="field span-all">${MODE === "web" ? `<div><button class="btn" data-act="fetch">${D.fetched ? "Fetch again" : "Get playlist details"}</button></div>` : `
          <ol class="handoff">
            <li><a class="btn primary" id="webLink" href="${webLinkFor(D.url)}" target="_blank" rel="noopener">Get details from YouTube</a> <span class="hint" style="margin:0">opens the web app in a new tab</span></li>
            <li>There, click <b>Copy for claude.ai</b>.</li>
            <li><label for="fPaste" style="font-size:inherit;color:inherit;font-weight:inherit">Paste it here:</label> <input type="text" id="fPaste" placeholder="Paste the copied playlist details" autocomplete="off"></li>
          </ol>`}
          ${D.fetched ? `<div class="fetched"><div class="grow"><b>${esc(D.fetched.title)}</b><span class="hint" style="margin:0">${esc(D.fetched.channel||"")}</span></div><span class="mono"><b>${D.fetched.sel.length}</b> videos · <b>${fmtDur(D.fetched.sel.reduce((a,v)=>a+v[1],0),true)}</b></span>${MODE === "web" && D.forClaude ? `<button class="btn primary" data-act="copyForClaude">Copy for claude.ai</button>` : ""}</div>` : ""}
          <div class="status ${D.statusKind}" id="fStatus">${esc(D.status)}</div></div>` : `
        <div class="field"><label for="fTitle">Name</label><input type="text" id="fTitle" placeholder="e.g. Andrew Ng · Machine Learning" value="${esc(D.title)}"></div>
        <div class="field"><label for="fCount">Number of videos</label><input type="number" id="fCount" min="1" placeholder="e.g. 40" value="${esc(D.count)}"></div>
        <div class="field"><label for="fLen">Total length</label><input type="text" id="fLen" placeholder="e.g. 12:34:56 or 12h 35m" value="${esc(D.length)}"></div>
        <div class="field span-all"><div class="status ${D.statusKind}" id="fStatus">${esc(D.status)}</div></div>`}
    </div>
    <h3 class="sec" style="margin-top:20px;font-size:16px">Your schedule</h3>
    <div class="settings-grid">
      <div class="field"><label for="dSpeed">Playback speed</label><div class="hm"><input type="number" id="dSpeed" min="0.25" max="4" step="0.25" value="${s.speed}"><span>x</span></div></div>
      <div class="field"><span class="flabel">Time per day</span><div class="hm"><input type="number" id="dH" min="0" max="16" value="${Math.floor(mins/60)}" aria-label="Hours per day"><span>h</span><input type="number" id="dM" min="0" max="59" step="5" value="${mins%60}" aria-label="Minutes per day"><span>m</span></div></div>
      <div class="field"><label for="dStart">Start date</label><input type="date" id="dStart" value="${s.startDate}"></div>
      <div class="field span-all"><span class="flabel">Watching days</span><div class="daychips">${DAYN.map((d,i)=>`<button class="daychip ${s.days[i]?"on":""}" data-act="draftDay" data-i="${i}" aria-pressed="${s.days[i]}">${d}</button>`).join("")}</div></div>
    </div>
    <div class="row-actions"><button class="btn primary" data-act="create">Create tracker</button>${S.list.length?`<button class="btn ghost" data-act="cancelNew">Cancel</button>`:""}</div>
  </section>`;
}
function readDraft(){
  const D = S.draft; if (!D) return; const v = id => { const e = document.getElementById(id); return e ? e.value : undefined; };
  if (v("fUrl") !== undefined) D.url = v("fUrl");
  if (v("fFrom") !== undefined) D.from = v("fFrom");
  if (v("fTo") !== undefined) D.to = v("fTo");
  if (v("fTitle") !== undefined) D.title = v("fTitle");
  if (v("fCount") !== undefined) D.count = v("fCount");
  if (v("fLen") !== undefined) D.length = v("fLen");
  if (v("dSpeed") !== undefined) { D.settings.speed = Math.max(0.25, Number(v("dSpeed"))||1); D.settings.minutesPerDay = Math.max(5, (Number(v("dH"))||0)*60 + (Number(v("dM"))||0)); D.settings.startDate = v("dStart") || todayIso(); }
}
function bindAdd(){}
function setStatus(msg, kind){ S.draft.status = msg; S.draft.statusKind = kind||""; const el = $("#fStatus"); if (el) { el.textContent = msg; el.className = "status " + (kind||""); } }
async function doFetch(){
  readDraft(); const D = S.draft; const id = playlistIdFrom(D.url); D.lastId = id; D.fetched = null;
  if (!id) return setStatus("That link has no playlist id. Copy the link from the playlist page, it contains list=…", "err");
  setStatus("Reading the playlist from YouTube…"); const btn = document.querySelector('[data-act="fetch"]'); if (btn) btn.disabled = true;
  const key = lsGet(LS_API) || "";
  try {
    const r = await fetch("/api/playlist?id=" + encodeURIComponent(id) + (key ? "&key=" + encodeURIComponent(key) : ""));
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.message || j.error || ("Request failed (" + r.status + ")"));
    if (D.lastId !== id) return;
    const from = Math.max(1, parseInt(D.from)||1), to = Math.min(j.videos.length, parseInt(D.to)||j.videos.length);
    D.fetched = { id, title: j.title, channel: j.channel, all: j.videos, sel: j.videos.slice(from-1, to), from };
    if (D.forClaude) toast("Now click Copy for claude.ai");
    if (!D.fetched.sel.length) { D.fetched = null; return setStatus("No videos in that range.", "err"); }
    D.status = j.partial ? `YouTube returned ${j.videos.length} of ${j.total} videos. Try Fetch again, or add an API key for large playlists.` : D.forClaude ? "Loaded. Click Copy for claude.ai, then paste it into your claude.ai tracker." : j.skipped ? `Loaded. ${j.skipped} private or deleted video${j.skipped===1?" was":"s were"} skipped.` : "Loaded. Set your schedule and create the tracker."; D.statusKind = j.partial ? "err" : "ok";
    // `YouTube returned ${j.videos.length} of ${j.total} videos. Try Fetch again, or add an API key for large playlists.` : j.skipped ? `Loaded. ${j.skipped} private or deleted video${j.skipped===1?" was":"s were"} skipped.` : "Loaded. Set your schedule and create the tracker."; D.statusKind = j.partial ? "err" : "ok";
    render();
  } catch (e) { setStatus("Couldn't load the playlist: " + e.message + " You can also enter it manually.", "err"); const b = document.querySelector('[data-act="fetch"]'); if (b) b.disabled = false; }
}
function applyRange(D){ const f = D.fetched; const from = Math.max(1, parseInt(D.from)||1), to = Math.min(f.all.length, parseInt(D.to)||f.all.length); f.sel = f.all.slice(from-1, to); f.from = from; }
function importPasted(txt){
  readDraft(); const D = S.draft; txt = String(txt||"").trim(); if (!txt) return;
  let j; try { j = JSON.parse(txt); } catch(e){ return setStatus("That isn't the copied playlist text. In the web app, click Copy for claude.ai and paste again.", "err"); }
  if (!j || j.pltrack !== 1 || !Array.isArray(j.videos) || !j.videos.length) return setStatus("That isn't the copied playlist text. In the web app, click Copy for claude.ai and paste again.", "err");
  D.fetched = { id: j.id || playlistIdFrom(D.url), title: j.title || "YouTube playlist", channel: j.channel || "", all: j.videos.filter(v => Array.isArray(v) && v[1] > 0), sel: [], from: 1 };
  applyRange(D);
  if (!D.url && D.fetched.id) D.url = "https://www.youtube.com/playlist?list=" + D.fetched.id;
  D.status = "Loaded. Set your schedule and create the tracker."; D.statusKind = "ok"; render();
}
function create(){
  readDraft(); const D = S.draft; let p;
  if (D.tab === "fetch") {
    if (!D.fetched) return setStatus(MODE === "web" ? "Paste a playlist link first. Its details load automatically." : "Paste the details from the web app first, or switch to Enter manually.", "err");
    p = hydrate({ id: uid(), title: D.fetched.title, channel: D.fetched.channel, url: "https://www.youtube.com/playlist?list=" + D.fetched.id, playlistId: D.fetched.id, source: "youtube", videos: D.fetched.sel.map(v => [v[0], v[1], v[2]]), rangeFrom: D.fetched.from });
  } else {
    const n = parseInt(D.count), len = parseLen(D.length);
    if (!n || n < 1) return setStatus("Enter how many videos the playlist has.", "err");
    if (!len) return setStatus("Enter the total length, like 12:34:56 or 12h 35m.", "err");
    const pid = playlistIdFrom(D.url), each = len / n;
    p = hydrate({ id: uid(), title: D.title.trim() || "My playlist", url: D.url.trim(), playlistId: pid, source: "manual",
      videos: Array.from({ length: n }, (_, i) => ["Video " + (i+1), Math.round(each), ""]) });
  }
  p.settings = Object.assign({}, D.settings);
  allocate(p, p.settings.startDate, false);
  S.list.push(p); S.sel = p.id; S.draft = null; persist(p); render(); afterRender(); toast("Tracker created");
}

/* ---------- actions ---------- */
function applySettings(p){
  const s = p.settings;
  s.speed = Math.max(0.25, Math.min(4, Number($("#setSpeed").value) || 1));
  s.minutesPerDay = Math.max(5, (Number($("#setH").value)||0)*60 + (Number($("#setM").value)||0));
  s.startDate = $("#setStart").value || s.startDate;
  replanFrom(p); persist(p); render(); afterRender();
}
document.addEventListener("click", e => {
  const el = e.target.closest("[data-act]"); if (!el) return;
  const act = el.dataset.act, p = cur();
  if (act === "vid" || act === "dayCheck") return; // handled on change
  if (act === "select") { S.sel = el.dataset.id; S.confirmDelete = false; S.renaming = false; lsSet(LS_SEL, S.sel); }
  else if (act === "new") { S.sel = "__new"; S.draft = null; }
  else if (act === "cancelNew") { S.sel = S.list[0]?.id || null; S.draft = null; }
  else if (act === "tab") { readDraft(); S.draft.tab = el.dataset.t; S.draft.status = ""; }
  else if (act === "draftDay") { readDraft(); const d = S.draft.settings.days; d[+el.dataset.i] = !d[+el.dataset.i]; if (!d.some(Boolean)) d[+el.dataset.i] = true; }
  else if (act === "fetch") { doFetch(); return; }
  else if (act === "create") { create(); return; }
  else if (act === "example") { loadExample(); return; }
  else if (act === "filter") { S.filter = el.dataset.f; }
  else if (act === "openDay") { if (e.target.closest(".cb")) return; const k = p.id + el.dataset.date; const t = todayIso(); const d = p.plan.find(x => x.date === el.dataset.date); const def = d.date === t || (d.date < t && !d.items.every(i=>p.doneSet.has(i))); S.open[k] = !(S.open[k] ?? def); }
  else if (act === "toggleDay") { const i = +el.dataset.i; p.settings.days[i] = !p.settings.days[i]; if (!p.settings.days.some(Boolean)) p.settings.days[i] = true; replanFrom(p); persist(p); }
  else if (act === "reschedule") { replanFrom(p); persist(p); toast("Plan rebuilt from today"); }
  else if (act === "rename") { S.renaming = true; render(); afterRender(); $("#renameInput")?.focus(); return; }
  else if (act === "renameSave") { const v = $("#renameInput").value.trim(); if (v) { p.title = v; persist(p); } S.renaming = false; }
  else if (act === "renameCancel") { S.renaming = false; }
  else if (act === "askDelete") { S.confirmDelete = true; }
  else if (act === "cancelDelete") { S.confirmDelete = false; }
  else if (act === "doDelete") { const id = p.id; S.list = S.list.filter(x => x.id !== id); S.sel = S.list[0]?.id || null; S.confirmDelete = false; removeStored(id); toast("Playlist deleted"); }
  else if (act === "copylink") { copyText(p.url); return; }
  else if (act === "copyForClaude") { const f = S.draft.fetched; copyText(JSON.stringify({ pltrack: 1, id: f.id, title: f.title, channel: f.channel, videos: f.all }), "Copied. Paste it into the claude.ai tracker"); return; }
  else return;
  render(); afterRender();
});
document.addEventListener("change", e => {
  const el = e.target; const p = cur();
  if (el.matches('.cb[data-act="vid"]')) { const i = +el.dataset.i; el.checked ? p.doneSet.add(i) : p.doneSet.delete(i); persist(p); render(); afterRender(); return; }
  if (el.matches('.cb[data-act="dayCheck"]')) { const d = p.plan.find(x => x.date === el.dataset.date); const all = d.items.every(i => p.doneSet.has(i)); d.items.forEach(i => all ? p.doneSet.delete(i) : p.doneSet.add(i)); if (!all) toast(`Day complete · ${Math.round(stats(p).pct*100)}% watched`); persist(p); render(); afterRender(); return; }
  if (p && ["setSpeed","setH","setM","setStart"].includes(el.id)) { applySettings(p); return; }
  if (S.draft && ["fFrom","fTo"].includes(el.id)) { readDraft(); if (S.draft.fetched) { applyRange(S.draft); render(); } }
});
document.addEventListener("input", e => {
  if (e.target.id === "fUrl" && MODE === "artifact") { const w = $("#webLink"), id = playlistIdFrom(e.target.value); if (w) w.href = webLinkFor(e.target.value); }
  if (e.target.id === "fPaste") { importPasted(e.target.value); return; }
  if (e.target.id !== "fUrl" || !S.draft || S.draft.tab !== "fetch" || MODE !== "web") return;
  const id = playlistIdFrom(e.target.value); clearTimeout(S.autoT);
  if (id && id !== S.draft.lastId) S.autoT = setTimeout(doFetch, 350);
});
document.addEventListener("keydown", e => {
  if ((e.key === "Enter" || e.key === " ") && e.target.matches(".dayhead")) { e.preventDefault(); e.target.click(); }
  if (e.key === "Enter" && e.target.id === "renameInput") document.querySelector('[data-act="renameSave"]').click();
  if (e.key === "Escape" && !$("#overlay").hidden) closeOverlay();
  if (e.key === "Enter" && e.target.id === "fUrl" && S.draft?.tab === "fetch" && MODE === "web") { e.preventDefault(); doFetch(); }
});

/* ---------- dialogs: backup, API key ---------- */
function copyText(txt, okMsg){
  const fallback = () => { const o = $("#overlay"); o.hidden = false; o.innerHTML = `<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="cpT"><h3 id="cpT">Copy this text</h3><p class="hint" style="margin-top:0">Your browser blocked automatic copying. Select all of it and copy.</p><textarea id="cpOut" rows="6" readonly>${esc(txt)}</textarea><div class="row-actions"><button class="btn ghost" id="cpClose">Close</button></div></div>`; $("#cpOut").select(); $("#cpClose").onclick = closeOverlay; };
  try { navigator.clipboard.writeText(txt).then(() => toast(okMsg || "Copied"), fallback); } catch(e){ fallback(); }
}
function closeOverlay(){ $("#overlay").hidden = true; $("#overlay").innerHTML = ""; }
function openBackup(){
  const data = JSON.stringify({ app: "playlist-progress-tracker", version: 1, playlists: S.list.map(serialize) });
  const o = $("#overlay"); o.hidden = false;
  o.innerHTML = `<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="bkT"><h3 id="bkT">Backup and move your progress</h3>
    <p class="hint" style="margin-top:0">Copy this text to keep a backup, or to move your playlists between the claude.ai version and the web app. Paste a backup below and choose Import to restore it.</p>
    <div class="field" style="margin-top:12px"><label for="bkOut">Your data</label><textarea id="bkOut" rows="5" readonly>${esc(data)}</textarea></div>
    <div class="row-actions" style="margin-top:10px"><button class="btn" id="bkCopy">Copy</button></div>
    <div class="field" style="margin-top:16px"><label for="bkIn">Paste a backup</label><textarea id="bkIn" rows="4" placeholder='{"app":"playlist-progress-tracker", …}'></textarea></div>
    <div class="status" id="bkStatus"></div>
    <div class="row-actions"><button class="btn primary" id="bkImport">Import</button><button class="btn ghost" id="bkClose">Close</button></div></div>`;
  $("#bkCopy").onclick = () => { $("#bkOut").select(); copyText(data); };
  $("#bkClose").onclick = closeOverlay;
  $("#bkImport").onclick = () => {
    const st = $("#bkStatus");
    try {
      const j = JSON.parse($("#bkIn").value); const arr = Array.isArray(j) ? j : j.playlists; if (!Array.isArray(arr)) throw 0;
      let n = 0; for (const raw of arr) { if (!raw || !Array.isArray(raw.videos)) continue; const p = hydrate(raw); if (!p.id) p.id = uid();
        const i = S.list.findIndex(x => x.id === p.id); if (i >= 0) S.list[i] = p; else S.list.push(p); persist(p); n++; }
      if (!n) throw 0; S.sel = S.list[S.list.length-1].id; closeOverlay(); render(); afterRender(); toast(`Imported ${n} playlist${n===1?"":"s"}`);
    } catch (err) { st.textContent = "That text isn't a backup from this tracker. Copy the whole backup and try again."; st.className = "status err"; }
  };
}
function openKey(){
  const o = $("#overlay"); o.hidden = false; const k = lsGet(LS_API) || "";
  o.innerHTML = `<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="kT"><h3 id="kT">YouTube API key</h3>
    <p class="hint" style="margin-top:0">Optional. The app reads playlists without a key. A key makes very large playlists load faster and more reliably. Create a free key in Google Cloud Console (enable YouTube Data API v3, then Credentials, Create API key). It is stored in this browser and sent only to this app's server.</p>
    <div class="field" style="margin-top:12px"><label for="kIn">API key</label><input type="password" id="kIn" value="${esc(k)}" placeholder="AIza…"></div>
    <div class="row-actions"><button class="btn primary" id="kSave">Save key</button>${k?`<button class="btn danger" id="kDel">Remove key</button>`:""}<button class="btn ghost" id="kClose">Close</button></div></div>`;
  $("#kSave").onclick = () => { lsSet(LS_API, $("#kIn").value.trim()); closeOverlay(); toast("Key saved"); };
  if ($("#kDel")) $("#kDel").onclick = () => { try { localStorage.removeItem(LS_API); } catch(e){} closeOverlay(); toast("Key removed"); };
  $("#kClose").onclick = closeOverlay;
}
$("#overlay").addEventListener("click", e => { if (e.target.id === "overlay") closeOverlay(); });
$("#btnBackup").onclick = openBackup;
if (MODE === "web") { $("#btnKey").hidden = false; $("#btnKey").onclick = openKey; }

function loadExample(){
  const titles = ["Course overview","Linear regression","Gradient descent","Cost functions","Feature scaling","Logistic regression","Regularization","Neural networks: intuition","Forward propagation","Backpropagation","Training tips","Bias and variance","Decision trees","Ensembles","K-means clustering","Anomaly detection","Recommender systems","Wrap-up"];
  const durs = [612,1480,1725,1190,860,1630,1402,1810,1545,2105,980,1320,1660,1270,1390,1150,1745,540];
  const p = hydrate({ id: uid(), title: "Example: ML course (delete when you add your own)", url: "", source: "manual", videos: titles.map((t,i)=>[t, durs[i], ""]) });
  p.settings = Object.assign(defaultSettings(), { speed: 1.5, minutesPerDay: 45, startDate: addDays(todayIso(), -3) });
  allocate(p, p.settings.startDate, false);
  p.plan.filter(d => d.date < todayIso()).slice(0,2).forEach(d => d.items.forEach(i => p.doneSet.add(i)));
  S.list.push(p); S.sel = p.id; S.draft = null; persist(p); render(); afterRender();
}

/* ---------- boot ---------- */
loadLocal();
if (MODE === "web") { try { const q = new URLSearchParams(location.search); const u = q.get("list") ? "https://www.youtube.com/playlist?list=" + q.get("list") : q.get("url"); if (u && playlistIdFrom(u)) { S.sel = "__new"; S.draft = null; render(); S.draft.url = u; S.draft.forClaude = q.get("for") === "claude"; render(); setTimeout(doFetch, 50); history.replaceState(null, "", location.pathname); } } catch(e){} }
render(); afterRender();
if (MODE === "web") setSaveState("Saved in this browser");
connectDb().then(afterRender);
