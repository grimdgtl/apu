import http from 'node:http';
import { URL } from 'node:url';
import { google } from 'googleapis';
import 'dotenv/config';

/**
 * Jednokratni helper za dobijanje Google refresh tokena.
 *
 * Pokreni:  npm run auth:google
 * Otvori link koji ispiše, odobri pristup, i skripta će ispisati REFRESH_TOKEN
 * koji treba da nalepiš u .env kao GOOGLE_REFRESH_TOKEN.
 *
 * Preduslov: u .env već imaš GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET i
 * GOOGLE_REDIRECT_URI (podrazumevano http://localhost:3000/oauth2callback).
 */

const SCOPES = ['https://www.googleapis.com/auth/calendar'];

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/oauth2callback';

if (!clientId || !clientSecret) {
  console.error('Nedostaju GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET u .env.');
  process.exit(1);
}

const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

const authUrl = oauth2.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent', // uvek vrati refresh_token
  scope: SCOPES,
});

const port = new URL(redirectUri).port || 3000;

const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith('/oauth2callback')) {
    res.writeHead(404).end();
    return;
  }
  const code = new URL(req.url, redirectUri).searchParams.get('code');
  try {
    const { tokens } = await oauth2.getToken(code);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h2>Uspešno! Možeš da zatvoriš ovaj prozor i vratiš se u terminal.</h2>');

    console.log('\n=========================================================');
    console.log('Nalepi ovo u svoj .env fajl:\n');
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log('=========================================================\n');
  } catch (err) {
    res.writeHead(500).end('Greška pri razmeni koda.');
    console.error(err);
  } finally {
    setTimeout(() => server.close(() => process.exit(0)), 500);
  }
});

server.listen(port, () => {
  console.log('Otvori ovaj URL u browseru i odobri pristup:\n');
  console.log(authUrl + '\n');
});
