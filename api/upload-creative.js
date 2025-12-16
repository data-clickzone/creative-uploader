// api/upload-creative.js
import { google } from "googleapis";
import FormData from "form-data";
import axios from "axios";
import { Readable } from "stream";

const API_VERSION = "oauth-drive-final-v4";

// Marka bazlı config – .env ile uyumlu
const BRAND_CONFIG = {
  desa: {
    adAccountId: process.env.DESA_META_AD_ACCOUNT_ID,
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
 * OAuth2 Drive client – senin Google hesabın adına çalışacak
 */
function getDriveClient() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET / GOOGLE_OAUTH_REFRESH_TOKEN env'leri eksik."
    );
  }

  const oauth2Client = new google.auth.OAuth2(
    clientId,
    clientSecret,
    "http://localhost"
  );

  oauth2Client.setCredentials({ refresh_token: refreshToken });

  return google.drive({ version: "v3", auth: oauth2Client });
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
 * Google Drive'a upload – OAuth ile, Readable stream kullanıyoruz
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
      body: Readable.from(buffer),
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
 * Burada buffer'ı OLDUĞU GİBİ gönderiyoruz; ekstra dönüşüm yok.
 */
async function uploadImageToMeta({ buffer, mimeType, fileName, brandCfg }) {
  const accessToken = brandCfg.accessToken;
  if (!accessToken) {
    throw new Error("Meta access token tanımlı değil (brand için).");
  }

  if (!mimeType || !mimeType.startsWith("image/")) {
    throw new Error(
      `Bu dosya bir görsel değil (mimeType=${mimeType || "bilinmiyor"}).`
    );
  }

  const adAccount = normalizeAdAccountId(brandCfg.adAccountId);

  const form = new FormData();
  form.append("access_token", accessToken);
  form.append("name", fileName);

  // ÖNEMLİ: Sadece filename veriyoruz, contentType'i form-data'ya bırakıyoruz
  form.append("bytes", buffer, fileName + ".jpg");

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
    return res
      .status(405)
      .json({ ok: false, error: "Only POST allowed", version: API_VERSION });
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
        version: API_VERSION,
      });
    }

    const brandCfg = BRAND_CONFIG[brand];
    if (!brandCfg) {
      return res.status(400).json({
        ok: false,
        error: 'Geçersiz brand. "desa" veya "bella" olmalı',
        version: API_VERSION,
      });
    }

    if (type !== "image" && type !== "video") {
      return res.status(400).json({
        ok: false,
        error: 'type "image" veya "video" olmalı',
        version: API_VERSION,
      });
    }

    // Kaynak tipine göre validasyon
    if (sourceType === "url" && !sourceUrl) {
      return res.status(400).json({
        ok: false,
        error: "sourceType=url ise sourceUrl zorunlu",
        version: API_VERSION,
      });
    }
    if (sourceType === "drive" && !driveUrl) {
      return res.status(400).json({
        ok: false,
        error: "sourceType=drive ise driveUrl zorunlu",
        version: API_VERSION,
      });
    }
    if (sourceType === "upload" && !fileBase64) {
      return res.status(400).json({
        ok: false,
        error: "sourceType=upload ise fileBase64 zorunlu",
        version: API_VERSION,
      });
    }

    let buffer;
    let mimeType;
    let usedSourceUrl = null;

    if (sourceType === "upload") {
      // Data URL ise (data:image/jpeg;base64,...) prefix'i temizle
      let base64 = fileBase64;
      let inferredMime = fileMimeType || null;

      const dataUrlMatch = /^data:(.*?);base64,(.*)$/.exec(fileBase64 || "");
      if (dataUrlMatch) {
        inferredMime = inferredMime || dataUrlMatch[1];
        base64 = dataUrlMatch[2];
      }

      buffer = Buffer.from(base64, "base64");
      mimeType = inferredMime || "application/octet-stream";
    } else {
      usedSourceUrl = sourceType === "drive" ? driveUrl : sourceUrl;
      const downloaded = await downloadFileToBuffer(usedSourceUrl);
      buffer = downloaded.buffer;
      mimeType = downloaded.contentType;
    }

    // DEBUG: Vercel log için
    console.log(
      "UPLOAD DEBUG →",
      JSON.stringify(
        {
          brand,
          type,
          sourceType,
          mimeType,
          fileName: fileName || null,
          bufferLength: buffer?.length || 0,
        },
        null,
        2
      )
    );

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
