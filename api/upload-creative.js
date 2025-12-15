// api/upload-creative.js
const API_VERSION = "debug-v1";

export default function handler(req, res) {
  res.status(200).json({
    ok: true,
    version: API_VERSION,
    method: req.method,
  });
}
