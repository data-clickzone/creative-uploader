// api/debug-google-oauth.js
import { google } from "googleapis";

const API_VERSION = "debug-google-oauth-v2";

export default async function handler(req, res) {
  try {
    // GEÇİCİ: clientId / secret'ı direkt buraya yazıyoruz
    const clientId =
      "682662432452-ctr4ja92rp32acnm529d6u872894404s.apps.googleusercontent.com";
    const clientSecret = "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";
    const refreshToken =
      process.env.GOOGLE_OAUTH_REFRESH_TOKEN; // sadece refresh token env'den

    if (!refreshToken) {
      return res.status(400).json({
        ok: false,
        error: "GOOGLE_OAUTH_REFRESH_TOKEN env'i eksik.",
        version: API_VERSION,
      });
    }

    const oauth2Client = new google.auth.OAuth2(
      clientId,
      clientSecret,
      "http://localhost"
    );

    oauth2Client.setCredentials({ refresh_token: refreshToken });

    const accessTokenResponse = await oauth2Client.getAccessToken();

    return res.status(200).json({
      ok: true,
      version: API_VERSION,
      message: "Access token başarıyla alındı.",
      accessTokenSample: accessTokenResponse?.token
        ? accessTokenResponse.token.substring(0, 25) + "..."
        : null,
    });
  } catch (err) {
    console.error("debug-google-oauth hata:", err);

    const any = err;
    const details =
      any?.response?.data ||
      any?.errors ||
      any?.stack ||
      any?.toString() ||
      null;

    return res.status(500).json({
      ok: false,
      version: API_VERSION,
      error: err.message || "Bilinmeyen hata",
      details,
    });
  }
}
