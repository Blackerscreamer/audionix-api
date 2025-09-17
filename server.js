// server.js
import express from 'express';
import multer from 'multer';
import { Dropbox } from 'dropbox';
import fetch from 'node-fetch';
import cors from 'cors';

const app = express();
const port = process.env.PORT || 3000;

// CORS (für Tests offen, später einschränken)
app.use(cors({ origin: '*' }));

// Multer (in-memory)
const upload = multer({ storage: multer.memoryStorage() });

// KONFIGURATION
const APP_KEY = '1w0y4rdnuvbe476';
const ACCESS_TOKEN = 'sl.u.AF-UdZilU_PLbwEPJ__A7VFoG_wk6jB840jNm35aCafNCT8GjYLNvBIKChfC0snlXu2ZkYsT5YYC-wRnsQVh_tJNdL5wJ1Qp2Yt0V0rrz6kSRxgHNp4KUJIetkvfGiuP9mdXY-cwAGYS05LRzTY6g5tBAsHdg8YUaACaHpROoVdZZ79BkdH5VptPfgo82KOvoybOgqpeqxJBvF7COezFCl5C5Q_F1qURbEqo7fvmL-eyLQ4f1Sscjqt213KI706AlpYvZAVlUyGsytQhQbJt6q6xeCS-47LWHlQNNHSeDU4wo-xPGj7a7AzLj1OE83kZDHc_2LBJftl9BHOHafzxDIVjtk21-NhAIg90nH5mppoxxOiNY3g-nRZCqTpGRUmZPbVZPbw4EWQB2qQc4mKEFbmyF4AlHMqm34II6JLKgGRr5KJVq8v4EYb5vuGCy9TIJN_3aRAYsrvgHKCh8Yz09V9S1AxXLXRVT_FnGZNbTpTLMgclq34sTCn4_RoALTJGphHn8E-6aB-jQYw3YV6cenR0Ko0Dx2IVNlSlo64c0CBe8ne-24w_xl7336nsftjQwnPoeFwKYnJRp4l5uUzGKk0ap1DpdK-DEB366GfjtPWwunu9OpBX3nTiaFBnMPS7P6PsbasZ5rjtsZY5OIAfJ6Bp5BwLDeh5fR_I3TfMOAo-WEMcpzXqKPcEptROFqx7iCxcppkb8-WOsAaKUS-wN0sLiQsmM4rxEfWPImdDNONlpYkAnt_OHU4-n8IqFy82kZaquP3o4L4-KkE9gl2_lV6whpYBdOem5Ue4KJVeTaQP7bdPyTKah536ceffdOoErgJDzgP0yGP2Te263MNlOPGvqESkHhZX8D__2HLkM-Ku0RfhAY7lM7FMd1UsWeJ8P8P4-Mho3aAf16csnDkhoJktQoxh-gELy3ur-lfs8SlXFMce3wj1f-Upes6WYf_HaFIrHttWWSTKjc2BuePHIXxAlFBgbFdHYNwo_wSyp1nvlMV2wLprj0B_nsSR4ZPRf4INpj4cHTeqb1d-kQkNYdr7FoGbqg4VpqaKnhoen2crw4YGchRLfBmORuiRxb8xtayZJSODIshbwtX5zOzPZrI4lRZHog9uTAi6YtgyP4cDkQbMYGmesulNNvQmYZpGNwKs8J82kNcoU9r1ZZ2H9YE6rMB2N6iMINr1BNmNFNZMnjkG661tK6pXNIhJHKWKterTWdIC6sA1sltXWVQ3FSbklVA7BVYChOB3tdzOCshnZDmFhV9ObmW6z4EuqIfYgpG1eKwYEJ59vSb6fvnYLm67';

// Dropbox client
const dbx = new Dropbox({ accessToken: ACCESS_TOKEN, fetch });

// Helper: sanitize file name for Dropbox path (simple)
function sanitizeFilename(name) {
  return name.replace(/[^\w\d_\-\.() ]/g, '_').slice(0, 200);
}

// Upload endpoint: mp3 file + coverBase64 + songName + artist
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    // multer place text fields into req.body
    const mp3 = req.file;
    const { coverBase64, songName, artist } = req.body || {};

    if (!mp3) return res.status(400).json({ error: 'Keine Datei hochgeladen (field "file")' });

    // Enforce MP3 mime or extension
    const isMp3Mime = (mp3.mimetype === 'audio/mpeg' || mp3.mimetype === 'audio/mp3');
    const isMp3Ext = mp3.originalname.toLowerCase().endsWith('.mp3');
    if (!isMp3Mime && !isMp3Ext) {
      return res.status(400).json({ error: 'Nur MP3-Dateien erlaubt' });
    }

    if (!coverBase64) return res.status(400).json({ error: 'coverBase64 fehlt' });
    if (!songName || !artist) return res.status(400).json({ error: 'songName und artist sind erforderlich' });

    // Prepare unique names
    const ts = Date.now();
    const safeMp3Name = `${ts}_${sanitizeFilename(mp3.originalname)}`;
    const mp3Path = `/songs/${safeMp3Name}`;

    console.log('Uploading MP3 to Dropbox:', mp3Path);

    // Upload MP3 (binary)
    const uploadRes = await dbx.filesUpload({
      path: mp3Path,
      contents: mp3.buffer,
      mode: 'add',
      autorename: true
    });

    console.log('MP3 upload result:', uploadRes && uploadRes.result && uploadRes.result.name);

    // Build metadata object
    const metadata = {
      songName: String(songName),
      artist: String(artist),
      coverBase64: String(coverBase64), // data-url string
      path: uploadRes.result && (uploadRes.result.path_lower || uploadRes.result.path_display) || mp3Path,
      mp3Name: uploadRes.result && uploadRes.result.name || safeMp3Name,
      uploadedAt: new Date().toISOString()
    };

    // Upload metadata JSON into /meta/<ts>_<safe>.json
    const metaFilename = `/meta/${ts}_${sanitizeFilename(songName)}.json`;
    await dbx.filesUpload({
      path: metaFilename,
      contents: Buffer.from(JSON.stringify(metadata, null, 2), 'utf8'),
      mode: 'add',
      autorename: true
    });

    return res.json({ success: true, path: metadata.path, metaPath: metaFilename, metadata });
  } catch (err) {
    console.error('=== UPLOAD ERROR ===');
    try { console.error(JSON.stringify(err, null, 2)); } catch(e) { console.error(err); }
    return res.status(500).json({ error: String(err) });
  }
});

// Parse / list songs: read /meta folder, fetch each JSON and return songs array
app.get('/parse', async (req, res) => {
  try {
    // list files in /meta
    const listRes = await dbx.filesListFolder({ path: '/meta' }).catch(async (e) => {
      // if folder not found, return empty
      console.warn('filesListFolder /meta failed, returning empty list', e);
      return { result: { entries: [] } };
    });

    const entries = (listRes && listRes.result && listRes.result.entries) || [];

    // For each metadata file, get a temporary link to fetch its content (simpler than filesDownload binary handling)
    const songs = [];
    for (const e of entries) {
      try {
        const tl = await dbx.filesGetTemporaryLink({ path: e.path_lower || e.path_display || e.path_lower });
        const link = tl && (tl.result?.link || tl.link);
        if (!link) {
          console.warn('No temp link for meta:', e.path_display);
          continue;
        }
        // fetch JSON via node-fetch
        const r = await fetch(link);
        if (!r.ok) {
          console.warn('Failed to fetch meta content for', e.path_display, r.status);
          continue;
        }
        const json = await r.json();
        // ensure expected fields
        songs.push({
          songName: json.songName || json.mp3Name || e.name,
          artist: json.artist || 'Unknown',
          coverBase64: json.coverBase64 || null,
          path: json.path || null,
          uploadedAt: json.uploadedAt || null
        });
      } catch (errMeta) {
        console.warn('Error fetching/parsing meta file', e.path_display, errMeta);
      }
    }

    return res.json({ songs });
  } catch (err) {
    console.error('=== LIST ERROR ===');
    try { console.error(JSON.stringify(err, null, 2)); } catch(e) { console.error(err); }
    return res.status(500).json({ error: String(err) });
  }
});

// temp-link endpoint -> returns a direct link to Dropbox-stored file (for playback)
app.get('/temp-link', async (req, res) => {
  try {
    const path = req.query.path;
    if (!path) return res.status(400).json({ error: 'path query param required' });

    const tl = await dbx.filesGetTemporaryLink({ path });
    const link = tl && (tl.result?.link || tl.link);
    if (!link) return res.status(500).json({ error: 'Kein temporärer Link erhalten' });

    return res.json({ link });
  } catch (err) {
    console.error('=== TEMPLINK ERROR ===');
    try { console.error(JSON.stringify(err, null, 2)); } catch(e) { console.error(err); }
    return res.status(500).json({ error: String(err) });
  }
});

// download fallback: fetch the temporary link and stream the file through the server
app.get('/download', async (req, res) => {
  try {
    const path = req.query.path;
    if (!path) return res.status(400).json({ error: 'path query param required' });

    const tl = await dbx.filesGetTemporaryLink({ path });
    const link = tl && (tl.result?.link || tl.link);
    if (!link) return res.status(500).json({ error: 'Kein temporärer Link erhalten' });

    const r = await fetch(link);
    if (!r.ok) return res.status(502).json({ error: 'Failed to fetch file from Dropbox', status: r.status });

    // forward headers (content-type, length) and pipe body
    res.setHeader('content-type', r.headers.get('content-type') || 'application/octet-stream');
    const cl = r.headers.get('content-length');
    if (cl) res.setHeader('content-length', cl);

    // stream
    r.body.pipe(res);
  } catch (err) {
    console.error('=== DOWNLOAD ERROR ===');
    try { console.error(JSON.stringify(err, null, 2)); } catch(e) { console.error(err); }
    return res.status(500).json({ error: String(err) });
  }
});

// Delete file (by Dropbox path) - also attempt to delete corresponding metadata file(s)
app.delete('/delete', express.json(), async (req, res) => {
  try {
    const { path } = req.body;
    if (!path) return res.status(400).json({ error: 'Pfad fehlt' });

    // delete the actual file
    const delRes = await dbx.filesDeleteV2({ path });
    console.log('Deleted file:', delRes && delRes.result && delRes.result.metadata && delRes.result.metadata.name);

    // optionally: remove metadata files that reference this path (scan /meta and delete matches)
    const listRes = await dbx.filesListFolder({ path: '/meta' }).catch(() => ({ result: { entries: [] } }));
    const metaEntries = (listRes && listRes.result && listRes.result.entries) || [];
    for (const e of metaEntries) {
      try {
        const tl = await dbx.filesGetTemporaryLink({ path: e.path_lower || e.path_display });
        const r = await fetch(tl.result?.link || tl.link);
        if (!r.ok) continue;
        const json = await r.json();
        if (json.path === path) {
          await dbx.filesDeleteV2({ path: e.path_lower || e.path_display });
          console.log('Deleted meta file:', e.path_display);
        }
      } catch (errMeta) {
        // ignore per-file errors
      }
    }

    return res.json({ success: true, name: delRes.result && delRes.result.metadata && delRes.result.metadata.name });
  } catch (err) {
    console.error('=== DELETE ERROR ===');
    try { console.error(JSON.stringify(err, null, 2)); } catch(e) { console.error(err); }
    return res.status(500).json({ error: String(err) });
  }
});

// simple root test
app.get('/', (req, res) => res.send('Dropbox Backend (Audionix) läuft ✅'));

app.listen(port, () => console.log(`Server läuft auf http://localhost:${port}`));

