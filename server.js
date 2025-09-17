import express from 'express';
import multer from 'multer';
import { Dropbox } from 'dropbox';
import fetch from 'node-fetch';
import cors from 'cors';

const app = express();
const port = process.env.PORT || 3000;

// ===== CORS =====
app.use(cors({
  origin: '*' // für Tests ok, später besser Domain einschränken
}));

// ===== Multer für Datei-Upload =====
const upload = multer({ storage: multer.memoryStorage() });

// ===== KONFIGURATION =====
const APP_KEY = '1w0y4rdnuvbe476';
const ACCESS_TOKEN = 'sl.u.AF-UdZilU_PLbwEPJ__A7VFoG_wk6jB840jNm35aCafNCT8GjYLNvBIKChfC0snlXu2ZkYsT5YYC-wRnsQVh_tJNdL5wJ1Qp2Yt0V0rrz6kSRxgHNp4KUJIetkvfGiuP9mdXY-cwAGYS05LRzTY6g5tBAsHdg8YUaACaHpROoVdZZ79BkdH5VptPfgo82KOvoybOgqpeqxJBvF7COezFCl5C5Q_F1qURbEqo7fvmL-eyLQ4f1Sscjqt213KI706AlpYvZAVlUyGsytQhQbJt6q6xeCS-47LWHlQNNHSeDU4wo-xPGj7a7AzLj1OE83kZDHc_2LBJftl9BHOHafzxDIVjtk21-NhAIg90nH5mppoxxOiNY3g-nRZCqTpGRUmZPbVZPbw4EWQB2qQc4mKEFbmyF4AlHMqm34II6JLKgGRr5KJVq8v4EYb5vuGCy9TIJN_3aRAYsrvgHKCh8Yz09V9S1AxXLXRVT_FnGZNbTpTLMgclq34sTCn4_RoALTJGphHn8E-6aB-jQYw3YV6cenR0Ko0Dx2IVNlSlo64c0CBe8ne-24w_xl7336nsftjQwnPoeFwKYnJRp4l5uUzGKk0ap1DpdK-DEB366GfjtPWwunu9OpBX3nTiaFBnMPS7P6PsbasZ5rjtsZY5OIAfJ6Bp5BwLDeh5fR_I3TfMOAo-WEMcpzXqKPcEptROFqx7iCxcppkb8-WOsAaKUS-wN0sLiQsmM4rxEfWPImdDNONlpYkAnt_OHU4-n8IqFy82kZaquP3o4L4-KkE9gl2_lV6whpYBdOem5Ue4KJVeTaQP7bdPyTKah536ceffdOoErgJDzgP0yGP2Te263MNlOPGvqESkHhZX8D__2HLkM-Ku0RfhAY7lM7FMd1UsWeJ8P8P4-Mho3aAf16csnDkhoJktQoxh-gELy3ur-lfs8SlXFMce3wj1f-Upes6WYf_HaFIrHttWWSTKjc2BuePHIXxAlFBgbFdHYNwo_wSyp1nvlMV2wLprj0B_nsSR4ZPRf4INpj4cHTeqb1d-kQkNYdr7FoGbqg4VpqaKnhoen2crw4YGchRLfBmORuiRxb8xtayZJSODIshbwtX5zOzPZrI4lRZHog9uTAi6YtgyP4cDkQbMYGmesulNNvQmYZpGNwKs8J82kNcoU9r1ZZ2H9YE6rMB2N6iMINr1BNmNFNZMnjkG661tK6pXNIhJHKWKterTWdIC6sA1sltXWVQ3FSbklVA7BVYChOB3tdzOCshnZDmFhV9ObmW6z4EuqIfYgpG1eKwYEJ59vSb6fvnYLm67'; // hier neuen gültigen Token einsetzen

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
    console.error('=== UPLOAD ERROR ===');
    console.error(JSON.stringify(err, null, 2)); // vollständige Dropbox-Fehlerausgabe
    res.status(500).json({ error: err });
  }
});

// Parse / List files
app.get('/parse', async (req, res) => {
  try {
    const response = await dbx.filesListFolder({ path: '' });
    res.json({ entries: response.result.entries });
  } catch (err) {
    console.error('=== LIST ERROR ===');
    console.error(JSON.stringify(err, null, 2));
    res.status(500).json({ error: err });
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
    console.error('=== DELETE ERROR ===');
    console.error(JSON.stringify(err, null, 2));
    res.status(500).json({ error: err });
  }
});

// Test
app.get('/', (req, res) => res.send('Dropbox Backend läuft ✅'));

app.listen(port, () => console.log(`Server läuft auf http://localhost:${port}`));
