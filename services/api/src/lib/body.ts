// Reads a JSON request body with a hard byte cap. The cap is enforced on the bytes actually read,
// not only on Content-Length, because a Lambda event or a chunked request can carry a body
// whose header is missing or wrong.

export type BodyResult =
  | { ok: true; value: unknown }
  | {
      ok: false;
      status: 400 | 413 | 415;
      code: "invalid_json" | "payload_too_large" | "unsupported_media_type";
      message: string;
    };

const JSON_TYPE = /^application\/json\s*(?:;|$)/i;

// Decision: require application/json. A cross-site HTML form can only send text/plain or form
// types without a CORS preflight, so this also keeps the plan endpoint off-limits to them.
function hasJsonContentType(request: Request): boolean {
  return JSON_TYPE.test(request.headers.get("content-type") ?? "");
}

function tooLarge(maxBytes: number): BodyResult {
  const message = `Request body is larger than ${maxBytes} bytes`;
  return { ok: false, status: 413, code: "payload_too_large", message };
}

function invalidJson(message: string): BodyResult {
  return { ok: false, status: 400, code: "invalid_json", message };
}

/** The body bytes, or null once more than `maxBytes` have arrived. */
async function readCapped(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readJsonBody(request: Request, maxBytes: number): Promise<BodyResult> {
  if (!hasJsonContentType(request)) {
    const message = "Send the request body as application/json";
    return { ok: false, status: 415, code: "unsupported_media_type", message };
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) return tooLarge(maxBytes);
  const bytes = await readCapped(request, maxBytes);
  if (bytes === null) return tooLarge(maxBytes);
  if (bytes.byteLength === 0) return invalidJson("Request body is empty");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return invalidJson("Request body is not valid UTF-8");
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return invalidJson("Request body is not valid JSON");
  }
}
