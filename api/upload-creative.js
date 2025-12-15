// api/upload-creative.js
import { google } from "googleapis";
import FormData from "form-data";
import axios from "axios";
import { Readable } from "stream";

const API_VERSION = "v5";

// Marka bazlı config – .env ile uyumlu
const BRAND_CONFIG = {
  desa: {
    adAccountId: process.env.DESA_META_AD_ACCOUNT_ID, // act_... olabilir
    accessToken: process.env.DESA_META_ACCESS_TOKEN,
    driveFolderId: process.env.DESA_DRIVE_FOLDER_ID,
  },
  bella: {
    adAccountId: process.env.BELLA_META_AD_ACCOUNT_ID,
    accessToken: process.env.BELLA_META_ACCESS_TOKEN,
    driveFolderId: process.env.BELLA_DRIVE_FOLDER_ID,
  },
};

/**
 * Google Service Account bilgilerini env'den al
 * Vercel için en temiz yöntem → GOOGLE_SERVICE_ACCOUNT_JSON
 */
function getServiceAccountCredentials() {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_JSON tanımlı değil. Service account JSON'unu bu env'e yapıştır."
    );
  }
  return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
}

function getDriveClient() {
  const creds = getServiceAccountCredentials();
  const scopes = ["https://www.googleapis.com/auth/drive"];

  const auth = new google.auth.JWT(
    creds.client_email,
    null,
    creds.private_key,
    scopes
  );

  return google.drive({ version: "v3", auth });
}

/**
 * URL'den dosya indirip Buffer + content-type döner (axios ile)
 */
async function downloadFileToBuffer(url) {
  const res = await axios.get(url, {
    responseType: "arraybuffer",
    validateStatus: () => true,
  });

  if (res.status < 200 || res.status >= 300) {
    throw new Error(
      `Kaynak URL indirilemedi: ${res.status} ${res.statusText || ""}`
    );
  }

  const buffer = Buffer.from(res.data);
  const contentType =
    res.headers["content-type"] || "application/octet-stream";

  return { buffer, contentType };
}

/**
 * Google Drive'a upload
 * ÖNEMLİ: body olarak Buffer değil, Readable stream veriyoruz (pipe hatasını çözer)
 */
async function uploadToDrive({ buffer, mimeType, fileName, folderId }) {
  const drive = getDriveClient();

  const res = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [folderId],
    },
    media: {
      mimeType,
      body: Readable.from(buffer), // <-- kritik değişiklik
    },
    fields: "id, webViewLink, webContentLink",
  });

  return res.data;
}

/**
 * Ad account ID'yi normalize et – "act_" yoksa ekler
 */
function normalizeAdAccountId(rawId) {
  if (!rawId) {
    throw new Error("Meta ad account ID tanımlı değil");
  }
  if (rawId.startsWith("act_")) return rawId;
  return `act_${rawId}`;
}

/**
 * Meta'ya image upload (adimages) – axios + form-data
 */
async function uploadImageToMeta({ buffer, mimeType, fileName, brandCfg }) {
  const accessToken = brandCfg.accessToken;
  if (!accessToken) {
    throw new Error("Meta access token tanımlı değil (brand için).");
  }

  const adAccount = normalizeAdAccountId(brandCfg.adAccountId);

  const form = new FormData();
  form.append("access_token", accessToken);
  form.append("name", fileName);
  form.append("bytes", buffer, {
    filename: fileName,
    contentType: mimeType || "application/octet-stream",
  });

  const headers = form.getHeaders();
  const url = `https://graph.facebook.com/v21.0/${adAccount}/adimages`;

  const res = await axios.post(url, form, {
    headers,
    validateStatus: () => true,
  });

  const json = res.data;

  if (res.status < 200 || res.status >= 300) {
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

/**
 * Meta'ya video upload (advideos) – axios + form-data
 */
async function uploadVideoToMeta({ buffer, mimeType, fileName, brandCfg }) {
  const accessToken = brandCfg.accessToken;
  if (!accessToken) {
    throw new Error("Meta access token tanımlı değil (brand için).");
  }

  const adAccount = normalizeAdAccountId(brandCfg.adAccountId);

  const form = new FormData();
  form.append("access_token", accessToken);
  form.append("title", fileName);
  form.append("source", buffer, {
    filename: fileName,
    contentType: mimeType || "video/mp4",
  });

  const headers = form.getHeaders();
  const url = `https://graph.facebook.com/v21.0/${adAccount}/advideos`;

  const res = await axios.post(url, form, {
    headers,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    validateStatus: () => true,
  });

  const json = res.data;

  if (res.status < 200 || res.status >= 300) {
    throw new Error(
      `Meta video upload hata: ${res.status} - ${JSON.stringify(json)}`
    );
  }

  return {
    raw: json,
    videoId: json.id,
  };
}

/**
 * Ana handler – URL / upload / Drive senaryolarını yönetiyor
 */
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Only POST allowed" });
  }

  try {
    const {
      brand,
      type,
      sourceType = "url", // "url" | "upload" | "drive"
      sourceUrl,
      driveUrl,
      fileName,
      fileBase64,
      fileMimeType,
    } = req.body || {};

    if (!brand || !type) {
      return res.status(400).json({
        ok: false,
        error: "brand ve type zorunlu alanlar",
      });
    }

    const brandCfg = BRAND_CONFIG[brand];
    if (!brandCfg) {
      return res.status(400).json({
        ok: false,
        error: 'Geçersiz brand. "desa" veya "bella" olmalı',
      });
    }

    if (type !== "image" && type !== "video") {
      return res.status(400).json({
        ok: false,
        error: 'type "image" veya "video" olmalı',
      });
    }

    // Kaynak tipine göre validasyon
    if (sourceType === "url" && !sourceUrl) {
      return res.status(400).json({
        ok: false,
        error: "sourceType=url ise sourceUrl zorunlu",
      });
    }
    if (sourceType === "drive" && !driveUrl) {
      return res.status(400).json({
        ok: false,
        error: "sourceType=drive ise driveUrl zorunlu",
      });
    }
    if (sourceType === "upload" && !fileBase64) {
      return res.status(400).json({
        ok: false,
        error: "sourceType=upload ise fileBase64 zorunlu",
      });
    }

    let buffer;
    let mimeType;
    let usedSourceUrl = null;

    if (sourceType === "upload") {
      buffer = Buffer.from(fileBase64, "base64");
      mimeType = fileMimeType || "application/octet-stream";
    } else {
      usedSourceUrl = sourceType === "drive" ? driveUrl : sourceUrl;
      const downloaded = await downloadFileToBuffer(usedSourceUrl);
      buffer = downloaded.buffer;
      mimeType = downloaded.contentType;
    }

    const safeFileName =
      fileName ||
      (sourceType === "upload"
        ? "uploaded_" + Date.now()
        : `${brand}_${Date.now()}.${type === "image" ? "jpg" : "mp4"}`);

    // 1) Google Drive'a upload
    const driveFile = await uploadToDrive({
      buffer,
      mimeType,
      fileName: safeFileName,
      folderId: brandCfg.driveFolderId,
    });

    // 2) Meta'ya upload
    let metaResult;
    if (type === "image") {
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
      version: API_VERSION,
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
    console.error("upload-creative hata:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || "Bilinmeyen hata",
      version: API_VERSION,
    });
  }
}
