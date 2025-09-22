// server.js
import express from 'express';
import multer from 'multer';
import { Dropbox } from 'dropbox';
import fetch from 'node-fetch';
import cors from 'cors';
import axios from 'axios';
import crypto from 'crypto';

const app = express();
const port = 3000; // fest gesetzt, kannst du ändern

// Middlewares
app.use(cors({ origin: '*' }));
app.use(express.json()); // für DELETE body parsing etc.

// Multer (in-memory)
const upload = multer({ storage: multer.memoryStorage() });

// ---------- HARDCODED KONFIGURATION (OHNE ENV) ----------
const CLIENT_ID = '1w0y4rdnuvbe476';
const CLIENT_SECRET = 'je5paqlcai1vxhc';
// Bitte hier deinen manuell geholtener Refresh-Token einsetzen:
const REFRESH_TOKEN = 'L4N3aNJBnM8AAAAAAAAAAX9jprkmTjHaduGuaKzGxtnODQ5UhEzEUIvgUFXQ3uop';

// Interner Zustand
let ACCESS_TOKEN = null;
let dbx = null;

// ---------- HILFSFUNKTIONEN ----------
function sanitizeFilename(name) {
  return name.replace(/[^\w\d_\-\.() ]/g, '_').slice(0, 200);
}

async function createOrUpdateDbx(token) {
  dbx = new Dropbox({ accessToken: token, fetch });
}

// Funktion, um Access Token automatisch zu erneuern
async function refreshAccessToken() {
  if (!REFRESH_TOKEN || REFRESH_TOKEN === 'DEIN_MANUELL_GEHOLTENER_REFRESH_TOKEN') {
    console.warn('Kein gültiger REFRESH_TOKEN gesetzt. Ersetze den Platzhalter in server.js durch deinen tatsächlichen Refresh-Token.');
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
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    const token = response.data.access_token;
    const expiresIn = response.data.expires_in;

    if (!token) {
      console.error('Kein access_token in der Antwort gefunden:', response.data);
      return;
    }

    ACCESS_TOKEN = token;
    await createOrUpdateDbx(ACCESS_TOKEN);

    console.log('Neuer Access Token erhalten (gültig für', expiresIn, 'Sekunden).');
  } catch (err) {
    console.error('Fehler beim Refreshen des Tokens:', err?.response?.data || err.message || err);
  }
}

// ID-Generator (URL-safe Base64-like)
function generateId() {
  return crypto
    .randomBytes(16)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
    .slice(0, 22);
}

// Hilfsfunktion: finde Meta (und zugehörigen Eintrag) per id
async function findMetaById(id) {
  if (!dbx) throw new Error('Dropbox client not initialized');
  const listRes = await dbx.filesListFolder({ path: '/meta' }).catch(() => ({ result: { entries: [] } }));
  const entries = (listRes && listRes.result && listRes.result.entries) || [];

  for (const e of entries) {
    try {
      const tl = await dbx.filesGetTemporaryLink({ path: e.path_lower || e.path_display });
      const link = tl?.result?.link || tl?.link;
      if (!link) continue;
      const r = await fetch(link);
      if (!r.ok) continue;
      const json = await r.json();
      if (json.id && json.id === id) {
        return { meta: json, entry: e };
      }
    } catch (err) {
      // ignore per-file errors
    }
  }
  return null;
}

// Hilfsfunktion: optionales Auflösen - akzeptiert id oder path
async function resolveIdOrPath({ id, path }) {
  if (path) return { path }; // bereits ein Pfad - einfach zurückgeben
  if (!id) throw new Error('Weder id noch path angegeben');
  const found = await findMetaById(id);
  if (!found) throw new Error('Keine Metadatei zu dieser id gefunden');
  return { path: found.meta.path, metaEntry: found.entry, meta: found.meta };
}

// ---------- START: Token holen, dann Server starten ----------
(async () => {
  await refreshAccessToken();

  // Interval zum erneuern: ca. 3.5 Stunden (Dropbox tokens ~4h)
  const REFRESH_INTERVAL_MS = 12600 * 1000;
  setInterval(refreshAccessToken, REFRESH_INTERVAL_MS);

  // ---------- ENDPOINTS ----------
  app.get('/', (req, res) => res.send('Dropbox Backend (ohne env) läuft ✅'));

  // Upload endpoint: mp3 file + coverBase64 + songName + artist
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
      const safeMp3Name = `${ts}_${sanitizeFilename(mp3.originalname)}`;
      const mp3Path = `/songs/${safeMp3Name}`;

      console.log('Uploading MP3 to Dropbox:', mp3Path);

      const uploadRes = await dbx.filesUpload({
        path: mp3Path,
        contents: mp3.buffer,
        mode: 'add',
        autorename: true
      });

      console.log('MP3 upload result:', uploadRes?.result?.name || uploadRes);

      // generiere eine öffentliche id für den Song (statt Pfad preiszugeben)
      const id = generateId();

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

      // Rückgabe: id + Meta-Infos (kein direkter Pfad)
      return res.json({ success: true, id, metaPath: metaFilename, metadata: { id: metadata.id, songName: metadata.songName, artist: metadata.artist, uploadedAt: metadata.uploadedAt } });
    } catch (err) {
      console.error('=== UPLOAD ERROR ===', err?.response?.data || err.message || err);
      return res.status(500).json({ error: String(err) });
    }
  });

  // Parse / list songs: read /meta folder, fetch each JSON and return songs array
  // ACHTUNG: Hier wird absichtlich NICHT der Dropbox-Pfad zurückgegeben.
  app.get('/parse', async (req, res) => {
    try {
      if (!dbx || !ACCESS_TOKEN) return res.status(503).json({ error: 'Dropbox-Client noch nicht initialisiert (kein Access Token).' });

      const listRes = await dbx.filesListFolder({ path: '/meta' }).catch((e) => {
        console.warn('filesListFolder /meta failed, returning empty list', e?.error || e);
        return { result: { entries: [] } };
      });

      const entries = (listRes && listRes.result && listRes.result.entries) || [];

      const songs = [];
      for (const e of entries) {
        try {
          const tl = await dbx.filesGetTemporaryLink({ path: e.path_lower || e.path_display || e.path_lower });
          const link = tl?.result?.link || tl?.link;
          if (!link) {
            console.warn('No temp link for meta:', e.path_display);
            continue;
          }
          const r = await fetch(link);
          if (!r.ok) {
            console.warn('Failed to fetch meta content for', e.path_display, r.status);
            continue;
          }
          const json = await r.json();
          songs.push({
            id: json.id || null,
            songName: json.songName || json.mp3Name || e.name,
            artist: json.artist || 'Unknown',
            coverBase64: json.coverBase64 || null,
            uploadedAt: json.uploadedAt || null
            // kein path mehr hier!
          });
        } catch (errMeta) {
          console.warn('Error fetching/parsing meta file', e.path_display, errMeta?.message || errMeta);
        }
      }

      return res.json({ songs });
    } catch (err) {
      console.error('=== LIST ERROR ===', err?.response?.data || err.message || err);
      return res.status(500).json({ error: String(err) });
    }
  });

  // temp-link endpoint -> returns a direct link to Dropbox-stored file (for playback)
  // Akzeptiert query param "id" (neu) oder "path" (alt, backwards compatible)
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

      return res.json({ link, id: id || null });
    } catch (err) {
      console.error('=== TEMPLINK ERROR ===', err?.response?.data || err.message || err);
      return res.status(500).json({ error: String(err) });
    }
  });

  // download fallback: fetch the temporary link and stream die Datei durch den Server
  // Akzeptiert query param "id" (neu) oder "path" (alt)
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

      const r = await fetch(link);
      if (!r.ok) return res.status(502).json({ error: 'Failed to fetch file from Dropbox', status: r.status });

      res.setHeader('content-type', r.headers.get('content-type') || 'application/octet-stream');
      const cl = r.headers.get('content-length');
      if (cl) res.setHeader('content-length', cl);

      r.body.pipe(res);
    } catch (err) {
      console.error('=== DOWNLOAD ERROR ===', err?.response?.data || err.message || err);
      return res.status(500).json({ error: String(err) });
    }
  });

  // Delete file (by id OR Dropbox path) - also attempt to delete corresponding metadata file(s)
  // Wenn "id" übergeben wird, lösche die MP3 (path) und die passende Meta-Datei.
  app.delete('/delete', async (req, res) => {
    try {
      if (!dbx || !ACCESS_TOKEN) return res.status(503).json({ error: 'Dropbox-Client noch nicht initialisiert (kein Access Token).' });

      const { id, path } = req.body || {};
      if (!id && !path) return res.status(400).json({ error: 'id oder path im Body erforderlich' });

      // Wenn id => meta finden und path daraus nehmen
      let resolved;
      try {
        resolved = await resolveIdOrPath({ id, path });
      } catch (e) {
        return res.status(404).json({ error: String(e.message || e) });
      }

      const resolvedPath = resolved.path;
      if (!resolvedPath) return res.status(404).json({ error: 'Pfad nicht gefunden' });

      // Delete MP3
      const delRes = await dbx.filesDeleteV2({ path: resolvedPath });
      console.log('Deleted file:', delRes?.result?.metadata?.name);

      // Wenn wir eine metaEntry haben (bei id-Auflösung), löschen wir genau diese Meta-Datei
      if (resolved.metaEntry) {
        try {
          await dbx.filesDeleteV2({ path: resolved.metaEntry.path_lower || resolved.metaEntry.path_display });
          console.log('Deleted meta file:', resolved.metaEntry.path_display);
        } catch (e) {
          console.warn('Konnte Meta-Datei nicht löschen (id):', e?.message || e);
        }
      } else {
        // Fallback: suche meta files, die path referenzieren und lösche sie
        const listRes = await dbx.filesListFolder({ path: '/meta' }).catch(() => ({ result: { entries: [] } }));
        const metaEntries = (listRes && listRes.result && listRes.result.entries) || [];
        for (const e of metaEntries) {
          try {
            const tl = await dbx.filesGetTemporaryLink({ path: e.path_lower || e.path_display });
            const r = await fetch(tl.result?.link || tl.link);
            if (!r.ok) continue;
            const json = await r.json();
            if (json.path === resolvedPath) {
              await dbx.filesDeleteV2({ path: e.path_lower || e.path_display });
              console.log('Deleted meta file:', e.path_display);
            }
          } catch (errMeta) {
            // ignore per-file errors
          }
        }
      }

      return res.json({ success: true, name: delRes?.result?.metadata?.name, id: id || null });
    } catch (err) {
      console.error('=== DELETE ERROR ===', err?.response?.data || err.message || err);
      return res.status(500).json({ error: String(err) });
    }
  });

  app.listen(port, () => console.log(`Server läuft auf http://localhost:${port}`));
})();
