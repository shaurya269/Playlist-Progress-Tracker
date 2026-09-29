// GET /api/playlist?id=<playlistId>[&key=<userKey>]
// Returns { title, channel, videos: [[title, seconds, videoId], ...], skipped, source }
// Works with no setup: reads the public playlist page directly from YouTube.
// If a YouTube Data API key is available (YOUTUBE_API_KEY env var or ?key=), it is tried first.

const API = "https://www.googleapis.com/youtube/v3/";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function isoToSeconds(iso) {
  const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || "");
  if (!m) return 0;
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}
function clockToSeconds(t) {
  if (!/^\d+(:\d{1,2}){1,2}$/.test(t || "")) return 0;
  return t.split(":").reduce((a, x) => a * 60 + Number(x), 0);
}
const text = t => !t ? "" : typeof t === "string" ? t : t.simpleText || t.content || (t.runs || []).map(r => r.text).join("");

/* ---------- with an API key ---------- */
async function viaApi(id, key) {
  const get = async (path, params) => {
    const u = new URL(API + path);
    for (const [k, v] of Object.entries(params)) if (v !== "" && v != null) u.searchParams.set(k, v);
    u.searchParams.set("key", key);
    const r = await fetch(u);
    const j = await r.json();
    if (!r.ok) throw new Error((j.error && j.error.message) || "YouTube API error " + r.status);
    return j;
  };
  const pl = await get("playlists", { part: "snippet", id });
  if (!pl.items || !pl.items.length) { const e = new Error("Playlist not found. It may be private."); e.code = 404; throw e; }
  const sn = pl.items[0].snippet;
  const ids = [];
  let pageToken = "";
  do {
    const j = await get("playlistItems", { part: "contentDetails", maxResults: 50, playlistId: id, pageToken });
    for (const it of j.items || []) ids.push(it.contentDetails.videoId);
    pageToken = j.nextPageToken || "";
  } while (pageToken && ids.length < 5000);
  const batches = [];
  for (let i = 0; i < ids.length; i += 50) batches.push(ids.slice(i, i + 50));
  const info = {};
  await Promise.all(batches.map(async b => {
    const j = await get("videos", { part: "contentDetails,snippet", id: b.join(","), maxResults: 50 });
    for (const v of j.items || []) info[v.id] = [v.snippet.title, isoToSeconds(v.contentDetails.duration)];
  }));
  const videos = ids.filter(v => info[v] && info[v][1] > 0).map(v => [info[v][0], info[v][1], v]);
  return { title: sn.title, channel: sn.channelTitle, videos, skipped: ids.length - videos.length, source: "api" };
}

/* ---------- no key: read the public playlist page ---------- */
function extractInitialData(html) {
  const marks = ["var ytInitialData = ", 'window["ytInitialData"] = '];
  for (const m of marks) {
    const i = html.indexOf(m);
    if (i < 0) continue;
    const start = i + m.length;
    const end = html.indexOf(";</script>", start);
    if (end < 0) continue;
    try { return JSON.parse(html.slice(start, end)); } catch (e) {}
  }
  return null;
}
function walk(node, out) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const x of node) walk(x, out); return; }
  if (node.playlistVideoRenderer) {
    const v = node.playlistVideoRenderer;
    const secs = Number(v.lengthSeconds) || clockToSeconds(text(v.lengthText));
    out.items.push({ id: v.videoId, title: text(v.title), secs, playable: v.isPlayable !== false });
    return;
  }
  if (node.playlistPanelVideoRenderer) {
    const v = node.playlistPanelVideoRenderer;
    out.items.push({ id: v.videoId, title: text(v.title), secs: clockToSeconds(text(v.lengthText)), playable: !v.unplayableText, index: parseInt(text(v.indexText)) || 0 });
    return;
  }
  if (node.lockupViewModel && node.lockupViewModel.contentId) {
    const l = node.lockupViewModel;
    let secs = 0;
    JSON.stringify(l).replace(/"text":"(\d+(?::\d{1,2}){1,2})"/g, (_, t) => { if (!secs) secs = clockToSeconds(t); return _; });
    const title = text(l.metadata && l.metadata.lockupMetadataViewModel && l.metadata.lockupMetadataViewModel.title);
    out.items.push({ id: l.contentId, title, secs, playable: true });
    return;
  }
  if (node.continuationItemRenderer) {
    const s = JSON.stringify(node.continuationItemRenderer);
    const m = s.match(/"continuationCommand":\{"token":"([^"]+)"/) || s.match(/"token":"([^"]+)"/);
    if (m) out.token = m[1];
    return;
  }
  for (const k in node) walk(node[k], out);
}
function findChannel(data) {
  try {
    const s = JSON.stringify(data.header || {}) + JSON.stringify(data.sidebar || {});
    const m = s.match(/"(?:videoOwnerRenderer|ownerText|shortBylineText)".*?"text":"([^"]+)"/);
    if (m) return m[1].replace(/^by\s+/i, "");
    const m2 = s.match(/"text":"by ([^"]+)"/);
    return m2 ? m2[1] : "";
  } catch (e) { return ""; }
}
function findTotal(data) {
  const s = JSON.stringify(data.header || {}) + JSON.stringify(data.sidebar || {});
  const m = s.match(/"(\d[\d,]*) videos?"/) || s.match(/"text":"(\d[\d,]*)"\},\{"text":" videos?"/) || s.match(/(\d[\d,]*) videos?/);
  return m ? parseInt(m[1].replace(/,/g, "")) : 0;
}
const cfg = (html, k) => (html.match(new RegExp('"' + k + '":"([^"]+)"')) || [])[1];
const uniq = items => { const seen = new Set(); return items.filter(v => v.id && !seen.has(v.id) && seen.add(v.id)); };

async function viaPage(id, debug) {
  const baseHeaders = { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", "Cookie": "CONSENT=YES+cb; SOCS=CAI" };
  const r = await fetch("https://www.youtube.com/playlist?list=" + encodeURIComponent(id) + "&hl=en&gl=US", { headers: baseHeaders });
  if (!r.ok) throw new Error("YouTube returned " + r.status);
  const html = await r.text();
  const data = extractInitialData(html);
  if (!data) throw new Error("Couldn't read the playlist page.");
  const alert = JSON.stringify(data.alerts || "");
  const meta = data.metadata && data.metadata.playlistMetadataRenderer;
  let title = meta ? meta.title : "";
  if (!title) { const m = JSON.stringify(data.header || {}).match(/"title":\{(?:"simpleText"|"content"|"runs":\[\{"text")\s*:\s*"([^"]+)"/); title = m ? m[1] : ""; }
  const total = findTotal(data);
  const out = { items: [], token: null };
  walk(data.contents, out);
  debug.firstPage = out.items.length; debug.total = total; debug.hasToken = !!out.token;
  if (!out.items.length && !title) {
    const e = new Error(/private|does not exist|unavailable/i.test(alert) ? "This playlist is private or doesn't exist." : "Playlist not found. It may be private.");
    e.code = 404; throw e;
  }

  // 1) Continuation pages through YouTube's own browse endpoint
  const apiKey = cfg(html, "INNERTUBE_API_KEY");
  const clientVersion = cfg(html, "INNERTUBE_CLIENT_VERSION") || "2.20250101.00.00";
  const visitorData = cfg(html, "VISITOR_DATA");
  let guard = 0; debug.pages = [];
  while (out.token && guard++ < 80) {
    const token = out.token; out.token = null;
    const before = out.items.length;
    let ok = false;
    for (const url of [
      "https://www.youtube.com/youtubei/v1/browse?prettyPrint=false" + (apiKey ? "&key=" + apiKey : ""),
      "https://www.youtube.com/youtubei/v1/browse?prettyPrint=false"
    ]) {
      try {
        const cr = await fetch(url, {
          method: "POST",
          headers: Object.assign({}, baseHeaders, {
            "Content-Type": "application/json", "Origin": "https://www.youtube.com", "Referer": "https://www.youtube.com/playlist?list=" + id,
            "X-YouTube-Client-Name": "1", "X-YouTube-Client-Version": clientVersion
          }, visitorData ? { "X-Goog-Visitor-Id": visitorData } : {}),
          body: JSON.stringify({ context: { client: Object.assign({ clientName: "WEB", clientVersion, hl: "en", gl: "US" }, visitorData ? { visitorData } : {}) }, continuation: token })
        });
        debug.pages.push(cr.status);
        if (!cr.ok) continue;
        const cj = await cr.json();
        walk(cj.onResponseReceivedActions || cj.continuationContents || cj, out);
        ok = out.items.length > before || !!out.token;
        if (ok) break;
      } catch (e) { debug.pages.push("err:" + e.message); }
    }
    if (!ok) break;
  }

  // 2) Fallback: page through the watch-page playlist panel (about 200 videos per window)
  let items = uniq(out.items);
  if (total && items.length < total && items.length) {
    debug.panel = [];
    let tries = 0;
    while (items.length < total && tries++ < 40) {
      const last = items[items.length - 1];
      const u = "https://www.youtube.com/watch?v=" + encodeURIComponent(last.id) + "&list=" + encodeURIComponent(id) + "&index=" + items.length + "&hl=en&gl=US";
      const wr = await fetch(u, { headers: baseHeaders });
      if (!wr.ok) { debug.panel.push(wr.status); break; }
      const wd = extractInitialData(await wr.text());
      if (!wd) { debug.panel.push("nodata"); break; }
      const po = { items: [], token: null };
      walk(wd.contents && wd.contents.twoColumnWatchNextResults && wd.contents.twoColumnWatchNextResults.playlist, po);
      const have = new Set(items.map(v => v.id));
      const fresh = po.items.filter(v => v.id && !have.has(v.id));
      debug.panel.push(fresh.length);
      if (!fresh.length) break;
      // keep playlist order: panel items carry their index
      items = uniq(items.concat(fresh.sort((a, b) => (a.index || 0) - (b.index || 0))));
    }
  }

  const videos = items.filter(v => v.secs > 0 && v.playable).map(v => [v.title, v.secs, v.id]);
  return { title: title || "YouTube playlist", channel: findChannel(data), videos, skipped: items.length - videos.length,
    total: total || items.length, partial: !!(total && items.length < total - 2), source: "page" };
}

module.exports = async (req, res) => {
  const id = String(req.query.id || "").trim();
  const key = String(req.query.key || "").trim() || process.env.YOUTUBE_API_KEY;
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (!/^[\w-]{10,}$/.test(id)) return res.status(400).json({ error: "BAD_ID", message: "That doesn't look like a playlist link." });

  const debug = {};
  let result = null, firstErr = null;
  if (key) { try { result = await viaApi(id, key); } catch (e) { firstErr = e; debug.apiError = e.message; } }
  if (!result) { try { result = await viaPage(id, debug); } catch (e) { firstErr = firstErr && firstErr.code === 404 ? firstErr : e; } }
  if (!result) return res.status(firstErr && firstErr.code === 404 ? 404 : 502).json({ error: "YOUTUBE", message: firstErr ? firstErr.message : "Couldn't load the playlist." });
  if (!result.videos.length) return res.status(404).json({ error: "EMPTY", message: "No playable videos found in this playlist." });

  if (req.query.debug) result.debug = debug;
  res.setHeader("Cache-Control", result.partial || req.query.debug ? "no-store" : "s-maxage=1800, stale-while-revalidate=86400");
  return res.status(200).json(result);
};
