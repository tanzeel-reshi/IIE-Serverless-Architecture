/**
 * IIE Educational Management Platform — Cloud Functions
 * ======================================================
 * SANITIZED FOR PORTFOLIO — All real API keys, project IDs,
 * domain names, email addresses, and phone numbers have been
 * replaced with [YOUR_XXX_HERE] placeholders.
 *
 * Runtime: Node.js 22, Firebase Functions v5 (ESM)
 *
 * Key architectural patterns demonstrated:
 *   - Secret Manager integration (defineSecret) for all credentials
 *   - OG image generation: SVG composed server-side -> JPEG via sharp
 *   - Firestore triggers for async image processing (WebP thumbnails)
 *   - Algolia real-time search indexing (onWrite trigger + bulk callable)
 *   - Student profile lifecycle with referral tracking + Firestore transactions
 *   - Batch QR-code generation for event passes
 *   - Username resolution with legacy schema self-healing
 *   - Admin-only password reset with cryptographically secure generation
 *   - CORS allowlist with localhost passthrough for development
 *   - Email transports via Nodemailer (credentials from Secret Manager)
 */

import * as functions from 'firebase-functions';
import { defineSecret, defineString } from 'firebase-functions/params';
import crypto from 'node:crypto';
import admin from 'firebase-admin';
import corsLib from 'cors';
import QRCode from 'qrcode';
import sharp from 'sharp';
import algoliasearch from 'algoliasearch';
import nodemailer from 'nodemailer';

// ── Secret Manager & Env-var param definitions ──────────────────────────────
// Sensitive credentials stored in Secret Manager:
const GMAIL_EMAIL = defineSecret('GMAIL_EMAIL');
const GMAIL_PASSWORD = defineSecret('GMAIL_PASSWORD');
const LIBRARY_GMAIL_EMAIL = defineSecret('LIBRARY_GMAIL_EMAIL');
const LIBRARY_GMAIL_PASSWORD = defineSecret('LIBRARY_GMAIL_PASSWORD');
const ALGOLIA_APP_ID = defineSecret('ALGOLIA_APP_ID');
const ALGOLIA_ADMIN_KEY = defineSecret('ALGOLIA_ADMIN_KEY');
// Non-sensitive config stored as environment variable:
const ALGOLIA_LIBRARY_INDEX = defineString('ALGOLIA_LIBRARY_INDEX', { default: 'library_books' });
// ─────────────────────────────────────────────────────────────────────────────

const ALLOWED_ORIGINS = new Set([
  'https://[YOUR_DOMAIN_HERE]',
  'https://www.[YOUR_DOMAIN_HERE]',
  'https://[YOUR_FIREBASE_APP_ID].web.app',
  'https://[YOUR_FIREBASE_APP_ID].firebaseapp.com'
]);

const cors = corsLib({
  origin: (origin, callback) => {
    // Allow non-browser requests (no Origin header)
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.has(origin)) return callback(null, true);
    if (/^http:\/\/localhost(:\d+)?$/.test(origin)) return callback(null, true);
    if (/^http:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)) return callback(null, true);
    return callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'content-type', 'authorization'],
  maxAge: 86400,
});

const TEACHER_EMAIL_DOMAIN = 'teachers.[YOUR_DOMAIN_HERE]';

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  if (/^http:\/\/localhost(:\d+)?$/.test(origin)) return true;
  if (/^http:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)) return true;
  return false;
}

function handleCorsPreflight(req, res, opts = {}) {
  if (req.method !== 'OPTIONS') return false;
  const origin = req.headers.origin;
  if (origin && !isAllowedOrigin(origin)) {
    return res.status(403).send('');
  }

  if (origin) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
  }

  const allowMethods = opts.allowMethods || 'POST, OPTIONS';
  const allowHeaders = opts.allowHeaders || 'Authorization, Content-Type, authorization, content-type';
  res.set('Access-Control-Allow-Methods', allowMethods);
  res.set('Access-Control-Allow-Headers', allowHeaders);
  res.set('Access-Control-Allow-Credentials', 'true');
  res.set('Access-Control-Max-Age', '86400');
  return res.status(204).send('');
}

// Configure email transport lazily so Secret Manager values are readable at runtime.
function getMailTransport() {
  return nodemailer.createTransport({
    pool: true,
    maxConnections: 1,
    maxMessages: 100,
    service: 'gmail',
    auth: {
      user: (GMAIL_EMAIL.value() || '').trim(),
      pass: (GMAIL_PASSWORD.value() || '').trim(),
    },
  });
}

function getLibraryMailTransport() {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: (LIBRARY_GMAIL_EMAIL.value() || '').trim(),
      pass: (LIBRARY_GMAIL_PASSWORD.value() || '').trim(),
    },
  });
}

function getLibraryEmailHtml(title, greeting, leadText, details = []) {
  const year = new Date().getFullYear();
  let detailsHtml = '';
  if (details.length > 0) {
    let rows = '';
    for (const item of details) {
      rows += `
        <tr style="border-bottom: 1px solid #f1f5f9;">
          <td style="padding: 12px 0; font-size: 14px; color: #64748b; font-weight: 500; text-align: left; border-bottom: 1px solid #f1f5f9;">${escapeHtml(item.label)}</td>
          <td style="padding: 12px 0; font-size: 14px; color: #0f172a; font-weight: 600; text-align: right; border-bottom: 1px solid #f1f5f9;">${escapeHtml(item.value)}</td>
        </tr>
      `;
    }
    detailsHtml = `
      <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px; margin-bottom: 25px;">
        <table style="width: 100%; border-collapse: collapse;">
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>
    `;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
</head>
<body style="font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f1f5f9; color: #1f2937; margin: 0; padding: 0; -webkit-font-smoothing: antialiased; width: 100% !important;">
  <table border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #f1f5f9; padding: 40px 0;">
    <tr>
      <td align="center">
        <table border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 600px; background-color: #ffffff; border-radius: 16px; box-shadow: 0 4px 20px rgba(27, 68, 138, 0.08); overflow: hidden; border-collapse: collapse;">
          <!-- Header -->
          <tr>
            <td align="center" style="background-color: #1b448a; padding: 40px 40px 35px 40px; text-align: center; border-top-left-radius: 16px; border-top-right-radius: 16px;">
              <h1 style="color: #ffffff; font-size: 24px; font-weight: 700; margin: 0; letter-spacing: -0.5px; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.2;">[YOUR_INSTITUTE_NAME_HERE]</h1>
              <div style="color: #00e676; font-size: 18px; font-weight: 600; margin-top: 10px; font-family: 'Amiri', 'Traditional Arabic', 'Scheherazade New', 'Noto Naskh Arabic', serif; direction: rtl; letter-spacing: 0.5px;">[ARABIC_INSTITUTE_NAME]</div>
            </td>
          </tr>
          <!-- Content -->
          <tr>
            <td style="padding: 40px; background-color: #ffffff;">
              <!-- Right-aligned Arabic Greeting -->
              <div style="text-align: right; font-family: 'Amiri', 'Traditional Arabic', 'Scheherazade New', 'Noto Naskh Arabic', serif; font-size: 24px; color: #1b448a; font-weight: bold; margin-bottom: 25px; direction: rtl; line-height: 1.2;">السَّلَامُ عَلَيْكُمْ وَرَحْمَةُ اللهِ وَبَرَكَاتُهُ،</div>
              
              <h2 style="font-size: 16px; font-weight: 700; margin-top: 0; margin-bottom: 15px; color: #0f172a; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">${escapeHtml(greeting)}</h2>
              <p style="font-size: 15px; line-height: 1.6; color: #475569; margin-top: 0; margin-bottom: 25px; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">${leadText}</p>
              
              ${detailsHtml}
              
              <div style="text-align: center; margin: 30px 0 10px 0;">
                <a href="https://www.[YOUR_DOMAIN_HERE]/library.html" style="background-color: #1b448a; color: #ffffff !important; padding: 12px 30px; text-decoration: none; font-weight: 600; font-size: 14px; border-radius: 6px; display: inline-block; box-shadow: 0 2px 5px rgba(27, 68, 138, 0.2); font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">Go to IIE Library</a>
              </div>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background-color: #1b448a; padding: 40px; text-align: center; color: #cbd5e1; border-bottom-left-radius: 16px; border-bottom-right-radius: 16px;">
              <div style="color: #00e676; font-size: 20px; font-weight: 600; margin-bottom: 12px; font-family: 'Amiri', 'Traditional Arabic', 'Scheherazade New', 'Noto Naskh Arabic', serif; direction: rtl; text-align: center;">[ARABIC_INSTITUTE_NAME]</div>
              <div style="font-size: 12px; color: #cbd5e1; margin-bottom: 20px; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
                [YOUR_ADDRESS_HERE]
              </div>
              <div style="border-top: 1px solid rgba(255, 255, 255, 0.1); margin: 20px 0;"></div>
              <div style="font-size: 13px; line-height: 1.6; color: #cbd5e1; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
                <strong style="color: #ffffff;">Need Help?</strong> Contact the Library Admin:<br>
                Phone/WhatsApp: <a href="tel:+[YOUR_PHONE_DIGITS]" style="color: #38bdf8; text-decoration: none; font-weight: 600;">[YOUR_PHONE_HERE]</a> | Email: <a href="mailto:[YOUR_LIBRARY_EMAIL_HERE]" style="color: #38bdf8; text-decoration: none; font-weight: 600;">[YOUR_LIBRARY_EMAIL_HERE]</a>
              </div>
              <div style="font-size: 11px; color: #94a3b8; margin-top: 25px; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
                &copy; ${year} [YOUR_INSTITUTE_NAME_HERE]. All rights reserved.
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function getModernEmailHtml(title, greeting, messageHtml, ctaText, ctaUrl) {
  const year = new Date().getFullYear();
  let ctaHtml = '';
  if (ctaText && ctaUrl) {
    ctaHtml = `
      <div style="text-align: center; margin: 35px 0 20px 0;">
        <a href="${ctaUrl}" style="background-color: #10b981; color: #ffffff !important; padding: 14px 32px; text-decoration: none; font-weight: 600; font-size: 16px; border-radius: 8px; display: inline-block; box-shadow: 0 4px 6px -1px rgba(16, 185, 129, 0.2), 0 2px 4px -1px rgba(16, 185, 129, 0.1); font-family: 'Inter', -apple-system, sans-serif;">${escapeHtml(ctaText)}</a>
      </div>
    `;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
</head>
<body style="font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f8fafc; color: #334155; margin: 0; padding: 0; -webkit-font-smoothing: antialiased; width: 100% !important;">
  <table border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #f8fafc; padding: 50px 0;">
    <tr>
      <td align="center">
        <table border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 600px; background-color: #ffffff; border-radius: 20px; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.05), 0 8px 10px -6px rgba(0, 0, 0, 0.01); overflow: hidden; border-collapse: collapse;">
          <!-- Header -->
          <tr>
            <td align="center" style="background-color: #1e3a8a; padding: 45px 40px; text-align: center;">
              <h1 style="color: #ffffff; font-size: 26px; font-weight: 800; margin: 0; letter-spacing: -0.5px; font-family: 'Inter', -apple-system, sans-serif;">[YOUR_INSTITUTE_NAME_HERE]</h1>
              <div style="color: #6ee7b7; font-size: 19px; font-weight: 600; margin-top: 12px; font-family: 'Amiri', serif; direction: rtl; letter-spacing: 0.5px;">[ARABIC_INSTITUTE_NAME]</div>
            </td>
          </tr>
          <!-- Content -->
          <tr>
            <td style="padding: 45px 40px; background-color: #ffffff;">
              <div style="text-align: right; font-family: 'Amiri', serif; font-size: 24px; color: #1e3a8a; font-weight: bold; margin-bottom: 30px; direction: rtl; line-height: 1.4;">السَّلَامُ عَلَيْكُمْ وَرَحْمَةُ اللهِ وَبَرَكَاتُهُ،</div>
              
              <h2 style="font-size: 20px; font-weight: 700; margin-top: 0; margin-bottom: 20px; color: #0f172a; font-family: 'Inter', -apple-system, sans-serif;">${escapeHtml(greeting)}</h2>
              <div style="font-size: 16px; line-height: 1.6; color: #475569; margin-top: 0; margin-bottom: 10px; font-family: 'Inter', -apple-system, sans-serif;">
                ${messageHtml}
              </div>
              
              ${ctaHtml}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background-color: #f1f5f9; padding: 35px 40px; text-align: center; border-top: 1px solid #e2e8f0;">
              <div style="font-size: 14px; line-height: 1.6; color: #64748b; font-family: 'Inter', -apple-system, sans-serif; margin-bottom: 15px;">
                <strong style="color: #334155;">Need Help?</strong><br>
                Phone/WhatsApp: <a href="tel:+[YOUR_PHONE_DIGITS]" style="color: #2563eb; text-decoration: none; font-weight: 600;">[YOUR_PHONE_HERE]</a><br>
                Email: <a href="mailto:[YOUR_SUPPORT_EMAIL_HERE]" style="color: #2563eb; text-decoration: none; font-weight: 600;">[YOUR_SUPPORT_EMAIL_HERE]</a>
              </div>
              <div style="font-size: 12px; color: #94a3b8; font-family: 'Inter', -apple-system, sans-serif;">
                &copy; ${year} [YOUR_INSTITUTE_NAME_HERE]. All rights reserved.<br>
                [YOUR_ADDRESS_HERE]
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

try { admin.app(); } catch { admin.initializeApp(); }
const db = admin.firestore();
const storage = admin.storage();
const THUMB_MAX_WIDTH = 800; // px
const THUMB_QUALITY = 80; // webp quality

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeXml(s) {
  // Suitable for SVG text nodes and attributes.
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function isPreviewBot(userAgent) {
  const ua = String(userAgent || '').toLowerCase();
  return (
    ua.includes('whatsapp') ||
    ua.includes('facebookexternalhit') ||
    ua.includes('facebot') ||
    ua.includes('twitterbot') ||
    ua.includes('slackbot') ||
    ua.includes('discordbot') ||
    ua.includes('linkedinbot') ||
    ua.includes('telegrambot') ||
    ua.includes('googlebot')
  );
}

function buildAbsoluteUrl(req, pathAndQuery) {
  const proto = (req.headers['x-forwarded-proto'] || 'https').toString().split(',')[0].trim() || 'https';
  const host = (req.headers['x-forwarded-host'] || req.headers.host || 'www.[YOUR_DOMAIN_HERE]').toString().split(',')[0].trim();
  const path = String(pathAndQuery || '/');
  return `${proto}://${host}${path.startsWith('/') ? path : `/${path}`}`;
}

function wrapTextLines(text, { maxCharsPerLine = 34, maxLines = 4 } = {}) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return ['Untitled'];
  const words = t.split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (!cur) {
      cur = w;
      continue;
    }
    if ((cur + ' ' + w).length <= maxCharsPerLine) {
      cur += ' ' + w;
    } else {
      lines.push(cur);
      cur = w;
      if (lines.length >= maxLines) break;
    }
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  // If overflow, ellipsize last line
  if (lines.length > maxLines) lines.length = maxLines;
  if (words.length && lines.length === maxLines) {
    const joined = lines.join(' ');
    if (joined.length < t.length) {
      lines[maxLines - 1] = String(lines[maxLines - 1]).replace(/\s*$/, '') + '…';
    }
  }
  return lines;
}

// (Logo removed from OG image)

async function getWritingForShare(writingId) {
  if (!writingId) return null;
  const snap = await db.collection('writings').doc(String(writingId)).get();
  if (!snap.exists) return null;
  const d = snap.data() || {};
  const title = String(d.title || 'Untitled');
  const content = String(d.content || d.body || '');
  const updatedAtMs = (() => {
    try {
      const ts = d.updatedAt || d.publishedAt || d.createdAt || null;
      const date = ts?.toDate ? ts.toDate() : ts ? new Date(ts) : null;
      const ms = date && !Number.isNaN(date.getTime()) ? date.getTime() : 0;
      return ms || 0;
    } catch {
      return 0;
    }
  })();
  const desc = content.replace(/\s+/g, ' ').trim().slice(0, 180);
  return { id: String(writingId), title, desc, updatedAtMs };
}

export const writingShare = functions.region('us-central1').https.onRequest(async (req, res) => {
  try {
    const writingId = String(req.query?.writing || req.query?.id || '');

    const w = await getWritingForShare(writingId);
    const institute = '[YOUR_INSTITUTE_NAME_HERE]';
    const title = w?.title || 'Featured Writing';
    const desc = w?.desc || institute;
    const pageUrl = buildAbsoluteUrl(req, `/w?writing=${encodeURIComponent(writingId)}`);
    const imgUrl = buildAbsoluteUrl(
      req,
      `/og/writing?writing=${encodeURIComponent(writingId)}${w?.updatedAtMs ? `&v=${encodeURIComponent(String(w.updatedAtMs))}` : ''}&lv=7`
    );

    const dest = `/writing-reader.html?writing=${encodeURIComponent(writingId)}`;

    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} | ${escapeHtml(institute)}</title>
  <meta name="description" content="${escapeHtml(desc)}" />

  <link rel="canonical" href="${escapeHtml(pageUrl)}" />

  <meta property="og:title" content="${escapeHtml(title)}" />
  <meta property="og:description" content="${escapeHtml(desc)}" />
  <meta property="og:type" content="article" />
  <meta property="og:url" content="${escapeHtml(pageUrl)}" />
  <meta property="og:site_name" content="${escapeHtml(institute)}" />
  <meta property="og:image" content="${escapeHtml(imgUrl)}" />
  <meta property="og:image:secure_url" content="${escapeHtml(imgUrl)}" />
  <meta property="og:image:type" content="image/jpeg" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:image:alt" content="${escapeHtml(title)} — ${escapeHtml(institute)}" />

  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escapeHtml(title)}" />
  <meta name="twitter:description" content="${escapeHtml(desc)}" />
  <meta name="twitter:image" content="${escapeHtml(imgUrl)}" />

  <script>
    (function () {
      try {
        window.location.replace(${JSON.stringify(dest)});
      } catch {
        window.location.href = ${JSON.stringify(dest)};
      }
    })();
  </script>
</head>
<body>
  <p>Opening… <a href="${escapeHtml(dest)}">Open writing</a></p>
</body>
</html>`;

    res.set('Content-Type', 'text/html; charset=utf-8');
    // Cache lightly so crawlers get consistent results.
    res.set('Cache-Control', 'public, max-age=300');
    return res.status(200).send(html);
  } catch (err) {
    console.error('writingShare error', err);
    res.set('Cache-Control', 'no-cache');
    return res.status(200).send('<!doctype html><meta charset="utf-8"><title>Writing</title>');
  }
});

export const ogWritingImage = functions.region('us-central1').https.onRequest(async (req, res) => {
  try {
    const writingId = String(req.query?.writing || req.query?.id || '');
    const w = await getWritingForShare(writingId);
    const title = w?.title || 'Featured Writing';

    const institute = '[YOUR_INSTITUTE_NAME_HERE]';
    const phone = '[YOUR_PHONE_HERE]';
    const email = '[YOUR_CONTACT_EMAIL_HERE]';
    const website = 'www.[YOUR_DOMAIN_HERE]';
    const lines = wrapTextLines(title, { maxCharsPerLine: 34, maxLines: 4 });
    const titleXml = lines.map((ln) => escapeXml(ln));
    const instituteXml = escapeXml(institute);
    const phoneXml = escapeXml(phone);
    const emailXml = escapeXml(email);
    const websiteXml = escapeXml(website);

    const svg = `
<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0" stop-color="#0b3a8f"/>
      <stop offset="0.55" stop-color="#0f3d88"/>
      <stop offset="1" stop-color="#059669"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="14" stdDeviation="18" flood-color="#000" flood-opacity="0.22"/>
    </filter>
  </defs>

  <rect width="1200" height="630" fill="url(#bg)"/>
  <circle cx="130" cy="90" r="160" fill="rgba(255,255,255,0.14)"/>
  <circle cx="1140" cy="540" r="220" fill="rgba(255,255,255,0.12)"/>

  <g filter="url(#shadow)">
    <rect x="70" y="80" width="1060" height="470" rx="34" fill="rgba(255,255,255,0.96)"/>
  </g>

  <g>
    <rect x="110" y="120" width="360" height="48" rx="24" fill="rgba(30,58,138,0.08)"/>
    <text x="140" y="153" font-family="Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial" font-size="22" font-weight="800" fill="#1e3a8a">${instituteXml}</text>
  </g>

  <g>
    <text x="120" y="270" font-family="Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial" font-size="46" font-weight="900" fill="#0f172a">
      <tspan x="120" dy="0">${titleXml[0] || ''}</tspan>
      <tspan x="120" dy="52">${titleXml[1] || ''}</tspan>
      <tspan x="120" dy="52">${titleXml[2] || ''}</tspan>
      <tspan x="120" dy="52">${titleXml[3] || ''}</tspan>
    </text>
  </g>

  <g>
    <text x="120" y="468" font-family="Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial" font-size="21" font-weight="900" fill="#1f2937">${phoneXml}</text>
    <text x="120" y="498" font-family="Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial" font-size="21" font-weight="900" fill="#1f2937">${emailXml}</text>
    <text x="120" y="528" font-family="Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial" font-size="21" font-weight="900" fill="#1f2937">${websiteXml}</text>
  </g>
</svg>`;

    const basePng = await sharp(Buffer.from(svg)).png().toBuffer();

    // JPEG is smaller than PNG => loads faster in WhatsApp previews.
    const jpg = await sharp(basePng).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=604800, s-maxage=604800, immutable');
    return res.status(200).send(jpg);
  } catch (err) {
    console.error('ogWritingImage error', err);
    res.set('Cache-Control', 'no-cache');
    return res.status(500).send('');
  }
});

async function getSponsorForShare(bookId) {
  if (!bookId) return null;
  let snap = await db.collection('sponsorshipOpportunities').doc(String(bookId)).get();
  if (!snap.exists) {
    snap = await db.collection('libraryBooks').doc(String(bookId)).get();
  }
  if (!snap.exists) return null;
  const d = snap.data() || {};
  const title = String(d.title || 'Untitled');
  const desc = String(d.description || d.author || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  const coverUrl = (typeof d.coverUrl === 'string' && d.coverUrl.trim()) ? d.coverUrl.trim() : '';
  return { id: String(bookId), title, desc, coverUrl };
}

export const sponsorShare = functions.region('us-central1').https.onRequest(async (req, res) => {
  try {
    const bookId = String(req.query?.book || req.query?.id || '');
    const lv = String(req.query?.lv || '').trim();

    const w = await getSponsorForShare(bookId);
    // WhatsApp preview: user requested to hide the title line.
    // Use a zero-width space so scrapers don't fall back to other page text.
    const ogTitle = '\u200B';
    // WhatsApp preview: user requested to hide the description line.
    // Use a zero-width space so scrapers don't fall back to body text.
    const desc = '\u200B';

    const pageQs = [`book=${encodeURIComponent(bookId)}`];
    if (lv) pageQs.push(`lv=${encodeURIComponent(lv)}`);
    const pageUrl = buildAbsoluteUrl(req, `/sponsor?${pageQs.join('&')}`);

    const imgUrl = (w?.coverUrl && String(w.coverUrl).startsWith('http'))
      ? String(w.coverUrl)
      : buildAbsoluteUrl(req, `/og/sponsor?book=${encodeURIComponent(bookId)}&lv=1`);

    const dest = `/library.html?book=${encodeURIComponent(bookId)}`;

    const isCover = Boolean(w?.coverUrl && String(w.coverUrl).startsWith('http'));
    const ogImageExtra = isCover
      ? ''
      : `\n  <meta property="og:image:type" content="image/jpeg" />\n  <meta property="og:image:width" content="1200" />\n  <meta property="og:image:height" content="630" />`;

    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(ogTitle)}</title>

  <link rel="canonical" href="${escapeHtml(pageUrl)}" />

  <meta name="description" content="${escapeHtml(desc)}" />

  <meta property="og:title" content="${escapeHtml(ogTitle)}" />
  <meta property="og:description" content="${escapeHtml(desc)}" />
  <meta property="og:type" content="website" />
  <meta property="og:url" content="${escapeHtml(pageUrl)}" />
  <meta property="og:image" content="${escapeHtml(imgUrl)}" />
  <meta property="og:image:secure_url" content="${escapeHtml(imgUrl)}" />
  ${ogImageExtra}

  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escapeHtml(ogTitle)}" />
  <meta name="twitter:description" content="${escapeHtml(desc)}" />
  <meta name="twitter:image" content="${escapeHtml(imgUrl)}" />

  <script>
    (function () {
      try {
        window.location.replace(${JSON.stringify(dest)});
      } catch {
        window.location.href = ${JSON.stringify(dest)};
      }
    })();
  </script>
</head>
<body>
  <p>Opening… <a href="${escapeHtml(dest)}">Open library</a></p>
</body>
</html>`;

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=300');
    return res.status(200).send(html);
  } catch (err) {
    console.error('sponsorShare error', err);
    res.set('Cache-Control', 'no-cache');
    return res.status(200).send('<!doctype html><meta charset="utf-8"><title>Sponsor</title>');
  }
});

export const ogSponsorImage = functions.region('us-central1').https.onRequest(async (req, res) => {
  try {
    const bookId = String(req.query?.book || req.query?.id || '');
    const w = await getSponsorForShare(bookId);
    const title = w?.title || 'Sponsor a Library Book';

    const institute = '[YOUR_INSTITUTE_NAME_HERE]';
    const phone = '[YOUR_PHONE_HERE]';
    const email = '[YOUR_CONTACT_EMAIL_HERE]';
    const website = 'www.[YOUR_DOMAIN_HERE]';
    const hadith = '"The believer\'s shade on the Day of Resurrection will be his charity." (Tirmidhi)';

    const lines = wrapTextLines(title, { maxCharsPerLine: 34, maxLines: 3 });
    const titleXml = lines.map((ln) => escapeXml(ln));
    const instituteXml = escapeXml(institute);
    const phoneXml = escapeXml(phone);
    const emailXml = escapeXml(email);
    const websiteXml = escapeXml(website);
    const hadithXml = escapeXml(hadith);

    const svg = `
<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0" stop-color="#0b3a8f"/>
      <stop offset="0.55" stop-color="#0f3d88"/>
      <stop offset="1" stop-color="#059669"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="14" stdDeviation="18" flood-color="#000" flood-opacity="0.22"/>
    </filter>
  </defs>

  <rect width="1200" height="630" fill="url(#bg)"/>
  <circle cx="130" cy="90" r="160" fill="rgba(255,255,255,0.14)"/>
  <circle cx="1140" cy="540" r="220" fill="rgba(255,255,255,0.12)"/>

  <g filter="url(#shadow)">
    <rect x="70" y="80" width="1060" height="470" rx="34" fill="rgba(255,255,255,0.96)"/>
  </g>

  <g>
    <rect x="110" y="120" width="360" height="48" rx="24" fill="rgba(30,58,138,0.08)"/>
    <text x="140" y="153" font-family="Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial" font-size="22" font-weight="800" fill="#1e3a8a">${instituteXml}</text>
  </g>

  <g>
    <text x="120" y="240" font-family="Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial" font-size="46" font-weight="900" fill="#0f172a">
      <tspan x="120" dy="0">${titleXml[0] || ''}</tspan>
      <tspan x="120" dy="52">${titleXml[1] || ''}</tspan>
      <tspan x="120" dy="52">${titleXml[2] || ''}</tspan>
    </text>
  </g>

  <g>
    <rect x="110" y="350" width="980" height="60" rx="12" fill="rgba(5,150,105,0.1)"/>
    <text x="130" y="388" font-family="Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial" font-size="24" font-style="italic" font-weight="600" fill="#059669">${hadithXml}</text>
  </g>

  <g>
    <text x="120" y="458" font-family="Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial" font-size="21" font-weight="900" fill="#1f2937">${phoneXml}</text>
    <text x="120" y="488" font-family="Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial" font-size="21" font-weight="900" fill="#1f2937">${emailXml}</text>
    <text x="120" y="518" font-family="Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial" font-size="21" font-weight="900" fill="#1f2937">${websiteXml}</text>
  </g>
</svg>`;

    const basePng = await sharp(Buffer.from(svg)).png().toBuffer();

    const jpg = await sharp(basePng).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=604800, s-maxage=604800, immutable');
    return res.status(200).send(jpg);
  } catch (err) {
    console.error('ogSponsorImage error', err);
    res.set('Cache-Control', 'no-cache');
    return res.status(500).send('');
  }
});

// Firestore trigger: when programs/{programId} has a coverPath set or changed (and no coverThumb),
// generate a resized WebP thumbnail and save its URL to coverThumb.
export const generateProgramCoverThumbOnWrite = functions
  .region('us-central1')
  .firestore.document('programs/{programId}')
  .onWrite(async (change, context) => {
    try {
      const after = change.after.exists ? (change.after.data() || {}) : null;
      if (!after) return null;
      const before = change.before.exists ? (change.before.data() || {}) : {};
      const coverPath = typeof after.coverPath === 'string' ? after.coverPath : '';
      if (!coverPath || !coverPath.startsWith('programs/')) return null;
      const coverChanged = coverPath !== (before.coverPath || '');
      const needsThumb = !after.coverThumb;
      if (!(coverChanged || needsThumb)) return null;

      const bucket = admin.storage().bucket();
      const file = bucket.file(coverPath);
      const [exists] = await file.exists();
      if (!exists) return null;

      const [meta] = await file.getMetadata();
      const contentType = meta?.contentType || '';
      if (contentType && !contentType.startsWith('image/')) return null;

      const [srcBuf] = await file.download();
      const thumbBuf = await sharp(srcBuf)
        .rotate()
        .resize({ width: THUMB_MAX_WIDTH, withoutEnlargement: true })
        .webp({ quality: THUMB_QUALITY })
        .toBuffer();

      const thumbPath = coverPath.replace(/([^/]+)$/i, 'thumbs/$1').replace(/\.[^.]+$/i, '.webp');
      const thumbFile = bucket.file(thumbPath);
      await thumbFile.save(thumbBuf, { metadata: { contentType: 'image/webp', cacheControl: 'public, max-age=31536000, immutable' } });

      // Ensure token for download URL compatibility
      const [tMeta] = await thumbFile.getMetadata();
      let token = tMeta?.metadata?.firebaseStorageDownloadTokens || '';
      if (!token) {
        token = crypto.randomUUID();
        await thumbFile.setMetadata({ metadata: { firebaseStorageDownloadTokens: token }, contentType: 'image/webp', cacheControl: 'public, max-age=31536000, immutable' });
      }
      const encodedPath = encodeURIComponent(thumbPath);
      const bucketName = bucket.name;
      const thumbUrl = `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(bucketName)}/o/${encodedPath}?alt=media&token=${token}`;

      await change.after.ref.set({ coverThumb: thumbUrl, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      return null;
    } catch (err) {
      console.error('generateProgramCoverThumbOnWrite error', err);
      return null;
    }
  });

// HTTPS endpoint: resolve username to email privately (usernames collection only; legacy studentIds read kept temporarily)
export const resolveUsernameToEmail = functions.region('us-central1').https.onRequest(async (req, res) => {
  cors(req, res, async () => {
    try {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
      const { username } = req.body || {};
      if (!username || typeof username !== 'string') return res.status(400).json({ error: 'username required' });
      const unameLC = String(username).toLowerCase();
      if (!/^[a-z0-9._-]{3,20}$/.test(unameLC)) return res.status(400).json({ error: 'invalid username' });
      let mapDoc = await db.collection('usernames').doc(unameLC).get();
      if (!mapDoc.exists) {
        const legacyDoc = await db.collection('studentIds').doc(unameLC).get();
        if (legacyDoc.exists) mapDoc = legacyDoc; // read-only fallback
      }
      if (!mapDoc.exists) {
        // Teacher Accounts fallback: allow deterministic mapping for teacher IDs
        // so login.html can accept Teacher ID even if the usernames doc is missing.
        const teacherEmail = `${unameLC}@${TEACHER_EMAIL_DOMAIN}`;
        try {
          const rec = await admin.auth().getUserByEmail(teacherEmail);
          if (rec?.email) return res.json({ email: String(rec.email).toLowerCase() });
        } catch {
          // If not found, fall through to 404
        }
        return res.status(404).json({ error: 'not found' });
      }
      // Transitional legacy support: some production docs may still have only { email } stored (older schema)
      // We attempt a one-time self-healing migration here to add ownerUid and strip the email.
      let { ownerUid, email: legacyEmail } = mapDoc.data() || {};
      if (!ownerUid) {
        try {
          if (legacyEmail && typeof legacyEmail === 'string') {
            const legacyEmailLC = legacyEmail.toLowerCase();
            // Prefer students collection (new canonical source) then fallback to users
            let studentSnap = null;
            const studentQuery = await db.collection('students').where('email', '==', legacyEmailLC).limit(1).get();
            if (!studentQuery.empty) studentSnap = studentQuery.docs[0];
            // Fallback to users collection if student doc not found
            if (!studentSnap) {
              const userQuery = await db.collection('users').where('email', '==', legacyEmailLC).limit(1).get();
              if (!userQuery.empty) studentSnap = userQuery.docs[0];
            }
            if (studentSnap) {
              ownerUid = studentSnap.id;
              // Best-effort background update (no need to await inside request path for speed, but we will await to ensure consistency)
              try {
                await mapDoc.ref.set({ ownerUid, email: admin.firestore.FieldValue.delete() }, { merge: true });
                console.log('resolveUsernameToEmail self-healed mapping for', unameLC, '->', ownerUid);
              } catch (healErr) {
                console.warn('Self-heal failed for', unameLC, healErr);
              }
            }
          }
        } catch (legacyErr) {
          console.warn('Legacy fallback failed for', unameLC, legacyErr);
        }
      }
      if (!ownerUid) return res.status(404).json({ error: 'not found' });

      // Read email from students collection only (students no longer stored in users)
      const studentDoc = await db.collection('students').doc(ownerUid).get();
      let email = null;
      if (studentDoc.exists) {
        email = (studentDoc.data() || {}).email || null;
      } else {
        // Fallback: legacy non-student roles may only exist in users collection
        const userDoc = await db.collection('users').doc(ownerUid).get();
        if (userDoc.exists) {
          email = (userDoc.data() || {}).email || null;
        }
      }
      // Final fallback: fetch from Auth user record (handles cases where Firestore lacks email)
      if (!email) {
        try {
          const userRec = await admin.auth().getUser(ownerUid);
          if (userRec && typeof userRec.email === 'string' && userRec.email) {
            email = userRec.email;
          }
        } catch (authErr) {
          console.warn('Auth fallback failed for ownerUid', ownerUid, authErr);
        }
      }
      if (!email || typeof email !== 'string') return res.status(404).json({ error: 'not found' });

      return res.json({ email: String(email).toLowerCase() });
    } catch (err) {
      console.error('resolveUsernameToEmail error', err);
      return res.status(500).json({ error: 'internal' });
    }
  });
});

// ---------- Algolia Search Indexing for Library (optional) ----------
function getAlgoliaClient() {
  const appId = ALGOLIA_APP_ID.value();
  const apiKey = ALGOLIA_ADMIN_KEY.value();
  const indexName = ALGOLIA_LIBRARY_INDEX.value();
  if (!appId || !apiKey) return null;
  const client = algoliasearch(appId, apiKey);
  return { client, index: client.initIndex(indexName) };
}

export const indexLibraryBookOnWrite = functions
  .runWith({ secrets: [ALGOLIA_APP_ID, ALGOLIA_ADMIN_KEY] })
  .region('us-central1')
  .firestore.document('libraryBooks/{bookId}')
  .onWrite(async (change, context) => {
    const algo = getAlgoliaClient();
    if (!algo) return null;
    const { index } = algo;
    const bookId = context.params.bookId;
    if (!change.after.exists) {
      try { await index.deleteObject(bookId); } catch (e) { console.warn('Algolia delete failed', bookId, e); }
      return null;
    }
    const data = change.after.data() || {};
    const record = {
      objectID: bookId,
      title: data.title || '',
      title_ar: data.title_ar || '',
      titleLC: (data.titleLC || (data.title || '').toLowerCase()),
      authors: Array.isArray(data.authors) ? data.authors : [],
      categories: Array.isArray(data.categories) ? data.categories : [],
      languages: Array.isArray(data.languages) ? data.languages : [],
      description: data.description || '',
      coverUrl: data.coverUrl || null,
      thumbnails: data.thumbnails || null,
      updatedAt: Date.now()
    };
    try { await index.saveObject(record); } catch (e) { console.error('Algolia save failed', bookId, e); }
    return null;
  });

export const reindexAllLibraryBooks = functions.region('us-central1').https.onCall(async (data, context) => {
  try {
    const uid = context.auth?.uid || null;
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Sign in required');
    if (!(await hasPermission(uid, 'canManageLibrary'))) throw new functions.https.HttpsError('permission-denied', 'Admin or Library Manager only');
    const algo = getAlgoliaClient();
    if (!algo) throw new functions.https.HttpsError('failed-precondition', 'Algolia not configured');
    const { index } = algo;
    const snap = await db.collection('libraryBooks').get();
    const batch = [];
    snap.forEach(d => {
      const x = d.data() || {};
      batch.push({
        objectID: d.id,
        title: x.title || '',
        title_ar: x.title_ar || '',
        titleLC: (x.titleLC || (x.title || '').toLowerCase()),
        authors: Array.isArray(x.authors) ? x.authors : [],
        categories: Array.isArray(x.categories) ? x.categories : [],
        languages: Array.isArray(x.languages) ? x.languages : [],
        description: x.description || '',
        coverUrl: x.coverUrl || null,
        thumbnails: x.thumbnails || null,
        updatedAt: Date.now()
      });
    });
    if (batch.length) await index.saveObjects(batch);
    return { ok: true, count: batch.length };
  } catch (err) {
    console.error('reindexAllLibraryBooks error', err);
    if (err instanceof functions.https.HttpsError) throw err;
    throw new functions.https.HttpsError('internal', 'reindex failed');
  }
});

function generateStrongPassword({ length = 12 } = {}) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const symbols = '!@#$%_-';
  const pick = (set) => set[crypto.randomInt(0, set.length)];

  const n = Math.max(10, Math.min(64, Number(length) || 12));
  let out = '';
  // Ensure at least 1 symbol
  for (let i = 0; i < n - 1; i++) out += pick(alphabet);
  out += pick(symbols);

  // Fisher–Yates shuffle
  const arr = out.split('');
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.join('');
}

export const adminResetTeacherPassword = functions.region('us-central1').https.onCall(async (data, context) => {
  try {
    const callerUid = context.auth?.uid || null;
    if (!callerUid) throw new functions.https.HttpsError('unauthenticated', 'Sign in required');
    if (!(await isAdmin(callerUid))) throw new functions.https.HttpsError('permission-denied', 'Admin only');

    const rawUid = (typeof data?.uid === 'string') ? data.uid.trim() : '';
    const rawTeacherIdLC = (typeof data?.teacherIdLC === 'string') ? data.teacherIdLC.trim().toLowerCase() : '';
    const rawTeacherId = (typeof data?.teacherId === 'string') ? data.teacherId.trim().toLowerCase() : '';
    const teacherIdLC = rawTeacherIdLC || rawTeacherId;

    let targetUid = rawUid;
    if (!targetUid) {
      if (!teacherIdLC) throw new functions.https.HttpsError('invalid-argument', 'uid or teacherIdLC required');
      const q = await db.collection('users').where('teacherIdLC', '==', teacherIdLC).limit(1).get();
      if (q.empty) throw new functions.https.HttpsError('not-found', 'Teacher not found');
      targetUid = q.docs[0].id;
    }

    const userRef = db.collection('users').doc(targetUid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) throw new functions.https.HttpsError('not-found', 'Teacher profile not found');
    const u = userSnap.data() || {};

    const isTeacher = (u.role === 'Teacher') || (Array.isArray(u.roles) && u.roles.includes('Teacher'));
    if (!isTeacher) throw new functions.https.HttpsError('failed-precondition', 'Target is not a Teacher');

    // Limit to the Teacher Accounts system (or same derived-email scheme)
    const email = String(u.email || '').toLowerCase();
    const usesTeacherDomain = email.endsWith('@teachers.[YOUR_DOMAIN_HERE]');
    const marked = u.teacherAccountSystem === true;
    const hasTeacherId = !!String(u.teacherIdLC || u.teacherId || '').trim();
    if (!(marked || (usesTeacherDomain && hasTeacherId))) {
      throw new functions.https.HttpsError('permission-denied', 'Not a managed teacher account');
    }

    const reqNewPass = (typeof data?.newPassword === 'string') ? data.newPassword.trim() : '';
    const newPassword = reqNewPass || generateStrongPassword({ length: 12 });
    if (newPassword.length < 8 || newPassword.length > 64) {
      throw new functions.https.HttpsError('invalid-argument', 'Invalid password length');
    }

    try {
      await admin.auth().updateUser(targetUid, { password: newPassword });
    } catch (e) {
      const code = String(e?.code || '');
      if (code.includes('auth/user-not-found')) throw new functions.https.HttpsError('not-found', 'Auth user not found');
      console.error('adminResetTeacherPassword updateUser failed', { targetUid, code });
      throw new functions.https.HttpsError('internal', 'Password reset failed');
    }

    await userRef.set({
      passwordResetAt: admin.firestore.FieldValue.serverTimestamp(),
      passwordResetBy: callerUid,
    }, { merge: true });

    return {
      ok: true,
      uid: targetUid,
      teacherIdLC: String(u.teacherIdLC || teacherIdLC || '').toLowerCase(),
      password: newPassword,
    };
  } catch (err) {
    console.error('adminResetTeacherPassword error', err);
    if (err instanceof functions.https.HttpsError) throw err;
    throw new functions.https.HttpsError('internal', 'Password reset failed');
  }
});

// Admin-protected endpoint to strip any lingering `email` fields from public usernames mapping
export const migrateStripEmailsFromUsernames = functions.region('us-central1').https.onRequest(async (req, res) => {
  cors(req, res, async () => {
    try {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
      const authHeader = req.headers.authorization || '';
      if (!authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
      const idToken = authHeader.substring('Bearer '.length);
      const decoded = await admin.auth().verifyIdToken(idToken);
      const uid = decoded.uid;
      const userDoc = await db.collection('users').doc(uid).get();
      const role = userDoc.exists ? userDoc.data().role : null;
      if (role !== 'Admin') return res.status(403).json({ error: 'Forbidden' });

      // Iterate in batches
      const batchSize = 300;
      let total = 0;
      let last = null;
      // Use paginated reads
      while (true) {
        let q = db.collection('usernames').orderBy(admin.firestore.FieldPath.documentId());
        if (last) q = q.startAfter(last);
        const snap = await q.limit(batchSize).get();
        if (snap.empty) break;
        const batch = db.batch();
        snap.docs.forEach(docSnap => {
          const data = docSnap.data() || {};
          if (Object.prototype.hasOwnProperty.call(data, 'email')) {
            batch.update(docSnap.ref, { email: admin.firestore.FieldValue.delete() });
          }
        });
        await batch.commit();
        total += snap.docs.length;
        last = snap.docs[snap.docs.length - 1];
        if (snap.size < batchSize) break;
      }

      return res.json({ status: 'ok', processed: total });
    } catch (err) {
      console.error('migrateStripEmailsFromUsernames error', err);
      return res.status(500).json({ error: 'internal' });
    }
  });
});

// Secure: Create/Update the signed-in user's student profile (One-Time Signup)
// Requires Firebase ID token in Authorization: Bearer <token>
// Body: { fullName: string, phone?: string }
export const createStudentProfile = functions.runWith({ secrets: [GMAIL_EMAIL, GMAIL_PASSWORD] }).region('us-central1').https.onRequest(async (req, res) => {
  if (handleCorsPreflight(req, res, { allowHeaders: 'Authorization, Content-Type, authorization, content-type' })) return;
  cors(req, res, async () => {
    try {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
      const authHeader = req.headers.authorization || '';
      if (!authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
      const idToken = authHeader.substring('Bearer '.length);
      const decoded = await admin.auth().verifyIdToken(idToken);
      const uid = decoded.uid;
      const email = decoded.email || null;

      // Basic payload validation
      const { fullName, phone, gender } = (req.body || {});
      if (!fullName || typeof fullName !== 'string' || fullName.trim().length < 2) {
        return res.status(400).json({ error: 'fullName required' });
      }
      if (phone && typeof phone !== 'string') {
        return res.status(400).json({ error: 'invalid phone' });
      }
      // Phone format validation: must look like a real phone number
      if (phone && !/^\+?[\d\s\-().]{7,25}$/.test(phone.trim())) {
        return res.status(400).json({ error: 'invalid phone format' });
      }

      const now = admin.firestore.FieldValue.serverTimestamp();

      // Server-side guard: if a users/{uid} doc exists with a non-student role, block creation
      try {
        const userDoc = await db.collection('users').doc(uid).get();
        if (userDoc.exists) {
          const uData = userDoc.data() || {};
          const primaryRole = uData.role;
          const rolesArray = Array.isArray(uData.roles) ? uData.roles : [];
          const isStudentRole = primaryRole === 'Student' || rolesArray.includes('Student');
          // Define any role that is not strictly Student as disallowed for auto student profile creation
          if (!isStudentRole) {
            return res.status(403).json({ error: 'forbidden: non-student role' });
          }
        }
      } catch (guardErr) {
        console.error('createStudentProfile guard error', guardErr);
        return res.status(500).json({ error: 'internal' });
      }

      // Single collection approach: only students/{uid}
      const studentRef = db.collection('students').doc(uid);
      const studentSnap = await studentRef.get();
      const existingData = studentSnap.exists ? (studentSnap.data() || {}) : {};

      // Rate limit / idempotency: if a fully-formed profile already exists, block re-creation.
      // Updates must go through updateStudentContact instead.
      if (studentSnap.exists && existingData.createdAt && existingData.fullName) {
        return res.status(200).json({ success: true, message: 'profile already exists' });
      }
      const keepFullName = existingData.fullName && typeof existingData.fullName === 'string' && existingData.fullName.trim().length > 1;
      const studentPayload = {
        role: 'Student',
        userUid: uid,
        // Only set/overwrite fullName if it doesn't already exist
        ...(keepFullName ? {} : { fullName: fullName.trim() }),
        email: email,
        phone: phone ? phone.trim() : (studentSnap.exists ? existingData.phone || null : null),
        ...(gender && typeof gender === 'string' ? { gender: gender.trim() } : {}),
        // Always set status to Pending for new students (auto-approve logic may override this below)
        ...(!studentSnap.exists ? { status: 'Pending' } : {}),
        updatedAt: now,
        ...(studentSnap.exists ? {} : { createdAt: now })
      };


      // Referral logic: check if referredBy parameter is provided during creation
      const { referredBy } = (req.body || {});
      if (referredBy && typeof referredBy === 'string' && referredBy.trim().length > 0) {
        const refCode = referredBy.trim();
        let referrerUid = null;
        let referrerData = null;

        // Try searching by UID first
        const refDoc = await db.collection('students').doc(refCode).get();
        if (refDoc.exists) {
          referrerUid = refCode;
          referrerData = refDoc.data();
        } else {
          // Try searching by username (case-insensitive)
          const refQuery = await db.collection('students').where('usernameLC', '==', refCode.toLowerCase()).limit(1).get();
          if (!refQuery.empty) {
            referrerUid = refQuery.docs[0].id;
            referrerData = refQuery.docs[0].data();
          }
        }

        if (referrerUid && referrerUid !== uid) {
          studentPayload.referredBy = referrerUid;
          studentPayload._referrerData = referrerData;
        }
      }

      // Generate sequential Enrollment ID only if the student is Approved and doesn't have one
      const currentStatus = studentPayload.status || existingData.status || 'Pending';
      if (currentStatus === 'Approved' && (!studentSnap.exists || !existingData.enrollmentId)) {
        try {
          const newEnrollmentId = await db.runTransaction(async (transaction) => {
            const counterRef = db.collection('metadata').doc('enrollmentCounter');
            const counterDoc = await transaction.get(counterRef);
            let currentCount = 0;
            if (counterDoc.exists) {
              currentCount = counterDoc.data().count || 0;
            }
            const newCount = currentCount + 1;
            transaction.set(counterRef, { count: newCount }, { merge: true });

            const date = new Date();
            const mm = String(date.getMonth() + 1).padStart(2, '0');
            const yy = String(date.getFullYear()).slice(-2);
            return `IIE-${mm}-${yy}-R-${newCount}`;
          });
          studentPayload.enrollmentId = newEnrollmentId;
        } catch (e) {
          console.error('Error generating enrollmentId', e);
        }
      }

      const batch = db.batch();
      if (studentPayload.referredBy) {
        const referrerUid = studentPayload.referredBy;
        const referrerData = studentPayload._referrerData || {};
        delete studentPayload._referrerData;

        // Increment referrer's stats in students/{referrerUid}
        batch.update(db.collection('students').doc(referrerUid), {
          referralsCount: admin.firestore.FieldValue.increment(1)
        });

        // Set/Increment referrer's public leaderboard document
        batch.set(db.collection('referralLeaderboard').doc(referrerUid), {
          fullName: referrerData.fullName || 'Student',
          username: referrerData.username || '',
          count: admin.firestore.FieldValue.increment(1),
          updatedAt: now
        }, { merge: true });
      }

      batch.set(studentRef, studentPayload, { merge: true });
      await batch.commit();


      // Send Welcome Email for new profiles
      if (!studentSnap.exists && email) {
        try {
          const transport = getMailTransport();
          // Detect if name contains Arabic or Urdu characters → RTL
          const displayName = fullName ? fullName.trim() : 'Student';
          const hasRTL = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/.test(displayName);
          const nameDir = hasRTL ? 'rtl' : 'ltr';
          const nameFont = hasRTL ? "'Traditional Arabic', 'Amiri', 'Times New Roman', serif" : "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif";
          const nameAlign = hasRTL ? 'right' : 'left';

          const htmlContent = `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Amiri&display=swap" rel="stylesheet">
<style>
  body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f4f7f6; margin: 0; padding: 0; }
  .container { max-width: 600px; margin: 40px auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,0.06); }
  .header { background: linear-gradient(135deg, #1e1e64 0%, #303090 100%); padding: 35px 20px; text-align: center; color: #ffffff; }
  .header h1 { margin: 0 0 6px; font-size: 24px; font-weight: 700; letter-spacing: 0.5px; }
  .header .arabic { font-family: 'Traditional Arabic', 'Amiri', 'Times New Roman', serif; font-size: 24px; font-weight: 700; direction: rtl; margin: 8px 0 0; color: #4ade80; }
  .content { padding: 36px 30px; color: #334155; line-height: 1.7; font-size: 15.5px; }
  .content p { margin: 0 0 16px; }
  .greeting-arabic { font-family: 'Traditional Arabic', 'Amiri', 'Times New Roman', serif; font-size: 19px; direction: rtl; text-align: right; color: #303090; font-weight: 600; margin: 0 0 8px; }
  .btn-container { text-align: center; margin: 32px 0 20px; }
  .btn { background: #20a040; color: #ffffff; text-decoration: none; padding: 14px 30px; border-radius: 50px; font-weight: 600; font-size: 15px; display: inline-block; box-shadow: 0 4px 12px rgba(32,160,64,0.3); }
  .highlight { color: #303090; font-weight: 700; }
  .divider { border: none; border-top: 1px solid #e8ecf0; margin: 24px 0; }
  .contact-box { background: #f0f2ff; border-left: 4px solid #303090; border-radius: 0 8px 8px 0; padding: 16px 20px; margin: 20px 0; }
  .contact-box h3 { margin: 0 0 10px; font-size: 13px; font-weight: 700; color: #303090; text-transform: uppercase; letter-spacing: 0.08em; }
  .contact-row { display: flex; align-items: flex-start; gap: 10px; margin: 6px 0; font-size: 13.5px; color: #334155; }
  .contact-label { font-weight: 600; min-width: 60px; color: #303090; }
  .footer { background: #1e1e64; padding: 22px 20px; text-align: center; color: #a0aac8; font-size: 12.5px; }
  .footer .arabic-footer { font-family: 'Traditional Arabic', 'Amiri', 'Times New Roman', serif; font-size: 20px; font-weight: 700; color: #4ade80; direction: rtl; margin-bottom: 6px; }
  .footer a { color: #7b88d0; text-decoration: none; }
</style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>[YOUR_INSTITUTE_NAME_HERE]</h1>
      <div class="arabic">[ARABIC_INSTITUTE_NAME]</div>
    </div>
    <div class="content">
      <p class="greeting-arabic">السلام عليكم ورحمة الله وبركاته،</p>
      <p style="font-family:${nameFont};direction:${nameDir};text-align:${nameAlign};font-size:16px;">
        <span class="highlight">${escapeHtml(displayName)}</span>
      </p>
      <p>We are absolutely thrilled to welcome you to the <strong>[YOUR_INSTITUTE_NAME_HERE]</strong>. Your student account has been successfully created.</p>
      <p>With your new account, you can now explore our programs, manage your profile, and embark on a fulfilling educational journey with us.</p>
      <div class="btn-container">
        <a href="https://[YOUR_DOMAIN_HERE]/student.html" class="btn" style="color: #ffffff;">Go to Student Portal</a>
      </div>
      <p>If you have any questions or need assistance, please do not hesitate to contact us using the details below.</p>
      <div class="contact-box">
        <h3>Contact Us</h3>
        <div class="contact-row"><span class="contact-label">Phone:</span> <span>[YOUR_PHONE_HERE]</span></div>
        <div class="contact-row"><span class="contact-label">Email:</span> <a href="mailto:[YOUR_SUPPORT_EMAIL_HERE]" style="color:#303090;">[YOUR_SUPPORT_EMAIL_HERE]</a></div>
        <div class="contact-row"><span class="contact-label">Address:</span> <span>[YOUR_ADDRESS_HERE]</span></div>
      </div>
      <hr class="divider">
      <p style="margin:0;">Warm regards,<br><strong>[YOUR_INSTITUTE_NAME_HERE]</strong></p>
    </div>
    <div class="footer">
      <div class="arabic-footer">[ARABIC_INSTITUTE_NAME]</div>
      <p style="margin:4px 0;">&copy; ${new Date().getFullYear()} [YOUR_INSTITUTE_NAME_HERE]. All rights reserved.</p>
    </div>
  </div>
</body>
</html>`;
          await transport.sendMail({
            from: '"[YOUR_INSTITUTE_NAME_HERE]" <[YOUR_DOMAIN_HERE]@gmail.com>',
            to: email,
            subject: 'Welcome to the [YOUR_INSTITUTE_NAME_HERE]! 🎉',
            html: htmlContent
          });
          console.log(`Welcome email sent to ${email}`);
        } catch (mailErr) {
          console.error('Failed to send welcome email', mailErr);
        }
      }

      return res.json({ status: 'ok' });
    } catch (err) {
      console.error('createStudentProfile error', err);
      return res.status(500).json({ error: 'internal' });
    }
  });
});

// Admin-protected endpoint: recompute rollNumber for all registrations of a program
// Body: { programId: string }
// Authorization: Bearer <idToken> of an Admin user
export const recomputeRollNumbersForProgram = functions.region('us-central1').https.onRequest(async (req, res) => {
  cors(req, res, async () => {
    try {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
      const authHeader = req.headers.authorization || '';
      if (!authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
      const idToken = authHeader.substring('Bearer '.length);
      const decoded = await admin.auth().verifyIdToken(idToken);
      const uid = decoded.uid;
      const userDoc = await db.collection('users').doc(uid).get();
      const role = userDoc.exists ? userDoc.data().role : null;
      if (role !== 'Admin') return res.status(403).json({ error: 'Forbidden' });

      const programId = (req.body && req.body.programId) ? String(req.body.programId).trim() : '';
      if (!programId) return res.status(400).json({ error: 'programId required' });

      const programRef = db.collection('programs').doc(programId);
      const pSnap = await programRef.get();
      if (!pSnap.exists) return res.status(404).json({ error: 'program missing' });
      const p = pSnap.data() || {};

      // Build shared parts of formatted roll (year/season removed from format)
      const rawCode = (p.programCode && typeof p.programCode === 'string') ? String(p.programCode).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) : null;
      const programCodePart = rawCode || 'GEN';
      // season/year previously used; kept out intentionally

      const pageSize = 200;
      let last = null;
      let scanned = 0;
      let updated = 0;

      while (true) {
        let q = programRef.collection('registrations').orderBy(admin.firestore.FieldPath.documentId());
        if (last) q = q.startAfter(last);
        const snap = await q.limit(pageSize).get();
        if (snap.empty) break;

        // Prepare a batched update for rollNumber changes
        const batch = db.batch();
        const qrJobs = [];
        for (const doc of snap.docs) {
          scanned++;
          const data = doc.data() || {};
          // Only recompute for registrations that have a numeric sequence
          const seq = (typeof data.rollSeq === 'number') ? data.rollSeq : null;
          if (seq === null) continue;
          const seqStr = String(seq).padStart(3, '0');
          const prefix = programCodePart.startsWith('IIE') ? '' : 'IIE';
          const formatted = `${prefix}${programCodePart}${seqStr}`;
          if (data.rollNumber !== formatted) {
            batch.update(doc.ref, { rollNumber: formatted });
            updated++;
            // schedule QR regeneration for this doc after commit
            qrJobs.push({ ref: doc.ref, formatted, registrationId: doc.id, studentUid: data.studentUid || doc.id });
          }
        }

        try {
          await batch.commit();
        } catch (bErr) {
          console.error('Batch commit failed during recomputeRollNumbersForProgram', bErr);
        }

        // Regenerate QR codes for updated docs
        for (const job of qrJobs) {
          try {
            const payload = { t: 'event-pass', programId, registrationId: job.registrationId, studentUid: job.studentUid, rollNumber: job.formatted, ts: Date.now() };
            const qrDataUrl = await QRCode.toDataURL(JSON.stringify(payload), { errorCorrectionLevel: 'M', margin: 1, scale: 4 });
            await job.ref.set({ qr: qrDataUrl }, { merge: true });
          } catch (qrErr) {
            console.error('QR generation failed during recomputeRollNumbersForProgram for', job.registrationId, qrErr);
          }
        }

        last = snap.docs[snap.docs.length - 1];
        if (snap.size < pageSize) break;
      }

      return res.json({ status: 'ok', scanned, updated });
    } catch (err) {
      console.error('recomputeRollNumbersForProgram error', err);
      return res.status(500).json({ error: 'internal' });
    }
  });
});

// Secure: Update the signed-in student's contact information (students/{uid})
// Body: { fullName?: string, parentage?: string, gender?: string, address?: string, pin?: string, altPhone?: string, officialIdUrl?: string, photoUrl?: string, notificationPrefs?: { inApp?: boolean, email?: boolean, whatsapp?: boolean } }
export const updateStudentContact = functions.region('us-central1').https.onRequest(async (req, res) => {
  if (handleCorsPreflight(req, res)) return;
  cors(req, res, async () => {
    try {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
      const authHeader = req.headers.authorization || '';
      if (!authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
      const idToken = authHeader.substring('Bearer '.length);
      const decoded = await admin.auth().verifyIdToken(idToken);
      const uid = decoded.uid;
      const email = decoded.email || null;

      const { fullName, parentage, gender, address, pin, altPhone, officialIdUrl, photoUrl, notificationPrefs, education, dob } = (req.body || {});
      // Basic sanitization: allow empty/undefined (will not overwrite with empty), allow strings only
      function strOrNull(v) { return (typeof v === 'string' && v.trim().length > 0) ? v.trim() : null; }
      function boolOrNull(v) { return (v === true) ? true : ((v === false) ? false : null); }
      function sanitizeNotificationPrefs(v) {
        if (!v || typeof v !== 'object') return null;
        const out = {};
        const inApp = boolOrNull(v.inApp);
        const emailPref = boolOrNull(v.email);
        const whatsapp = boolOrNull(v.whatsapp);
        if (inApp !== null) out.inApp = inApp;
        if (emailPref !== null) out.email = emailPref;
        if (whatsapp !== null) out.whatsapp = whatsapp;
        return Object.keys(out).length ? out : null;
      }

      const now = admin.firestore.FieldValue.serverTimestamp();
      const studentRef = db.collection('students').doc(uid);
      const studentSnap = await studentRef.get();
      const existing = studentSnap.exists ? (studentSnap.data() || {}) : {};
      
      // Save existing profile to history for auditing/soft-delete tracking
      if (studentSnap.exists) {
        try {
          await studentRef.collection('history').add({
            ...existing,
            archivedAt: now,
            archivedReason: 'profile_update'
          });
        } catch (historyErr) {
          console.error('Failed to save student history', historyErr);
          // Non-fatal, continue with update
        }
      }

      const existingVerification = (existing.verification && typeof existing.verification === 'object') ? existing.verification : {};
      const nextVerification = {
        email: decoded.email_verified === true,
        phone: (typeof existingVerification.phone === 'boolean') ? existingVerification.phone : false
      };
      // If the token contains a Firebase-verified phone number, upgrade phone verification to true.
      if (typeof decoded.phone_number === 'string' && decoded.phone_number.trim().length > 0) {
        nextVerification.phone = true;
      }

      const prefs = sanitizeNotificationPrefs(notificationPrefs);
      const studentPayload = {
        updatedAt: now,
        role: 'Student',
        userUid: uid,
        email: email,
        verification: nextVerification,
        ...(prefs ? { notificationPrefs: prefs } : {}),
        ...(strOrNull(fullName) ? { fullName: strOrNull(fullName) } : {}),
        ...(strOrNull(parentage) ? { parentage: strOrNull(parentage) } : { parentage: admin.firestore.FieldValue.delete() }),
        ...(strOrNull(gender) ? { gender: strOrNull(gender) } : { gender: admin.firestore.FieldValue.delete() }),
        ...(strOrNull(address) ? { address: strOrNull(address) } : { address: admin.firestore.FieldValue.delete() }),
        ...(strOrNull(pin) ? { pin: strOrNull(pin) } : { pin: admin.firestore.FieldValue.delete() }),
        ...(strOrNull(altPhone) ? { altPhone: strOrNull(altPhone) } : { altPhone: admin.firestore.FieldValue.delete() }),
        ...(strOrNull(officialIdUrl) ? { officialIdUrl: strOrNull(officialIdUrl) } : { officialIdUrl: admin.firestore.FieldValue.delete() }),
        ...(strOrNull(photoUrl) ? { photoUrl: strOrNull(photoUrl) } : { photoUrl: admin.firestore.FieldValue.delete() }),
        ...(strOrNull(education) ? { education: strOrNull(education) } : { education: admin.firestore.FieldValue.delete() }),
        ...(strOrNull(dob) && /^\d{4}-\d{2}-\d{2}$/.test(strOrNull(dob)) ? { dob: strOrNull(dob) } : { dob: admin.firestore.FieldValue.delete() }),
        ...(studentSnap.exists ? {} : { createdAt: now })
      };
      await studentRef.set(studentPayload, { merge: true });

      // Auto-approve on profile completion: if autoApproveStudents is ON
      // AND the student is still Pending AND the profile is now complete, approve them.
      try {
        const freshSnap = await studentRef.get();
        const fresh = freshSnap.exists ? (freshSnap.data() || {}) : {};
        const currentStatus = fresh.status || 'Pending';
        const alreadyApproved = ['Approved', 'Active', 'Enrolled'].includes(currentStatus);

        if (!alreadyApproved) {
          // Check profile completeness using the same required fields as the student portal
          const hasFn = typeof fresh.fullName === 'string' && fresh.fullName.trim().length > 1;
          const hasPar = typeof fresh.parentage === 'string' && fresh.parentage.trim().length > 0;
          const hasGen = typeof fresh.gender === 'string' && fresh.gender.trim().length > 0;
          const hasPhone = typeof fresh.phone === 'string' && fresh.phone.trim().length > 0;
          const hasAddr = typeof fresh.address === 'string' && fresh.address.trim().length > 0;
          const hasPin = /^\d{6}$/.test((fresh.pin || '').trim());
          const hasDob = /^\d{4}-\d{2}-\d{2}$/.test((fresh.dob || '').trim());
          const hasId = typeof fresh.officialIdUrl === 'string' && fresh.officialIdUrl.trim().length > 0;
          const hasEdu = typeof fresh.education === 'string' && fresh.education.trim().length > 0;
          const genderLC = (fresh.gender || '').trim().toLowerCase();
          const isFemale = genderLC === 'female' || genderLC === 'f';
          const hasPhoto = isFemale || (typeof fresh.photoUrl === 'string' && fresh.photoUrl.trim().length > 0);

          const isProfileComplete = hasFn && hasPar && hasGen && hasPhone && hasAddr && hasPin && hasDob && hasId && hasEdu && hasPhoto;

          if (isProfileComplete) {
            // Profile is now complete — check auto-approve setting
            const settingsSnap = await db.collection('settings').doc('global').get();
            const autoApprove = settingsSnap.exists ? (settingsSnap.data() || {}).autoApproveStudents === true : false;
            if (autoApprove) {
              await studentRef.update({
                status: 'Approved',
                approvedAt: admin.firestore.FieldValue.serverTimestamp(),
                approvedBy: 'system:auto-approve'
              });
              return res.json({ status: 'ok', autoApproved: true });
            }
          }
        }
      } catch (autoErr) {
        console.warn('Auto-approve check failed (non-fatal):', autoErr);
      }

      return res.json({ status: 'ok' });
    } catch (err) {

      console.error('updateStudentContact error', err);
      return res.status(500).json({ error: 'internal' });
    }
  });
});

// ---------- Library: Physical books reservations ----------
// Callable: Reserve a book (creates reservation if stock available and user has no active reservation)
export const reservePhysicalBook = functions.region('us-central1').https.onCall(async (data, context) => {
  try {
    const uid = context.auth?.uid || null;
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Sign in required');
    const bookId = (typeof data?.bookId === 'string') ? data.bookId.trim() : '';
    if (!bookId) throw new functions.https.HttpsError('invalid-argument', 'bookId required');
    // Optional reservation details coming from client form
    const details = (data && typeof data === 'object' && data.details && typeof data.details === 'object') ? data.details : {};
    const cleanStr = (v, max = 160) => {
      if (typeof v !== 'string') return null;
      const s = v.trim();
      if (!s) return null;
      return s.slice(0, max);
    };
    const contactName = cleanStr(details.name, 100);
    const contactPhone = cleanStr(details.phone, 40);
    const contactEmail = cleanStr(details.email, 100);
    const parentage = cleanStr(details.parentage, 120);
    const address = cleanStr(details.address, 260);
    const pin = cleanStr(details.pin, 16);
    const aadhaarUrl = cleanStr(details.aadhaarUrl, 2000);
    const termsRaw = Array.isArray(details.terms) ? details.terms.slice(0, 20) : [];
    const terms = termsRaw
      .map((x) => ({ text: cleanStr(x?.text, 240), required: !!x?.required, checked: !!x?.checked }))
      .filter((x) => !!x.text);
    const notes = cleanStr(details.notes, 500);
    let pickupDate = null;
    if (details && typeof details.pickupDate === 'string') {
      const d = new Date(details.pickupDate);
      if (!isNaN(d.getTime())) pickupDate = admin.firestore.Timestamp.fromDate(d);
    }

    const bookRef = db.collection('libraryBooks').doc(bookId);
    const resCol = db.collection('libraryReservations');
    let reservationId = null;

    await db.runTransaction(async (tx) => {
      const bookSnap = await tx.get(bookRef);
      if (!bookSnap.exists) throw new functions.https.HttpsError('not-found', 'Book not found');
      const book = bookSnap.data() || {};
      const total = Number(book.copiesTotal || 0);
      const activeCount = Number(book.activeReservations || 0);
      if (total <= 0) throw new functions.https.HttpsError('failed-precondition', 'No copies');
      if (activeCount >= total) throw new functions.https.HttpsError('failed-precondition', 'All copies reserved');

      // Ensure user does not have an active reservation for this book
      const q = resCol.where('bookId', '==', bookId).where('userUid', '==', uid).where('status', '==', 'active').limit(1);
      const existing = await tx.get(q);
      if (!existing.empty) throw new functions.https.HttpsError('already-exists', 'Already reserved');

      const newRef = resCol.doc();
      reservationId = newRef.id;
      tx.set(newRef, {
        bookId,
        userUid: uid,
        status: 'active',
        placedAt: admin.firestore.FieldValue.serverTimestamp(),
        expiresAt: null,
        // Store user-provided details for librarian review
        form: {
          name: contactName || null,
          phone: contactPhone || null,
          email: contactEmail || null,
          parentage: parentage || null,
          address: address || null,
          pin: pin || null,
          pickupDate: pickupDate || null,
          notes: notes || null,
          aadhaarUrl: aadhaarUrl || null,
          terms: terms || []
        }
      });
      // Optimistic increment; the onWrite trigger will also maintain consistency
      tx.update(bookRef, {
        activeReservations: admin.firestore.FieldValue.increment(1),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    return { ok: true, reservationId };
  } catch (err) {
    console.error('reservePhysicalBook error', err);
    if (err instanceof functions.https.HttpsError) throw err;
    throw new functions.https.HttpsError('internal', 'Reservation failed');
  }
});

// Callable: Cancel user's active reservation (sets status to cancelled)
export const cancelPhysicalReservation = functions.region('us-central1').https.onCall(async (data, context) => {
  try {
    const uid = context.auth?.uid || null;
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Sign in required');
    const reservationId = (typeof data?.reservationId === 'string') ? data.reservationId.trim() : '';
    if (!reservationId) throw new functions.https.HttpsError('invalid-argument', 'reservationId required');
    const isRequest = data?.type === 'request';
    const rejectionReason = (typeof data?.reason === 'string') ? data.reason.trim() : null;

    const collectionName = isRequest ? 'libraryReservationRequests' : 'libraryReservations';
    const resRef = db.collection(collectionName).doc(reservationId);

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(resRef);
      if (!snap.exists) throw new functions.https.HttpsError('not-found', 'Reservation missing');
      const res = snap.data() || {};

      // For requests, usually only admin can cancel/reject via this flow, or the user themselves if we tracked uid
      if (isRequest) {
        if (!(await hasPermission(uid, 'canManageLibrary'))) throw new functions.https.HttpsError('permission-denied', 'Admin or Library Manager only');
        if (res.status === 'pending') {
          const updateData = { status: 'rejected', rejectedAt: admin.firestore.FieldValue.serverTimestamp() };
          if (rejectionReason) updateData.rejectionReason = rejectionReason;
          tx.update(resRef, updateData);
        }
        return;
      }

      if (res.userUid !== uid && !(await hasPermission(uid, 'canManageLibrary'))) {
        throw new functions.https.HttpsError('permission-denied', 'Not allowed');
      }
      if (res.status !== 'active') {
        // idempotent
        tx.update(resRef, { status: 'cancelled', cancelledAt: admin.firestore.FieldValue.serverTimestamp() });
        return;
      }
      tx.update(resRef, { status: 'cancelled', cancelledAt: admin.firestore.FieldValue.serverTimestamp() });
      if (res.bookId) {
        const bookRef = db.collection('libraryBooks').doc(res.bookId);
        tx.update(bookRef, { activeReservations: admin.firestore.FieldValue.increment(-1), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      }
    });
    return { ok: true };
  } catch (err) {
    console.error('cancelPhysicalReservation error', err);
    if (err instanceof functions.https.HttpsError) throw err;
    throw new functions.https.HttpsError('internal', 'Cancel failed');
  }
});

// Callable: Request a book when all copies are out (records interest)
export const requestPhysicalBook = functions.region('us-central1').https.onCall(async (data, context) => {
  try {
    const uid = context.auth?.uid || null;
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Sign in required');
    const bookId = (typeof data?.bookId === 'string') ? data.bookId.trim() : '';
    if (!bookId) throw new functions.https.HttpsError('invalid-argument', 'bookId required');

    const bookRef = db.collection('libraryBooks').doc(bookId);
    const reqCol = db.collection('libraryRequests');
    await db.runTransaction(async (tx) => {
      const bookSnap = await tx.get(bookRef);
      if (!bookSnap.exists) throw new functions.https.HttpsError('not-found', 'Book not found');
      // Prevent duplicate active request by same user
      const existingQ = reqCol.where('bookId', '==', bookId).where('userUid', '==', uid).where('status', '==', 'active').limit(1);
      const existing = await tx.get(existingQ);
      if (!existing.empty) throw new functions.https.HttpsError('already-exists', 'Already requested');
      const newRef = reqCol.doc();
      tx.set(newRef, {
        bookId,
        userUid: uid,
        status: 'active',
        placedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      // Optional counter on book doc
      tx.set(bookRef, { requestedCount: admin.firestore.FieldValue.increment(1), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    });
    return { ok: true };
  } catch (err) {
    console.error('requestPhysicalBook error', err);
    if (err instanceof functions.https.HttpsError) throw err;
    throw new functions.https.HttpsError('internal', 'Request failed');
  }
});

async function hasPermission(uid, flag) {
  try {
    const userDoc = await db.collection('users').doc(uid).get();
    if (!userDoc.exists) return false;
    const d = userDoc.data() || {};

    // Admin always has permission
    if (d.role === 'Admin' || (Array.isArray(d.roles) && d.roles.includes('Admin'))) {
      return true;
    }

    // Check specific delegation
    if (flag && d.tempPermissions && typeof d.tempPermissions === 'object') {
      const hasFlag = d.tempPermissions[flag] === true;
      const expiresAt = d.tempPermissions.expiresAt;

      if (hasFlag && expiresAt) {
        const now = admin.firestore.Timestamp.now();
        // Ensure expiresAt is a Timestamp
        const expMillis = expiresAt.toMillis ? expiresAt.toMillis() : new Date(expiresAt).getTime();
        if (expMillis > now.toMillis()) {
          return true;
        }
      }
    }

    return false;
  } catch (e) {
    console.error('hasPermission check failed', e);
    return false;
  }
}

async function isAdmin(uid) {
  try {
    const userDoc = await db.collection('users').doc(uid).get();
    if (!userDoc.exists) return false;
    const d = userDoc.data() || {};
    return d.role === 'Admin' || (Array.isArray(d.roles) && d.roles.includes('Admin'));
  } catch {
    return false;
  }
}

// Trigger: keep libraryBooks.activeReservations in sync with libraryReservations status changes
export const maintainLibraryActiveReservations = functions
  .region('us-central1')
  .firestore.document('libraryReservations/{resId}')
  .onWrite(async (change, context) => {
    try {
      const before = change.before.exists ? (change.before.data() || {}) : null;
      const after = change.after.exists ? (change.after.data() || {}) : null;
      const bookId = (after?.bookId) || (before?.bookId);
      if (!bookId) return null;
      const bookRef = db.collection('libraryBooks').doc(bookId);

      // Determine delta: +1 on new active, -1 on active -> non-active, +1 on non-active -> active
      const wasActive = before && before.status === 'active';
      const isActive = after && after.status === 'active';
      let delta = 0;
      if (!before && isActive) delta = 1; // create active
      else if (before && !after && wasActive) delta = -1; // delete active
      else if (before && after && wasActive && !isActive) delta = -1; // active -> other
      else if (before && after && !wasActive && isActive) delta = 1; // other -> active
      if (delta === 0) return null;

      await bookRef.set({ activeReservations: admin.firestore.FieldValue.increment(delta), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      return null;
    } catch (err) {
      console.error('maintainLibraryActiveReservations error', err);
      return null;
    }
  });

// Callable: Checkout a reservation into a loan
export const checkoutPhysicalReservation = functions
  .runWith({ secrets: [LIBRARY_GMAIL_EMAIL, LIBRARY_GMAIL_PASSWORD] })
  .region('us-central1').https.onCall(async (data, context) => {
    try {
      const uid = context.auth?.uid || null;
      if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Sign in required');
      // Admin only
      if (!(await hasPermission(uid, 'canManageLibrary'))) throw new functions.https.HttpsError('permission-denied', 'Admin or Library Manager only');
      const reservationId = (typeof data?.reservationId === 'string') ? data.reservationId.trim() : '';
      const dueDateStr = (typeof data?.dueDate === 'string') ? data.dueDate.trim() : '';
      if (!reservationId || !dueDateStr) throw new functions.https.HttpsError('invalid-argument', 'reservationId and dueDate required');
      const due = new Date(dueDateStr);
      if (isNaN(due.getTime())) throw new functions.https.HttpsError('invalid-argument', 'Invalid due date');
      const isRequest = data?.type === 'request';

      const collectionName = isRequest ? 'libraryReservationRequests' : 'libraryReservations';
      const resRef = db.collection(collectionName).doc(reservationId);

      const { r, book } = await db.runTransaction(async (tx) => {
        const snap = await tx.get(resRef);
        if (!snap.exists) throw new functions.https.HttpsError('not-found', 'Reservation missing');
        const r = snap.data() || {};

        if (isRequest) {
          if (!['pending', 'update_sent', 'response_received'].includes(r.status)) throw new functions.https.HttpsError('failed-precondition', 'Request not pending or active');
        } else {
          if (r.status !== 'active') throw new functions.https.HttpsError('failed-precondition', 'Reservation not active');
        }

        const bookRef = db.collection('libraryBooks').doc(r.bookId);
        const bookSnap = await tx.get(bookRef);
        if (!bookSnap.exists) throw new functions.https.HttpsError('not-found', 'Book missing');
        const book = bookSnap.data() || {};

        // Create loan
        const loanRef = db.collection('libraryLoans').doc();
        tx.set(loanRef, {
          reservationId, // This is the doc ID of the request/reservation
          trackingId: r.reservationId || null, // This is the custom IIEZL... ID
          bookId: r.bookId,
          userUid: r.userUid || 'anonymous', // Requests might not have uid
          borrowerName: r.name || (r.form && r.form.name) || null, // Store name for anonymous loans
          borrowerEmail: r.email || (r.form && r.form.email) || null, // Store email for notifications
          phone: r.phone || (r.form && r.form.phone) || null,
          parentage: r.parentage || (r.form && r.form.parentage) || null,
          address: r.address || (r.form && r.form.address) || null,
          pin: r.pin || (r.form && r.form.pin) || null,
          pickupDate: r.pickupDate || (r.form && r.form.pickupDate) || null,
          notes: r.notes || (r.form && r.form.notes) || null,
          terms: r.terms || (r.form && r.form.terms) || null,
          status: 'active',
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          dueDate: admin.firestore.Timestamp.fromDate(due)
        });

        tx.update(resRef, { status: 'fulfilled', fulfilledAt: admin.firestore.FieldValue.serverTimestamp() });

        tx.update(bookRef, { activeLoans: admin.firestore.FieldValue.increment(1), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        return { r, book };
      });

      // Send email notification
      try {
        let email = r.email;
        if (!email && r.userUid) {
          const uSnap = await db.collection('users').doc(r.userUid).get();
          if (uSnap.exists) email = uSnap.data().email;
          if (!email) {
            const sSnap = await db.collection('students').doc(r.userUid).get();
            if (sSnap.exists) email = sSnap.data().email;
          }
        }

        if (email && LIBRARY_GMAIL_EMAIL.value()) {
          const mailOptions = {
            from: `"IIE Library" <${LIBRARY_GMAIL_EMAIL.value()}>`,
            to: email,
            subject: 'Book Checkout Confirmation - IIE Library',
            text: `Assalamu Alaikum ${r.name || 'Student'},\n\n` +
              `Your request for "${book.title || 'Book'}" has been approved and checked out.\n` +
              `Due Date: ${due.toLocaleDateString()}\n\n` +
              `The book will reach you soon.\n` +
              `For any queries, please contact the library administration:\n` +
              `Phone/WhatsApp: [YOUR_PHONE_HERE]\n` +
              `Email: [YOUR_LIBRARY_EMAIL_HERE]\n\n` +
              `Website: www.[YOUR_DOMAIN_HERE]\n\n` +
              `JazakAllah Khair,\nLibrarian [YOUR_INSTITUTE_NAME_HERE]`,
            html: getLibraryEmailHtml(
              'Book Checkout Confirmation',
              `Assalamu Alaikum ${r.name || 'Student'},`,
              `Your request for the book <strong>${escapeHtml(book.title || 'Book')}</strong> has been approved and checked out successfully.`,
              [
                { label: 'Book Title', value: book.title || 'Book' },
                { label: 'Due Date', value: due.toLocaleDateString() },
                { label: 'Status', value: 'Checked Out' }
              ]
            )
          };
          await getLibraryMailTransport().sendMail(mailOptions);
        } else {
          console.log('Skipping email: No recipient email or SMTP config missing.');
        }
      } catch (e) {
        console.error('Failed to send checkout email', e);
      }

      return { ok: true };
    } catch (err) {
      console.error('checkoutPhysicalReservation error', err);
      if (err instanceof functions.https.HttpsError) throw err;
      throw new functions.https.HttpsError('internal', 'Checkout failed');
    }
  });

// Callable: Return a loan
export const returnPhysicalLoan = functions
  .runWith({ secrets: [LIBRARY_GMAIL_EMAIL, LIBRARY_GMAIL_PASSWORD] })
  .region('us-central1').https.onCall(async (data, context) => {
    try {
      const uid = context.auth?.uid || null;
      if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Sign in required');
      if (!(await hasPermission(uid, 'canManageLibrary'))) throw new functions.https.HttpsError('permission-denied', 'Admin or Library Manager only');
      const loanId = (typeof data?.loanId === 'string') ? data.loanId.trim() : '';
      if (!loanId) throw new functions.https.HttpsError('invalid-argument', 'loanId required');

      const damageNotes = (typeof data?.damageNotes === 'string') ? data.damageNotes.trim() : null;
      const fineAmount = (typeof data?.fineAmount === 'number') ? data.fineAmount : null;

      const loanRef = db.collection('libraryLoans').doc(loanId);
      const result = await db.runTransaction(async (tx) => {
        const snap = await tx.get(loanRef);
        if (!snap.exists) throw new functions.https.HttpsError('not-found', 'Loan missing');
        const L = snap.data() || {};
        if (L.status !== 'active') return null; // idempotent

        // Fetch book details for email (Read before Write)
        const bookRef = db.collection('libraryBooks').doc(L.bookId);
        const bookSnap = await tx.get(bookRef);
        const book = bookSnap.exists ? bookSnap.data() : {};

        const updateData = {
          status: 'returned',
          returnedAt: admin.firestore.FieldValue.serverTimestamp()
        };
        if (damageNotes) updateData.damageNotes = damageNotes;
        if (fineAmount !== null) updateData.fineAmount = fineAmount;

        tx.update(loanRef, updateData);
        tx.update(bookRef, { activeLoans: admin.firestore.FieldValue.increment(-1), updatedAt: admin.firestore.FieldValue.serverTimestamp() });

        return { L, book };
      });

      if (!result) return { ok: true }; // Already returned

      // Send email notification
      try {
        const { L, book } = result;
        let email = L.borrowerEmail || null;

        // Try to find email from userUid if not on loan doc
        if (!email && L.userUid && L.userUid !== 'anonymous') {
          const uSnap = await db.collection('users').doc(L.userUid).get();
          if (uSnap.exists) email = uSnap.data().email;
          if (!email) {
            const sSnap = await db.collection('students').doc(L.userUid).get();
            if (sSnap.exists) email = sSnap.data().email;
          }
        }

        if (email && LIBRARY_GMAIL_EMAIL.value()) {
          let emailBody = `Assalamu Alaikum ${L.borrowerName || 'Student'},\n\n` +
            `This is a confirmation that the book "${book.title || 'Book'}" has been returned.\n\n`;

          const details = [
            { label: 'Book Title', value: book.title || 'Book' },
            { label: 'Status', value: 'Returned' }
          ];

          if (damageNotes || fineAmount) {
            emailBody += `--- Return Details ---\n`;
            if (damageNotes) {
              emailBody += `Notes/Damage: ${damageNotes}\n`;
              details.push({ label: 'Notes/Damage', value: damageNotes });
            }
            if (fineAmount) {
              emailBody += `Fine Applied: ₹${fineAmount}\n`;
              details.push({ label: 'Fine Applied', value: `₹${fineAmount}` });
            }
            emailBody += `\n`;
          }

          emailBody += `For any queries, please contact the library administration:\n` +
            `Phone/WhatsApp: [YOUR_PHONE_HERE]\n` +
            `Email: [YOUR_LIBRARY_EMAIL_HERE]\n\n` +
            `Website: www.[YOUR_DOMAIN_HERE]\n\n` +
            `JazakAllah Khair,\nLibrarian [YOUR_INSTITUTE_NAME_HERE]`;

          const mailOptions = {
            from: `"IIE Library" <${LIBRARY_GMAIL_EMAIL.value()}>`,
            to: email,
            subject: 'Book Return Confirmation - IIE Library',
            text: emailBody,
            html: getLibraryEmailHtml(
              'Book Return Confirmation',
              `Assalamu Alaikum ${L.borrowerName || 'Student'},`,
              `This is a confirmation that the book <strong>${escapeHtml(book.title || 'Book')}</strong> has been returned successfully.`,
              details
            )
          };
          await getLibraryMailTransport().sendMail(mailOptions);
        }
      } catch (e) {
        console.error('Failed to send return email', e);
      }

      return { ok: true };
    } catch (err) {
      console.error('returnPhysicalLoan error', err);
      if (err instanceof functions.https.HttpsError) throw err;
      throw new functions.https.HttpsError('internal', 'Return failed');
    }
  });

// Callable: Borrower requests a return (or indicates they have sent the book)
export const requestReturnLoan = functions.region('us-central1').https.onCall(async (data, context) => {
  try {
    const uid = context.auth?.uid || null;
    const trackingId = (typeof data?.trackingId === 'string') ? data.trackingId.trim().toUpperCase() : '';
    const loanId = (typeof data?.loanId === 'string') ? data.loanId.trim() : '';

    if (!loanId && !trackingId) {
      throw new functions.https.HttpsError('invalid-argument', 'loanId or trackingId required');
    }

    const note = (typeof data?.note === 'string') ? data.note.trim() : null;

    let loanSnap;
    let loanRef;

    if (loanId) {
      loanRef = db.collection('libraryLoans').doc(loanId);
      loanSnap = await loanRef.get();
      if (!loanSnap.exists) throw new functions.https.HttpsError('not-found', 'Loan not found');

      const L = loanSnap.data() || {};
      if (trackingId && L.trackingId !== trackingId) {
        throw new functions.https.HttpsError('permission-denied', 'Tracking ID mismatch');
      }
    } else {
      const q = await db.collection('libraryLoans').where('trackingId', '==', trackingId).limit(1).get();
      if (q.empty) {
        throw new functions.https.HttpsError('not-found', 'Loan not found for the given tracking ID');
      }
      loanSnap = q.docs[0];
      loanRef = loanSnap.ref;
    }

    const L = loanSnap.data() || {};

    // Authorization:
    // If trackingId is not provided, enforce standard authentication
    if (!trackingId) {
      if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Sign in required');
      const borrowerUid = L.userUid || null;
      if (borrowerUid && borrowerUid !== uid) {
        throw new functions.https.HttpsError('permission-denied', 'Not the borrower');
      }
    }

    const now = admin.firestore.FieldValue.serverTimestamp();

    await loanRef.update({
      returnRequested: true,
      returnRequestedAt: now,
      returnRequestNote: note || null,
      updatedAt: now
    });

    const reqRef = db.collection('libraryReturnRequests').doc();
    await reqRef.set({
      loanId: loanRef.id,
      bookId: L.bookId || null,
      userUid: uid || 'anonymous',
      borrowerName: L.borrowerName || null,
      note: note || null,
      status: 'requested',
      createdAt: now
    });

    return { ok: true };
  } catch (err) {
    console.error('requestReturnLoan error', err);
    if (err instanceof functions.https.HttpsError) throw err;
    throw new functions.https.HttpsError('internal', 'Request failed');
  }
});

// Secure: Claim a Student ID (username) and write only to usernames/{usernameLC}
// Body: { username: string }
export const claimStudentId = functions.region('us-central1').https.onRequest(async (req, res) => {
  if (handleCorsPreflight(req, res)) return;
  cors(req, res, async () => {
    try {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
      const authHeader = req.headers.authorization || '';
      if (!authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
      const idToken = authHeader.substring('Bearer '.length);
      const decoded = await admin.auth().verifyIdToken(idToken);
      const uid = decoded.uid;

      const { username } = req.body || {};
      if (!username || typeof username !== 'string') return res.status(400).json({ error: 'username required' });
      const usernameOriginal = username.trim();
      const unameLC = usernameOriginal.toLowerCase();
      const valid = /^[a-z0-9._-]{3,20}$/.test(unameLC);
      if (!valid) return res.status(400).json({ error: 'invalid username' });
      const reserved = new Set([
        'admin', 'root', 'system', 'support', 'about', 'contact', 'home', 'index', 'login', 'logout', 'signup', 'register', 'profile',
        'teacher', 'instructor', 'finance', 'volunteer', 'events', 'exams', 'notices', 'tasks', 'settings', 'privacy', 'terms',
        'api', 'static', 'assets', 'storage', 'firestore', 'iie', 'iieccpora', 'mail', 'email', 'help', 'www'
      ]);
      if (reserved.has(unameLC)) return res.status(400).json({ error: 'reserved username' });

      const now = admin.firestore.Timestamp.now();
      // Mapping now stored only in usernames collection
      const studentRef = db.collection('students').doc(uid);

      await db.runTransaction(async (tx) => {
        const usernamesRef = db.collection('usernames').doc(unameLC);
        const [sSnap, mapSnap] = await Promise.all([tx.get(studentRef), tx.get(usernamesRef)]);
        if (mapSnap.exists) throw new functions.https.HttpsError('already-exists', 'username taken');
        // Lock: if student already has username and last change < 100 days, block
        if (sSnap.exists) {
          const d = sSnap.data() || {};
          if (d.usernameLC && d.lastUsernameChange && typeof d.lastUsernameChange.toMillis === 'function') {
            const elapsed = now.toMillis() - d.lastUsernameChange.toMillis();
            const HUNDRED_DAYS = 100 * 24 * 60 * 60 * 1000; // 100 days
            if (elapsed < HUNDRED_DAYS) throw new functions.https.HttpsError('failed-precondition', 'username change locked');
          }
        }
        // Delete previous mapping in usernames if changing from an existing ID
        if (sSnap.exists) {
          const prev = sSnap.data()?.usernameLC;
          if (prev && prev !== unameLC) {
            const prevRef = db.collection('usernames').doc(prev);
            tx.delete(prevRef);
          }
        }
        // Primary mapping write (single source of truth)
        tx.set(usernamesRef, { ownerUid: uid, usernameOriginal, role: 'Student', createdAt: now }, { merge: false });
        tx.set(studentRef, { username: usernameOriginal, usernameLC: unameLC, lastUsernameChange: now }, { merge: true });
      });

      return res.json({ status: 'ok' });
    } catch (err) {
      console.error('claimStudentId error', err);
      const code = err?.code || 'internal';
      const msg = err?.message || 'internal';
      const status = code === 'already-exists' ? 409 : code === 'failed-precondition' ? 412 : code === 'invalid-argument' ? 400 : 500;
      return res.status(status).json({ error: msg });
    }
  });
});

// Scheduled cleanup: remove unverified auth users older than 30 minutes
// Goal: If a student signs up but doesn't verify within 30 minutes, their email should not be stored in the backend
// This function runs periodically and deletes such accounts only if there is no Firestore profile for them.
export const deleteStaleUnverifiedUsers = functions
  .region('us-central1')
  .pubsub.schedule('every 15 minutes')
  .timeZone('Etc/UTC')
  .onRun(async () => {
    const TTL_MINUTES = 30;
    const cutoff = Date.now() - TTL_MINUTES * 60 * 1000;
    let inspected = 0;
    let deleted = 0;

    async function processPage(nextPageToken) {
      const result = await admin.auth().listUsers(1000, nextPageToken);
      for (const user of result.users) {
        inspected++;
        try {
          // Skip already-verified users
          if (user.emailVerified) continue;
          const creationMs = user.metadata?.creationTime ? Date.parse(user.metadata.creationTime) : 0;
          const lastSignInMs = user.metadata?.lastSignInTime ? Date.parse(user.metadata.lastSignInTime) : creationMs;
          // Only consider truly stale, inactive accounts
          if (!(creationMs && creationMs < cutoff && lastSignInMs < cutoff)) continue;
          // Safety check: if a Firestore profile exists, do not delete
          const userDoc = await db.collection('users').doc(user.uid).get();
          if (userDoc.exists) continue;
          // Optional safety: if a students doc exists, skip (should not exist before verification in current flow)
          const studentDoc = await db.collection('students').doc(user.uid).get();
          if (studentDoc.exists) continue;

          await admin.auth().deleteUser(user.uid);
          deleted++;
        } catch (e) {
          console.error('deleteStaleUnverifiedUsers: error processing uid', user.uid, e);
        }
      }
      if (result.pageToken) {
        await processPage(result.pageToken);
      }
    }

    await processPage(undefined);
    console.log(`deleteStaleUnverifiedUsers done. inspected=${inspected}, deleted=${deleted}`);
    return null;
  });

// ─── Shared: build modern HTML event pass email (matches IIE email design) ──────
function buildPassEmailHtml({ recipientName, rollNumber, programTitle, venue, address, startDate, endDate, startTime, endTime, fee, isAddon, addonNote, isApprovalOnly, isWalkin }) {
  const fmtDate = (ts) => { try { const d = ts && typeof ts.toDate === 'function' ? ts.toDate() : new Date(ts); return isNaN(d) ? '' : d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }); } catch (_) { return ''; } };
  const fmtTime = (ts) => { try { const d = ts && typeof ts.toDate === 'function' ? ts.toDate() : new Date(ts); return isNaN(d) ? '' : d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }); } catch (_) { return ''; } };
  const dateStr = fmtDate(startDate);
  const endDateStr = endDate ? fmtDate(endDate) : '';
  const timeStr = startTime ? fmtTime(startTime) : (startDate ? fmtTime(startDate) : '');
  const endTimeStr = endTime ? fmtTime(endTime) : (endDate ? fmtTime(endDate) : '');
  const dateRange = dateStr + (endDateStr && endDateStr !== dateStr ? ` – ${endDateStr}` : '');
  const timeRange = timeStr + (endTimeStr && endTimeStr !== timeStr ? ` – ${endTimeStr}` : '');
  const feeStr = fee && parseFloat(fee) > 0 ? `₹${fee}` : 'Free';
  const passLabel = isAddon ? 'Add-on Student Pass' : 'Student Event Pass';
  const passLabelColor = isAddon ? '#7c3aed' : '#16a34a';
  return `<!DOCTYPE html>
<html lang="en" dir="ltr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Event Pass – IIE</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 0;"><tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.10);">
  <!-- HEADER -->
  <tr><td style="background:#1e3a8a;padding:32px 40px 28px;text-align:center;">
    <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:600;letter-spacing:0.3px;font-family:'Segoe UI',Arial,sans-serif;">[YOUR_INSTITUTE_NAME_HERE]</h1>
    <p style="margin:8px 0 0;color:#16a34a;font-size:18px;font-family:'Traditional Arabic','Scheherazade New',serif;font-weight:700;direction:rtl;">[ARABIC_INSTITUTE_NAME]</p>
  </td></tr>
  <!-- ARABIC GREETING -->
  <tr><td style="padding:28px 40px 0;text-align:right;direction:rtl;">
    <p style="margin:0;font-size:18px;color:#1e3a8a;font-family:'Traditional Arabic','Scheherazade New',serif;font-weight:700;line-height:1.6;">السَّلَامُ عَلَيْكُمْ وَرَحْمَةُ اللهِ وَبَرَكَاتُهُ،</p>
  </td></tr>
  <!-- BODY -->
  <tr><td style="padding:14px 40px 0;text-align:left;">
    <p style="margin:0;font-size:14px;color:#334155;line-height:1.75;">Dear <strong>${recipientName}</strong>,</p>
    <p style="margin:10px 0 0;font-size:14px;color:#475569;line-height:1.75;">${isApprovalOnly ? 'Your registration has been approved! Your event pass and QR code will be available to download 48 hours before the event starts.' : 'Your event pass is now ready. Please find the details below and present the QR code at the venue for check-in.'}</p>
  </td></tr>
  ${!isApprovalOnly ? `
  <!-- PASS CARD -->
  <tr><td style="padding:20px 40px;">
    <div style="background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:12px;padding:22px 24px;">
      <p style="margin:0 0 4px;font-size:11px;font-weight:700;color:${passLabelColor};text-transform:uppercase;letter-spacing:1px;">${passLabel}</p>
      <h2 style="margin:0 0 16px;font-size:18px;color:#1e3a8a;font-weight:800;border-bottom:2px solid #e2e8f0;padding-bottom:12px;">${programTitle || 'Event'}</h2>
      <table width="100%" cellpadding="0" cellspacing="0">
        ${rollNumber ? `<tr><td style="padding:6px 0;"><span style="font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.5px;">Roll Number</span><br><span style="font-size:22px;font-weight:800;color:#1e3a8a;font-family:monospace;letter-spacing:2px;">${rollNumber}</span></td></tr>` : ''}
        ${dateRange ? `<tr><td style="padding:6px 0;"><span style="font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.5px;">Date</span><br><span style="font-size:14px;color:#0f172a;font-weight:600;">${dateRange}</span></td></tr>` : ''}
        ${timeRange ? `<tr><td style="padding:6px 0;"><span style="font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.5px;">Time</span><br><span style="font-size:14px;color:#0f172a;font-weight:600;">${timeRange}</span></td></tr>` : ''}
        ${venue ? `<tr><td style="padding:6px 0;"><span style="font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.5px;">Venue</span><br><span style="font-size:14px;color:#0f172a;font-weight:600;">${venue}</span></td></tr>` : ''}
        ${address ? `<tr><td style="padding:6px 0;"><span style="font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.5px;">Address</span><br><span style="font-size:14px;color:#0f172a;">${address}</span></td></tr>` : ''}
        <tr><td style="padding:6px 0;"><span style="font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.5px;">Fee</span><br><span style="font-size:14px;color:#0f172a;font-weight:600;">${feeStr}</span></td></tr>
      </table>
      ${addonNote ? `<div style="margin-top:14px;background:#ede9fe;border-left:4px solid #7c3aed;padding:10px 14px;border-radius:0 8px 8px 0;font-size:13px;color:#4c1d95;">${addonNote}</div>` : ''}
      <!-- QR CODE (injected via CID) -->
      <div style="margin-top:18px;text-align:center;">
        <p style="margin:0 0 8px;font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.5px;">Your QR Code</p>
        <img src="cid:eventqr" alt="Event QR Code" width="160" height="160" style="border:3px solid #e2e8f0;border-radius:10px;display:block;margin:0 auto;">
        <p style="margin:6px 0 0;font-size:11px;color:#94a3b8;">Present this at the venue for check-in</p>
      </div>
    </div>
  </td></tr>
  ` : ''}
  ${!isWalkin ? `
  <!-- CTA -->
  <tr><td style="padding:0 40px 24px;text-align:center;">
    <a href="https://[YOUR_FIREBASE_APP_ID].web.app/student.html" style="display:inline-block;margin-top:18px;background:#16a34a;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:13px 32px;border-radius:8px;">Go to Student Portal</a>
  </td></tr>
  ${!isApprovalOnly ? `
  <!-- NOTE -->
  <tr><td style="padding:0 40px 24px;">
    <p style="margin:0;font-size:13px;color:#64748b;line-height:1.75;">Please bring event pass to the event. Log in to the <a href="https://[YOUR_FIREBASE_APP_ID].web.app/student.html" style="color:#1d4ed8;text-decoration:none;font-weight:600;">Student Portal</a> to view and download your full event pass with QR code.</p>
  </td></tr>
  ` : ''}
  ` : (!isApprovalOnly ? `
  <!-- NOTE (Walk-in) -->
  <tr><td style="padding:0 40px 24px;">
    <p style="margin:0;font-size:13px;color:#64748b;line-height:1.75;">Please bring this event pass to the event.</p>
  </td></tr>
  ` : '')}
  <!-- CONTACT BOX -->
  <tr><td style="padding:0 40px 24px;">
    <div style="border-left:4px solid #1e3a8a;background:#f1f5f9;padding:14px 18px;border-radius:0 8px 8px 0;">
      <p style="margin:0 0 8px;font-size:11px;font-weight:800;color:#64748b;text-transform:uppercase;letter-spacing:.8px;">Contact Us</p>
      <p style="margin:0 0 4px;font-size:13px;color:#334155;"><strong>Phone:</strong> [YOUR_PHONE_HERE]</p>
      <p style="margin:0 0 4px;font-size:13px;color:#334155;"><strong>Email:</strong> <a href="mailto:[YOUR_SUPPORT_EMAIL_HERE]" style="color:#1d4ed8;text-decoration:none;">[YOUR_SUPPORT_EMAIL_HERE]</a></p>
      <p style="margin:0;font-size:13px;color:#334155;"><strong>Address:</strong> [YOUR_ADDRESS_HERE]</p>
    </div>
  </td></tr>
  <!-- SIGN-OFF -->
  <tr><td style="padding:0 40px 28px;">
    <p style="margin:0;font-size:14px;color:#334155;">Warm regards,<br><strong>[YOUR_INSTITUTE_NAME_HERE]</strong></p>
  </td></tr>
  <!-- FOOTER -->
  <tr><td style="background:#1e3a8a;padding:22px 40px;text-align:center;border-radius:0 0 16px 16px;">
    <p style="margin:0 0 4px;color:#16a34a;font-size:16px;font-family:'Traditional Arabic','Scheherazade New',serif;font-weight:700;direction:rtl;">[ARABIC_INSTITUTE_NAME]</p>
    <p style="margin:0 0 6px;color:#94a3b8;font-size:12px;">&copy; 2026 [YOUR_INSTITUTE_NAME_HERE]. All rights reserved.</p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

// Helper: send pass email with QR as CID attachment
async function sendPassEmail({ toEmail, subject, recipientName, rollNumber, qrDataUrl, programData, isAddon, addonNote, isApprovalOnly }) {
  const p = programData || {};
  const html = buildPassEmailHtml({
    recipientName,
    rollNumber,
    programTitle: p.title,
    venue: p.venue || p.location,
    address: p.address || p.venueAddress,
    startDate: p.startDate || p.date,
    endDate: p.endDate,
    startTime: p.startTime || p.startDate,
    endTime: p.endTime || p.endDate,
    fee: p.price,
    isAddon,
    addonNote,
    isApprovalOnly
  });
  // Convert QR data URL to buffer for CID inline attachment
  const attachments = [];
  if (!isApprovalOnly && qrDataUrl && qrDataUrl.startsWith('data:image/png;base64,')) {
    const base64Data = qrDataUrl.replace('data:image/png;base64,', '');
    attachments.push({ filename: 'pass-qr.png', content: Buffer.from(base64Data, 'base64'), cid: 'eventqr' });
  }
  await getMailTransport().sendMail({
    from: `"[YOUR_INSTITUTE_NAME_HERE] Events" <${GMAIL_EMAIL.value()}>`,
    to: toEmail,
    subject,
    html,
    attachments
  });
}

// Helper to promote the oldest waitlisted student (primary or addon) based on createdAt timestamp
async function promoteNextWaitlistedStudent(programId) {
  try {
    const primaryQuery = await db.collection('programs')
      .doc(programId)
      .collection('registrations')
      .where('waitlisted', '==', true)
      .orderBy('createdAt', 'asc')
      .limit(1)
      .get();

    const addonQuery = await db.collection('programs')
      .doc(programId)
      .collection('addon_registrations')
      .where('waitlisted', '==', true)
      .orderBy('createdAt', 'asc')
      .limit(1)
      .get();

    let nextPrimary = primaryQuery.empty ? null : primaryQuery.docs[0];
    let nextAddon = addonQuery.empty ? null : addonQuery.docs[0];

    if (nextPrimary && nextAddon) {
      const primaryTime = nextPrimary.data().createdAt?.toDate ? nextPrimary.data().createdAt.toDate().getTime() : Infinity;
      const addonTime = nextAddon.data().createdAt?.toDate ? nextAddon.data().createdAt.toDate().getTime() : Infinity;

      if (primaryTime < addonTime) {
        nextAddon = null; // Promote primary
      } else {
        nextPrimary = null; // Promote addon
      }
    }

    if (nextPrimary) {
      await nextPrimary.ref.update({
        waitlisted: false,
        approved: true,
        approvedAt: admin.firestore.FieldValue.serverTimestamp(),
        approvedBy: 'system',
        rejected: false
      });
      console.log('Automatically promoted waitlisted primary student', nextPrimary.id, 'for program', programId);
    } else if (nextAddon) {
      await nextAddon.ref.update({
        waitlisted: false,
        approved: true,
        approvedAt: admin.firestore.FieldValue.serverTimestamp(),
        approvedBy: 'system',
        rejected: false
      });
      console.log('Automatically promoted waitlisted addon student', nextAddon.id, 'for program', programId);
    }
  } catch (e) {
    console.error('promoteNextWaitlistedStudent failed for program', programId, e);
  }
}

// Expects registration docs to have at least { studentUid, createdAt } (validated on client or security rules)
export const onProgramRegistrationCreate = functions.runWith({ secrets: [GMAIL_EMAIL, GMAIL_PASSWORD] }).region('us-central1').firestore
  .document('programs/{programId}/registrations/{registrationId}')
  .onCreate(async (snap, context) => {
    const { programId } = context.params;
    const regData = snap.data() || {};
    const studentUid = regData.studentUid || snap.id;
    const programRef = db.collection('programs').doc(programId);
    try {
      let programSnapshotData = null;
      // Atomically reserve a roll number using a nextRollNumber field on the program document.
      // This reduces race conditions where concurrent transactions could cause off-by-one
      // behavior and incorrectly push the Nth student to the waitlist.
      await db.runTransaction(async (tx) => {
        const programSnap = await tx.get(programRef);
        if (!programSnap.exists) {
          console.warn('Program missing for registration', programId);
          return;
        }

        const currentRegSnap = await tx.get(snap.ref);
        const currentRegData = currentRegSnap.data() || {};
        if (currentRegData.counted || currentRegData.rollNumber) {
          console.log('Registration already processed by generateEventPass', snap.id);
          return;
        }

        const p = programSnap.data() || {};
        programSnapshotData = p;
        const capacity = typeof p.capacity === 'number' ? p.capacity : null;
        let regCount = (typeof p.registeredCount === 'number') ? p.registeredCount : 0;

        // If capacity enforced and already full, optionally set waitlist flag on registration
        if (capacity && regCount >= capacity) {
          if (p.waitlistEnabled) {
            tx.update(snap.ref, { waitlisted: true });
          } else {
            tx.update(snap.ref, { rejected: true, rejectionReason: 'FULL' });
          }
          return;
        }

        const updatesToRegistration = { counted: true };
        let assignedFormatted = null;
        let qrDataUrl = null;

        if (currentRegData.approved === true) {
          let nextRoll = typeof p.nextRollNumber === 'number' ? p.nextRollNumber : 0;
          nextRoll += 1;
          
          const rawCode = (p.programCode && typeof p.programCode === 'string') ? String(p.programCode).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) : null;
          const programCodePart = rawCode || 'GEN';
          const seqStr = String(nextRoll).padStart(3, '0');
          const prefix = programCodePart.startsWith('IIE') ? '' : 'IIE';
          
          assignedFormatted = `${prefix}${programCodePart}${seqStr}`;
          
          const qrPayload = {
            t: 'event-pass',
            programId,
            registrationId: snap.id,
            studentUid,
            rollNumber: assignedFormatted,
            ts: Date.now()
          };
          // We must generate QR later outside transaction because it's async, but actually wait, QRCode.toDataURL is async but purely CPU bound. 
          // We can use it inside runTransaction in JS. Let's do it outside to be safe.
          // Wait, we can't export it outside easily if it's inside tx. Let's just generate it inside! It's perfectly fine in JS Firestore SDK.
        }

        // Just increment registeredCount
        const newRegistered = regCount + 1;
        tx.update(programRef, { registeredCount: newRegistered, updatedAt: admin.firestore.FieldValue.serverTimestamp() });

        // But wait! If we generated QR inside, we'd need QRCode.toDataURL.
        // Let's just do it cleanly outside the transaction!
      });
      
      if (snap.data().approved === true) {
        // Now that transaction finished, assign roll number outside!
        await db.runTransaction(async (tx) => {
          const pSnap = await tx.get(programRef);
          const p = pSnap.data() || {};
          let nextRoll = typeof p.nextRollNumber === 'number' ? p.nextRollNumber : 0;
          nextRoll += 1;
          
          const rawCode = (p.programCode && typeof p.programCode === 'string') ? String(p.programCode).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) : null;
          const programCodePart = rawCode || 'GEN';
          const seqStr = String(nextRoll).padStart(3, '0');
          const prefix = programCodePart.startsWith('IIE') ? '' : 'IIE';
          
          const rollNumber = `${prefix}${programCodePart}${seqStr}`;
          const qrPayload = { t: 'event-pass', programId, registrationId: snap.id, studentUid, rollNumber, ts: Date.now() };
          const qrDataUrl = await QRCode.toDataURL(JSON.stringify(qrPayload), { errorCorrectionLevel: 'M', margin: 1, scale: 4 });
          
          tx.update(programRef, { nextRollNumber: nextRoll, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
          tx.update(snap.ref, { rollNumber, rollSeq: nextRoll, qr: qrDataUrl, counted: true });
        });
      } else {
         await snap.ref.update({ counted: true });
      }

      // Email + notification sent via onProgramRegistrationUpdate when organizer approves
    } catch (e) {
      console.error('onProgramRegistrationCreate failure', programId, e);
    }
  });

// Firestore trigger: Assign roll number and QR to Add-on registration
export const onProgramAddonRegistrationCreate = functions.runWith({ secrets: [GMAIL_EMAIL, GMAIL_PASSWORD] }).region('us-central1').firestore
  .document('programs/{programId}/addon_registrations/{registrationId}')
  .onCreate(async (snap, context) => {
    const { programId } = context.params;
    const regData = snap.data() || {};
    const programRef = db.collection('programs').doc(programId);
    try {
      let programSnapshotData = null;

      await db.runTransaction(async (tx) => {
        const programSnap = await tx.get(programRef);
        if (!programSnap.exists) {
          console.warn('Program missing for addon registration', programId);
          return;
        }

        const currentRegSnap = await tx.get(snap.ref);
        const currentRegData = currentRegSnap.data() || {};
        if (currentRegData.counted || currentRegData.rollNumber) {
          console.log('Addon registration already processed by generateEventPass', snap.id);
          return;
        }

        const p = programSnap.data() || {};
        programSnapshotData = p;
        const capacity = typeof p.capacity === 'number' ? p.capacity : null;
        let regCount = (typeof p.registeredCount === 'number') ? p.registeredCount : 0;

        // If capacity enforced and already full, optionally set waitlist flag on registration
        if (capacity && regCount >= capacity) {
          if (p.waitlistEnabled) {
            tx.update(snap.ref, { waitlisted: true });
          } else {
            tx.update(snap.ref, { rejected: true, rejectionReason: 'FULL' });
          }
          return;
        }

        const updatesToRegistration = { counted: true };
        let assignedFormatted = null;

        if (currentRegData.approved === true) {
          let nextRoll = typeof p.nextRollNumber === 'number' ? p.nextRollNumber : 0;
          nextRoll += 1;
          
          const rawCode = (p.programCode && typeof p.programCode === 'string') ? String(p.programCode).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) : null;
          const programCodePart = rawCode || 'GEN';
          const seqStr = String(nextRoll).padStart(3, '0');
          const prefix = programCodePart.startsWith('IIE') ? '' : 'IIE';
          
          assignedFormatted = `${prefix}${programCodePart}${seqStr}-AO`;
          
          tx.update(programRef, { registeredCount: regCount + 1, nextRollNumber: nextRoll, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        } else {
          tx.update(programRef, { registeredCount: regCount + 1, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        }

        tx.update(snap.ref, updatesToRegistration);
      });
      
      if (snap.data().approved === true) {
        await db.runTransaction(async (tx) => {
          const pSnap = await tx.get(programRef);
          const p = pSnap.data() || {};
          let nextRoll = typeof p.nextRollNumber === 'number' ? p.nextRollNumber : 0;
          nextRoll += 1;
          
          const rawCode = (p.programCode && typeof p.programCode === 'string') ? String(p.programCode).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) : null;
          const programCodePart = rawCode || 'GEN';
          const seqStr = String(nextRoll).padStart(3, '0');
          const prefix = programCodePart.startsWith('IIE') ? '' : 'IIE';
          
          const rollNumber = `${prefix}${programCodePart}${seqStr}-AO`;
          const qrPayload = { t: 'event-pass', programId, registrationId: snap.id, studentUid: snap.id, rollNumber, ts: Date.now(), isAddon: true, addedByUid: regData.addedByUid };
          const qrDataUrl = await QRCode.toDataURL(JSON.stringify(qrPayload), { errorCorrectionLevel: 'M', margin: 1, scale: 4 });
          
          tx.update(programRef, { nextRollNumber: nextRoll, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
          tx.update(snap.ref, { rollNumber, rollSeq: nextRoll, qr: qrDataUrl, counted: true });
        });
      } else {
         await snap.ref.update({ counted: true });
      }

      // Email + notification sent via onProgramAddonRegistrationUpdate when organizer approves
    } catch (e) {
      console.error('onProgramAddonRegistrationCreate failure', programId, e);
    }
  });

// ─── onUpdate: Send pass email + notification when organizer approves primary registration ──
export const onProgramRegistrationUpdate = functions.runWith({ secrets: [GMAIL_EMAIL, GMAIL_PASSWORD] }).region('us-central1').firestore
  .document('programs/{programId}/registrations/{registrationId}')
  .onUpdate(async (change, context) => {
    const { programId, registrationId } = context.params;
    const before = change.before.data() || {};
    const after = change.after.data() || {};

    const studentUid = after.studentUid || registrationId;
    const programRef = db.collection('programs').doc(programId);

    try {
      // 1. Get program details
      const programSnap = await programRef.get();
      if (!programSnap.exists) return null;
      const p = programSnap.data() || {};
      const isPaid = p.priceType === 'paid' && parseFloat(p.price) > 0;

      // 2. Handle counted transitions (Capacity tracking)
      const beforeCounted = !before.waitlisted && !before.rejected;
      const afterCounted = !after.waitlisted && !after.rejected;

      if (!beforeCounted && afterCounted) {
        // Transition to Counted: Increment registeredCount
        await db.runTransaction(async (tx) => {
          const pSnap = await tx.get(programRef);
          const pData = pSnap.data() || {};
          const registered = (typeof pData.registeredCount === 'number' ? pData.registeredCount : 0) + 1;
          tx.update(programRef, { registeredCount: registered, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
          tx.update(change.after.ref, { counted: true });
        });
      } else if (beforeCounted && !afterCounted) {
        // Transition from Counted to Uncounted (e.g. rejection or manual waitlisting)
        await db.runTransaction(async (tx) => {
          const pSnap = await tx.get(programRef);
          const pData = pSnap.data() || {};
          let registered = typeof pData.registeredCount === 'number' ? pData.registeredCount : 0;
          if (registered > 0) registered -= 1;
          tx.update(programRef, { registeredCount: registered, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
          tx.update(change.after.ref, { counted: admin.firestore.FieldValue.delete() });
        });

        // A spot opened up! Promote the next waitlisted student (primary or addon)
        await promoteNextWaitlistedStudent(programId);
      }

      // 3. Handle Roll Number assignment on Approval
      const beforeApproved = before.approved === true;
      const afterApproved = after.approved === true;

      if (!beforeApproved && afterApproved) {
        await db.runTransaction(async (tx) => {
          const currentRegSnap = await tx.get(change.after.ref);
          const currentRegData = currentRegSnap.data() || {};
          
          if (currentRegData.rollNumber) {
            return; // Already has a roll number
          }

          const pSnap = await tx.get(programRef);
          const pData = pSnap.data() || {};

          let nextRoll = (typeof pData.nextRollNumber === 'number') ? pData.nextRollNumber : 0;
          nextRoll += 1;

          const rawCode = (pData.programCode && typeof pData.programCode === 'string') ? String(pData.programCode).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) : null;
          const programCodePart = rawCode || 'GEN';
          const seqStr = String(nextRoll).padStart(3, '0');
          const prefix = programCodePart.startsWith('IIE') ? '' : 'IIE';
          
          const rollNumber = `${prefix}${programCodePart}${seqStr}`;
          
          const qrPayload = {
            t: 'event-pass',
            programId,
            registrationId,
            studentUid,
            rollNumber,
            ts: Date.now()
          };
          const qrDataUrl = await QRCode.toDataURL(JSON.stringify(qrPayload), { errorCorrectionLevel: 'M', margin: 1, scale: 4 });

          tx.update(programRef, { nextRollNumber: nextRoll, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
          tx.update(change.after.ref, {
            rollSeq: nextRoll,
            rollNumber,
            qr: qrDataUrl
          });
        });

        // Fetch the updated registration data to get the generated fields
        const refreshedSnap = await change.after.ref.get();
        Object.assign(after, refreshedSnap.data());
      }

      // 3. Handle confirmation email transmission
      const beforeConfirmed = !before.waitlisted && !before.rejected && before.approved === true && (!isPaid || before.paymentProofStatus === 'verified');
      const afterConfirmed = !after.waitlisted && !after.rejected && after.approved === true && (!isPaid || after.paymentProofStatus === 'verified');

      if (!beforeConfirmed && afterConfirmed && !after.approvalEmailSent && !after.passEmailSent) {
        const studentDoc = await db.collection('students').doc(studentUid).get();
        const studentData = studentDoc.exists ? studentDoc.data() : {};
        const email = studentData.email || (after.walkinData ? after.walkinData.email : null) || after.email || null;
        const recipientName = studentData.fullName || studentData.name || after.studentName || (after.walkinData ? after.walkinData.name : null) || 'Student';
        const rollNumber = after.rollNumber || null;
        const qrDataUrl = after.qr || null;
        const notifId = `approval-${programId}-${registrationId}`;

        // Write in-app notification
        const notifPayload = {
          id: notifId,
          type: 'approval',
          title: '🎟️ Registration Approved!',
          body: `Your registration for "${p.title || 'the program'}" has been approved. Your pass will be available 48 hours before the event starts.`,
          time: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          read: false,
          programId,
          rollNumber
        };
        await db.collection('students').doc(studentUid).collection('notifications').doc(notifId).set(notifPayload);

        // Send email
        if (email && GMAIL_EMAIL.value()) {
          await sendPassEmail({
            toEmail: email,
            subject: `✅ Registration Approved – ${p.title || 'IIE Program'}`,
            recipientName,
            rollNumber,
            qrDataUrl,
            programData: p,
            isAddon: false,
            isApprovalOnly: true,
            isWalkin: studentUid === 'Walk-in' || !!after.walkinData
          });
          console.log('Approval email sent to', email, 'roll', rollNumber);
        }

        // Mark email sent
        await change.after.ref.set({ approvalEmailSent: true }, { merge: true });
      }
    } catch (e) {
      console.error('onProgramRegistrationUpdate trigger error', e);
    }
    return null;
  });

// ─── onUpdate: Send pass email + notification when organizer approves add-on registration ──
export const onProgramAddonRegistrationUpdate = functions.runWith({ secrets: [GMAIL_EMAIL, GMAIL_PASSWORD] }).region('us-central1').firestore
  .document('programs/{programId}/addon_registrations/{registrationId}')
  .onUpdate(async (change, context) => {
    const { programId, registrationId } = context.params;
    const before = change.before.data() || {};
    const after = change.after.data() || {};

    const programRef = db.collection('programs').doc(programId);

    try {
      // 1. Get program details
      const programSnap = await programRef.get();
      if (!programSnap.exists) return null;
      const p = programSnap.data() || {};
      const isPaid = p.priceType === 'paid' && parseFloat(p.price) > 0;


      // 2. Handle counted transitions (Capacity tracking)
      const beforeCounted = !before.waitlisted && !before.rejected;
      const afterCounted = !after.waitlisted && !after.rejected;

      if (!beforeCounted && afterCounted) {
        // Transition to Counted: Increment registeredCount
        await db.runTransaction(async (tx) => {
          const pSnap = await tx.get(programRef);
          const pData = pSnap.data() || {};
          const registered = (typeof pData.registeredCount === 'number' ? pData.registeredCount : 0) + 1;
          tx.update(programRef, { registeredCount: registered, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
          tx.update(change.after.ref, { counted: true });
        });
      } else if (beforeCounted && !afterCounted) {
        // Transition from Counted to Uncounted (e.g. rejection or manual waitlisting)
        await db.runTransaction(async (tx) => {
          const pSnap = await tx.get(programRef);
          const pData = pSnap.data() || {};
          let registered = typeof pData.registeredCount === 'number' ? pData.registeredCount : 0;
          if (registered > 0) registered -= 1;
          tx.update(programRef, { registeredCount: registered, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
          tx.update(change.after.ref, { counted: admin.firestore.FieldValue.delete() });
        });

        // A spot opened up! Promote the next waitlisted student (primary or addon)
        await promoteNextWaitlistedStudent(programId);
      }

      // 3. Handle Roll Number assignment on Approval
      const beforeApproved = before.approved === true;
      const afterApproved = after.approved === true;

      if (!beforeApproved && afterApproved) {
        await db.runTransaction(async (tx) => {
          const currentRegSnap = await tx.get(change.after.ref);
          const currentRegData = currentRegSnap.data() || {};
          
          if (currentRegData.rollNumber) {
            return; // Already has a roll number
          }

          const pSnap = await tx.get(programRef);
          const pData = pSnap.data() || {};

          let nextRoll = (typeof pData.nextRollNumber === 'number') ? pData.nextRollNumber : 0;
          nextRoll += 1;

          const rawCode = (pData.programCode && typeof pData.programCode === 'string') ? String(pData.programCode).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) : null;
          const programCodePart = rawCode || 'GEN';
          const seqStr = String(nextRoll).padStart(3, '0');
          const prefix = programCodePart.startsWith('IIE') ? '' : 'IIE';
          
          const rollNumber = `${prefix}${programCodePart}${seqStr}-AO`;
          
          const qrPayload = {
            t: 'event-pass',
            programId,
            registrationId,
            studentUid: registrationId,
            rollNumber,
            ts: Date.now(),
            isAddon: true,
            addedByUid: after.addedByUid
          };
          const qrDataUrl = await QRCode.toDataURL(JSON.stringify(qrPayload), { errorCorrectionLevel: 'M', margin: 1, scale: 4 });

          tx.update(programRef, { nextRollNumber: nextRoll, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
          tx.update(change.after.ref, {
            rollSeq: nextRoll,
            rollNumber,
            qr: qrDataUrl
          });
        });

        // Fetch the updated registration data to get the generated fields
        const refreshedSnap = await change.after.ref.get();
        Object.assign(after, refreshedSnap.data());
      }

      // 3. Handle confirmation email transmission
      const beforeConfirmed = !before.waitlisted && !before.rejected && before.approved === true && (!isPaid || before.paymentProofStatus === 'verified');
      const afterConfirmed = !after.waitlisted && !after.rejected && after.approved === true && (!isPaid || after.paymentProofStatus === 'verified');

      if (!beforeConfirmed && afterConfirmed && !after.approvalEmailSent && !after.passEmailSent) {
        const addedByUid = after.addedByUid || null;
        const addonName = after.addonName || 'Add-on Student';
        if (addedByUid) {
          const studentDoc = await db.collection('students').doc(addedByUid).get();
          const studentData = studentDoc.exists ? studentDoc.data() : {};
          const email = studentData.email || null;
          const primaryName = studentData.fullName || studentData.name || 'Student';
          const rollNumber = after.rollNumber || null;
          const qrDataUrl = after.qr || null;
          const notifId = `addon-approval-${programId}-${registrationId}`;

          const notifPayload = {
            id: notifId,
            type: 'approval',
            title: '🎟️ Add-on Registration Approved!',
            body: `Registration for "${addonName}" in "${p.title || 'the program'}" has been approved. The pass will be available 48 hours before the event.`,
            time: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            read: false,
            programId,
            rollNumber,
            isAddon: true
          };
          await db.collection('students').doc(addedByUid).collection('notifications').doc(notifId).set(notifPayload);

          if (email && GMAIL_EMAIL.value()) {
            await sendPassEmail({
              toEmail: email,
              subject: `✅ Add-on Registration Approved – ${addonName} | ${p.title || 'IIE Program'}`,
              recipientName: primaryName,
              rollNumber,
              qrDataUrl,
              programData: p,
              isAddon: true,
              addonNote: `This pass is for <strong>${addonName}</strong>, registered as an add-on under your account.`,
              isApprovalOnly: true
            });
            console.log('Addon approval email sent to', email, 'for addon', addonName);
          }
          await change.after.ref.set({ approvalEmailSent: true }, { merge: true });
        }
      }
    } catch (e) {
      console.error('onProgramAddonRegistrationUpdate trigger error', e);
    }
    return null;
  });

// Callable fallback: generateEventPass
// Parameters: { programId: string }
// Ensures rollNumber and qr exist for an existing registration doc.
export const generateEventPass = functions.region('us-central1').https.onCall(async (data, context) => {
  try {
    const uid = context.auth?.uid;
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'auth required');
    const programId = (data?.programId || '').trim();
    if (!programId) throw new functions.https.HttpsError('invalid-argument', 'programId required');

    const programRef = db.collection('programs').doc(programId);
    const pSnap = await programRef.get();
    const p = pSnap.data() || {};

    const userSnap = await db.collection('users').doc(uid).get();
    const userData = userSnap.data() || {};
    const isAdminOrOrg = userData.role === 'Admin' || userData.role === 'ProgramOrganizer' || (userData.roles && (userData.roles.includes('Admin') || userData.roles.includes('ProgramOrganizer')));
    const isAssistant = userData.role === 'Volunteer' && userData.organizerPermissions && userData.organizerPermissions.active !== false;

    const targetUid = ((isAdminOrOrg || isAssistant) && data?.registrationId) ? data.registrationId.trim() : uid;

    if (!isAdminOrOrg && !isAssistant) {
      let isPassReleased = true;
      const rawSDate = p.startDate || p.date || p.startTime || p.start || p.begin;
      let startObj = null;
      if (rawSDate) {
        if (typeof rawSDate.toDate === 'function') startObj = rawSDate.toDate();
        else startObj = new Date(rawSDate);
      }
      if (startObj && !isNaN(startObj.getTime())) {
        const msDiff = startObj.getTime() - Date.now();
        if (msDiff > 48 * 3600 * 1000) {
          isPassReleased = false;
        }
      }
      if (!isPassReleased) {
        throw new functions.https.HttpsError('failed-precondition', 'Pass will be released 48 hours before the program starts.');
      }
    }

    const regRef = programRef.collection('registrations').doc(targetUid);
    const regSnap = await regRef.get();
    if (!regSnap.exists) throw new functions.https.HttpsError('not-found', 'registration missing');
    const reg = regSnap.data() || {};
    if (reg.rejected) throw new functions.https.HttpsError('failed-precondition', 'registration rejected');
    if (reg.waitlisted) return { status: 'waitlisted' };

    // Ensure roll assignment exists with formatted number and sequence, mirroring onCreate logic
    let currentData = reg;
    if (!reg.rollNumber || !reg.rollSeq || !reg.counted) {
      await db.runTransaction(async (tx) => {
        const [pSnap, rSnap] = await Promise.all([tx.get(programRef), tx.get(regRef)]);
        if (!pSnap.exists) throw new functions.https.HttpsError('not-found', 'program missing');
        const p = pSnap.data() || {};
        const r = (rSnap.exists ? (rSnap.data() || {}) : {});
        if (r.rollNumber && r.rollSeq && r.counted) { currentData = Object.assign({}, r); return; }
        // Allocate next sequence from nextRollNumber counter (fallback to registeredCount)
        const capacity = typeof p.capacity === 'number' ? p.capacity : null;
        let nextRoll = (typeof p.nextRollNumber === 'number') ? p.nextRollNumber : 0;

        if (capacity && nextRoll >= capacity) {
          if (p.waitlistEnabled) {
            tx.update(regRef, { waitlisted: true });
            currentData = Object.assign({}, r, { waitlisted: true });
          } else {
            tx.update(regRef, { rejected: true, rejectionReason: 'FULL' });
            currentData = Object.assign({}, r, { rejected: true, rejectionReason: 'FULL' });
          }
          return;
        }

        nextRoll += 1;
        const seq = nextRoll;
        // Build formatted roll string: IIE + YY + programCode + seasonDigit + zero-padded 3-digit seq
        let yy = (new Date()).getFullYear();
        try { if (p.startDate && typeof p.startDate.toDate === 'function') yy = p.startDate.toDate().getFullYear(); } catch (_) { }
        const yy2 = String(yy).slice(-2);
        const rawCode = (p.programCode && typeof p.programCode === 'string') ? String(p.programCode).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) : null;
        const programCodePart = rawCode || 'GEN';
        let seasonDigit = null;
        if (typeof p.season === 'number' && [1, 2, 3, 4].includes(p.season)) {
          seasonDigit = p.season;
        } else if (p.startDate && typeof p.startDate.toDate === 'function') {
          try {
            const m = p.startDate.toDate().getMonth();
            if ([11, 0, 1].includes(m)) seasonDigit = 1; else if ([2, 3, 4].includes(m)) seasonDigit = 2; else if ([5, 6, 7].includes(m)) seasonDigit = 3; else seasonDigit = 4;
          } catch (_) { seasonDigit = 1; }
        } else { seasonDigit = 1; }
        const seqStr = String(seq).padStart(3, '0');
        const prefix = programCodePart.startsWith('IIE') ? '' : 'IIE';
        const formatted = `${prefix}${programCodePart}${seqStr}`;
        const newRegistered = (typeof p.registeredCount === 'number') ? (p.registeredCount + 1) : seq;
        tx.update(programRef, { registeredCount: newRegistered, nextRollNumber: seq, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        tx.update(regRef, { rollSeq: seq, rollNumber: formatted, counted: true });
        currentData = Object.assign({}, r, { rollSeq: seq, rollNumber: formatted, counted: true });
      });
    }

    if (currentData.rejected) throw new functions.https.HttpsError('failed-precondition', 'registration rejected');
    if (currentData.waitlisted) return { status: 'waitlisted' };

    // Generate QR if missing
    let qr = currentData.qr || null;
    if (!qr && currentData.rollNumber) {
      try {
        const payload = { t: 'event-pass', programId, registrationId: targetUid, studentUid: targetUid, rollNumber: currentData.rollNumber, ts: Date.now() };
        qr = await QRCode.toDataURL(JSON.stringify(payload), { errorCorrectionLevel: 'M', margin: 1, scale: 4 });
        await regRef.set({ qr }, { merge: true });
      } catch (e) { console.error('generateEventPass qr fail', e); }
    }
    return { status: 'ok', rollNumber: currentData.rollNumber, hasQr: !!qr };
  } catch (err) {
    if (err instanceof functions.https.HttpsError) throw err;
    console.error('generateEventPass error', err);
  }
});

// Callable fallback: generateAddonEventPass
// Parameters: { programId: string, addonId: string }
export const generateAddonEventPass = functions.region('us-central1').https.onCall(async (data, context) => {
  try {
    const uid = context.auth?.uid;
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'auth required');
    const programId = (data?.programId || '').trim();
    const addonId = (data?.addonId || '').trim();
    if (!programId || !addonId) throw new functions.https.HttpsError('invalid-argument', 'programId and addonId required');

    const programRef = db.collection('programs').doc(programId);
    const pSnap = await programRef.get();
    const p = pSnap.data() || {};

    const userSnap = await db.collection('users').doc(uid).get();
    const userData = userSnap.data() || {};
    const isAdminOrOrg = userData.role === 'Admin' || userData.role === 'ProgramOrganizer' || (userData.roles && (userData.roles.includes('Admin') || userData.roles.includes('ProgramOrganizer')));
    const isAssistant = userData.role === 'Volunteer' && userData.organizerPermissions && userData.organizerPermissions.active !== false;

    if (!isAdminOrOrg && !isAssistant) {
      let isPassReleased = true;
      const rawSDate = p.startDate || p.date || p.startTime || p.start || p.begin;
      let startObj = null;
      if (rawSDate) {
        if (typeof rawSDate.toDate === 'function') startObj = rawSDate.toDate();
        else startObj = new Date(rawSDate);
      }
      if (startObj && !isNaN(startObj.getTime())) {
        const msDiff = startObj.getTime() - Date.now();
        if (msDiff > 48 * 3600 * 1000) {
          isPassReleased = false;
        }
      }
      if (!isPassReleased) {
        throw new functions.https.HttpsError('failed-precondition', 'Pass will be released 48 hours before the program starts.');
      }
    }

    const regRef = programRef.collection('addon_registrations').doc(addonId);
    const regSnap = await regRef.get();
    if (!regSnap.exists) throw new functions.https.HttpsError('not-found', 'registration missing');
    const reg = regSnap.data() || {};

    if (reg.rejected) throw new functions.https.HttpsError('failed-precondition', 'registration rejected');
    if (reg.waitlisted) return { status: 'waitlisted' };

    let currentData = reg;
    if (!reg.rollNumber || !reg.rollSeq || !reg.counted) {
      await db.runTransaction(async (tx) => {
        const [pSnap, rSnap] = await Promise.all([tx.get(programRef), tx.get(regRef)]);
        if (!pSnap.exists) throw new functions.https.HttpsError('not-found', 'program missing');
        const p = pSnap.data() || {};
        const r = (rSnap.exists ? (rSnap.data() || {}) : {});
        if (r.rollNumber && r.rollSeq && r.counted) { currentData = Object.assign({}, r); return; }

        const capacity = typeof p.capacity === 'number' ? p.capacity : null;
        let nextRoll = (typeof p.nextRollNumber === 'number') ? p.nextRollNumber : 0;

        if (capacity && nextRoll >= capacity) {
          if (p.waitlistEnabled) {
            tx.update(regRef, { waitlisted: true });
            currentData = Object.assign({}, r, { waitlisted: true });
          } else {
            tx.update(regRef, { rejected: true, rejectionReason: 'FULL' });
            currentData = Object.assign({}, r, { rejected: true, rejectionReason: 'FULL' });
          }
          return;
        }

        nextRoll += 1;
        const seq = nextRoll;

        const rawCode = (p.programCode && typeof p.programCode === 'string') ? String(p.programCode).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) : null;
        const programCodePart = rawCode || 'GEN';
        const seqStr = String(seq).padStart(3, '0');
        const prefix = programCodePart.startsWith('IIE') ? '' : 'IIE';
        const formatted = `${prefix}${programCodePart}${seqStr}-AO`;

        const newRegistered = (typeof p.registeredCount === 'number') ? (p.registeredCount + 1) : seq;
        tx.update(programRef, { registeredCount: newRegistered, nextRollNumber: seq, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        tx.update(regRef, { rollSeq: seq, rollNumber: formatted, counted: true });
        currentData = Object.assign({}, r, { rollSeq: seq, rollNumber: formatted, counted: true });
      });
    }

    if (currentData.rejected) throw new functions.https.HttpsError('failed-precondition', 'registration rejected');
    if (currentData.waitlisted) return { status: 'waitlisted' };

    let qr = currentData.qr || null;
    if (!qr && currentData.rollNumber) {
      try {
        const payload = { t: 'event-pass', programId, registrationId: addonId, studentUid: addonId, rollNumber: currentData.rollNumber, ts: Date.now(), isAddon: true, addedByUid: currentData.addedByUid || uid };
        qr = await QRCode.toDataURL(JSON.stringify(payload), { errorCorrectionLevel: 'M', margin: 1, scale: 4 });
        await regRef.set({ qr }, { merge: true });
      } catch (e) { console.error('generateAddonEventPass qr fail', e); }
    }
    return { status: 'ok', rollNumber: currentData.rollNumber, hasQr: !!qr };
  } catch (err) {
    if (err instanceof functions.https.HttpsError) throw err;
    console.error('generateAddonEventPass error', err);
    throw new functions.https.HttpsError('internal', 'internal');
  }
});

// OPTIONAL: Decrement registeredCount if a registration is deleted (only if it was counted)
export const onProgramRegistrationDelete = functions.region('us-central1').firestore
  .document('programs/{programId}/registrations/{registrationId}')
  .onDelete(async (snap, context) => {
    const { programId } = context.params;
    const reg = snap.data() || {};
    const programRef = db.collection('programs').doc(programId);
    try {
      // 1. Decrement count if the deleted registration was counted
      if (reg.counted === true) {
        await db.runTransaction(async (tx) => {
          const programSnap = await tx.get(programRef);
          if (!programSnap.exists) return;
          const p = programSnap.data() || {};
          let registered = typeof p.registeredCount === 'number' ? p.registeredCount : 0;
          if (registered > 0) registered -= 1;
          tx.update(programRef, { registeredCount: registered, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        });

        // 2. Promote the oldest waitlisted student since a spot just opened up (primary or addon)
        await promoteNextWaitlistedStudent(programId);
      }
    } catch (e) {
      console.error('onProgramRegistrationDelete failure', programId, e);
    }
  });

export const onProgramAddonRegistrationDelete = functions.region('us-central1').firestore
  .document('programs/{programId}/addon_registrations/{registrationId}')
  .onDelete(async (snap, context) => {
    const { programId } = context.params;
    const reg = snap.data() || {};
    const programRef = db.collection('programs').doc(programId);
    try {
      if (reg.counted === true) {
        await db.runTransaction(async (tx) => {
          const programSnap = await tx.get(programRef);
          if (!programSnap.exists) return;
          const p = programSnap.data() || {};
          let registered = typeof p.registeredCount === 'number' ? p.registeredCount : 0;
          if (registered > 0) registered -= 1;
          tx.update(programRef, { registeredCount: registered, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        });

        // Promote next waitlisted student (primary or addon)
        await promoteNextWaitlistedStudent(programId);
      }
    } catch (e) {
      console.error('onProgramAddonRegistrationDelete failure', programId, e);
    }
  });

// Admin-protected endpoint to recalculate and backfill waitlist flags and registeredCount
// Runs in pages to avoid memory spikes. Body: none. Authorization: Bearer <idToken> of an Admin user.
export const backfillRecalculateWaitlists = functions.region('us-central1').https.onRequest(async (req, res) => {
  cors(req, res, async () => {
    try {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
      const authHeader = req.headers.authorization || '';
      if (!authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
      const idToken = authHeader.substring('Bearer '.length);
      const decoded = await admin.auth().verifyIdToken(idToken);
      const uid = decoded.uid;
      const userDoc = await db.collection('users').doc(uid).get();
      const role = userDoc.exists ? userDoc.data().role : null;
      if (role !== 'Admin') return res.status(403).json({ error: 'Forbidden' });

      const pageSize = 200;
      let last = null;
      let processedPrograms = 0;
      while (true) {
        let q = db.collection('programs').orderBy(admin.firestore.FieldPath.documentId());
        if (last) q = q.startAfter(last);
        const snap = await q.limit(pageSize).get();
        if (snap.empty) break;
        const batch = db.batch();
        for (const pDoc of snap.docs) {
          const pId = pDoc.id;
          const p = pDoc.data() || {};
          const cap = (typeof p.capacity === 'number') ? p.capacity : null;
          const waitlistEnabled = !!p.waitlistEnabled;
          if (!cap || cap <= 0) continue; // nothing to do for unlimited programs

          // Load registrations ordered by createdAt ascending (FIFO)
          const regsSnap = await db.collection('programs').doc(pId).collection('registrations').orderBy('createdAt', 'asc').get();
          const addonRegsSnap = await db.collection('programs').doc(pId).collection('addon_registrations').orderBy('createdAt', 'asc').get();

          const allRegs = [];
          regsSnap.forEach(r => allRegs.push(r));
          addonRegsSnap.forEach(r => allRegs.push(r));
          allRegs.sort((a, b) => {
            const ta = a.data().createdAt?.toDate ? a.data().createdAt.toDate().getTime() : Infinity;
            const tb = b.data().createdAt?.toDate ? b.data().createdAt.toDate().getTime() : Infinity;
            return ta - tb;
          });

          if (allRegs.length === 0) {
            // ensure registeredCount is zero
            batch.update(pDoc.ref, { registeredCount: 0, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
            processedPrograms++;
            continue;
          }

          // Count already confirmed (approved, counted, or with rollNumber) and skip rejected
          let confirmed = 0;
          for (const r of allRegs) {
            const d = r.data() || {};
            if (d.rejected) continue;
            if (d.approved || d.approvedAt || d.counted || d.rollNumber) confirmed++;
          }

          let slotsLeft = Math.max(0, cap - confirmed);
          // Prepare updates for overflow registrations
          for (const r of allRegs) {
            const d = r.data() || {};
            if (d.rejected) continue; // leave rejected as-is
            if (d.approved || d.approvedAt || d.counted || d.rollNumber) continue; // already confirmed
            if (slotsLeft > 0) {
              // This pending registration fits in capacity; leave as pending/confirmed for now
              slotsLeft -= 1;
              continue;
            }
            // Overflow: mark waitlisted or rejected depending on program setting
            if (waitlistEnabled) {
              if (!d.waitlisted) batch.update(r.ref, { waitlisted: true });
            } else {
              if (!d.rejected) batch.update(r.ref, { rejected: true, rejectionReason: 'FULL' });
            }
          }

          // Recompute registeredCount as number of registrations not rejected and not waitlisted
          const newRegistered = allRegs.filter(rd => { const dd = rd.data() || {}; return !dd.rejected && !dd.waitlisted; }).length;
          batch.update(pDoc.ref, { registeredCount: newRegistered, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
          processedPrograms++;
        }
        await batch.commit();
        last = snap.docs[snap.docs.length - 1];
        if (snap.size < pageSize) break;
      }

      return res.json({ status: 'ok', processedPrograms });
    } catch (err) {
      console.error('backfillRecalculateWaitlists error', err);
      return res.status(500).json({ error: 'internal' });
    }
  });
});

// Admin/Organizer-protected endpoint: import registrations for a program from parsed CSV rows
// Body: { programId: string, rows: Array<{ fullName?: string, name?: string, email?: string, phone?: string }> }
// Authorization: Bearer <idToken> of an Admin or ProgramOrganizer user
const importRuntime = { timeoutSeconds: 300, memory: '512MB' };
export const importProgramRegistrations = functions.region('us-central1').runWith(importRuntime).https.onRequest(async (req, res) => {
  if (handleCorsPreflight(req, res)) return;
  cors(req, res, async () => {
    try {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
      const authHeader = req.headers.authorization || '';
      if (!authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
      const idToken = authHeader.substring('Bearer '.length);
      const decoded = await admin.auth().verifyIdToken(idToken);
      const uid = decoded.uid;
      // Check role: allow Admin or ProgramOrganizer
      const userDoc = await db.collection('users').doc(uid).get();
      const uData = userDoc.exists ? (userDoc.data() || {}) : {};
      const primaryRole = uData.role;
      const rolesArr = Array.isArray(uData.roles) ? uData.roles : [];
      const isAdmin = primaryRole === 'Admin' || rolesArr.includes('Admin');
      const isOrganizer = primaryRole === 'ProgramOrganizer' || rolesArr.includes('ProgramOrganizer');
      if (!isAdmin && !isOrganizer) return res.status(403).json({ error: 'Forbidden' });

      const body = req.body || {};
      const programId = (body.programId ? String(body.programId).trim() : '');
      const rows = Array.isArray(body.rows) ? body.rows : [];
      if (!programId) return res.status(400).json({ error: 'programId required' });
      if (!rows.length) return res.status(400).json({ error: 'rows required' });
      if (rows.length > 500) return res.status(400).json({ error: 'too many rows (max 500 per request)' });

      const programRef = db.collection('programs').doc(programId);
      const pSnap = await programRef.get();
      if (!pSnap.exists) return res.status(404).json({ error: 'program missing' });

      // Normalize helper
      const toEmail = (v) => {
        if (!v || typeof v !== 'string') return null;
        const e = v.trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null;
        return e;
      };
      const toName = (v) => {
        if (!v || typeof v !== 'string') return null;
        const s = v.trim().replace(/\s+/g, ' ');
        return s.length >= 2 ? s : null;
      };
      const toPhone = (v) => {
        if (!v || typeof v !== 'string') return null;
        const digits = v.replace(/[^0-9+]/g, '').trim();
        return digits || null;
      };

      const now = admin.firestore.FieldValue.serverTimestamp();
      const results = [];

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i] || {};
        const fullName = toName(row.fullName || row.name || row.full_name || row['Full Name'] || row['Name']);
        const email = toEmail(row.email || row.Email || row['Email Address']);
        const phone = toPhone(row.phone || row.Phone || row['Phone Number'] || row['Contact']);
        const parentage = toName(row.parentage || row.Parentage || row.fatherName || row['Father Name'] || row['Father'] || row['Guardian']);
        const rawGender = (row.gender || row.Gender || row.sex || row.Sex || '').trim();
        const gender = rawGender ? (/^f/i.test(rawGender) ? 'Female' : (/^m/i.test(rawGender) ? 'Male' : rawGender)) : null;

        // Always generate a deterministic per-row student ID to ensure one student per CSV row
        // Priority: _rowIndex (best for idempotency) -> email hash -> name hash -> random
        let studentId = null;
        if (typeof row._rowIndex === 'number') {
          studentId = `imp_row_${programId}_${row._rowIndex}`;
        } else if (email) {
          const hash = crypto.createHash('sha1').update(email).digest('hex').slice(0, 20);
          studentId = `imp_${hash}`;
        } else if (fullName) {
          const key = `${programId}|${fullName.toLowerCase()}`;
          const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 20);
          studentId = `imp_name_${hash}`;
        } else {
          studentId = `imp_${crypto.randomUUID()}`;
        }

        // Upsert students/{studentId}
        const studentRef = db.collection('students').doc(studentId);
        const sSnap = await studentRef.get();
        const studentPayload = {
          role: 'Student',
          userUid: studentId,
          ...(fullName ? { fullName } : {}),
          ...(email ? { email } : {}),
          ...(phone ? { phone } : {}),
          ...(parentage ? { parentage } : {}),
          ...(gender ? { gender } : {}),
          imported: true,
          importSource: `csv:${programId}`,
          updatedAt: now,
          ...(sSnap.exists ? {} : { createdAt: now })
        };
        await studentRef.set(studentPayload, { merge: true });

        // Create registration doc with idempotency per row (allow multiple regs even if same student/email)
        // Deterministic regId: prefer _rowIndex; else hash of key fields
        let regId = null;
        if (typeof row._rowIndex === 'number') {
          regId = 'r_' + crypto.createHash('sha1').update(`${programId}|row|${row._rowIndex}`).digest('hex').slice(0, 20);
        } else {
          const key = `${programId}|${email || ''}|${(fullName || '').toLowerCase()}|${phone || ''}`;
          regId = 'r_' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 20);
        }
        const regRef = programRef.collection('registrations').doc(regId);
        const regSnap = await regRef.get();
        if (regSnap.exists) {
          // Update basic fields if missing; do not overwrite roll/qr; do not alter counted flags
          await regRef.set({
            studentUid: studentId,
            ...(fullName ? { studentName: fullName } : {}),
            ...(email ? { studentEmail: email } : {}),
            ...(phone ? { studentPhone: phone } : {}),
            ...(parentage ? { parentage } : {}),
            ...(gender ? { gender } : {}),
            updatedAt: now,
            source: 'import'
          }, { merge: true });
          results.push({ index: i, status: 'exists', registrationId: regId });
          continue;
        }

        // New registration: onCreate trigger will assign rollNumber and generate QR
        await regRef.set({
          studentUid: studentId,
          ...(fullName ? { studentName: fullName } : {}),
          ...(email ? { studentEmail: email } : {}),
          ...(phone ? { studentPhone: phone } : {}),
          ...(parentage ? { parentage } : {}),
          ...(gender ? { gender } : {}),
          createdAt: now,
          source: 'import'
        }, { merge: false });

        results.push({ index: i, status: 'created', registrationId: regId });
      }

      // Summarize
      const created = results.filter(r => r.status === 'created').length;
      const exists = results.filter(r => r.status === 'exists').length;
      const skipped = results.filter(r => r.status === 'skipped').length;
      return res.json({ status: 'ok', programId, counts: { created, exists, skipped }, results });
    } catch (err) {
      console.error('importProgramRegistrations error', err);
      return res.status(500).json({ error: 'internal' });
    }
  });
});

// Callable variant to avoid CORS issues from browsers. Requires Admin or ProgramOrganizer.
// data: { programId: string, rows: Array<{ fullName?: string, name?: string, email?: string, phone?: string }> }
export const importProgramRegistrationsCallable = functions.region('us-central1').runWith(importRuntime).https.onCall(async (data, context) => {
  try {
    if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Auth required');
    const uid = context.auth.uid;
    const userDoc = await db.collection('users').doc(uid).get();
    const uData = userDoc.exists ? (userDoc.data() || {}) : {};
    const primaryRole = uData.role;
    const rolesArr = Array.isArray(uData.roles) ? uData.roles : [];
    const isAdmin = primaryRole === 'Admin' || rolesArr.includes('Admin');
    const isOrganizer = primaryRole === 'ProgramOrganizer' || rolesArr.includes('ProgramOrganizer');
    if (!isAdmin && !isOrganizer) throw new functions.https.HttpsError('permission-denied', 'Forbidden');

    const programId = (data && data.programId) ? String(data.programId).trim() : '';
    const rows = Array.isArray(data && data.rows) ? data.rows : [];
    if (!programId) throw new functions.https.HttpsError('invalid-argument', 'programId required');
    if (!rows.length) throw new functions.https.HttpsError('invalid-argument', 'rows required');
    if (rows.length > 500) throw new functions.https.HttpsError('invalid-argument', 'too many rows (max 500)');

    const programRef = db.collection('programs').doc(programId);
    const pSnap = await programRef.get();
    if (!pSnap.exists) throw new functions.https.HttpsError('not-found', 'program missing');

    const toEmail = (v) => {
      if (!v || typeof v !== 'string') return null;
      const e = v.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null;
      return e;
    };
    const toName = (v) => {
      if (!v || typeof v !== 'string') return null;
      const s = v.trim().replace(/\s+/g, ' ');
      return s.length >= 2 ? s : null;
    };
    const toPhone = (v) => {
      if (!v || typeof v !== 'string') return null;
      const digits = v.replace(/[^0-9+]/g, '').trim();
      return digits || null;
    };

    const now = admin.firestore.FieldValue.serverTimestamp();
    const results = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] || {};
      const fullName = toName(row.fullName || row.name || row.full_name || row['Full Name'] || row['Name']);
      const email = toEmail(row.email || row.Email || row['Email Address']);
      const phone = toPhone(row.phone || row.Phone || row['Phone Number'] || row['Contact']);
      const parentage = toName(row.parentage || row.Parentage || row.fatherName || row['Father Name'] || row['Father'] || row['Guardian']);
      const rawGender = (row.gender || row.Gender || row.sex || row.Sex || '').trim();
      const gender = rawGender ? (/^f/i.test(rawGender) ? 'Female' : (/^m/i.test(rawGender) ? 'Male' : rawGender)) : null;

      // Always generate a deterministic per-row student ID to ensure one student per CSV row
      // Priority: _rowIndex (best for idempotency) -> email hash -> name hash -> random
      let studentId = null;
      if (typeof row._rowIndex === 'number') {
        studentId = `imp_row_${programId}_${row._rowIndex}`;
      } else if (email) {
        const hash = crypto.createHash('sha1').update(email).digest('hex').slice(0, 20);
        studentId = `imp_${hash}`;
      } else if (fullName) {
        const key = `${programId}|${fullName.toLowerCase()}`;
        const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 20);
        studentId = `imp_name_${hash}`;
      } else {
        studentId = `imp_${crypto.randomUUID()}`;
      }

      const studentRef = db.collection('students').doc(studentId);
      const sSnap = await studentRef.get();
      const studentPayload = {
        role: 'Student',
        userUid: studentId,
        ...(fullName ? { fullName } : {}),
        ...(email ? { email } : {}),
        ...(phone ? { phone } : {}),
        ...(parentage ? { parentage } : {}),
        ...(gender ? { gender } : {}),
        imported: true,
        importSource: `csv:${programId}`,
        updatedAt: now,
        ...(sSnap.exists ? {} : { createdAt: now })
      };
      await studentRef.set(studentPayload, { merge: true });

      // Determine a deterministic registrationId per row to allow multiple registrations per CSV row
      let regId = null;
      if (typeof row._rowIndex === 'number') {
        regId = 'r_' + crypto.createHash('sha1').update(`${programId}|row|${row._rowIndex}`).digest('hex').slice(0, 20);
      } else {
        const key = `${programId}|${email || ''}|${(fullName || '').toLowerCase()}|${phone || ''}`;
        regId = 'r_' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 20);
      }
      const regRef = programRef.collection('registrations').doc(regId);
      const regSnap = await regRef.get();
      if (regSnap.exists) {
        await regRef.set({
          studentUid: studentId,
          ...(fullName ? { studentName: fullName } : {}),
          ...(email ? { studentEmail: email } : {}),
          ...(phone ? { studentPhone: phone } : {}),
          ...(parentage ? { parentage } : {}),
          ...(gender ? { gender } : {}),
          updatedAt: now,
          source: 'import'
        }, { merge: true });
        results.push({ index: i, status: 'exists', registrationId: regId });
        continue;
      }

      await regRef.set({
        studentUid: studentId,
        ...(fullName ? { studentName: fullName } : {}),
        ...(email ? { studentEmail: email } : {}),
        ...(phone ? { studentPhone: phone } : {}),
        ...(parentage ? { parentage } : {}),
        ...(gender ? { gender } : {}),
        createdAt: now,
        source: 'import'
      }, { merge: false });
      results.push({ index: i, status: 'created', registrationId: regId });
    }

    const created = results.filter(r => r.status === 'created').length;
    const exists = results.filter(r => r.status === 'exists').length;
    const skipped = results.filter(r => r.status === 'skipped').length;
    return { status: 'ok', programId, counts: { created, exists, skipped }, results };
  } catch (err) {
    console.error('importProgramRegistrationsCallable error', err);
    if (err instanceof functions.https.HttpsError) throw err;
    throw new functions.https.HttpsError('internal', 'internal');
  }
});

// Sync pending request status to libraryBooks document
export const syncBookPendingStatus = functions.region('us-central1').firestore
  .document('libraryReservationRequests/{reqId}')
  .onWrite(async (change, context) => {
    const after = change.after.exists ? change.after.data() : null;
    const before = change.before.exists ? change.before.data() : null;
    const bookId = after?.bookId || before?.bookId;

    if (!bookId) return null;

    try {
      // Count pending requests for this book
      const snapshot = await db.collection('libraryReservationRequests')
        .where('bookId', '==', bookId)
        .where('status', '==', 'pending')
        .get();

      const count = snapshot.size;

      // Update the book document
      await db.collection('libraryBooks').doc(bookId).set({
        pendingRequestCount: count,
        hasPendingRequest: count > 0,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

    } catch (err) {
      console.error('syncBookPendingStatus error', err);
    }
    return null;
  });

// Notify user when reservation is rejected
export const notifyReservationRejection = functions
  .runWith({ secrets: [LIBRARY_GMAIL_EMAIL, LIBRARY_GMAIL_PASSWORD] })
  .region('us-central1').firestore
  .document('libraryReservationRequests/{reqId}')
  .onUpdate(async (change, context) => {
    const after = change.after.data();
    const before = change.before.data();

    // Only trigger if status changes to 'rejected'
    if (before.status === 'rejected' || after.status !== 'rejected') return null;

    const email = after.email;
    if (!email) {
      console.log('No email found in reservation request, skipping notification.');
      return null;
    }

    // Get book title for context
    let bookTitle = 'Book';
    if (after.bookId) {
      try {
        const bookSnap = await db.collection('libraryBooks').doc(after.bookId).get();
        if (bookSnap.exists) {
          bookTitle = bookSnap.data().title || 'Book';
        }
      } catch (e) {
        console.error('Error fetching book details for rejection email:', e);
      }
    } const mailOptions = {
      from: `"IIE Library" <${LIBRARY_GMAIL_EMAIL.value() || 'noreply@iie.org'}>`,
      to: email,
      subject: 'Reservation Request Update - IIE Library',
      text: `Assalamu Alaikum ${after.name || 'Student'},\n\n` +
        `Your reservation request for "${bookTitle}" has been cancelled/rejected.\n\n` +
        `Reason: ${after.rejectionReason || 'Not specified'}\n\n` +
        `For further details or queries, please contact the library administration:\n` +
        `Phone/WhatsApp: [YOUR_PHONE_HERE]\n` +
        `Email: [YOUR_LIBRARY_EMAIL_HERE]\n\n` +
        `Website: www.[YOUR_DOMAIN_HERE]\n\n` +
        `JazakAllah Khair,\nLibrarian [YOUR_INSTITUTE_NAME_HERE]`,
      html: getLibraryEmailHtml(
        'Reservation Request Update',
        `Assalamu Alaikum ${after.name || 'Student'},`,
        `Your reservation request for the book <strong>${escapeHtml(bookTitle)}</strong> has been cancelled or rejected.`,
        [
          { label: 'Book Title', value: bookTitle },
          { label: 'Status', value: 'Cancelled/Rejected' },
          { label: 'Reason', value: after.rejectionReason || 'Not specified' }
        ]
      )
    };
    try {
      await getLibraryMailTransport().sendMail(mailOptions);
      console.log(`Rejection email sent to ${email}`);
    } catch (error) {
      console.error('Error sending rejection email:', error);
    }
    return null;
  });

// Notify user when reservation is created and assign Tracking ID
export const notifyReservationRequest = functions
  .runWith({ secrets: [LIBRARY_GMAIL_EMAIL, LIBRARY_GMAIL_PASSWORD] })
  .region('us-central1').firestore
  .document('libraryReservationRequests/{reqId}')
  .onCreate(async (snap, context) => {
    const data = snap.data();
    const email = data.email;

    // Generate Tracking ID: IIEZL + Name(3) + Month(2) + Random(3)
    const namePart = (data.name || 'UNK').replace(/[^a-zA-Z]/g, '').substring(0, 3).toUpperCase().padEnd(3, 'X');
    const date = new Date();
    const monthPart = String(date.getMonth() + 1).padStart(2, '0');
    const randomPart = crypto.randomBytes(2).toString('hex').substring(0, 3).toUpperCase();
    const reservationId = `IIEZL${namePart}${monthPart}${randomPart}`;

    // Update the document with the generated ID
    try {
      await snap.ref.update({ reservationId });
    } catch (e) {
      console.error('Error updating reservation ID:', e);
    }

    // Get book title for context
    let bookTitle = 'Book';
    if (data.bookId) {
      try {
        const bookSnap = await db.collection('libraryBooks').doc(data.bookId).get();
        if (bookSnap.exists) {
          bookTitle = bookSnap.data().title || 'Book';
        }
      } catch (e) {
        console.error('Error fetching book details for confirmation email:', e);
      }
    }

    // 1. Send confirmation email to the user if email is provided
    if (email) {
      const mailOptions = {
        from: `"IIE Library" <${LIBRARY_GMAIL_EMAIL.value() || 'noreply@iie.org'}>`,
        to: email,
        subject: 'Reservation Received - IIE Library',
        text: `Assalamu Alaikum ${data.name || 'Student'},\n\n` +
          `Your reservation request for "${bookTitle}" has been received successfully.\n\n` +
          `Your Tracking ID is: ${reservationId}\n\n` +
          `You can use this ID on the library page to track the status of your request.\n\n` +
          `For further details or queries, please contact the library administration:\n` +
          `Phone/WhatsApp: [YOUR_PHONE_HERE]\n` +
          `Email: [YOUR_LIBRARY_EMAIL_HERE]\n\n` +
          `Website: www.[YOUR_DOMAIN_HERE]\n\n` +
          `JazakAllah Khair,\nLibrarian [YOUR_INSTITUTE_NAME_HERE]`,
        html: getLibraryEmailHtml(
          'Reservation Received',
          `Assalamu Alaikum ${data.name || 'Student'},`,
          `Your reservation request for the book <strong>${escapeHtml(bookTitle)}</strong> has been received successfully.`,
          [
            { label: 'Book Title', value: bookTitle },
            { label: 'Tracking ID', value: reservationId },
            { label: 'Status', value: 'Pending Approval' }
          ]
        )
      };
      try {
        await getLibraryMailTransport().sendMail(mailOptions);
        console.log(`Confirmation email sent to ${email} with ID ${reservationId}`);
      } catch (error) {
        console.error('Error sending confirmation email:', error);
      }
    } else {
      console.log('No email found in reservation request, skipping user confirmation email.');
    }

    // 2. Send admin alert email to library admin
    const adminMailOptions = {
      from: `"IIE Library" <${LIBRARY_GMAIL_EMAIL.value() || 'noreply@iie.org'}>`,
      to: '[YOUR_LIBRARY_EMAIL_HERE]',
      subject: `[New Reservation] ${data.name || 'Student'} - IIE Library`,
      text: `Assalamu Alaikum,\n\n` +
        `A new book reservation request has been received.\n\n` +
        `Applicant Name: ${data.name || 'N/A'}\n` +
        `Book Title: ${bookTitle}\n` +
        `Tracking ID: ${reservationId}\n` +
        `Pickup Date: ${data.pickupDate || 'Not specified'}\n` +
        `Notes: ${data.notes || 'None'}\n\n` +
        `Please review this request in the Librarian Admin Portal:\n` +
        `https://www.[YOUR_DOMAIN_HERE]/library-admin.html\n\n` +
        `JazakAllah Khair,\nIIE Library System`,
      html: getLibraryEmailHtml(
        'New Reservation Alert',
        `Assalamu Alaikum Admin,`,
        `A new book reservation request has been submitted by <strong>${escapeHtml(data.name || 'a student')}</strong> and is pending approval.`,
        [
          { label: 'Applicant', value: data.name || 'N/A' },
          { label: 'Book Title', value: bookTitle },
          { label: 'Tracking ID', value: reservationId },
          { label: 'Pickup Date', value: data.pickupDate || 'Not specified' },
          { label: 'Status', value: 'Pending Approval' }
        ]
      )
    };
    try {
      await getLibraryMailTransport().sendMail(adminMailOptions);
      console.log(`Admin alert email sent to [YOUR_LIBRARY_EMAIL_HERE] for request ${reservationId}`);
    } catch (error) {
      console.error('Error sending admin alert email:', error);
    }

    return null;
  });

// Public callable function to track a library request or loan by ID
export const trackLibraryRequest = functions.region('us-central1').https.onCall(async (data, context) => {
  const trackingId = (data.trackingId || '').trim().toUpperCase();
  if (!trackingId) {
    throw new functions.https.HttpsError('invalid-argument', 'Tracking ID is required.');
  }

  try {
    let requestData = null;
    let loanData = null;
    let bookId = null;

    // 1. Search in Requests
    const reqQuery = await db.collection('libraryReservationRequests')
      .where('reservationId', '==', trackingId)
      .limit(1)
      .get();

    if (!reqQuery.empty) {
      const doc = reqQuery.docs[0];
      requestData = doc.data();
      bookId = requestData.bookId;
    } else {
      // 2. Search in Loans
      const loanQuery = await db.collection('libraryLoans')
        .where('trackingId', '==', trackingId)
        .limit(1)
        .get();

      if (!loanQuery.empty) {
        const doc = loanQuery.docs[0];
        loanData = doc.data();
        bookId = loanData.bookId;
        // expose loan document id and return-request flags to caller
        loanData.__docId = doc.id;
      }
    }

    // If request found but fulfilled, check if it became a loan
    if (requestData && requestData.status === 'fulfilled') {
      const loanQuery = await db.collection('libraryLoans')
        .where('trackingId', '==', trackingId)
        .limit(1)
        .get();
      if (!loanQuery.empty) {
        const doc = loanQuery.docs[0];
        loanData = doc.data();
        // ensure doc id is exposed when loan found via fulfilled request path
        loanData.__docId = doc.id;
        // Prefer loan data for status if available
      }
    }

    if (!requestData && !loanData) {
      throw new functions.https.HttpsError('not-found', 'Tracking ID not found.');
    }

    // 3. Fetch Book Details
    let bookTitle = 'Unknown Book';
    let bookAuthor = '';

    if (bookId) {
      const bookSnap = await db.collection('libraryBooks').doc(bookId).get();
      if (bookSnap.exists) {
        const b = bookSnap.data();
        bookTitle = b.title || 'Unknown Book';
        bookAuthor = (b.authors || []).join(', ');
      }
    }

    // 4. Construct Response
    const result = {
      trackingId,
      bookTitle,
      bookAuthor,
      status: 'Unknown',
      details: {}
    };

    if (loanData) {
      // Pass common loan fields if present
      if (loanData.fineAmount) result.details.fineAmount = loanData.fineAmount;
      if (loanData.paymentRequired) result.details.paymentRequired = loanData.paymentRequired;
      if (loanData.adminMessage) result.details.adminMessage = loanData.adminMessage;

      if (loanData.status === 'active') {
        result.status = 'Checked Out';
        // include internal loan id for client actions
        if (loanData.__docId) result.details.loanId = loanData.__docId;
        result.details.dueDate = loanData.dueDate ? loanData.dueDate.toDate().toISOString() : null;

        if (loanData.dueDate) {
          const due = loanData.dueDate.toDate();
          const now = new Date();
          const diffTime = due - now;
          const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
          result.details.daysLeft = diffDays;
        }
        if (loanData.returnRequested) {
          result.details.returnRequested = true;
          if (loanData.returnRequestNote) result.details.returnRequestNote = loanData.returnRequestNote;
        }
      } else if (loanData.status === 'returned') {
        result.status = 'Returned';
        result.details.returnedAt = loanData.returnedAt ? loanData.returnedAt.toDate().toISOString() : null;
      }

      // Fallback: Preserve admin message from request if not already set by loan
      if (!result.details.adminMessage && requestData && requestData.adminMessage) {
        result.details.adminMessage = requestData.adminMessage;
      }
    } else if (requestData) {
      if (requestData.status === 'pending') {
        result.status = 'Pending Approval';
      } else if (requestData.status === 'update_sent') {
        result.status = 'Action Required';
        result.details.adminMessage = requestData.adminMessage;
        result.details.shippingCost = requestData.shippingCost;
      } else if (requestData.status === 'response_received') {
        result.status = 'Response Sent';
        result.details.userResponse = requestData.userResponse;
        result.details.adminMessage = requestData.adminMessage; // Show history
        result.details.shippingCost = requestData.shippingCost;
      } else if (requestData.status === 'rejected') {
        result.status = 'Rejected';
        result.details.rejectionReason = requestData.rejectionReason || 'Not specified';
      } else if (requestData.status === 'fulfilled') {
        result.status = 'Approved'; // Fallback if loan not found
      }
    }

    return result;

  } catch (error) {
    console.error('Error in trackLibraryRequest:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', 'An error occurred while tracking.');
  }
});

export const respondToLibraryRequest = functions.region('us-central1').https.onCall(async (data, context) => {
  const trackingId = (data.trackingId || '').trim().toUpperCase();
  const response = (data.response || '').trim();

  if (!trackingId || !response) {
    throw new functions.https.HttpsError('invalid-argument', 'Tracking ID and response are required.');
  }

  // Find the request
  const reqQuery = await db.collection('libraryReservationRequests')
    .where('reservationId', '==', trackingId)
    .limit(1)
    .get();

  if (reqQuery.empty) {
    throw new functions.https.HttpsError('not-found', 'Tracking ID not found.');
  }

  const doc = reqQuery.docs[0];

  await doc.ref.update({
    userResponse: response,
    status: 'response_received',
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  return { success: true };
});

// Helper: Build highly aesthetic welcome email for Al-Tarbiyah newsletter subscribers
function buildNewsletterEmailHtml({ recipientName, emailAddress, phoneNum, countryCode }) {
  const formattedPhone = phoneNum ? `${countryCode} ${phoneNum}` : 'Not provided';
  const subscribeDate = new Date().toLocaleDateString('en-IN', { dateStyle: 'long' });

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Welcome to Al-Tarbiyah</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Scheherazade+New:wght@400;700&display=swap" rel="stylesheet">
  <style>
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background-color: #f4f6f8;
      margin: 0;
      padding: 0;
      -webkit-font-smoothing: antialiased;
    }
    .email-container {
      max-width: 600px;
      margin: 40px auto;
      background-color: #ffffff;
      border-radius: 20px;
      overflow: hidden;
      box-shadow: 0 10px 30px rgba(0,0,0,0.06);
    }
    .header {
      background: #1e3a8a;
      padding: 45px 30px;
      text-align: center;
      color: #ffffff;
    }
    .header-english {
      font-size: 22px;
      font-weight: 700;
      margin: 0;
      letter-spacing: 0.5px;
      font-family: 'Inter', sans-serif;
    }
    .header-arabic {
      font-family: 'Scheherazade New', 'Traditional Arabic', 'Times New Roman', serif;
      font-size: 32px;
      font-weight: 700;
      direction: rtl;
      margin: 12px 0 0 0;
      color: #86efac;
      line-height: 1.2;
    }
    .content {
      padding: 40px 35px;
      color: #334155;
      line-height: 1.8;
      font-size: 15.5px;
    }
    .salaam-box {
      font-family: 'Scheherazade New', 'Traditional Arabic', 'Times New Roman', serif;
      font-size: 28px;
      font-weight: 700;
      color: #047857;
      direction: rtl;
      text-align: right;
      margin-bottom: 25px;
      line-height: 1.4;
    }
    .intro-text {
      margin-bottom: 30px;
      font-size: 16px;
      color: #475569;
    }
    .section-title {
      font-size: 18px;
      font-weight: 700;
      color: #1e1b4b;
      margin-top: 35px;
      margin-bottom: 20px;
      padding-bottom: 8px;
      border-bottom: 2px solid #e2e8f0;
    }
    .feature-card {
      background-color: #f8fafc;
      border-left: 4px solid #10b981;
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 20px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.01);
    }
    .feature-title {
      font-size: 16.5px;
      font-weight: 700;
      color: #1e1b4b;
      margin: 0 0 6px 0;
    }
    .feature-desc {
      font-size: 14px;
      color: #475569;
      margin: 0 0 12px 0;
      line-height: 1.5;
    }
    .feature-link {
      display: inline-flex;
      align-items: center;
      color: #059669;
      font-weight: 600;
      font-size: 14px;
      text-decoration: none;
    }
    .details-card {
      background: linear-gradient(145deg, #f1f5f9 0%, #e2e8f0 100%);
      border-radius: 16px;
      padding: 25px;
      margin: 35px 0;
      border: 1px solid #cbd5e1;
    }
    .details-title {
      font-size: 14px;
      font-weight: 700;
      color: #1e1b4b;
      margin-top: 0;
      margin-bottom: 15px;
      text-transform: uppercase;
      letter-spacing: 1px;
    }
    .details-row {
      display: flex;
      justify-content: space-between;
      border-bottom: 1px dashed #cbd5e1;
      padding: 10px 0;
      font-size: 14px;
    }
    .details-row:last-child {
      border-bottom: none;
    }
    .details-label {
      color: #64748b;
      font-weight: 500;
    }
    .details-value {
      color: #0f172a;
      font-weight: 600;
    }
    .cta-section {
      text-align: center;
      margin: 40px 0;
    }
    .cta-btn {
      background: linear-gradient(135deg, #10b981 0%, #059669 100%);
      color: #ffffff !important;
      font-weight: 700;
      padding: 15px 35px;
      border-radius: 50px;
      text-decoration: none;
      display: inline-block;
      font-size: 15.5px;
      box-shadow: 0 8px 16px rgba(16,185,129,0.2);
    }
    .footer {
      background-color: #16a34a;
      padding: 40px 30px;
      color: #ffffff;
      font-size: 14.5px;
      border-top: 5px solid #1e3a8a;
    }
    .footer-title {
      color: #ffffff;
      font-size: 16px;
      font-weight: 700;
      margin-bottom: 20px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .footer-text {
      margin-bottom: 20px;
      line-height: 1.6;
      color: #ffffff;
    }
    .footer-contact-item {
      margin-bottom: 12px;
      display: block;
      width: 100%;
      color: #ffffff;
      font-size: 14px;
      line-height: 1.5;
    }
    .footer-contact-row {
      display: table;
      width: 100%;
      border-collapse: collapse;
    }
    .footer-contact-icon {
      display: table-cell;
      width: 28px;
      vertical-align: middle;
      padding-right: 8px;
    }
    .footer-contact-text {
      display: table-cell;
      vertical-align: middle;
      color: #bfdbfe;
      font-size: 14px;
    }
    .footer-contact-link {
      color: #fef08a;
      text-decoration: none;
      font-weight: 600;
    }
    .footer-social-link-block {
      display: inline-block;
      margin-right: 18px;
      color: #fef08a !important;
      text-decoration: none;
      font-weight: 600;
      font-size: 14px;
      vertical-align: middle;
    }
    .social-label-english {
      font-weight: 700;
      font-size: 14px;
      vertical-align: middle;
    }
    .copyright {
      text-align: center;
      margin-top: 20px;
      font-size: 11px;
      color: #e6f9ed;
    }
    @media only screen and (max-width: 600px) {
      .email-container {
        margin: 0 auto;
        border-radius: 0;
      }
      .content {
        padding: 30px 18px;
      }
      .header {
        padding: 30px 18px;
      }
      .footer {
        padding: 30px 18px;
      }
      .header-arabic {
        font-size: 26px;
      }
      .salaam-box {
        font-size: 22px;
      }
      .details-row {
        display: block;
        padding: 8px 0;
      }
      .details-label, .details-value {
        display: block;
        width: 100%;
      }
      .details-value {
        margin-top: 2px;
      }
    }
  </style>
</head>
<body>
  <div class="email-container">
    <div class="header">
      <div class="header-english">[YOUR_INSTITUTE_NAME_HERE]</div>
      <div class="header-arabic">معهد التربية الاسلامية</div>
    </div>
    <div class="content">
      <div class="salaam-box">السَّلَامُ عَلَيْكُمْ وَرَحْمَةُ اللهِ وَبَرَكَاتُهُ</div>
      
      <p class="intro-text">
        Dear <strong>${escapeHtml(recipientName)}</strong>,<br><br>
        Thank you for subscribing to <strong>Al-Tarbiyah</strong>, the official newsletter of the <strong>[YOUR_INSTITUTE_NAME_HERE]</strong>. We are thrilled to welcome you to our community of learning, spiritual development, and educational excellence.
      </p>

      <div class="section-title">Explore Our Key Services</div>
      
      <div class="feature-card">
        <h4 class="feature-title">📚 Zubairiyyah Library</h4>
        <p class="feature-desc">Discover our comprehensive selection of authentic Islamic books, reference manuscripts, and academic research papers.</p>
        <a href="https://www.[YOUR_DOMAIN_HERE]/library" target="_blank" class="feature-link">Visit the Library &rarr;</a>
      </div>

      <div class="feature-card">
        <h4 class="feature-title">🎓 Student Portal & Courses</h4>
        <p class="feature-desc">Access our online student environment, enroll in structured curriculum programs, and track your ongoing academic progress.</p>
        <a href="https://www.[YOUR_DOMAIN_HERE]/student-login" target="_blank" class="feature-link">Access Student Portal &rarr;</a>
      </div>

      <div class="feature-card">
        <h4 class="feature-title">✍️ Scholarly Blogs & Articles</h4>
        <p class="feature-desc">Read inspiring articles, weekly notices, and academic essays written by our respected instructors and dedicated students.</p>
        <a href="https://www.[YOUR_DOMAIN_HERE]/#writings" target="_blank" class="feature-link">Read Latest Blogs &rarr;</a>
      </div>

      <div class="feature-card">
        <h4 class="feature-title">📅 Upcoming Programs & Events</h4>
        <p class="feature-desc">Stay informed about our upcoming virtual seminars, community development workshops, and spiritual retreats.</p>
        <a href="https://www.[YOUR_DOMAIN_HERE]/#events" target="_blank" class="feature-link">View Upcoming Events &rarr;</a>
      </div>

      <div class="details-card">
        <h4 class="details-title">Your Subscription Information</h4>
        <div class="details-row">
          <span class="details-label">Subscriber Name:</span>
          <span class="details-value">${escapeHtml(recipientName)}</span>
        </div>
        <div class="details-row">
          <span class="details-label">Registered Email:</span>
          <span class="details-value">${escapeHtml(emailAddress)}</span>
        </div>
        <div class="details-row">
          <span class="details-label">Phone Number:</span>
          <span class="details-value">${escapeHtml(formattedPhone)}</span>
        </div>
        <div class="details-row">
          <span class="details-label">Joined On:</span>
          <span class="details-value">${escapeHtml(subscribeDate)}</span>
        </div>
      </div>

      <div class="cta-section">
        <a href="https://www.[YOUR_DOMAIN_HERE]" target="_blank" class="cta-btn">Visit Our Website</a>
      </div>
    </div>
    

    <div class="footer">
      <!-- Centered brand header with Scheherazade New traditional Arabic font -->
      <div style="text-align: center; margin-bottom: 25px; border-bottom: 1px solid rgba(255, 255, 255, 0.15); padding-bottom: 15px;">
        <div style="font-size: 18px; font-weight: 700; color: #ffffff; letter-spacing: 0.5px; margin-bottom: 6px; font-family: 'Inter', -apple-system, sans-serif;">[YOUR_INSTITUTE_NAME_HERE]</div>
        <div style="font-family: 'Scheherazade New', 'Traditional Arabic', 'Times New Roman', serif; font-size: 28px; font-weight: 700; color: #ffffff; direction: rtl; line-height: 1.4; unicode-bidi: bidi-override;">معهد التربية الاسلامية</div>
      </div>

      <!-- Phone row — table-based for email client compatibility -->
      <div class="footer-contact-item">
        <div class="footer-contact-row">
          <div class="footer-contact-icon">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.63 3.37 2 2 0 0 1 3.6 1h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.6a16 16 0 0 0 6 6l.94-.94a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 21.72 16z"/></svg>
          </div>
          <div class="footer-contact-text">Phone: <a href="tel:+[YOUR_PHONE_DIGITS]" class="footer-contact-link">[YOUR_PHONE_HERE]</a></div>
        </div>
      </div>

      <!-- WhatsApp row -->
      <div class="footer-contact-item">
        <div class="footer-contact-row">
          <div class="footer-contact-icon">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="#25D366"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413z"/></svg>
          </div>
          <div class="footer-contact-text">WhatsApp: <a href="https://wa.me/[YOUR_PHONE_DIGITS]" target="_blank" class="footer-contact-link">[YOUR_PHONE_HERE]</a></div>
        </div>
      </div>

      <!-- Email row -->
      <div class="footer-contact-item">
        <div class="footer-contact-row">
          <div class="footer-contact-icon">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>
          </div>
          <div class="footer-contact-text">Email: <a href="mailto:[YOUR_CONTACT_EMAIL_HERE]" class="footer-contact-link">[YOUR_CONTACT_EMAIL_HERE]</a></div>
        </div>
      </div>

      <!-- YouTube & Facebook — table-based for perfect alignment -->
      <div class="footer-contact-item" style="margin-top: 10px;">
        <div class="footer-contact-row">
          <div class="footer-contact-icon">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="#FF0000"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>
          </div>
          <div class="footer-contact-text" style="width: 50%;">
            <a href="https://youtube.com/@[YOUR_YOUTUBE_CHANNEL]" target="_blank" class="footer-contact-link">YouTube</a>
          </div>
          <div class="footer-contact-icon">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="#1877F2"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>
          </div>
          <div class="footer-contact-text">
            <a href="https://facebook.com/[YOUR_FACEBOOK_PAGE]" target="_blank" class="footer-contact-link">Facebook</a>
          </div>
        </div>
      </div>

      <!-- Address row — table-based -->
      <div class="footer-contact-item" style="margin-top: 10px;">
        <div class="footer-contact-row">
          <div class="footer-contact-icon" style="vertical-align: top; padding-top: 2px;">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="#FF3B30"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>
          </div>
          <div class="footer-contact-text">
            <a href="https://maps.app.goo.gl/[YOUR_MAPS_LINK]" target="_blank" class="footer-contact-link" style="text-decoration:none;">[YOUR_ADDRESS_HERE]</a>
          </div>
        </div>
      </div>
      
      <!-- Unsubscribe -->
      <div class="unsubscribe-box" style="margin-top: 25px; padding-top: 15px; border-top: 1px solid rgba(255,255,255,0.25); text-align: center; font-size: 12px; color: #e6f9ed;">
        You received this email because you subscribed to Al-Tarbiyah Newsletter.<br>
        <a href="https://us-central1-[YOUR_FIREBASE_APP_ID].cloudfunctions.net/newsletterUnsubscribe?email=${encodeURIComponent(emailAddress)}" target="_blank" style="color: #fef08a; text-decoration: underline; font-weight: 600;">Unsubscribe from our newsletter</a>
      </div>
      
      <div class="copyright">
        &copy; ${new Date().getFullYear()} <a href="https://www.[YOUR_DOMAIN_HERE]" target="_blank" style="color: #fef08a; text-decoration: none; font-weight: 600;">[YOUR_INSTITUTE_NAME_HERE]</a>. All Rights Reserved.
      </div>
    </div>
  </div>
</body>
</html>`;
}

// Cloud Function: Send Welcome Email to new Al-Tarbiyah subscribers
export const onNewsletterSubscriberCreate = functions.runWith({ secrets: [GMAIL_EMAIL, GMAIL_PASSWORD] }).region('us-central1').firestore
  .document('newsletterSubscribers/{subscriberId}')
  .onCreate(async (snap, context) => {
    const data = snap.data() || {};
    const email = data['newsletter-email'] || data.email || null;
    const name = data['newsletter-name'] || data.name || 'Subscriber';
    const phone = data['newsletter-phone'] || data.phone || '';
    const countryCode = data['country-code'] || data.countryCode || '';

    if (!email) {
      console.warn('No email address provided for newsletter subscriber:', snap.id);
      return null;
    }

    try {
      const htmlContent = buildNewsletterEmailHtml({
        recipientName: name,
        emailAddress: email,
        phoneNum: phone,
        countryCode: countryCode
      });

      await getMailTransport().sendMail({
        from: `"[YOUR_INSTITUTE_NAME_HERE]" <${GMAIL_EMAIL.value()}>`,
        to: email,
        subject: `✨ Welcome to Al-Tarbiyah – [YOUR_INSTITUTE_NAME_HERE]`,
        html: htmlContent
      });

      console.log('Al-Tarbiyah welcome email sent successfully to:', email);
    } catch (err) {
      console.error('Failed to send Al-Tarbiyah welcome email:', err);
    }
    return null;
  });

// Cloud Function: Handle newsletter unsubscribe requests
export const newsletterUnsubscribe = functions.region('us-central1').https.onRequest(async (req, res) => {
  const db = admin.firestore();
  const email = (req.query.email || '').toString().trim().toLowerCase();

  const sendPage = (title, heading, message, isSuccess) => {
    const color = isSuccess ? '#16a34a' : '#dc2626';
    const bg = isSuccess ? '#f0fdf4' : '#fef2f2';
    const icon = isSuccess ? '✅' : '❌';
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} – [YOUR_INSTITUTE_NAME_HERE]</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=Amiri:wght@400;700&display=swap');
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Inter', -apple-system, sans-serif; background: #f4f6f8; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .card { background: #fff; border-radius: 20px; box-shadow: 0 10px 40px rgba(0,0,0,0.08); padding: 48px 36px; max-width: 480px; width: 100%; text-align: center; }
    .header-bar { background: #1e3a8a; border-radius: 14px; padding: 22px 20px; margin-bottom: 32px; }
    .header-bar h1 { color: #fff; font-size: 17px; font-weight: 700; }
    .header-bar p { font-family: 'Amiri', serif; font-size: 22px; color: #86efac; margin-top: 4px; direction: rtl; }
    .icon { font-size: 56px; margin-bottom: 20px; }
    .badge { display: inline-block; background: ${bg}; color: ${color}; border-radius: 50px; padding: 4px 16px; font-size: 13px; font-weight: 600; margin-bottom: 18px; border: 1px solid ${color}33; }
    h2 { font-size: 22px; font-weight: 700; color: #0f172a; margin-bottom: 12px; }
    p { color: #475569; font-size: 15px; line-height: 1.7; margin-bottom: 10px; }
    a.btn { display: inline-block; margin-top: 24px; background: #16a34a; color: #fff; font-weight: 700; padding: 12px 32px; border-radius: 50px; text-decoration: none; font-size: 15px; }
    a.btn:hover { background: #15803d; }
    .footer-note { margin-top: 28px; font-size: 12px; color: #94a3b8; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header-bar">
      <h1>[YOUR_INSTITUTE_NAME_HERE]</h1>
      <p>معهد التربية الاسلامية</p>
    </div>
    <div class="icon">${icon}</div>
    <div class="badge">${isSuccess ? 'Unsubscribed' : 'Error'}</div>
    <h2>${heading}</h2>
    <p>${message}</p>
    <a href="https://www.[YOUR_DOMAIN_HERE]" class="btn">Visit Our Website</a>
    <p class="footer-note">© ${new Date().getFullYear()} [YOUR_INSTITUTE_NAME_HERE]. All Rights Reserved.</p>
  </div>
</body>
</html>`);
  };

  if (!email || !email.includes('@')) {
    return sendPage('Invalid Request', 'Invalid Email Address', 'The unsubscribe link appears to be invalid or malformed. Please contact us at <a href="mailto:[YOUR_CONTACT_EMAIL_HERE]">[YOUR_CONTACT_EMAIL_HERE]</a> if you need assistance.', false);
  }

  try {
    const snap = await db.collection('newsletterSubscribers')
      .where('newsletter-email', '==', email)
      .limit(5)
      .get();

    if (snap.empty) {
      return sendPage('Already Removed', 'Not Found', `The email <strong>${email}</strong> is not currently subscribed to Al-Tarbiyah Newsletter, or has already been unsubscribed.`, true);
    }

    const batch = db.batch();
    snap.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();

    console.log('Al-Tarbiyah newsletter unsubscribe successful for:', email);
    return sendPage('Unsubscribed', 'You Have Been Unsubscribed', `The email <strong>${email}</strong> has been successfully removed from the Al-Tarbiyah Newsletter. You will no longer receive newsletter emails from us.<br><br>We are sorry to see you go. If this was a mistake, you can always re-subscribe on our website.`, true);
  } catch (err) {
    console.error('Unsubscribe error:', err);
    return sendPage('Error', 'Something Went Wrong', 'We were unable to process your unsubscribe request at this time. Please try again later or contact us at <a href="mailto:[YOUR_CONTACT_EMAIL_HERE]">[YOUR_CONTACT_EMAIL_HERE]</a>.', false);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// FCM PUSH NOTIFICATIONS
// ─────────────────────────────────────────────────────────────────────────────

/** Split an array into fixed-size chunks. */
function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

/**
 * onNewAnnouncement
 * Fires when a Program Organizer writes a new broadcast to `announcements`.
 * Reads every student FCM token and sends a real device push so students
 * receive the alert even when the PWA / browser tab is closed.
 */
export const onNewAnnouncement = functions.firestore
  .document('announcements/{docId}')
  .onCreate(async (snap, context) => {
    const data = snap.data();
    if (!data) return null;
    const { title, message, priority, audience, audienceGenders } = data;
    if (!title && !message) return null;

    const db = admin.firestore();
    const docId = context.params.docId;
    const aud = audience || 'all_students';

    const tokenToUid = {};

    try {
      if (Array.isArray(aud) && aud.length > 0) {
        // Specific students (UIDs)
        const refs = aud.map(uid => db.collection('students').doc(uid));
        for (let i = 0; i < refs.length; i += 100) {
          const batchRefs = refs.slice(i, i + 100);
          const docs = await db.getAll(...batchRefs);
          docs.forEach(d => {
            if (!d.exists) return;
            const stuData = d.data();

            // Gender filtering via audienceGenders (sent by assistant)
            if (audienceGenders && Array.isArray(audienceGenders)) {
              const g = (stuData.gender || '').toLowerCase();
              if (g && !audienceGenders.includes(g)) return; // block send
            }

            const t = stuData.fcmToken;
            const arr = stuData.fcmTokens;
            if (t && typeof t === 'string') tokenToUid[t] = d.id;
            if (Array.isArray(arr)) {
              arr.forEach(token => { if (token && typeof token === 'string') tokenToUid[token] = d.id; });
            }
          });
        }
      } else {
        // Group audience
        let q = db.collection('students').select('fcmToken', 'fcmTokens', 'gender');
        if (aud === 'verified') q = q.where('status', 'in', ['Approved', 'Active', 'Enrolled']);
        else if (aud === 'pending') q = q.where('status', '==', 'Pending');
        else if (aud === 'waitlisted') q = q.where('status', '==', 'Waitlisted');

        const studentsSnap = await q.get();
        studentsSnap.docs.forEach(d => {
          const stuData = d.data();

          // Gender filtering via audienceGenders (sent by assistant)
          if (audienceGenders && Array.isArray(audienceGenders)) {
            const g = (stuData.gender || '').toLowerCase();
            if (g && !audienceGenders.includes(g)) return; // block send
          }

          const t = stuData.fcmToken;
          const arr = stuData.fcmTokens;
          if (t && typeof t === 'string') tokenToUid[t] = d.id;
          if (Array.isArray(arr)) {
            arr.forEach(token => { if (token && typeof token === 'string') tokenToUid[token] = d.id; });
          }
        });
      }
    } catch (err) {
      console.error('onNewAnnouncement: failed to fetch tokens', err);
      return null;
    }

    const tokens = Object.keys(tokenToUid);
    if (!tokens.length) {
      console.log('onNewAnnouncement: no student FCM tokens — skipping');
      return null;
    }
    console.log(`onNewAnnouncement: sending push to ${tokens.length} students`);

    const isUrgent = priority === 'high';
    const staleTokens = [];

    for (const batch of chunkArray(tokens, 500)) {
      let result;
      try {
        result = await admin.messaging().sendEachForMulticast({
          tokens: batch,
          notification: { title: title || 'New Announcement', body: message || '' },
          webpush: {
            headers: {
              Urgency: 'high',   // Makes Android Chrome play sound & vibrate
            },
            notification: {
              icon: '/icons/icon-512.png',          // Crisp 512px icon
              badge: '/icons/badge.png', // Monochrome badge for status bar
              vibrate: [200, 100, 200, 100, 200],
              tag: docId,             // unique per doc — no collapsing
              requireInteraction: true, // Stay on screen until dismissed
              renotify: true,           // Always alert even if same tag
            },
            fcmOptions: { link: '/student.html#notifications' },
            data: { docId, url: '/student.html#notifications' },
          },
          android: {
            priority: 'high',    // Always high — wake screen + sound
            notification: {
              tag: docId,
              sound: 'default',
              defaultSound: true,
              notificationPriority: 'PRIORITY_HIGH',
              channelId: 'iie_announcements',
            },
          },
        });
      } catch (err) {
        console.error('onNewAnnouncement: multicast error', err);
        continue;
      }
      result.responses.forEach((resp, i) => {
        if (!resp.success) {
          const code = resp.error?.code || '';
          if (code === 'messaging/registration-token-not-registered' ||
            code === 'messaging/invalid-registration-token') {
            staleTokens.push(batch[i]);
          }
        }
      });
    }

    // Remove stale tokens from Firestore
    if (staleTokens.length) {
      console.log(`onNewAnnouncement: removing ${staleTokens.length} stale token(s)`);
      const bw = db.batch();
      // Group stale tokens by uid so we can do one write per student
      const staleByUid = {};
      staleTokens.forEach(token => {
        const uid = tokenToUid[token];
        if (uid) {
          if (!staleByUid[uid]) staleByUid[uid] = [];
          staleByUid[uid].push(token);
        }
      });
      // For each uid, read their current fcmToken before deciding to delete it
      for (const [uid, badTokens] of Object.entries(staleByUid)) {
        const ref = db.collection('students').doc(uid);
        const updates = { fcmTokens: admin.firestore.FieldValue.arrayRemove(...badTokens) };
        // Only delete the legacy fcmToken field if it is one of the stale tokens
        const studentDoc = await ref.get();
        const legacyToken = studentDoc.data()?.fcmToken;
        if (legacyToken && badTokens.includes(legacyToken)) {
          updates.fcmToken = admin.firestore.FieldValue.delete();
        }
        bw.update(ref, updates);
      }
      try { await bw.commit(); } catch (err) { console.warn('Stale token cleanup failed', err); }
    }

    return null;
  });

/**
 * onNewStudentNotification
 * Fires when a targeted notification is written to `student_notifications`
 * (e.g. add-on verify/reject from Program Organizer).
 * Sends a push only to that specific student's device.
 */
export const onNewStudentNotification = functions.firestore
  .document('student_notifications/{docId}')
  .onCreate(async (snap, context) => {
    const data = snap.data();
    if (!data) return null;
    const { studentUid, title, message } = data;
    if (!studentUid || (!title && !message)) return null;

    const db = admin.firestore();
    const docId = context.params.docId;

    let studentSnap;
    try {
      studentSnap = await db.collection('students').doc(studentUid).get();
    } catch (err) {
      console.error('onNewStudentNotification: failed to fetch student', err);
      return null;
    }

    const studentData = studentSnap.data() || {};
    let tokens = [];
    if (studentData.fcmToken) tokens.push(studentData.fcmToken);
    if (Array.isArray(studentData.fcmTokens)) tokens.push(...studentData.fcmTokens);
    tokens = [...new Set(tokens)];

    if (!tokens.length) return null;

    try {
      await admin.messaging().sendEachForMulticast({
        tokens,
        notification: { title: title || 'IIE Notification', body: message || '' },
        webpush: {
          notification: {
            icon: '/IMG-20230327-WA0002.jpg',
            badge: '/icons/badge.png',
            tag: docId,
          },
          fcmOptions: { link: '/student.html' },
          data: { docId, url: '/student.html' },
        },
      });
    } catch (err) {
      // Clean up stale tokens if possible.
      // With sendEachForMulticast, we'd need to check responses, but for simplicity here 
      // we'll just let them accumulate or rely on onNewAnnouncement for cleanup.
    }
    return null;
  });

// Trigger: Send Profile Approved Notification
export const onStudentProfileApproved = functions.runWith({ secrets: [GMAIL_EMAIL, GMAIL_PASSWORD] }).region('us-central1').firestore
  .document('students/{uid}')
  .onUpdate(async (change, context) => {
    const before = change.before.data() || {};
    const after = change.after.data() || {};

    if (before.status !== 'Approved' && after.status === 'Approved') {
      let newEnrollmentId = after.enrollmentId;

      // Generate sequential Enrollment ID if they don't have one
      if (!newEnrollmentId) {
        try {
          newEnrollmentId = await admin.firestore().runTransaction(async (transaction) => {
            const counterRef = admin.firestore().collection('metadata').doc('enrollmentCounter');
            const counterDoc = await transaction.get(counterRef);
            let currentCount = 0;
            if (counterDoc.exists) {
              currentCount = counterDoc.data().count || 0;
            }
            const newCount = currentCount + 1;
            transaction.set(counterRef, { count: newCount }, { merge: true });

            const date = new Date();
            const mm = String(date.getMonth() + 1).padStart(2, '0');
            const yy = String(date.getFullYear()).slice(-2);
            return `IIE-${mm}-${yy}-R-${newCount}`;
          });
          await change.after.ref.update({ enrollmentId: newEnrollmentId });
          after.enrollmentId = newEnrollmentId;
        } catch (e) {
          console.error('Error generating enrollmentId on approval', e);
        }
      }

      const email = after.email;
      if (!email) {
        console.warn(`Cannot send Profile Approved email: No email for student ${context.params.uid}`);
        return null;
      }

      const title = 'Your Student Account is Approved!';
      const greeting = `${after.fullName || 'Student'},`;

      const hasFn = typeof after.fullName === 'string' && after.fullName.trim().length > 1;
      const hasPar = typeof after.parentage === 'string' && after.parentage.trim().length > 0;
      const hasGen = typeof after.gender === 'string' && after.gender.trim().length > 0;
      const hasPhone = typeof after.phone === 'string' && after.phone.trim().length > 0;
      const hasAddr = typeof after.address === 'string' && after.address.trim().length > 0;
      const hasPin = /^\d{6}$/.test((after.pin || '').trim());
      const hasDob = /^\d{4}-\d{2}-\d{2}$/.test((after.dob || '').trim());
      const hasId = typeof after.officialIdUrl === 'string' && after.officialIdUrl.trim().length > 0;
      const hasEdu = typeof after.education === 'string' && after.education.trim().length > 0;
      const genderLC = (after.gender || '').trim().toLowerCase();
      const isFemale = genderLC === 'female' || genderLC === 'f';
      const hasPhoto = isFemale || (typeof after.photoUrl === 'string' && after.photoUrl.trim().length > 0);
      const isProfileComplete = hasFn && hasPar && hasGen && hasPhone && hasAddr && hasPin && hasDob && hasId && hasEdu && hasPhoto;

      let messageHtml = `
        <p>Great news! Your student account at the [YOUR_INSTITUTE_NAME_HERE] has been <strong>approved</strong>.</p>
        <p>Your official Enrollment ID is <strong>${newEnrollmentId || after.enrollmentId || 'Pending'}</strong>.</p>
        <p>You now have full access to our online services. You can start registering for programs, enrolling in courses, and reserving physical books from our library.</p>
      `;

      if (!isProfileComplete) {
        messageHtml += `
          <div style="background-color: #fffbeb; border-left: 4px solid #f59e0b; padding: 15px; margin-top: 20px; border-radius: 4px;">
            <strong style="color: #b45309; font-size: 14px;">Action Recommended:</strong>
            <p style="margin: 5px 0 0; color: #92400e; font-size: 14px;">We noticed that your profile details are incomplete. Please take a moment to add any missing information (such as your address, phone number, or ID document) in the student portal.</p>
          </div>
        `;
      }

      const ctaText = 'Go to Student Portal';
      const ctaUrl = 'https://[YOUR_DOMAIN_HERE]/student.html';

      const htmlContent = getModernEmailHtml(title, greeting, messageHtml, ctaText, ctaUrl);

      try {
        await getMailTransport().sendMail({
          from: `"[YOUR_INSTITUTE_NAME_HERE]" <${GMAIL_EMAIL.value()}>`,
          to: email,
          subject: 'Your Student account is Approved! 🎉',
          html: htmlContent
        });
        console.log(`Profile Approved email sent to ${email}`);
      } catch (err) {
        console.error('Failed to send Profile Approved email', err);
      }
    }
    return null;
  });

// Scheduled Function: Send Incomplete Profile Reminders
export const sendIncompleteProfileReminders = functions.runWith({ secrets: [GMAIL_EMAIL, GMAIL_PASSWORD] }).region('us-central1').pubsub
  .schedule('every 24 hours')
  .timeZone('Etc/UTC')
  .onRun(async (context) => {
    const now = admin.firestore.Timestamp.now();
    const twoDaysAgo = new Date(now.toDate().getTime() - (48 * 60 * 60 * 1000));
    const threeDaysAgo = new Date(now.toDate().getTime() - (72 * 60 * 60 * 1000));

    const db = admin.firestore();

    try {
      const snapshot = await db.collection('students')
        .where('status', '==', 'Pending')
        .where('createdAt', '<=', admin.firestore.Timestamp.fromDate(twoDaysAgo))
        .where('createdAt', '>', admin.firestore.Timestamp.fromDate(threeDaysAgo))
        .get();

      if (snapshot.empty) {
        console.log('No pending profiles to remind today.');
        return null;
      }

      console.log(`Found ${snapshot.size} pending profiles to remind.`);

      const promises = [];
      const transport = getMailTransport();
      const sender = `"[YOUR_INSTITUTE_NAME_HERE]" <${GMAIL_EMAIL.value()}>`;

      snapshot.forEach(doc => {
        const student = doc.data();
        const email = student.email;
        if (!email) return;

        const title = 'Complete Your Profile';
        const greeting = `${student.fullName || 'Student'},`;
        const messageHtml = `
          <p>We noticed that your student profile is still incomplete or pending approval.</p>
          <p>You're almost there! Please log in to the student portal to complete any missing details (such as your address, phone number, or ID document).</p>
          <p>Completing your profile unlocks full access to register for events and reserve library books.</p>
        `;
        const ctaText = 'Complete Profile Now';
        const ctaUrl = 'https://[YOUR_DOMAIN_HERE]/student.html';

        const htmlContent = getModernEmailHtml(title, greeting, messageHtml, ctaText, ctaUrl);

        const mailOptions = {
          from: sender,
          to: email,
          subject: 'Action Required: Complete Your Student Profile',
          html: htmlContent
        };

        promises.push(
          transport.sendMail(mailOptions).catch(err => {
            console.error(`Failed to send reminder to ${email}`, err);
          })
        );
      });

      await Promise.all(promises);
      console.log('Finished sending incomplete profile reminders.');
    } catch (error) {
      console.error('Error in sendIncompleteProfileReminders:', error);
    }

    return null;
  });

// Trigger: Send Program Published Notification
export const onProgramPublished = functions.runWith({ secrets: [GMAIL_EMAIL, GMAIL_PASSWORD] }).region('us-central1').firestore
  .document('programs/{programId}')
  .onWrite(async (change, context) => {
    const before = change.before.exists ? change.before.data() || {} : {};
    const after = change.after.exists ? change.after.data() || {} : {};

    // Only proceed if visibility changed to 'Published'
    if (before.visibility === 'Published' || after.visibility !== 'Published') {
      return null;
    }

    const programTitle = after.title || 'New Program';
    const programId = context.params.programId;
    const instructor = after.instructor || '[YOUR_INSTITUTE_NAME_HERE]';
    let startDateStr = 'TBD';
    if (after.startDate && after.startDate.toDate) {
      startDateStr = after.startDate.toDate().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    }
    const description = after.description ? after.description.substring(0, 150) + '...' : '';

    const db = admin.firestore();
    // Fetch ALL students
    const studentsSnap = await db.collection('students').get();
    if (studentsSnap.empty) {
      console.log('No students found to notify.');
      return null;
    }

    const transport = getMailTransport();
    const sender = `"[YOUR_INSTITUTE_NAME_HERE]" <${GMAIL_EMAIL.value()}>`;
    const ctaText = 'View Program Details';
    const ctaUrl = 'https://[YOUR_DOMAIN_HERE]/student.html';

    const subject = `New Program Announced: ${programTitle}! 🎉`;
    const localTime = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    const now = admin.firestore.FieldValue.serverTimestamp();

    const emailPromises = [];
    const notificationPromises = [];
    const fcmTokens = [];

    studentsSnap.forEach(doc => {
      const student = doc.data();
      const studentUid = doc.id;
      const email = student.email;

      if (Array.isArray(student.fcmTokens) && student.fcmTokens.length > 0) {
        fcmTokens.push(...student.fcmTokens);
      }

      // 1. Create In-App Notification Payload
      const notifId = db.collection('students').doc(studentUid).collection('notifications').doc().id;
      const notifPayload = {
        id: notifId,
        type: 'announcement',
        title: '🌟 New Program Announced!',
        body: `
          <div style="margin-top: 6px; padding: 12px; background: #f8fafc; border-radius: 8px; border-left: 4px solid #4f46e5; box-shadow: 0 1px 2px rgba(0,0,0,0.05);">
            <p style="margin: 0; font-weight: 700; color: #1e293b; font-size: 0.9rem;">${programTitle}</p>
            <p style="margin: 4px 0 0; font-size: 0.8rem; color: #475569;"><strong>Instructor:</strong> ${instructor}</p>
            <p style="margin: 2px 0 0; font-size: 0.8rem; color: #475569;"><strong>Starts:</strong> ${startDateStr}</p>
            <a href="#registration" onclick="document.getElementById('notif-close-btn') && document.getElementById('notif-close-btn').click();" style="display: inline-block; margin-top: 10px; padding: 5px 12px; background: #4f46e5; color: white; text-decoration: none; border-radius: 6px; font-size: 0.75rem; font-weight: 600; box-shadow: 0 1px 2px rgba(79, 70, 229, 0.3); transition: background 0.2s;">View Details <i class="fa-solid fa-arrow-right" style="margin-left: 4px; font-size: 0.7rem;"></i></a>
          </div>
        `,
        time: localTime,
        createdAt: now,
        read: false,
        programId: programId
      };

      notificationPromises.push(
        db.collection('students').doc(studentUid).collection('notifications').doc(notifId).set(notifPayload)
      );

      // 2. Send Stylish Email
      if (email) {
        const greeting = `${student.fullName || 'Student'},`;
        const messageHtml = `
          <p>We are excited to announce a new program at the [YOUR_INSTITUTE_NAME_HERE]: <strong>${programTitle}</strong></p>
          <ul style="margin: 15px 0; padding-left: 20px; color: #334155;">
            <li><strong>Instructor:</strong> ${instructor}</li>
            <li><strong>Starts on:</strong> ${startDateStr}</li>
          </ul>
          ${description ? `<p style="font-style: italic; color: #64748b;">"${description}"</p>` : ''}
        `;

        const htmlContent = getModernEmailHtml(subject, greeting, messageHtml, ctaText, ctaUrl);

        emailPromises.push(
          transport.sendMail({
            from: sender,
            to: email,
            subject: subject,
            html: htmlContent
          }).catch(err => {
            console.error(`Failed to send program notification to ${email}`, err);
          })
        );
      }
    });

    // We use chunking for firestore writes if there are many students, but since it's just set() promises, Promise.all is fine for reasonable numbers.
    // Wait for all emails and notifications to finish.
    await Promise.all([
      ...notificationPromises,
      ...emailPromises
    ]);

    // 3. Send FCM Push Notifications
    if (fcmTokens.length > 0) {
      try {
        const uniqueTokens = [...new Set(fcmTokens)];
        for (const batch of chunkArray(uniqueTokens, 500)) {
          await admin.messaging().sendEachForMulticast({
            tokens: batch,
            notification: { title: '🌟 New Program Announced!', body: programTitle },
            webpush: {
              notification: {
                icon: '/icons/icon-512.png',
                badge: '/icons/badge.png'
              },
              fcmOptions: { link: 'https://[YOUR_DOMAIN_HERE]/student.html' }
            }
          }).catch(err => console.error('FCM batch error:', err));
        }
        console.log(`Push notifications sent to ${uniqueTokens.length} devices.`);
      } catch (err) {
        console.error('Error sending push notifications:', err);
      }
    }

    console.log(`Program published notification sent to ${studentsSnap.size} students.`);
    return null;
  });


// --- Cron Job: Release Event Passes 48 hours before the event ---
export const releaseEventPassesHourly = functions.runWith({ secrets: [GMAIL_EMAIL, GMAIL_PASSWORD], timeoutSeconds: 540 })
  .region('us-central1')
  .pubsub.schedule('every 60 minutes')
  .timeZone('Asia/Kolkata')
  .onRun(async (context) => {
    try {
      const nowMs = Date.now();
      const programsSnap = await db.collection('programs').get();
      const targetPrograms = [];

      programsSnap.forEach(doc => {
        const p = doc.data();
        const startRaw = p.startDate || p.date || p.startTime || p.start || p.begin;
        let startObj = null;
        if (startRaw) {
          if (startRaw.toDate) startObj = startRaw.toDate();
          else if (startRaw.seconds) startObj = new Date(startRaw.seconds * 1000);
          else startObj = new Date(startRaw);
        }
        if (startObj && !isNaN(startObj.getTime())) {
          const msDiff = startObj.getTime() - nowMs;
          if (msDiff <= 48 * 3600 * 1000 && msDiff >= -24 * 3600 * 1000) {
            targetPrograms.push({ id: doc.id, data: p });
          }
        }
      });

      if (targetPrograms.length === 0) return null;

      const sendEmailPromises = [];
      const MAX_CONCURRENT_EMAILS = 3;

      for (const program of targetPrograms) {
        const programId = program.id;
        const p = program.data;

        const regsSnap = await db.collection('programs').doc(programId).collection('registrations')
          .where('approved', '==', true).get();

        for (const regDoc of regsSnap.docs) {
          const regData = regDoc.data();
          if (regData.passEmailSent === true) continue;

          sendEmailPromises.push(async () => {
            const studentUid = regData.studentUid || regDoc.id;
            const studentDoc = await db.collection('students').doc(studentUid).get();
            const studentData = studentDoc.exists ? studentDoc.data() : {};
            const email = studentData.email || (regData.walkinData ? regData.walkinData.email : null) || regData.email || null;
            const recipientName = studentData.fullName || studentData.name || regData.studentName || (regData.walkinData ? regData.walkinData.name : null) || 'Student';

            const rollNumber = regData.rollNumber || null;
            const qrDataUrl = regData.qr || null;
            if (!rollNumber || !qrDataUrl) return;

            const notifId = `pass-ready-${programId}-${regDoc.id}`;
            const notifPayload = {
              id: notifId,
              type: 'approval',
              title: '🎫 Your Event Pass is Ready!',
              body: `Your event pass for "${p.title || 'the program'}" is now available. Roll No: ${rollNumber}. Open the Student Portal to view it.`,
              time: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
              read: false,
              programId,
              rollNumber
            };
            await db.collection('students').doc(studentUid).collection('notifications').doc(notifId).set(notifPayload);

            await db.collection('student_notifications').doc(notifId).set({
              studentUid: studentUid,
              title: notifPayload.title,
              message: `Your event pass for "${p.title || 'the program'}" is now available. Roll No: ${rollNumber}.`,
              createdAt: admin.firestore.FieldValue.serverTimestamp()
            });

            if (email && GMAIL_EMAIL.value()) {
              await sendPassEmail({
                toEmail: email,
                subject: `🎫 Your Event Pass is Ready – ${p.title || 'IIE Program'}`,
                recipientName,
                rollNumber,
                qrDataUrl,
                programData: p,
                isAddon: false,
                isWalkin: studentUid === 'Walk-in' || !!regData.walkinData
              });
            }
            await regDoc.ref.set({ passEmailSent: true }, { merge: true });
          });
        }

        const addonsSnap = await db.collection('programs').doc(programId).collection('addon_registrations')
          .where('approved', '==', true).get();

        for (const addonDoc of addonsSnap.docs) {
          const addonData = addonDoc.data();
          if (addonData.passEmailSent === true) continue;

          sendEmailPromises.push(async () => {
            const addedByUid = addonData.addedByUid;
            if (!addedByUid) return;
            const studentDoc = await db.collection('students').doc(addedByUid).get();
            const studentData = studentDoc.exists ? studentDoc.data() : {};
            const email = studentData.email || null;
            const primaryName = studentData.fullName || studentData.name || 'Student';

            const rollNumber = addonData.rollNumber || null;
            const qrDataUrl = addonData.qr || null;
            if (!rollNumber || !qrDataUrl) return;

            const addonName = addonData.addonName || 'Add-on Student';

            const notifId = `addon-pass-ready-${programId}-${addonDoc.id}`;
            const notifPayload = {
              id: notifId,
              type: 'approval',
              title: '🎫 Add-on Pass is Ready!',
              body: `The event pass for "${addonName}" in "${p.title || 'the program'}" is now available. Roll No: ${rollNumber}. Open the Student Portal to view it.`,
              time: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
              read: false,
              programId,
              rollNumber,
              isAddon: true
            };
            await db.collection('students').doc(addedByUid).collection('notifications').doc(notifId).set(notifPayload);

            await db.collection('student_notifications').doc(notifId).set({
              studentUid: addedByUid,
              title: notifPayload.title,
              message: `Your add-on event pass for "${addonName}" is now available. Roll No: ${rollNumber}.`,
              createdAt: admin.firestore.FieldValue.serverTimestamp()
            });

            if (email && GMAIL_EMAIL.value()) {
              await sendPassEmail({
                toEmail: email,
                subject: `🎫 Add-on Event Pass Ready – ${addonName} | ${p.title || 'IIE Program'}`,
                recipientName: primaryName,
                rollNumber,
                qrDataUrl,
                programData: p,
                isAddon: true,
                addonNote: `This pass is for <strong>${addonName}</strong>, registered as an add-on under your account.`
              });
            }
            await addonDoc.ref.set({ passEmailSent: true }, { merge: true });
          });
        }
      }

      const chunkArray = (arr, size) => Array.from({ length: Math.ceil(arr.length / size) }, (v, i) => arr.slice(i * size, i * size + size));
      const batches = chunkArray(sendEmailPromises, MAX_CONCURRENT_EMAILS);

      for (const batch of batches) {
        await Promise.all(batch.map(fn => fn()));
      }

    } catch (err) {
      console.error('releaseEventPassesHourly error', err);
    }
  });

export const adminBroadcastNotification = functions.runWith({ timeoutSeconds: 120, memory: '256MB' }).https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated.');
  }

  // Ensure caller is Admin
  const callerDoc = await db.collection('users').doc(context.auth.uid).get();
  if (!callerDoc.exists) {
    throw new functions.https.HttpsError('permission-denied', 'Caller user doc not found.');
  }
  const callerData = callerDoc.data();
  const callerRole = callerData.role;
  const callerRoles = Array.isArray(callerData.roles) ? callerData.roles : [];
  if (callerRole !== 'Admin' && !callerRoles.includes('Admin')) {
    throw new functions.https.HttpsError('permission-denied', 'Caller must be an Admin.');
  }

  const title = data.title;
  const body = data.body;
  const targetUid = data.targetUid || 'all';
  if (!title || !body) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing title or body.');
  }

  const tokens = [];

  if (targetUid !== 'all') {
    // Fetch single user
    const userDoc = await db.collection('users').doc(targetUid).get();
    if (userDoc.exists) {
      const d = userDoc.data();
      if (Array.isArray(d.fcmTokens) && d.fcmTokens.length > 0) {
        tokens.push(...d.fcmTokens);
      }
    }
  } else {
    // Fetch all users to find teachers and their fcmTokens
    const usersSnap = await db.collection('users').get();
    usersSnap.forEach(doc => {
      const d = doc.data();
      const r = d.role;
      const rs = Array.isArray(d.roles) ? d.roles : [];
      if (r === 'Teacher' || rs.includes('Teacher')) {
        if (Array.isArray(d.fcmTokens) && d.fcmTokens.length > 0) {
          tokens.push(...d.fcmTokens);
        }
      }
    });
  }

  if (tokens.length === 0) {
    return { success: false, message: 'No teacher tokens found.' };
  }

  const message = {
    notification: {
      title: title,
      body: body
    },
    tokens: tokens
  };

  try {
    const response = await admin.messaging().sendEachForMulticast(message);
    
    // Save to Firestore for history and UI syncing
    await db.collection('admin_broadcasts').add({
      title: title,
      body: body,
      targetUid: targetUid,
      senderUid: context.auth.uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return { 
      success: true, 
      successCount: response.successCount, 
      failureCount: response.failureCount 
    };
  } catch (error) {
    console.error('Broadcast error:', error);
    throw new functions.https.HttpsError('internal', 'Broadcast failed: ' + error.message);
  }
});
