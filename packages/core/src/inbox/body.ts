// GTM-agents: where inbound email bodies live.
//
// An inbound_emails row holds the metadata and a short preview; the full plain-text body is kept in
// blob storage (the BUCKET binding) under the row's body_key, written once when the message is
// recorded. The body is untrusted text from outside (full taint): whoever reads it sanitizes and
// fences it before it reaches a model, and never puts it in a system prompt.
//
// The database is the truth for which messages exist; the blob is the archive of their text. A
// missing blob reads as null, never as an empty body, so a reader can tell "no text" from "gone".

/** The longest body kept, in characters. Longer bodies keep their head; the rest is quoted history. */
export const INBOUND_BODY_MAX_CHARS = 100_000;
/** The preview stored on the row, in characters. */
export const INBOUND_PREVIEW_CHARS = 280;

/** The blob key for an inbound message's body. */
export function inboundBodyKey(inboundId: string): string {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(inboundId)) throw new TypeError("an inbound id is 1 to 100 letters, digits, underscores or hyphens");
  return `inbound/${inboundId}.txt`;
}

/** The row's preview: whitespace collapsed, cut to INBOUND_PREVIEW_CHARS. */
export function inboundPreview(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= INBOUND_PREVIEW_CHARS ? collapsed : `${collapsed.slice(0, INBOUND_PREVIEW_CHARS - 3)}...`;
}

/** Store a body and return its key. Throws on a storage error: the caller decides whether to retry. */
export async function putInboundBody(bucket: Pick<R2Bucket, "put">, inboundId: string, text: string): Promise<string> {
  const key = inboundBodyKey(inboundId);
  await bucket.put(key, text.slice(0, INBOUND_BODY_MAX_CHARS), { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
  return key;
}

/** Read a body by key. Null when the key is empty or the blob is missing; throws on a storage error. */
export async function readInboundBody(bucket: Pick<R2Bucket, "get">, key: string | null | undefined): Promise<string | null> {
  if (!key) return null;
  const object = await bucket.get(key);
  return object ? await object.text() : null;
}

/** Delete a body, for erasure. A missing blob is not an error. */
export async function deleteInboundBody(bucket: Pick<R2Bucket, "delete">, key: string | null | undefined): Promise<void> {
  if (key) await bucket.delete(key);
}
