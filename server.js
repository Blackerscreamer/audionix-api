// server.js
// server.js (ES module style)
import express from "express";
import axios from "axios";
import bodyParser from "body-parser";

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

// HIER deine Dropbox App Keys eintragen
const CLIENT_ID = "1w0y4rdnuvbe476";
const CLIENT_SECRET = "je5paqlcai1vxhc";
const REDIRECT_URI = "https://audionix-api-ex4b.onrender.com/auth";

// 1. Startseite mit Login-Link
app.get("/", (req, res) => {
  const authUrl = `https://www.dropbox.com/oauth2/authorize?client_id=${CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(
    REDIRECT_URI
  )}&token_access_type=offline`;
  res.send(`<a href="${authUrl}">Mit Dropbox verbinden</a>`);
});

// 2. Dropbox schickt dich hierher zurück
app.get("/auth", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.send("Kein Code erhalten!");

  try {
    // Code gegen Token austauschen
    const response = await axios.post(
      "https://api.dropbox.com/oauth2/token",
      new URLSearchParams({
        code,
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    const data = response.data;
    res.send(`
      <h1>Dropbox Tokens</h1>
      <p><b>Access Token (kurzlebig):</b> ${data.access_token}</p>
      <p><b>Refresh Token (lange gültig):</b> ${data.refresh_token}</p>
      <p><b>Token Type:</b> ${data.token_type}</p>
      <p><b>Expires In:</b> ${data.expires_in} Sekunden</p>
    `);
  } catch (err) {
    res.send("Fehler beim Token-Austausch: " + err.message);
  }
});

app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
