/**
 * Slug-prefixed ID generator.
 *
 * IDs follow the pattern: `<prefix>_<24-char-hex>`.
 * The prefix encodes the resource kind for at-a-glance readability and
 * leak detection (log scrubbers can identify which kind of ID leaked).
 *
 * The 12-byte random suffix (24 hex chars) gives 96 bits of entropy —
 * collision-safe at any realistic scale.
 *
 * Uses Web Crypto's `getRandomValues` — available on both Workers and Node 20+.
 */

const PREFIX_BY_KIND: Record<string, string> = {
  agent:       'agt',
  connector:   'cnn',
  project:     'prj',
  task:        't',
  comment:     'cmt',
  event:       'evt',
  externalRef: 'xrf',
  org:         'org',
  user:        'usr',
  apiKey:      'apk',
};

/**
 * Generate a unique slug-prefixed ID for the given resource kind.
 *
 * If `kind` is not in the known prefix table the raw `kind` string is used
 * as the prefix — this allows callers to mint ad-hoc typed IDs without
 * updating the table while still producing readable output.
 */
export function makeId(kind: keyof typeof PREFIX_BY_KIND | string): string {
  const prefix = PREFIX_BY_KIND[kind] ?? kind;
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}_${hex}`;
}
