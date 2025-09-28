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

// ---------- KONFIGURATION (ersetze durch ENV in Produktion) ----------
const CLIENT_ID = process.env.DROPBOX_CLIENT_ID || '1w0y4rdnuvbe476';
const CLIENT_SECRET = process.env.DROPBOX_CLIENT_SECRET || 'je5paqlcai1vxhc';
const REFRESH_TOKEN = process.env.DROPBOX_REFRESH_TOKEN || 'L4N3aNJBnM8AAAAAAAAAAX9jprkmTjHaduGuaKzGxtnODQ5UhEzEUIvgUFXQ3uop';
// ---------------------------------------------------------------------

// Middlewares
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));
const upload = multer({ storage: multer.memoryStorage() });

// Interner Zustand
let ACCESS_TOKEN = null;
let dbx = null;
const metaCache = new Map(); // id -> metadata (includes metaPath, coverPath)

// ---------- Hilfsfunktionen ----------
function sanitizeFilename(name) {
  return String(name || '')
    .replace(/[^\w\d_\-\.() ]/g, '_')
    .slice(0, 200);
}

function createDropboxClient(token) {
  dbx = new Dropbox({ accessToken: token, fetch });
}

function generateId() {
  return crypto.randomBytes(16).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 22);
}

function cleanBase64Prefix(b64) {
  if (!b64 || typeof b64 !== 'string') return '';
  const s = b64.trim();
  if (s.startsWith('data:image/')) {
    return s.replace(/^data:image\/\w+;base64,/, '');
  }
  return s;
}

// Token automatisch erneuern (refresh_token flow)
async function refreshAccessToken() {
  if (!REFRESH_TOKEN) {
    console.warn('Kein REFRESH_TOKEN gesetzt — Dropbox nicht initialisiert.');
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
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000
    });

    const token = resp.data?.access_token;
    if (!token) throw new Error('Keine access_token in Token-Response');

    ACCESS_TOKEN = token;
    createDropboxClient(ACCESS_TOKEN);
    console.log('Dropbox access token refreshed.');
  } catch (err) {
    console.error('Fehler beim Refreshen des Dropbox-Tokens:', err?.response?.data || err?.message || err);
  }
}

// helper: list all entries for a folder (handles has_more)
async function listAllFolderEntries(folderPath) {
  const entries = [];
  try {
    let res = await dbx.filesListFolder({ path: folderPath }).catch(err => { throw err; });
    entries.push(...(res.result?.entries || []));
    while (res.result?.has_more) {
      res = await dbx.filesListFolderContinue({ cursor: res.result.cursor });
      entries.push(...(res.result?.entries || []));
    }
  } catch (err) {
    // if folder doesn't exist or other error, return empty
    console.warn(`listAllFolderEntries("${folderPath}") error:`, err?.error || err?.message || err);
  }
  return entries;
}

// ---------- Meta-Cache Laden (inkl. coverPath) ----------
async function loadMetaCache() {
  metaCache.clear();
  if (!dbx) {
    console.warn('Dropbox client not initialized — cannot load meta cache.');
    return;
  }

  try {
    const entries = await listAllFolderEntries('/meta');

    await Promise.all(entries.map(async (e) => {
      try {
        // Hole temporären Link und lade JSON
        const tl = await dbx.filesGetTemporaryLink({ path: e.path_lower });
        const link = tl?.result?.link || tl?.link;
        if (!link) return;

        const r = await fetch(link, { timeout: 15000 });
        if (!r.ok) {
          console.warn('Failed to fetch meta JSON:', e.path_lower, r.status);
          return;
        }

        const json = await r.json();
        if (!json?.id) {
          console.warn('Meta JSON ohne id:', e.path_lower);
          return;
        }

        // normalize coverPath if present
        const coverPath = json.coverPath ? String(json.coverPath) : null;

        metaCache.set(String(json.id), {
          ...json,
          metaPath: e.path_lower,
          coverPath
        });
      } catch (err) {
        console.warn('Fehler beim Laden einer meta-Datei:', e.path_display || e.name, err?.message || err);
      }
    }));

    console.log(`Meta-Cache geladen: ${metaCache.size} Einträge.`);
  } catch (err) {
    console.error('Fehler beim Auflisten/Laden von /meta:', err?.response?.data || err?.message || err);
  }
}

async function findMetaById(id) {
  if (!id) return null;
  const sid = String(id);
  if (metaCache.has(sid)) return metaCache.get(sid);
  await loadMetaCache();
  return metaCache.get(sid) || null;
}

/**
 * Resolve helper:
 * - accepts { id, path }
 * - if path starts with '/' -> return path
 * - if path looks like an id -> treat as id
 * - if id -> resolve meta.path
 */
async function resolveIdOrPath({ id, path }) {
  if (!id && !path) throw new Error('Weder id noch path angegeben');

  // direct dropbox path
  if (path && path.startsWith('/')) {
    return { path, meta: null };
  }

  // path that is actually an id?
  if (path && /^[A-Za-z0-9\-_]{12,64}$/.test(path)) {
    id = path;
    path = undefined;
  }

  if (id) {
    const meta = await findMetaById(id);
    if (!meta) throw new Error('Keine Metadatei zu dieser id gefunden');
    return { path: meta.path, meta };
  }

  // fallback
  const normalized = path && path.startsWith('/') ? path : `/${path}`;
  return { path: normalized, meta: null };
}

// ---------- Migration: vorhandene coverBase64 -> /covers/<id>_cover.(jpg|png) ----------
async function migrateBase64Covers() {
  if (!dbx) return;
  console.log('Starte Migration: coverBase64 -> Dropbox /covers/ ...');

  // ensure meta cache filled
  if (metaCache.size === 0) await loadMetaCache();

  for (const [id, meta] of Array.from(metaCache.entries())) {
    try {
      // if already has coverPath, skip
      if (meta.coverPath) continue;
      const b64 = meta.coverBase64;
      if (!b64 || typeof b64 !== 'string') continue;
      const cleaned = cleanBase64Prefix(b64);
      if (!cleaned) continue;

      // determine extension
      let ext = '.jpg';
      const headerMatch = (b64 || '').match(/^data:image\/(png|jpeg|jpg|webp)/i);
      if (headerMatch) {
        const t = headerMatch[1].toLowerCase();
        if (t === 'png') ext = '.png';
        else if (t === 'webp') ext = '.webp';
        else ext = '.jpg';
      }

      const coverPath = `/covers/${id}_cover${ext}`;

      // upload to Dropbox (overwrite to be safe)
      await dbx.filesUpload({
        path: coverPath,
        contents: Buffer.from(cleaned, 'base64'),
        mode: { '.tag': 'overwrite' }
      });

      // update meta: remove coverBase64, set coverPath
      const updatedMeta = { ...meta, coverPath, coverBase64: undefined };

      if (!updatedMeta.metaPath) {
        // create new meta file if missing metaPath
        updatedMeta.metaPath = `/meta/${Date.now()}_${sanitizeFilename(updatedMeta.songName || id)}.json`;
      }

      await dbx.filesUpload({
        path: updatedMeta.metaPath,
        contents: Buffer.from(JSON.stringify(updatedMeta, null, 2), 'utf8'),
        mode: { '.tag': 'overwrite' }
      });

      // update cache
      metaCache.set(String(id), updatedMeta);
      console.log(`Migrated cover for id=${id} -> ${coverPath}`);
    } catch (err) {
      console.warn(`Migration failed for id=${id}:`, err?.message || err);
    }
  }

  console.log('Migration abgeschlossen.');
}

// ---------- ENDPOINTS ----------

app.get('/', (req, res) => res.send('Audionix backend running.'));

//
// Upload: mp3 file + coverBase64 (cover optional) -> stores mp3 in /songs, cover in /covers, meta in /meta
// Fields (form-data): file (mp3), coverBase64 (string - optional), songName, artist
//
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!dbx || !ACCESS_TOKEN) return res.status(503).json({ error: 'Dropbox nicht initialisiert.' });

    const mp3 = req.file;
    const { coverBase64, songName, artist } = req.body || {};

    if (!mp3) return res.status(400).json({ error: 'Keine Datei (field "file")' });
    if (!songName || !artist) return res.status(400).json({ error: 'songName und artist erforderlich' });

    // basic mp3 check
    const isMp3Mime = (mp3.mimetype === 'audio/mpeg' || mp3.mimetype === 'audio/mp3');
    const isMp3Ext = mp3.originalname.toLowerCase().endsWith('.mp3');
    if (!isMp3Mime && !isMp3Ext) {
      return res.status(400).json({ error: 'Nur MP3-Dateien erlaubt' });
    }

    const id = generateId();
    const safeMp3Name = `${id}_${sanitizeFilename(mp3.originalname)}`;
    const mp3Path = `/songs/${safeMp3Name}`;

    // upload mp3
    const uploadRes = await dbx.filesUpload({
      path: mp3Path,
      contents: mp3.buffer,
      mode: 'add',
      autorename: true
    });

    // handle cover if provided
    let coverPath = null;
    if (coverBase64 && typeof coverBase64 === 'string') {
      try {
        const cleaned = cleanBase64Prefix(coverBase64);
        // determine ext
        let ext = '.jpg';
        const headerMatch = coverBase64.match(/^data:image\/(png|jpeg|jpg|webp)/i);
        if (headerMatch) {
          const t = headerMatch[1].toLowerCase();
          if (t === 'png') ext = '.png';
          else if (t === 'webp') ext = '.webp';
        }
        coverPath = `/covers/${id}_cover${ext}`;
        await dbx.filesUpload({
          path: coverPath,
          contents: Buffer.from(cleaned, 'base64'),
          mode: 'add',
          autorename: true
        });
      } catch (err) {
        console.warn('Cover upload failed (continuing without cover):', err?.message || err);
        coverPath = null;
      }
    }

    const metadata = {
      id,
      songName: String(songName),
      artist: String(artist),
      path: uploadRes?.result?.path_lower || mp3Path,
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

    // update cache (store metaPath and coverPath)
    metaCache.set(id, { ...metadata, metaPath });

    return res.json({ success: true, id, metadata });
  } catch (err) {
    console.error('UPLOAD ERROR', err?.response?.data || err?.message || err);
    return res.status(500).json({ error: String(err) });
  }
});

//
// Parse: list songs (from metaCache)
//
app.get('/parse', async (req, res) => {
  try {
    if (metaCache.size === 0) await loadMetaCache();
    const songs = [...metaCache.values()].map(m => ({
      id: m.id,
      songName: m.songName || m.mp3Name || 'Unknown',
      artist: m.artist || 'Unknown',
      uploadedAt: m.uploadedAt || null,
      coverPath: m.coverPath || null,
      path: m.path || null
    }));
    res.json({ songs });
  } catch (err) {
    console.error('PARSE ERROR', err);
    res.status(500).json({ error: String(err) });
  }
});

//
// Temp-link: returns Dropbox temporary link for a song or cover.
// - If type=cover and id provided => uses meta.coverPath
// - If id provided and no type => returns temp link for song path (meta.path)
// - Or pass ?path=<dropbox-path> directly
//
app.get('/temp-link', async (req, res) => {
  try {
    if (!dbx || !ACCESS_TOKEN) return res.status(503).json({ error: 'Dropbox-Client noch nicht initialisiert.' });

    const { id, path, type } = req.query;
    if (!id && !path) return res.status(400).json({ error: 'id oder path query param required' });

    let resolvedPath;
    if (type === 'cover' && id) {
      const meta = await findMetaById(id);
      if (!meta) return res.status(404).json({ error: 'Song nicht gefunden' });
      if (!meta.coverPath) return res.status(404).json({ error: 'Cover nicht gefunden' });
      resolvedPath = meta.coverPath;
    } else if (path && path.startsWith('/')) {
      resolvedPath = path;
    } else {
      const resolved = await resolveIdOrPath({ id, path });
      resolvedPath = resolved.path;
    }

    if (!resolvedPath) return res.status(404).json({ error: 'Pfad nicht gefunden' });

    const tl = await dbx.filesGetTemporaryLink({ path: resolvedPath });
    const link = tl?.result?.link || tl?.link;
    if (!link) return res.status(500).json({ error: 'Kein temporärer Link erhalten' });

    return res.json({ link, id: id || null });
  } catch (err) {
    console.error('=== TEMPLINK ERROR ===', err?.response?.data || err.message || err);
    return res.status(500).json({ error: String(err) });
  }
});

//
// Download: stream file through server (fallback) - accepts id OR path
//
app.get('/download', async (req, res) => {
  try {
    if (!dbx || !ACCESS_TOKEN) return res.status(503).json({ error: 'Dropbox-Client noch nicht initialisiert.' });

    const { id, path } = req.query;
    if (!id && !path) return res.status(400).json({ error: 'id oder path query param required' });

    const resolved = await resolveIdOrPath({ id, path });
    const resolvedPath = resolved.path;
    if (!resolvedPath) return res.status(404).json({ error: 'Pfad nicht gefunden' });

    const tl = await dbx.filesGetTemporaryLink({ path: resolvedPath });
    const link = tl?.result?.link || tl?.link;
    if (!link) return res.status(500).json({ error: 'Kein temporärer Link erhalten' });

    const r = await fetch(link);
    if (!r.ok) return res.status(502).json({ error: 'Failed to fetch file from Dropbox', status: r.status });

    // forward headers for client
    res.setHeader('content-type', r.headers.get('content-type') || 'application/octet-stream');
    const cl = r.headers.get('content-length');
    if (cl) res.setHeader('content-length', cl);

    r.body.pipe(res);
  } catch (err) {
    console.error('DOWNLOAD ERROR', err?.response?.data || err.message || err);
    return res.status(500).json({ error: String(err) });
  }
});

//
// Change metadata: update songName, artist, optionally new coverBase64 (which will be uploaded to /covers/ and coverPath updated)
// Body: { id, songName?, artist?, coverBase64? }
//
app.post('/change', async (req, res) => {
  try {
    const { id, songName, artist, coverBase64 } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id im Body erforderlich' });

    const meta = await findMetaById(id);
    if (!meta) return res.status(404).json({ error: 'Song nicht gefunden' });

    let coverPath = meta.coverPath || null;
    if (coverBase64 && typeof coverBase64 === 'string') {
      try {
        const cleaned = cleanBase64Prefix(coverBase64);
        // determine ext
        let ext = '.jpg';
        const headerMatch = coverBase64.match(/^data:image\/(png|jpeg|jpg|webp)/i);
        if (headerMatch) {
          const t = headerMatch[1].toLowerCase();
          if (t === 'png') ext = '.png';
          else if (t === 'webp') ext = '.webp';
        }
        coverPath = `/covers/${id}_cover${ext}`;
        await dbx.filesUpload({
          path: coverPath,
          contents: Buffer.from(cleaned, 'base64'),
          mode: { '.tag': 'overwrite' }
        });
      } catch (err) {
        console.warn('Failed to upload new cover:', err?.message || err);
      }
    }

    const updated = {
      ...meta,
      songName: songName ?? meta.songName,
      artist: artist ?? meta.artist,
      coverPath
    };

    if (!updated.metaPath) {
      updated.metaPath = `/meta/${Date.now()}_${sanitizeFilename(updated.songName || id)}.json`;
    }

    await dbx.filesUpload({
      path: updated.metaPath,
      contents: Buffer.from(JSON.stringify(updated, null, 2), 'utf8'),
      mode: { '.tag': 'overwrite' }
    });

    // update cache
    metaCache.set(String(id), updated);

    return res.json({ success: true, metadata: updated });
  } catch (err) {
    console.error('CHANGE POST ERROR', err?.response?.data || err.message || err);
    return res.status(500).json({ error: String(err) });
  }
});

//
// Delete: delete file by id or path, also try to delete meta and cover (if meta known)
// Body: { id } OR { path: "/songs/..." }
//
app.delete('/delete', async (req, res) => {
  try {
    const { id, path } = req.body || {};
    if (!id && !path) return res.status(400).json({ error: 'id oder path im Body erforderlich' });

    // resolve primary file path
    let resolved;
    try {
      resolved = await resolveIdOrPath({ id, path });
    } catch (e) {
      return res.status(404).json({ error: String(e.message || e) });
    }

    const resolvedPath = resolved.path;
    if (!resolvedPath) return res.status(404).json({ error: 'Pfad nicht gefunden' });

    // delete main file
    const delRes = await dbx.filesDeleteV2({ path: resolvedPath });
    console.log('Deleted file:', delRes?.result?.metadata?.name);

    // delete meta entry if available
    if (resolved.meta && resolved.meta.metaPath) {
      try {
        await dbx.filesDeleteV2({ path: resolved.meta.metaPath });
        console.log('Deleted meta:', resolved.meta.metaPath);
      } catch (e) {
        console.warn('Could not delete meta file:', e?.message || e);
      }
      metaCache.delete(resolved.meta.id);
    } else if (id) {
      // try to find meta files which reference this path
      const metas = await listAllFolderEntries('/meta');
      for (const m of metas) {
        try {
          const tl = await dbx.filesGetTemporaryLink({ path: m.path_lower });
          const r = await fetch(tl.result.link);
          if (!r.ok) continue;
          const json = await r.json();
          if (json?.path === resolvedPath) {
            await dbx.filesDeleteV2({ path: m.path_lower });
            if (json.id) metaCache.delete(json.id);
            console.log('Deleted meta (fallback):', m.path_display || m.name);
          }
        } catch (e) { /* ignore per-file errors */ }
      }
    }

    // try to delete cover if known in metaCache
    if (id) {
      const meta = await findMetaById(id);
      if (meta && meta.coverPath) {
        try {
          await dbx.filesDeleteV2({ path: meta.coverPath });
          console.log('Deleted cover:', meta.coverPath);
        } catch (e) {
          console.warn('Could not delete cover:', e?.message || e);
        }
        // remove coverPath from cache/meta
        if (meta.metaPath) {
          const updated = { ...meta, coverPath: undefined };
          await dbx.filesUpload({
            path: meta.metaPath,
            contents: Buffer.from(JSON.stringify(updated, null, 2), 'utf8'),
            mode: { '.tag': 'overwrite' }
          }).catch(() => {});
          metaCache.set(String(id), updated);
        }
      }
    }

    return res.json({ success: true, name: delRes?.result?.metadata?.name || null, id: id || null });
  } catch (err) {
    console.error('DELETE ERROR', err?.response?.data || err.message || err);
    return res.status(500).json({ error: String(err) });
  }
});

// ---------- Server start ----------
(async () => {
  await refreshAccessToken();
  // refresh periodically (~3.5 hours)
  setInterval(refreshAccessToken, 3.5 * 60 * 60 * 1000);

  // load cache and run migration
  await loadMetaCache();
  await migrateBase64Covers();

  app.listen(port, () => {
    console.log(`Server läuft auf http://localhost:${port}`);
  });
})();
