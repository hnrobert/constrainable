/**
 * Port of check_server.py `_safe_name`: replace illegal filesystem characters
 * with underscores.
 */
const ILLEGAL = ['\\', '/', ':', '*', '?', '"', '<', '>', '|']

export function safeName(name: string): string {
  let out = name
  for (const ch of ILLEGAL) {
    out = out.split(ch).join('_')
  }
  return out
}
