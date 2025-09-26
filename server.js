// server.js
// Song Detect API (Upload + URL) with Debug Logs (Render-ready)

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

// Helper: Safe delete
function safeUnlink(file) {
  try { if (file && fs.existsSync(file)) fs.unlinkSync(file); } catch {}
}

// Key check
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
if (!RAPIDAPI_KEY) {
  console.warn("⚠️ RAPIDAPI_KEY not set in environment (.env on local or Render Environment Variables).");
}

// Health route
app.get("/", (req, res) => {
  res.send("✅ REBEL Song-Detect API is running!");
});

// --- Song Detect API ---
app.post("/song-detect", upload.single("file"), async (req, res) => {
  let tempFile = null;
  try {
    let sourceFile = null;

    // Case 1: File Upload
    if (req.file) {
      console.log("📂 File received:", req.file.originalname, req.file.size + " bytes", req.file.mimetype);
      sourceFile = req.file.path;
    }

    // Case 2: URL Provided
    else if (req.body.url) {
      const mediaUrl = String(req.body.url || "").trim();
      if (!mediaUrl) return res.status(400).json({ success: false, error: "Empty url" });

      console.log("🌍 URL received:", mediaUrl);

      // For YouTube use external API
      let mediaResp;
      if (mediaUrl.includes("youtube.com") || mediaUrl.includes("youtu.be")) {
        mediaResp = await axios.get("https://nayan-video-downloader.vercel.app/ytdown", {
          params: { url: mediaUrl }
        });
      } else {
        return res.status(400).json({ success: false, error: "Only YouTube supported right now" });
      }

      const md = mediaResp.data;
      console.log("🔗 MediaResp keys:", Object.keys(md));

      const downloadUrl =
        md?.data?.audio || md?.data?.video || md?.data?.url ||
        md?.result?.audio || md?.result?.video || md?.result?.url || null;

      if (!downloadUrl) {
        return res.status(404).json({ success: false, error: "No downloadable audio/video found" });
      }

      console.log("⬇️ Downloading from:", downloadUrl);

      const uploadDir = path.join(__dirname, "uploads");
      fs.ensureDirSync(uploadDir);

      tempFile = path.join(uploadDir, `song_${Date.now()}.mp3`);
      const resp = await axios.get(downloadUrl, { responseType: "arraybuffer", timeout: 60_000 });
      fs.writeFileSync(tempFile, Buffer.from(resp.data));
      sourceFile = tempFile;
    }

    // Nothing provided
    else {
      return res.status(400).json({ success: false, error: "Upload a file or provide url in 'url' field." });
    }

    // File Size Safety
    const stat = fs.statSync(sourceFile);
    console.log("📏 File size:", stat.size, "bytes");
    if (stat.size > 8 * 1024 * 1024) {
      safeUnlink(tempFile);
      return res.status(413).json({ success: false, error: "File too large (limit 8MB)" });
    }

    // Convert to Base64
    const audioBase64 = fs.readFileSync(sourceFile, { encoding: "base64" });
    console.log("🎵 File converted to base64, length:", audioBase64.length);

    // RAPIDAPI check
    if (!RAPIDAPI_KEY) {
      safeUnlink(tempFile);
      return res.status(500).json({ success: false, error: "RAPIDAPI_KEY not configured" });
    }

    // Call Shazam API
    console.log("🚀 Sending to Shazam API...");
    const shazamResp = await axios.request({
      method: "POST",
      url: "https://shazam-core.p.rapidapi.com/v1/tracks/detect",
      headers: {
        "content-type": "application/json",
        "X-RapidAPI-Key": RAPIDAPI_KEY,
        "X-RapidAPI-Host": "shazam-core.p.rapidapi.com"
      },
      data: { audio: audioBase64 },
      timeout: 60_000
    });

    safeUnlink(tempFile);
    console.log("✅ Song detected successfully!");

    return res.json({ success: true, detected: shazamResp.data });
  } catch (err) {
    safeUnlink(tempFile);
    console.error("❌ Song detect error:", err.response?.data || err.message);
    return res.status(500).json({ success: false, error: err.response?.data || err.message });
  }
});

// Start
app.listen(PORT, () => {
  console.log(`🎧 REBEL Song-Detect API running on port ${PORT}`);
});
