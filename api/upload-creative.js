import { google } from 'googleapis';
import fs from 'fs';

// Marka bazlı config – senin .env ile uyumlu
const BRAND_CONFIG = {
  desa: {
    adAccountId: process.env.DESA_META_AD_ACCOUNT_ID,       // act_1171... şeklinde
    accessToken: process.env.DESA_META_ACCESS_TOKEN,
    driveFolderId: process.env.DESA_DRIVE_FOLDER_ID,
  },
  bella: {
    adAccountId: process.env.BELLA_META_AD_ACCOUNT_ID,      // act_1073... şeklinde
    accessToken: process.env.BELLA_META_ACCESS_TOKEN,
    driveFolderId: process.env.BELLA_DRIVE_FOLDER_ID,
  },
};

// Service account bilgilerini al – iki opsiyon:
// 1) GOOGLE_SERVICE_ACCOUNT_JSON env'si (tüm JSON string olarak)
// 2) GOOGLE_CREDENTIALS_FILE env'si üzerinden dosya
function getServiceAccountCredentials() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  }

  if (process.env.GOOGLE_CREDENTIALS_FILE) {
    const filePath = process.env.GOOGLE_CREDENTIALS_FILE;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  }

  throw new Error(
    'Google service account bilgisi bulunamadı. GOOGLE_SERVICE_ACCOUNT_JSON veya GOOGLE_CREDENTIALS_FILE ayarla.'
  );
}

function getDriveClient() {
  const creds = getServiceAccountCredentials();

  const scopes = ['https://www.googleapis.com/auth/drive'];

  const auth = new google.auth.JWT(
    creds.client_email,
    null,
    creds.private_key,
    scopes
  );

  const drive = google.drive({ version: 'v3', auth });
  return drive;
}

async function downloadFileToBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Kaynak URL indirilemedi: ${res.status} ${res.statusText}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const contentType =
    res.headers.get('content-type') || 'application/octet-stream';
  return { buffer, contentType };
}

async function uploadToDrive({ buffer, mimeType, fileName, folderId }) {
  const drive = getDriveClient();

  const res = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [folderId],
    },
    media: {
      mimeType,
      body: Buffer.from(buffer),
    },
    fields: 'id, webViewLink, webContentLink',
  });

  return res.data; // { id, webViewLink, webContentLink }
}

function normalizeAdAccountId(rawId) {
  if (!rawId) {
    throw new Error('Meta ad account ID tanımlı değil');
  }
  // "act_..." geliyorsa doğrudan kullan
  if (rawId.startsWith('act_')) return rawId;
  return `act_${rawId}`;
}

async function uploadImageToMeta({ buffer, mimeType, fileName, brandCfg }) {
  const accessToken = brandCfg.accessToken;
  if (!accessToken) {
    throw new Error('Meta access token tanımlı değil (brand için).');
  }

  const adAccount = normalizeAdAccountId(brandCfg.adAccountId);

  const form = new FormData();
  form.append('access_token', accessToken);
  form.append('name', fileName);

  const blob = new Blob([buffer], {
    type: mimeType || 'application/octet-stream',
  });
  form.append('bytes', blob, fileName);

  const url = `https://graph.facebook.com/v21.0/${adAccount}/adimages`;

  const res = await fetch(url, {
    method: 'POST',
    body: form,
  });

  const json = await res.json();

  if (!res.ok) {
    throw new Error(
      `Meta image upload hata: ${res.status} - ${JSON.stringify(json)}`
    );
  }

  const images = json.images || {};
  const firstKey = Object.keys(images)[0];
  const imageData = images[firstKey] || {};

  return {
    raw: json,
    imageHash: imageData.hash,
  };
}

async function uploadVideoToMeta({ buffer, mimeType, fileName, brandCfg }) {
  const accessToken = brandCfg.accessToken;
  if (!accessToken) {
    throw new Error('Meta access token tanımlı değil (brand için).');
  }

  const adAccount = normalizeAdAccountId(brandCfg.adAccountId);

  const form = new FormData();
  form.append('access_token', accessToken);
  form.append('title', fileName);

  const blob = new Blob([buffer], {
    type: mimeType || 'video/mp4',
  });
  form.append('source', blob, fileName);

  const url = `https://graph.facebook.com/v21.0/${adAccount}/advideos`;

  const res = await fetch(url, {
    method: 'POST',
    body: form,
  });

  const json = await res.json();

  if (!res.ok) {
    throw new Error(
      `Meta video upload hata: ${res.status} - ${JSON.stringify(json)}`
    );
  }

  return {
    raw: json,
    videoId: json.id,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Only POST allowed' });
  }

  try {
    const {
      brand,
      type,
      sourceType = 'url',
      sourceUrl,
      driveUrl,
      fileName,
      fileBase64,
      fileMimeType,
    } = req.body || {};

    if (!brand || !type) {
      return res.status(400).json({
        ok: false,
        error: 'brand ve type zorunlu alanlar',
      });
    }

    const brandCfg = BRAND_CONFIG[brand];
    if (!brandCfg) {
      return res.status(400).json({
        ok: false,
        error: 'Geçersiz brand. Örnek: desa, bella',
      });
    }

    if (type !== 'image' && type !== 'video') {
      return res.status(400).json({
        ok: false,
        error: 'type "image" veya "video" olmalı',
      });
    }

    // Kaynak tipine göre validasyon
    if (sourceType === 'url' && !sourceUrl) {
      return res.status(400).json({
        ok: false,
        error: 'sourceType=url ise sourceUrl zorunlu',
      });
    }
    if (sourceType === 'drive' && !driveUrl) {
      return res.status(400).json({
        ok: false,
        error: 'sourceType=drive ise driveUrl zorunlu',
      });
    }
    if (sourceType === 'upload' && !fileBase64) {
      return res.status(400).json({
        ok: false,
        error: 'sourceType=upload ise fileBase64 zorunlu',
      });
    }

    let buffer;
    let mimeType;
    let usedSourceUrl = null;

    if (sourceType === 'upload') {
      // Frontend'den gelen base64'ü buffer'a çevir
      buffer = Buffer.from(fileBase64, 'base64');
      mimeType = fileMimeType || 'application/octet-stream';
    } else {
      usedSourceUrl = sourceType === 'drive' ? driveUrl : sourceUrl;
      const downloaded = await downloadFileToBuffer(usedSourceUrl);
      buffer = downloaded.buffer;
      mimeType = downloaded.contentType;
    }

    const safeFileName =
      fileName ||
      (sourceType === 'upload'
        ? 'uploaded_' + Date.now()
        : `${brand}_${Date.now()}.${type === 'image' ? 'jpg' : 'mp4'}`);

    // 1) Drive'a yükle
    const driveFile = await uploadToDrive({
      buffer,
      mimeType,
      fileName: safeFileName,
      folderId: brandCfg.driveFolderId,
    });

    // 2) Meta'ya yükle
    let metaResult = null;
    if (type === 'image') {
      metaResult = await uploadImageToMeta({
        buffer,
        mimeType,
        fileName: safeFileName,
        brandCfg,
      });
    } else {
      metaResult = await uploadVideoToMeta({
        buffer,
        mimeType,
        fileName: safeFileName,
        brandCfg,
      });
    }

    return res.status(200).json({
      ok: true,
      brand,
      type,
      sourceType,
      sourceUrl: usedSourceUrl || null,
      fileName: safeFileName,
      driveFileId: driveFile.id,
      driveWebViewLink: driveFile.webViewLink,
      meta: metaResult,
    });
  } catch (err) {
    console.error('upload-creative hata:', err);
    return res.status(500).json({
      ok: false,
      error: err.message || 'Bilinmeyen hata',
    });
  }
}
