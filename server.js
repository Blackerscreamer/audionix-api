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

// --------- KONFIGURATION (ersetze durch deine Werte oder ENV) ----------
const CLIENT_ID = process.env.DROPBOX_CLIENT_ID;
const CLIENT_SECRET = process.env.DROPBOX_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.DROPBOX_REFRESH_TOKEN;
// ---------------------------------------------------------------------

// Middlewares
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '100mb' })); // hohe Grenze wegen Base64
const upload = multer({ storage: multer.memoryStorage() });

// Interner Zustand
let ACCESS_TOKEN = null;
let dbx = null;

// In-memory cache: id -> metadata (meta contains at least id, path, songName, artist, coverBase64, uploadedAt, metaPath)
const metaCache = new Map();

// ---------- Hilfsfunktionen ----------
function sanitizeFilename(name) {
  return String(name || '').replace(/[^\w\d_\-\.() ]/g, '_').slice(0, 200);
}

function createDropboxClient(token) {
  dbx = new Dropbox({ accessToken: token, fetch });
}

// ID-Generator (URL-safe)
function generateId() {
  return crypto
    .randomBytes(16)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
    .slice(0, 22);
}

// Entfernt data:...;base64, Prefix falls vorhanden
function stripDataPrefix(b64) {
  if (!b64 || typeof b64 !== 'string') return '';
  const s = b64.trim();
  if (s.startsWith('data:')) {
    const idx = s.indexOf('base64,');
    if (idx !== -1) return s.slice(idx + 7);
  }
  return s;
}

// Baut data URI aus buffer + content-type
function buildDataUri(buffer, contentType = 'image/jpeg') {
  const b64 = buffer.toString('base64');
  return `data:${contentType};base64,${b64}`;
}

// Token automatisch erneuern (refresh_token flow)
async function refreshAccessToken() {
  if (!REFRESH_TOKEN || REFRESH_TOKEN === 'DEIN_MANUELL_GEHOLTENER_REFRESH_TOKEN') {
    console.warn('Kein gültiger REFRESH_TOKEN gesetzt. Ersetze den Platzhalter in server.js oder setze die Umgebungsvariable.');
    return;
  }

  try {
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: REFRESH_TOKEN,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET
    });

    const response = await axios.post('https://api.dropbox.com/oauth2/token', params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000
    });

    const token = response.data.access_token;
    const expiresIn = response.data.expires_in;

    if (!token) {
      console.error('Kein access_token in der Antwort gefunden:', response.data);
      return;
    }

    ACCESS_TOKEN = token;
    createDropboxClient(ACCESS_TOKEN);

    console.log('Neuer Access Token erhalten (gültig für', expiresIn, 'Sekunden).');
  } catch (err) {
    console.error('Fehler beim Refreshen des Tokens:', err?.response?.data || err.message || err);
  }
}

// Hilfsfunktion: liste alle Einträge in einem Ordner (mit Pagination)
async function listAllFolderEntries(folderPath) {
  if (!dbx) return [];
  try {
    let res = await dbx.filesListFolder({ path: folderPath }).catch(() => ({ result: { entries: [] } }));
    const entries = (res.result && res.result.entries) || [];
    while (res.result && res.result.has_more) {
      res = await dbx.filesListFolderContinue({ cursor: res.result.cursor });
      entries.push(...(res.result?.entries || []));
    }
    return entries;
  } catch (err) {
    console.warn('listAllFolderEntries error for', folderPath, err?.message || err);
    return [];
  }
}

// Lädt alle meta-Dateien aus /meta in den In-Memory-Cache
async function loadMetaCache() {
  metaCache.clear();
  if (!dbx) return;

  try {
    const entries = await listAllFolderEntries('/meta');

    const promises = entries.map(async (e) => {
      try {
        const tl = await dbx.filesGetTemporaryLink({ path: e.path_lower || e.path_display });
        const link = tl?.result?.link || tl?.link;
        if (!link) return;

        const r = await fetch(link, { timeout: 15000 });
        if (!r.ok) {
          console.warn('Failed to fetch meta JSON:', e.path_lower || e.path_display, r.status);
          return;
        }
        const json = await r.json();
        if (json && json.id) {
          metaCache.set(String(json.id), {
            ...json,
            metaPath: e.path_lower || e.path_display
          });
        }
      } catch (err) {
        console.warn('Fehler beim Laden einer meta-Datei:', e.path_display || e.name || e.path_lower, err?.message || err);
      }
    });

    await Promise.all(promises);
    console.log(`Meta-Cache geladen: ${metaCache.size} Einträge.`);
  } catch (err) {
    console.error('Fehler beim Auflisten/Laden von /meta:', err?.response?.data || err.message || err);
  }
}

// Sucht Meta per ID (nutzt Cache; falls nicht vorhanden, versucht Cache neu zu laden)
async function findMetaById(id) {
  if (!id) return null;
  const sid = String(id);
  if (metaCache.has(sid)) return metaCache.get(sid);

  // Falls Cache leer oder Eintrag fehlt, nochmal neu laden (Fallback)
  await loadMetaCache();
  return metaCache.get(sid) || null;
}

// Resolve helper: akzeptiert { id, path } und gibt { path, meta } zurück.
async function resolveIdOrPath({ id, path }) {
  if (!id && !path) throw new Error('Weder id noch path angegeben');

  // Wenn path vorhanden und mit '/' beginnt -> direkt nutzen
  if (path && path.startsWith('/')) {
    return { path, meta: null };
  }

  // Wenn path vorhanden, aber keinen Slash enthält und nach dem ID-Pattern aussieht,
  // dann behandeln wir es wie eine id
  if (path && /^[A-Za-z0-9\-_]{12,32}$/.test(path)) {
    id = path;
    path = undefined;
  }

  if (id) {
    const meta = await findMetaById(id);
    if (!meta) throw new Error('Keine Metadatei zu dieser id gefunden');
    return { path: meta.path, meta };
  }

  // Fallback - falls path doch gesetzt ist (z.B. ohne leading slash), normalisieren wir
  if (path) {
    const normalized = path.startsWith('/') ? path : `/${path}`;
    return { path: normalized, meta: null };
  }

  throw new Error('Konnte id/path nicht auflösen');
}

// ---------- Migration: Dropbox coverPath -> coverBase64 in meta ----------
async function migrateCoversToBase64() {
  if (!dbx) {
    console.warn('Dropbox client not initialized - skipping cover migration.');
    return;
  }

  if (metaCache.size === 0) await loadMetaCache();

  console.log('Starte Migration: Dropbox covers -> coverBase64 in meta (falls nötig)...');

  for (const [id, meta] of Array.from(metaCache.entries())) {
    try {
      // skip if already has a reasonable coverBase64
      const hasBase64 = meta.coverBase64 && typeof meta.coverBase64 === 'string' && meta.coverBase64.length > 100;
      const hasCoverPath = meta.coverPath && typeof meta.coverPath === 'string' && meta.coverPath.length > 3;
      if (hasBase64) {
        // already present -> skip
        continue;
      }
      if (!hasCoverPath) {
        // nothing to migrate for this entry
        continue;
      }

      // fetch cover from Dropbox via temporary link
      try {
        const tl = await dbx.filesGetTemporaryLink({ path: meta.coverPath });
        const link = tl?.result?.link || tl?.link;
        if (!link) {
          console.warn(`No temporary link for cover of id=${id}`);
          continue;
        }

        const r = await fetch(link, { timeout: 20000 });
        if (!r.ok) {
          console.warn(`Failed to fetch cover for id=${id} path=${meta.coverPath} status=${r.status}`);
          continue;
        }

        const contentType = r.headers.get('content-type') || 'image/jpeg';
        const arr = await r.arrayBuffer();
        const buffer = Buffer.from(arr);
        const dataUri = buildDataUri(buffer, contentType);

        // update meta: set coverBase64, remove coverPath (to match original base64-only format)
        const updated = { ...meta, coverBase64: dataUri };
        // remove coverPath to match "old" base64-only format
        if ('coverPath' in updated) delete updated.coverPath;

        // ensure metaPath exists
        if (!updated.metaPath) {
          updated.metaPath = `/meta/${Date.now()}_${sanitizeFilename(updated.songName || id)}.json`;
        }

        // upload updated meta JSON to Dropbox (overwrite)
        await dbx.filesUpload({
          path: updated.metaPath,
          contents: Buffer.from(JSON.stringify(updated, null, 2), 'utf8'),
          mode: { '.tag': 'overwrite' }
        });

        // update cache
        metaCache.set(String(id), updated);
        console.log(`Migrated cover -> base64 for id=${id}`);
      } catch (innerErr) {
        console.warn(`Failed to migrate cover for id=${id}:`, innerErr?.message || innerErr);
      }
    } catch (err) {
      console.warn('Migration loop error for', id, err?.message || err);
    }
  }

  console.log('Migration complete.');
}

// ---------- Server start / Token holen ----------
(async () => {
  await refreshAccessToken();
  // Dropbox-Token alle ~3.5 Stunden erneuern (Dropbox Tokens ~4h)
  const REFRESH_INTERVAL_MS = 12600 * 1000;
  setInterval(refreshAccessToken, REFRESH_INTERVAL_MS);

  // Meta-Cache initial laden (wenn DBX initialisiert)
  await loadMetaCache();

  // Migration: wenn es coverPath gibt, konvertiere in base64 und schreibe in meta
  await migrateCoversToBase64();

  // ---------- ENDPOINTS ----------
  app.get('/', (req, res) => res.send('Audionix backend running.'));


  /**
 * GET /change?id=<id> -> gibt Metadaten zurück
 * POST /change -> aktualisiert Metadaten
 * Body: { id, songName?, artist?, coverBase64? }
 */
app.route('/change')
  // GET: liefert die Metadaten eines Songs
  .get(async (req, res) => {
    try {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'id query param required' });

      const meta = await findMetaById(id);
      if (!meta) return res.status(404).json({ error: 'Song nicht gefunden' });

      return res.json({ metadata: meta });
    } catch (err) {
      console.error('=== CHANGE GET ERROR ===', err?.message || err);
      return res.status(500).json({ error: String(err) });
    }
  })
  // POST: aktualisiert die Metadaten eines Songs
  .post(async (req, res) => {
    try {
      const { id, songName, artist, coverBase64 } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id im Body erforderlich' });

      const meta = await findMetaById(id);
      if (!meta) return res.status(404).json({ error: 'Song nicht gefunden' });
      if (!meta.metaPath) return res.status(500).json({ error: 'Meta-Dateipfad fehlt' });

      // Update Meta lokal
      const updatedMeta = {
        ...meta,
        songName: songName ?? meta.songName,
        artist: artist ?? meta.artist,
        coverBase64: coverBase64 ?? meta.coverBase64
      };

      // Speichere zurück auf Dropbox (overwrite)
      await dbx.filesUpload({
        path: meta.metaPath,
        contents: Buffer.from(JSON.stringify(updatedMeta, null, 2), 'utf8'),
        mode: { '.tag': 'overwrite' }
      });

      // Update Cache
      metaCache.set(String(id), updatedMeta);

      return res.json({ success: true, metadata: updatedMeta });
    } catch (err) {
      console.error('=== CHANGE POST ERROR ===', err?.message || err);
      return res.status(500).json({ error: String(err) });
    }
  });

  /**
   * Upload:
   * - FormData: file (mp3), coverBase64, songName, artist
   * - Response: { success: true, id, path, metadata: { ... } }
   */
  app.post('/upload', upload.single('file'), async (req, res) => {
    try {
      if (!dbx || !ACCESS_TOKEN) return res.status(503).json({ error: 'Dropbox-Client noch nicht initialisiert (kein Access Token).' });

      const mp3 = req.file;
      const { coverBase64, songName, artist } = req.body || {};

      if (!mp3) return res.status(400).json({ error: 'Keine Datei hochgeladen (field "file")' });

      const isMp3Mime = (mp3.mimetype === 'audio/mpeg' || mp3.mimetype === 'audio/mp3');
      const isMp3Ext = mp3.originalname.toLowerCase().endsWith('.mp3');
      if (!isMp3Mime && !isMp3Ext) {
        return res.status(400).json({ error: 'Nur MP3-Dateien erlaubt' });
      }

      if (!coverBase64) return res.status(400).json({ error: 'coverBase64 fehlt' });
      if (!songName || !artist) return res.status(400).json({ error: 'songName und artist sind erforderlich' });

      const ts = Date.now();
      const id = generateId();
      const safeMp3Name = `${id}_${sanitizeFilename(mp3.originalname)}`; // nutze id im Filename
      const mp3Path = `/songs/${safeMp3Name}`;

      console.log('Uploading MP3 to Dropbox:', mp3Path);

      const uploadRes = await dbx.filesUpload({
        path: mp3Path,
        contents: mp3.buffer,
        mode: 'add',
        autorename: true
      });

      console.log('MP3 upload result:', uploadRes?.result?.name || uploadRes);

      // Metadaten (inkl. id und dem gespeicherten dropbox-path)
      const metadata = {
        id,
        songName: String(songName),
        artist: String(artist),
        coverBase64: String(coverBase64),
        path: uploadRes?.result?.path_lower || uploadRes?.result?.path_display || mp3Path,
        mp3Name: uploadRes?.result?.name || safeMp3Name,
        uploadedAt: new Date().toISOString()
      };

      const metaFilename = `/meta/${ts}_${sanitizeFilename(songName)}.json`;
      await dbx.filesUpload({
        path: metaFilename,
        contents: Buffer.from(JSON.stringify(metadata, null, 2), 'utf8'),
        mode: 'add',
        autorename: true
      });

      // Update In-Memory-Cache direkt (schnell)
      metaCache.set(String(id), { ...metadata, metaPath: metaFilename });

      return res.json({
        success: true,
        id,
        path: metadata.path, // WICHTIG: wir geben den Dropbox-Pfad mit zurück (schnelles Abspielen möglich)
        metadata: {
          id: metadata.id,
          songName: metadata.songName,
          artist: metadata.artist,
          uploadedAt: metadata.uploadedAt
        }
      });
    } catch (err) {
      console.error('=== UPLOAD ERROR ===', err?.response?.data || err.message || err);
      return res.status(500).json({ error: String(err) });
    }
  });

  /**
   * Parse / list songs:
   * - liefert alle Songs aus dem In-Memory-Cache
   * - Achtung: gibt absichtlich keinen internen Pfad-String der Dropbox (path) bei Bedarf kannst du das ändern;
   *   in dieser Version geben wir id, songName, artist, coverBase64, uploadedAt zurück.
   */
  app.get('/parse', async (req, res) => {
    try {
      // Wenn Cache leer, lade nochmal
      if (metaCache.size === 0) {
        await loadMetaCache();
      }

      const songs = [];
      for (const [, m] of metaCache) {
        songs.push({
          id: m.id,
          songName: m.songName || m.mp3Name,
          artist: m.artist || 'Unknown',
          uploadedAt: m.uploadedAt || null,
          coverBase64: m.coverBase64 || null
          // kein path standardmäßig hier — aber du hast jetzt beim Upload path in der Response
        });
      }

      return res.json({ songs });
    } catch (err) {
      console.error('=== LIST ERROR ===', err?.response?.data || err.message || err);
      return res.status(500).json({ error: String(err) });
    }
  });

  /**
   * temp-link -> returns Dropbox temporary link for playback
   * Accepts query param "id" or "path" (or even ?path=<id> which is interpreted as id)
   */
  app.get('/temp-link', async (req, res) => {
    try {
      if (!dbx || !ACCESS_TOKEN) return res.status(503).json({ error: 'Dropbox-Client noch nicht initialisiert (kein Access Token).' });

      const { id, path } = req.query;
      if (!id && !path) return res.status(400).json({ error: 'id oder path query param required' });

      const resolved = await resolveIdOrPath({ id, path });
      const resolvedPath = resolved.path;
      if (!resolvedPath) return res.status(404).json({ error: 'Pfad nicht gefunden' });

      const tl = await dbx.filesGetTemporaryLink({ path: resolvedPath });
      const link = tl?.result?.link || tl?.link;
      if (!link) return res.status(500).json({ error: 'Kein temporärer Link erhalten' });

      return res.json({ link, id: id || (resolved.meta ? resolved.meta.id : null) });
    } catch (err) {
      console.error('=== TEMPLINK ERROR ===', err?.response?.data || err.message || err);
      return res.status(500).json({ error: String(err) });
    }
  });

  /**
   * download -> streams file through server (fallback)
   * Accepts query param "id" or "path"
   */
  app.get('/download', async (req, res) => {
    try {
      if (!dbx || !ACCESS_TOKEN) return res.status(503).json({ error: 'Dropbox-Client noch nicht initialisiert (kein Access Token).' });

      const { id, path } = req.query;
      if (!id && !path) return res.status(400).json({ error: 'id oder path query param required' });

      const resolved = await resolveIdOrPath({ id, path });
      const resolvedPath = resolved.path;
      if (!resolvedPath) return res.status(404).json({ error: 'Pfad nicht gefunden' });

      const tl = await dbx.filesGetTemporaryLink({ path: resolvedPath });
      const link = tl?.result?.link || tl?.link;
      if (!link) return res.status(500).json({ error: 'Kein temporärer Link erhalten' });

      // Fetch the temporary link and pipe to response
      const r = await fetch(link);
      if (!r.ok) return res.status(502).json({ error: 'Failed to fetch file from Dropbox', status: r.status });

      res.setHeader('content-type', r.headers.get('content-type') || 'application/octet-stream');
      const cl = r.headers.get('content-length');
      if (cl) res.setHeader('content-length', cl);

      // Pipe the readable stream
      r.body.pipe(res);
    } catch (err) {
      console.error('=== DOWNLOAD ERROR ===', err?.response?.data || err.message || err);
      return res.status(500).json({ error: String(err) });
    }
  });

  /**
   * delete -> delete by id OR path
   * Body: { "id": "<id>" } or { "path": "/songs/..." }
   */
  app.delete('/delete', async (req, res) => {
    try {
      if (!dbx || !ACCESS_TOKEN) return res.status(503).json({ error: 'Dropbox-Client noch nicht initialisiert (kein Access Token).' });

      const { id, path } = req.body || {};
      if (!id && !path) return res.status(400).json({ error: 'id oder path im Body erforderlich' });

      // Resolve
      let resolved;
      try {
        resolved = await resolveIdOrPath({ id, path });
      } catch (e) {
        return res.status(404).json({ error: String(e.message || e) });
      }

      const resolvedPath = resolved.path;
      if (!resolvedPath) return res.status(404).json({ error: 'Pfad nicht gefunden' });

      // Delete the actual file
      const delRes = await dbx.filesDeleteV2({ path: resolvedPath });
      console.log('Deleted file:', delRes?.result?.metadata?.name);

      // If we have meta info (from cache), delete the specific meta file and remove from cache
      if (resolved.meta && resolved.meta.metaPath) {
        try {
          await dbx.filesDeleteV2({ path: resolved.meta.metaPath });
          console.log('Deleted meta file:', resolved.meta.metaPath);
        } catch (e) {
          console.warn('Konnte Meta-Datei nicht löschen (id):', e?.message || e);
        }
        metaCache.delete(resolved.meta.id);
      } else {
        // Fallback: scan /meta and delete any meta files that reference this path
        const listRes = await dbx.filesListFolder({ path: '/meta' }).catch(() => ({ result: { entries: [] } }));
        const metaEntries = (listRes && listRes.result && listRes.result.entries) || [];
        for (const e of metaEntries) {
          try {
            const tl = await dbx.filesGetTemporaryLink({ path: e.path_lower || e.path_display });
            const r = await fetch(tl.result?.link || tl.link);
            if (!r.ok) continue;
            const json = await r.json();
            if (json.path === resolvedPath && (e.path_lower || e.path_display)) {
              await dbx.filesDeleteV2({ path: e.path_lower || e.path_display });
              console.log('Deleted meta file (fallback):', e.path_display);
              if (json.id) metaCache.delete(json.id);
            }
          } catch (errMeta) {
            // ignore per-file errors
          }
        }
      }

      return res.json({ success: true, name: delRes?.result?.metadata?.name, id: resolved.meta ? resolved.meta.id : null });
    } catch (err) {
      console.error('=== DELETE ERROR ===', err?.response?.data || err.message || err);
      return res.status(500).json({ error: String(err) });
    }
  });

  // start server
  app.listen(port, () => {
    console.log(`Server läuft auf http://localhost:${port}`);
  });
})();
