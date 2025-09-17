import express from 'express';
import multer from 'multer';
import { Dropbox } from 'dropbox';
import fetch from 'node-fetch';
import cors from 'cors';

const app = express();
const port = process.env.PORT || 3000;

// ===== CORS =====
app.use(cors({
  origin: '*' // lokal: Frontend kann alles aufrufen, später besser nur die Domain erlauben
}));

// ===== Multer für Datei-Upload =====
const upload = multer({ storage: multer.memoryStorage() });

// ===== KONFIGURATION =====
const APP_KEY = '1w0y4rdnuvbe476';
const ACCESS_TOKEN = 'sl.u.AF94...'; // hier neuen Token einsetzen

const dbx = new Dropbox({ accessToken: ACCESS_TOKEN, fetch });

// ===== ROUTES =====

// Upload
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Keine Datei hochgeladen' });

    const response = await dbx.filesUpload({
      path: '/' + req.file.originalname,
      contents: req.file.buffer,
      mode: 'add',
      autorename: true
    });

    res.json({ success: true, name: response.result.name });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.error || err.message || 'Upload fehlgeschlagen' });
  }
});

// Parse / List files
app.get('/parse', async (req, res) => {
  try {
    const response = await dbx.filesListFolder({ path: '' });
    res.json({ entries: response.result.entries });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.error || err.message || 'Fehler beim Listen der Dateien' });
  }
});

// Delete file
app.delete('/delete', express.json(), async (req, res) => {
  try {
    const { path } = req.body;
    if (!path) return res.status(400).json({ error: 'Pfad fehlt' });

    const response = await dbx.filesDeleteV2({ path });
    res.json({ success: true, name: response.result.metadata.name });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.error || err.message || 'Löschen fehlgeschlagen' });
  }
});

// Test
app.get('/', (req, res) => res.send('Dropbox Backend läuft ✅'));

app.listen(port, () => console.log(`Server läuft auf http://localhost:${port}`));
