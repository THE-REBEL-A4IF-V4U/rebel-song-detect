// server.js
// Render-ready Song Detect API (Upload + URL, YouTube via nayan ytdown, Shazam via RapidAPI)

const express = require("express");
const multer = require("multer");
const axios = require("axios");
const fs = require("fs-extra");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ dest: "uploads/" });

// Middleware
app.set("trust proxy", 1);
app.use(rateLimit({ windowMs: 10 * 60 * 1000, max: 1000 }));
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// helper
function safeUnlink(file) {
  try { if (file && fs.existsSync(file)) fs.unlinkSync(file); } catch (e) {}
}

// Keys (try environment first)
const KEYS = {
  RAPIDAPI_KEY: process.env.RAPIDAPI_KEY || null
};

// Basic health
app.get("/", (req, res) => res.send("REBEL Song-Detect API is up"));

// --- Media endpoint ---
// Normalizes downloader outputs (YouTube via nayan ytdown, TikTok, Facebook)
app.get("/media", async (req, res) => {
  try {
    const url = (req.query.url || "").trim();
    if (!url) return res.status(400).json({ success: false, error: "Missing ?url parameter" });

    let result = {};

    // YouTube -> nayan ytdown
    if (url.includes("youtube.com") || url.includes("youtu.be")) {
      const r = await axios.get("https://nayan-video-downloader.vercel.app/ytdown", { params: { url } });
      const d = r.data;
      const data = d?.data || d;
      result = {
        audio: data?.audio || data?.audios?.[0]?.url || null,
        video: data?.video || data?.videos?.[0]?.url || data?.result?.video || null,
        title: data?.title || data?.result?.title || null,
        raw: d
      };
    }

    // TikTok -> tikwm
    else if (url.includes("tiktok.com")) {
      const r = await axios.get("https://tikwm.com/api", { params: { url, hd: 1 } });
      const d = r.data;
      if (!d || d.code !== 0) return res.status(400).json({ success:false, error:"Failed to fetch TikTok info" });
      result = {
        audio: d.data?.music || null,
        video: d.data?.play || null,
        title: d.data?.title || null,
        raw: d
      };
    }

    // Facebook -> try fdown.net scraping
    else if (url.includes("facebook.com") || url.includes("fb.watch")) {
      const form = new URLSearchParams();
      form.append("URLz", url);
      const r = await axios.post("https://fdown.net/download.php", form.toString(), {
        headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: "https://fdown.net/", "User-Agent":"Mozilla/5.0" }
      });
      const html = String(r.data || "");
      const matches = Array.from(html.matchAll(/href="(https?:\/\/[^"]+\.mp4[^"]*)"/gi)).map(m=>m[1]);
      result = {
        audio: null,
        video: matches[0] || null,
        title: null,
        raw: html
      };
    }

    // unsupported
    else {
      return res.status(400).json({ success: false, error: "Unsupported URL or platform" });
    }

    res.json({ success: true, result });
  } catch (err) {
    console.error("Media error:", err.response?.data || err.message || err);
    res.status(500).json({ success:false, error: err.response?.data || err.message || "Internal error" });
  }
});

// --- Song Detect (Upload + URL) ---
app.post("/song-detect", upload.single("file"), async (req, res) => {
  let tempFile = null;
  try {
    let sourceFile = null;

    // 1) File upload
    if (req.file) {
      sourceFile = req.file.path;
    }

    // 2) URL provided
    else if (req.body.url) {
      const mediaUrl = String(req.body.url || "").trim();
      if (!mediaUrl) return res.status(400).json({ success:false, error:"Empty url" });

      let mediaResp;
      try {
        if (mediaUrl.includes("youtube.com") || mediaUrl.includes("youtu.be")) {
          mediaResp = await axios.get("https://nayan-video-downloader.vercel.app/ytdown", { params: { url: mediaUrl } });
        } else {
          mediaResp = await axios.get(`${req.protocol}://${req.get("host")}/media`, { params: { url: mediaUrl } });
        }
      } catch (fetchErr) {
        return res.status(400).json({ success:false, error:"Failed to fetch media", details: fetchErr.message });
      }

      const md = mediaResp.data;
      const downloadUrl = md?.result?.audio || md?.result?.video || md?.data?.audio || md?.data?.video || md?.data?.url || md?.result?.url || null;
      if (!downloadUrl) return res.status(404).json({ success:false, error:"No downloadable audio/video found." });

      // ensure uploads
      const uploadDir = path.join(__dirname, "uploads");
      fs.ensureDirSync(uploadDir);

      tempFile = path.join(uploadDir, `song_${Date.now()}.mp3`);
      const resp = await axios.get(downloadUrl, { responseType: "arraybuffer", timeout: 60_000 });
      fs.writeFileSync(tempFile, Buffer.from(resp.data));
      sourceFile = tempFile;
    }

    // nothing provided
    else {
      return res.status(400).json({ success:false, error:"Upload a file or provide url in 'url' field." });
    }

    // file size check (safety)
    const stat = fs.statSync(sourceFile);
    const maxBytes = 8 * 1024 * 1024; // 8 MB
    if (stat.size > maxBytes) { safeUnlink(tempFile); return res.status(413).json({ success:false, error:"File too large (limit 8MB)" }); }

    // read & base64
    const audioBase64 = fs.readFileSync(sourceFile, { encoding: "base64" });

    // RAPIDAPI_KEY check (environment)
    if (!KEYS.RAPIDAPI_KEY && !process.env.RAPIDAPI_KEY) { safeUnlink(tempFile); return res.status(500).json({ success:false, error:"RAPIDAPI_KEY not configured" }); }
    const rapidKey = KEYS.RAPIDAPI_KEY || process.env.RAPIDAPI_KEY;

    // call Shazam
    const shazamResp = await axios.request({
      method: "POST",
      url: "https://shazam-core.p.rapidapi.com/v1/tracks/detect",
      headers: {
        "content-type": "application/json",
        "X-RapidAPI-Key": rapidKey,
        "X-RapidAPI-Host": "shazam-core.p.rapidapi.com"
      },
      data: { audio: audioBase64 },
      timeout: 60_000
    });

    safeUnlink(tempFile);
    return res.json({ success:true, detected: shazamResp.data });
  } catch (err) {
    safeUnlink(tempFile);
    console.error("Song detect error:", err.response?.data || err.message || err);
    return res.status(500).json({ success:false, error: err.response?.data || err.message || String(err) });
  }
});

// Start
app.listen(PORT, () => {
  console.log(`✅ REBEL Song-Detect API running on port ${PORT}`);
});
