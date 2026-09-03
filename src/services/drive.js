import { google } from 'googleapis';
import { config, featureEnabled } from '../config.js';
import { logger } from '../logger.js';

/**
 * Google Drive servis. Koristi isti OAuth nalog kao kalendar, ali traži i
 * Drive scope — pa je posle dodavanja Drive-a potreban NOV refresh token
 * (npm run auth:google). Bez tog scope-a pozivi vraćaju "insufficient scope".
 */

let drive = null;
function getDrive() {
  if (!featureEnabled.drive) {
    throw new Error('Google nije konfigurisan (CLIENT_ID/SECRET/REFRESH_TOKEN).');
  }
  if (!drive) {
    const oauth2 = new google.auth.OAuth2(
      config.google.clientId,
      config.google.clientSecret,
      config.google.redirectUri,
    );
    oauth2.setCredentials({ refresh_token: config.google.refreshToken });
    drive = google.drive({ version: 'v3', auth: oauth2 });
  }
  return drive;
}

const MAX_CONTENT = 6000; // koliko teksta najviše vraćamo modelu

function escapeQuery(s) {
  return String(s).replace(/'/g, "\\'");
}

/**
 * Pretražuje Drive po imenu i sadržaju fajla.
 */
export async function searchFiles({ query, limit = 10 }) {
  const d = getDrive();
  const q = escapeQuery(query);
  const res = await d.files.list({
    q: `trashed = false and (name contains '${q}' or fullText contains '${q}')`,
    pageSize: limit,
    orderBy: 'modifiedTime desc',
    fields: 'files(id, name, mimeType, modifiedTime, webViewLink)',
  });

  const files = (res.data.files || []).map((f) => ({
    id: f.id,
    name: f.name,
    type: f.mimeType,
    modified: f.modifiedTime,
    link: f.webViewLink,
  }));
  logger.debug(`Drive search "${query}": ${files.length} fajlova`);
  return files;
}

/**
 * Čita sadržaj fajla kao tekst. Google Docs se izvoze u tekst, Sheets u CSV,
 * obični tekstualni fajlovi se preuzimaju. Binarni fajlovi (slike, PDF...) se
 * ne čitaju ovde.
 */
export async function readFile({ fileId }) {
  const d = getDrive();
  const meta = await d.files.get({ fileId, fields: 'id, name, mimeType' });
  const mt = meta.data.mimeType || '';
  let content = null;

  if (mt === 'application/vnd.google-apps.document') {
    const r = await d.files.export({ fileId, mimeType: 'text/plain' }, { responseType: 'text' });
    content = r.data;
  } else if (mt === 'application/vnd.google-apps.spreadsheet') {
    const r = await d.files.export({ fileId, mimeType: 'text/csv' }, { responseType: 'text' });
    content = r.data;
  } else if (mt.startsWith('text/') || mt === 'application/json') {
    const r = await d.files.get({ fileId, alt: 'media' }, { responseType: 'text' });
    content = r.data;
  }

  const text =
    content == null
      ? `(fajl tipa ${mt} nije tekstualni — ne mogu da ga pročitam ovde)`
      : String(content).replace(/^﻿/, '').slice(0, MAX_CONTENT); // skini BOM

  logger.info(`Drive: pročitan fajl "${meta.data.name}" (${mt})`);
  return { id: fileId, name: meta.data.name, type: mt, content: text };
}

/**
 * Uploaduje binarni fajl (npr. PDF fakture) na Drive.
 *
 * Odvojeno od createDoc jer taj konvertuje tekst u Google Doc; ovde fajl
 * ostaje takav kakav jeste. Stream se pravi iz bafera da googleapis ne mora
 * ceo sadržaj da drži kao string.
 *
 * @param {{name: string, buffer: Buffer, mimeType?: string, folderId?: string}} opts
 */
export async function uploadFile({ name, buffer, mimeType = 'application/pdf', folderId }) {
  const d = getDrive();
  const { Readable } = await import('node:stream');

  const res = await d.files.create({
    requestBody: {
      name,
      ...(folderId ? { parents: [folderId] } : {}),
    },
    media: { mimeType, body: Readable.from(buffer) },
    fields: 'id, name, webViewLink',
  });

  logger.info(`Drive: uploadovan fajl "${name}" (${buffer.length} B, ${res.data.id})`);
  return { id: res.data.id, name: res.data.name, link: res.data.webViewLink };
}

/**
 * Kreira novi Google Doc sa zadatim tekstom.
 */
export async function createDoc({ name, content = '', folderId }) {
  const d = getDrive();
  const res = await d.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.document',
      ...(folderId ? { parents: [folderId] } : {}),
    },
    media: { mimeType: 'text/plain', body: content },
    fields: 'id, name, webViewLink',
  });

  logger.info(`Drive: kreiran dokument "${name}" (${res.data.id})`);
  return { id: res.data.id, name: res.data.name, link: res.data.webViewLink };
}
