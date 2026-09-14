/**
 * Encoding Utilities
 *
 * Pure functions for data encoding/decoding and format conversions.
 * All functions are framework-agnostic with zero external dependencies.
 */

/**
 * Convert base64 data URL to Blob
 *
 * Extracts the MIME type and binary data from a base64 data URL and creates a Blob.
 *
 * @param base64 - Base64 data URL string (e.g., "data:image/png;base64,iVBORw0KG...")
 * @returns Blob with the correct MIME type extracted from the data URL
 * @throws Error if the data URL format is invalid
 *
 * @example
 * ```typescript
 * const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANS...';
 * const blob = base64ToBlob(dataUrl);
 *
 * // Use the blob for file downloads, uploads, etc.
 * const url = URL.createObjectURL(blob);
 * ```
 */
export function base64ToBlob(base64: string): Blob {
  const arr = base64.split(',');
  // 按文档校验格式：非法输入应抛出明确错误而非无意义的 TypeError
  const mimeMatch = arr[0]?.match(/:(.*?);/);
  if (!mimeMatch?.[1] || !arr[1]) {
    throw new Error('Invalid data URL format');
  }
  const fileType = mimeMatch[1];
  const bstr = atob(arr[1]);
  let l = bstr.length;
  const u8Arr = new Uint8Array(l);

  while (l--) {
    u8Arr[l] = bstr.charCodeAt(l);
  }

  return new Blob([u8Arr], {
    type: fileType,
  });
}
