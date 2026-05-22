/**
 * JSON-LD を dangerouslySetInnerHTML に渡す前に XSS 危険文字を Unicode エスケープする。
 * U+2028/U+2029 は JSON.stringify が素通りさせるため追加でエスケープが必要。
 * new RegExp("\\u2028") は実際の U+2028 にマッチするリテラル正規表現と等価。
 */
export function safeJsonLd(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(new RegExp("\\u2028", "g"), "\\u2028")
    .replace(new RegExp("\\u2029", "g"), "\\u2029");
}
