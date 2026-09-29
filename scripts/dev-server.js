// Local development server: serves the static app and runs the /api/playlist
// function the same way Vercel does. No dependencies, Node 18+.
//
//   npm run dev        ->  http://localhost:3000
//   PORT=8080 npm run dev

const http = require("http");
const fs = require("fs");
const path = require("path");
const playlist = require("../api/playlist.js");

const ROOT = path.join(__dirname, "..");
const PORT = Number(process.env.PORT) || 3000;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };

// Minimal Vercel-style req/res helpers for the API function
function vercelify(req, res, url) {
  req.query = Object.fromEntries(url.searchParams);
  res.status = code => { res.statusCode = code; return res; };
  res.json = body => { if (!res.getHeader("Content-Type")) res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(body)); return res; };
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/api/playlist") {
    vercelify(req, res, url);
    try { await playlist(req, res); }
    catch (e) { res.status(500).json({ error: "SERVER", message: e.message }); }
    return;
  }
  const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT) || rel.startsWith("api/") || rel.startsWith("scripts/")) { res.statusCode = 404; return res.end("Not found"); }
  fs.readFile(file, (err, data) => {
    if (err) { res.statusCode = 404; return res.end("Not found"); }
    res.setHeader("Content-Type", TYPES[path.extname(file)] || "application/octet-stream");
    res.end(data);
  });
}).listen(PORT, () => console.log(`Playlist Progress Tracker running at http://localhost:${PORT}`));
