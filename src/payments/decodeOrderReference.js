function decodeBase64(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4;
  const padded = padding ? normalized + "=".repeat(4 - padding) : normalized;
  return Buffer.from(padded, "base64").toString("utf8");
}

export default function decodeOrderReference(value) {
  if (typeof value !== "string") return value || null;
  const reference = value.trim();
  if (!reference) return null;

  try {
    const decoded = decodeBase64(reference);
    const printable = /^[\x20-\x7E]+$/.test(decoded);
    if (!printable || !decoded.includes(":")) return reference;

    const parts = decoded.split(":").filter(Boolean);
    return parts[parts.length - 1] || reference;
  } catch (error) {
    return reference;
  }
}
