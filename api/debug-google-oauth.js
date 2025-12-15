// api/debug-google-oauth.js
import { google } from "googleapis";

const API_VERSION = "debug-google-oauth-env";

export default async function handler(req, res) {
  try {
    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;

    if (!clientId || !clientSecret || !refreshToken) {
      return res.status(400).json({
        ok: false,
        error:
          "GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET / GOOGLE_OAUTH_REFRESH_TOKEN env'leri eksik.",
        version: API_VERSION,
        have: {
          clientId: !!clientId,
          clientSecret: !!clientSecret,
          refreshToken: !!refreshToken,
        },
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
