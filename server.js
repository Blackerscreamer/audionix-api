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

// Middlewares
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));
const upload = multer({ storage: multer.memoryStorage() });

// Interner Zustand
let ACCESS_TOKEN = null;
let dbx = null;
const metaCache = new Map();

// ---------- Hilfsfunktionen ----------
function sanitizeFilename(name) {
  return name.replace(/[^\w\d_\-\.() ]/g, '_').slice(0, 200);
}

function createDropboxClient(token) {
  dbx = new Dropbox({ accessToken: token, fetch });
}

function generateId() {
  return crypto.randomBytes(16).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 22);
}

async function refreshAccessToken() {
  try {
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: REFRESH_TOKEN,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET
    });

    const response = await axios.post('https://api.dropbox.com/oauth2/token', params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    const token = response.data.access_token;
    ACCESS_TOKEN = token;
    createDropboxClient(ACCESS_TOKEN);

    console.log('Neuer Access Token erhalten.');
  } catch (err) {
    console.error('Fehler beim Refreshen des Tokens:', err?.response?.data || err.message);
  }
}

async function loadMetaCache() {
  metaCache.clear();
  if (!dbx) return;

  try {
    const listRes = await dbx.filesListFolder({ path: '/meta' }).catch(() => ({ result: { entries: [] } }));
    const entries = listRes?.result?.entries || [];

    await Promise.all(entries.map(async (e) => {
      try {
        const tl = await dbx.filesGetTemporaryLink({ path: e.path_lower });
        const r = await fetch(tl?.result?.link);
        if (!r.ok) return;
        const json = await r.json();

        if (json?.id) {
          metaCache.set(json.id, { ...json, metaPath: e.path_lower });
        }
      } catch (err) {
        console.warn('Fehler beim Laden einer meta-Datei:', e.path_display, err.message);
      }
    }));
    console.log(`Meta-Cache geladen: ${metaCache.size} Einträge.`);
  } catch (err) {
    console.error('Fehler beim Auflisten/Laden von /meta:', err.message);
  }
}

async function findMetaById(id) {
  if (metaCache.has(id)) return metaCache.get(id);
  await loadMetaCache();
  return metaCache.get(id) || null;
}

async function resolveIdOrPath({ id, path }) {
  if (!id && !path) throw new Error('Weder id noch path angegeben');
  if (path && path.startsWith('/')) return { path, meta: null };
  if (path && /^[A-Za-z0-9\-_]{12,32}$/.test(path)) { id = path; path = undefined; }

  if (id) {
    const meta = await findMetaById(id);
    if (!meta) throw new Error('Keine Metadatei zu dieser id gefunden');
    return { path: meta.path, meta };
  }
  return { path: `/${path}`, meta: null };
}

// ---------- Migration: Base64 -> Datei ----------
async function migrateBase64Covers() {
  for (const [id, meta] of metaCache) {
    if (meta.coverBase64 && !meta.coverPath) {
      try {
        const buffer = Buffer.from(meta.coverBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
        const coverPath = `/covers/${id}_cover.jpg`;

        await dbx.filesUpload({
          path: coverPath,
          contents: buffer,
          mode: { '.tag': 'overwrite' }
        });

        const updatedMeta = { ...meta, coverPath, coverBase64: undefined };
        await dbx.filesUpload({
          path: meta.metaPath,
          contents: Buffer.from(JSON.stringify(updatedMeta, null, 2), 'utf8'),
          mode: { '.tag': 'overwrite' }
        });

        metaCache.set(id, updatedMeta);
        console.log(`Migrated cover for ${id}`);
      } catch (err) {
        console.warn(`Migration failed for ${id}:`, err.message);
      }
    }
  }
}

// ---------- Server start ----------
(async () => {
  await refreshAccessToken();
  setInterval(refreshAccessToken, 3.5 * 60 * 60 * 1000);
  await loadMetaCache();
  await migrateBase64Covers();

  // ---------- ENDPOINTS ----------
  app.get('/', (req, res) => res.send('Audionix backend running.'));

  // GET/POST change
  app.route('/change')
    .get(async (req, res) => {
      const { id } = req.query;
      const meta = await findMetaById(id);
      if (!meta) return res.status(404).json({ error: 'Song nicht gefunden' });
      res.json({ metadata: meta });
    })
    .post(async (req, res) => {
      try {
        const { id, songName, artist, coverBase64 } = req.body;
        const meta = await findMetaById(id);
        if (!meta) return res.status(404).json({ error: 'Song nicht gefunden' });

        let coverPath = meta.coverPath;
        if (coverBase64) {
          const buffer = Buffer.from(coverBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
          coverPath = `/covers/${id}_cover.jpg`;
          await dbx.filesUpload({ path: coverPath, contents: buffer, mode: { '.tag': 'overwrite' } });
        }

        const updatedMeta = {
          ...meta,
          songName: songName ?? meta.songName,
          artist: artist ?? meta.artist,
          coverPath
        };

        await dbx.filesUpload({
          path: meta.metaPath,
          contents: Buffer.from(JSON.stringify(updatedMeta, null, 2), 'utf8'),
          mode: { '.tag': 'overwrite' }
        });

        metaCache.set(id, updatedMeta);
        res.json({ success: true, metadata: updatedMeta });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

  // Upload
  app.post('/upload', upload.single('file'), async (req, res) => {
    try {
      const mp3 = req.file;
      const { coverBase64, songName, artist } = req.body;
      if (!mp3 || !coverBase64 || !songName || !artist) {
        return res.status(400).json({ error: 'MP3, Cover, Songname, Artist erforderlich' });
      }

      const id = generateId();
      const safeName = sanitizeFilename(mp3.originalname);
      const mp3Path = `/songs/${id}_${safeName}`;

      await dbx.filesUpload({ path: mp3Path, contents: mp3.buffer, mode: 'add', autorename: true });

      const coverBuffer = Buffer.from(coverBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
      const coverPath = `/covers/${id}_cover.jpg`;
      await dbx.filesUpload({ path: coverPath, contents: coverBuffer, mode: 'add', autorename: true });

      const metadata = {
        id, songName, artist,
        path: mp3Path,
        coverPath,
        uploadedAt: new Date().toISOString()
      };

      const metaPath = `/meta/${Date.now()}_${sanitizeFilename(songName)}.json`;
      await dbx.filesUpload({
        path: metaPath,
        contents: Buffer.from(JSON.stringify(metadata, null, 2), 'utf8'),
        mode: 'add',
        autorename: true
      });

      metaCache.set(id, { ...metadata, metaPath });
      res.json({ success: true, id, metadata });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Parse
  app.get('/parse', async (req, res) => {
    if (metaCache.size === 0) await loadMetaCache();
    const songs = [...metaCache.values()].map(m => ({
      id: m.id,
      songName: m.songName,
      artist: m.artist,
      uploadedAt: m.uploadedAt,
      coverPath: m.coverPath
    }));
    res.json({ songs });
  });

  // Temp-link (mp3 oder cover)
  app.get('/temp-link', async (req, res) => {
    try {
      const { id, path, type } = req.query;
      let resolved;
      if (id) {
        const meta = await findMetaById(id);
        if (!meta) return res.status(404).json({ error: 'Song nicht gefunden' });
        const filePath = type === 'cover' ? meta.coverPath : meta.path;
        resolved = { path: filePath, meta };
      } else {
        resolved = await resolveIdOrPath({ path });
      }

      const tl = await dbx.filesGetTemporaryLink({ path: resolved.path });
      res.json({ link: tl.result.link, id: id || null });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // start server
  app.listen(port, () => console.log(`Server läuft auf http://localhost:${port}`));
})();
