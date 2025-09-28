// server.js
import express from 'express';
import multer from 'multer';
import { Dropbox } from 'dropbox';
import fetch from 'node-fetch';
import cors from 'cors';
import axios from 'axios';
import crypto from 'crypto';

const app = express();
const port = process.env.PORT || 3000;

// ---------- KONFIGURATION ----------
const CLIENT_ID = process.env.DROPBOX_CLIENT_ID || '1w0y4rdnuvbe476';
const CLIENT_SECRET = process.env.DROPBOX_CLIENT_SECRET || 'je5paqlcai1vxhc';
const REFRESH_TOKEN = process.env.DROPBOX_REFRESH_TOKEN || 'L4N3aNJBnM8AAAAAAAAAAX9jprkmTjHaduGuaKzGxtnODQ5UhEzEUIvgUFXQ3uop';
const IMGBB_API_KEY = process.env.IMGBB_API_KEY || '3387d665ebe211402c5ae8166b27c6ae';

// Middlewares
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));

const upload = multer({ storage: multer.memoryStorage() });

// Interner Zustand
let ACCESS_TOKEN = null;
let dbx = null;
const metaCache = new Map();

// ----------------- Hilfsfunktionen -----------------
function sanitizeFilename(name) {
  return name.replace(/[^\w\d_\-\.() ]/g, '_').slice(0, 200);
}

function createDropboxClient(token) {
  dbx = new Dropbox({ accessToken: token, fetch });
}

function generateId() {
  return crypto
    .randomBytes(16)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
    .slice(0, 22);
}

// Token refresh
async function refreshAccessToken() {
  if (!REFRESH_TOKEN) {
    console.warn('Kein gültiger REFRESH_TOKEN gesetzt.');
    return;
  }
  try {
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: REFRESH_TOKEN,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET
    });
    const resp = await axios.post('https://api.dropbox.com/oauth2/token', params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    ACCESS_TOKEN = resp.data.access_token;
    createDropboxClient(ACCESS_TOKEN);
    console.log('Access token refreshed.');
  } catch (e) {
    console.error('Token refresh failed', e);
  }
}

// Load all meta files
async function loadMetaCache() {
  metaCache.clear();
  if (!dbx) return;

  try {
    const listRes = await dbx.filesListFolder({ path: '/meta' }).catch(() => ({ result: { entries: [] } }));
    const entries = listRes.result.entries || [];

    await Promise.all(entries.map(async e => {
      try {
        const tl = await dbx.filesGetTemporaryLink({ path: e.path_lower });
        const r = await fetch(tl.result.link);
        if (!r.ok) return;
        const json = await r.json();
        if (json && json.id) metaCache.set(json.id, { ...json, metaPath: e.path_lower });
      } catch (err) {
        console.warn('Failed to load meta', e.path_display, err.message);
      }
    }));
    console.log(`Meta cache loaded: ${metaCache.size} entries.`);
  } catch (err) {
    console.error('Error loading meta cache', err);
  }
}

async function findMetaById(id) {
  if (metaCache.has(id)) return metaCache.get(id);
  await loadMetaCache();
  return metaCache.get(id) || null;
}

// Resolve path/id
async function resolveIdOrPath({ id, path }) {
  if (!id && !path) throw new Error('id or path required');
  if (path && path.startsWith('/')) return { path, meta: null };
  if (path && /^[A-Za-z0-9\-_]{12,32}$/.test(path)) id = path, path = undefined;
  if (id) {
    const meta = await findMetaById(id);
    if (!meta) throw new Error('Meta not found');
    return { path: meta.path, meta };
  }
  if (path) return { path: path.startsWith('/') ? path : `/${path}`, meta: null };
  throw new Error('Could not resolve id/path');
}

// ----------------- ImgBB Upload -----------------
async function uploadToImgBB(base64) {
  const params = new URLSearchParams();
  params.append('key', IMGBB_API_KEY);
  params.append('image', base64.replace(/^data:image\/\w+;base64,/, ''));
  const res = await fetch('https://api.imgbb.com/1/upload', { method: 'POST', body: params });
  if (!res.ok) throw new Error('ImgBB upload failed: ' + res.status);
  const j = await res.json();
  return j.data.url;
}

// ----------------- Endpoints -----------------
app.get('/', (req, res) => res.send('Audionix backend running.'));

// Upload song + cover
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!dbx || !ACCESS_TOKEN) return res.status(503).json({ error: 'Dropbox not initialized.' });
    const mp3 = req.file;
    const { coverBase64, songName, artist } = req.body || {};
    if (!mp3) return res.status(400).json({ error: 'No file uploaded' });
    if (!coverBase64 || !songName || !artist) return res.status(400).json({ error: 'coverBase64, songName, artist required' });

    const id = generateId();
    const safeMp3Name = `${id}_${sanitizeFilename(mp3.originalname)}`;
    const mp3Path = `/songs/${safeMp3Name}`;

    // Upload MP3
    await dbx.filesUpload({ path: mp3Path, contents: mp3.buffer, mode: 'add', autorename: true });

    // Cover zu ImgBB
    const coverLink = await uploadToImgBB(coverBase64);

    const metadata = {
      id,
      songName,
      artist,
      path: mp3Path,
      coverLink,
      uploadedAt: new Date().toISOString()
    };

    const metaFilename = `/meta/${Date.now()}_${sanitizeFilename(songName)}.json`;
    await dbx.filesUpload({
      path: metaFilename,
      contents: Buffer.from(JSON.stringify(metadata, null, 2), 'utf8'),
      mode: 'add',
      autorename: true
    });

    metaCache.set(id, { ...metadata, metaPath: metaFilename });
    return res.json({ success: true, ...metadata });
  } catch (e) {
    console.error('Upload failed', e);
    return res.status(500).json({ error: String(e) });
  }
});

// Parse songs
app.get('/parse', async (req, res) => {
  try {
    if (metaCache.size === 0) await loadMetaCache();
    const songs = [];
    for (const [, m] of metaCache) {
      songs.push({
        id: m.id,
        songName: m.songName || 'Unknown',
        artist: m.artist || 'Unknown',
        uploadedAt: m.uploadedAt,
        coverLink: m.coverLink || null
      });
    }
    res.json({ songs });
  } catch (e) {
    console.error('Parse failed', e);
    res.status(500).json({ error: String(e) });
  }
});

// Temp-link
app.get('/temp-link', async (req, res) => {
  try {
    const { id, path } = req.query;
    if (!id && !path) return res.status(400).json({ error: 'id or path required' });
    const resolved = await resolveIdOrPath({ id, path });
    const tl = await dbx.filesGetTemporaryLink({ path: resolved.path });
    res.json({ link: tl.result.link, id: id || resolved.meta?.id });
  } catch (e) {
    console.error('Temp-link failed', e);
    res.status(500).json({ error: String(e) });
  }
});

// Download
app.get('/download', async (req, res) => {
  try {
    const { id, path } = req.query;
    if (!id && !path) return res.status(400).json({ error: 'id or path required' });
    const resolved = await resolveIdOrPath({ id, path });
    const tl = await dbx.filesGetTemporaryLink({ path: resolved.path });
    const r = await fetch(tl.result.link);
    if (!r.ok) return res.status(502).json({ error: 'Failed to fetch file' });
    res.setHeader('content-type', r.headers.get('content-type') || 'audio/mpeg');
    r.body.pipe(res);
  } catch (e) {
    console.error('Download failed', e);
    res.status(500).json({ error: String(e) });
  }
});

// Change metadata
app.route('/change')
  .get(async (req, res) => {
    try {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'id required' });
      const meta = await findMetaById(id);
      if (!meta) return res.status(404).json({ error: 'Not found' });
      res.json({ metadata: meta });
    } catch (e) {
      console.error('Change GET failed', e);
      res.status(500).json({ error: String(e) });
    }
  })
  .post(async (req, res) => {
    try {
      const { id, songName, artist, coverBase64 } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id required' });
      const meta = await findMetaById(id);
      if (!meta) return res.status(404).json({ error: 'Not found' });

      let coverLink = meta.coverLink;
      if (coverBase64) coverLink = await uploadToImgBB(coverBase64);

      const updated = { ...meta, songName: songName || meta.songName, artist: artist || meta.artist, coverLink };
      await dbx.filesUpload({ path: meta.metaPath, contents: Buffer.from(JSON.stringify(updated, null, 2), 'utf8'), mode: { '.tag': 'overwrite' } });
      metaCache.set(id, updated);
      res.json({ success: true, metadata: updated });
    } catch (e) {
      console.error('Change POST failed', e);
      res.status(500).json({ error: String(e) });
    }
  });

// Start server
(async () => {
  await refreshAccessToken();
  setInterval(refreshAccessToken, 12600 * 1000);
  await loadMetaCache();

  app.listen(port, () => console.log(`Server running at http://localhost:${port}`));
})();
