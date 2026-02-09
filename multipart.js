/**
 * Minimal multipart/form-data parser (no dependencies).
 * 
 * Parses incoming multipart requests, saves uploaded files to disk,
 * and returns { fields: {}, files: [] }.
 * 
 * For production, replace with multer or busboy.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/**
 * Parse a multipart/form-data request.
 * 
 * @param {http.IncomingMessage} req
 * @param {string} uploadDir — directory to save files into
 * @returns {Promise<{ fields: Object, files: Array<{ fieldName, originalName, savedPath, mimeType, size }> }>}
 */
function parseMultipart(req, uploadDir) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers["content-type"] || "";
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) {
      return reject(new Error("No boundary found in content-type"));
    }
    const boundary = boundaryMatch[1];

    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("error", reject);
    req.on("end", () => {
      try {
        const buffer = Buffer.concat(chunks);
        const result = { fields: {}, files: [] };

        // Split by boundary
        const boundaryBuf = Buffer.from(`--${boundary}`);
        const parts = splitBuffer(buffer, boundaryBuf);

        for (const part of parts) {
          const str = part.toString("latin1");
          if (str.trim() === "" || str.trim() === "--") continue;

          // Find header/body separator (double CRLF)
          const sepIdx = str.indexOf("\r\n\r\n");
          if (sepIdx === -1) continue;

          const headerStr = str.substring(0, sepIdx);
          const bodyStart = sepIdx + 4;

          // Parse Content-Disposition
          const nameMatch = headerStr.match(/name="([^"]+)"/);
          const filenameMatch = headerStr.match(/filename="([^"]+)"/);
          const ctMatch = headerStr.match(/Content-Type:\s*(.+)/i);

          if (!nameMatch) continue;
          const fieldName = nameMatch[1];

          if (filenameMatch && filenameMatch[1]) {
            // File field — save to disk
            const originalName = filenameMatch[1];
            const mimeType = ctMatch ? ctMatch[1].trim() : "application/octet-stream";
            const ext = path.extname(originalName) || guessExt(mimeType);
            const savedName = `${crypto.randomUUID()}${ext}`;
            const savedPath = path.join(uploadDir, savedName);

            // Extract binary body from original buffer (not the latin1 string)
            const bodyBuf = part.slice(Buffer.byteLength(str.substring(0, bodyStart), "latin1"));
            // Trim trailing \r\n
            const trimmed = bodyBuf.length > 2 && bodyBuf[bodyBuf.length - 2] === 0x0d && bodyBuf[bodyBuf.length - 1] === 0x0a
              ? bodyBuf.slice(0, -2)
              : bodyBuf;

            fs.mkdirSync(uploadDir, { recursive: true });
            fs.writeFileSync(savedPath, trimmed);

            result.files.push({
              fieldName,
              originalName,
              savedName,
              savedPath,
              mimeType,
              size: trimmed.length,
            });
          } else {
            // Text field
            let val = str.substring(bodyStart);
            // Trim trailing \r\n
            if (val.endsWith("\r\n")) val = val.slice(0, -2);
            result.fields[fieldName] = val;
          }
        }

        resolve(result);
      } catch (err) {
        reject(err);
      }
    });
  });
}

/** Split a buffer by a delimiter buffer */
function splitBuffer(buf, delim) {
  const parts = [];
  let start = 0;
  while (true) {
    const idx = buf.indexOf(delim, start);
    if (idx === -1) {
      parts.push(buf.slice(start));
      break;
    }
    if (idx > start) parts.push(buf.slice(start, idx));
    start = idx + delim.length;
  }
  return parts;
}

function guessExt(mimeType) {
  const map = {
    "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif",
    "image/webp": ".webp", "video/mp4": ".mp4", "video/quicktime": ".mov",
    "audio/mpeg": ".mp3", "audio/wav": ".wav", "audio/mp4": ".m4a",
  };
  return map[mimeType] || "";
}

/**
 * Parse JSON body from request.
 */
function parseJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("error", reject);
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        resolve({});
      }
    });
  });
}

module.exports = { parseMultipart, parseJson };
