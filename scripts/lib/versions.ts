// versions.ts — human-readable version derivation for `info`/`start` display.
//
// A running container's image is either `repo:tag` (human) or `repo@sha256:…`
// (digest-pinned — opaque). For digest pins we fall back to the requested tag
// recorded in .stack/<svc>/.generated.env (`<NAME>_IMAGE_REQUESTED` /
// `<SVC>_SOURCE_REQUESTED`); if that too is a digest/sha we show a short hash.

import type { VersionKnob } from './services.ts'

export interface ImageRef {
  repo: string
  tag?: string
  digest?: string
}

// The .generated.env key holding the requested version for a knob: image knobs
// record `<IMAGE>_IMAGE_REQUESTED` (images.ts), source knobs record
// `<SVC_UC>_SOURCE_REQUESTED` (source.ts).
export const requestedKey = (knob: VersionKnob, svc: string): string =>
  knob.kind === 'image'
    ? `${knob.imageName}_IMAGE_REQUESTED`
    : `${svc.toUpperCase().replace(/-/g, '_')}_SOURCE_REQUESTED`

// Parse an OCI image reference into repo / tag / digest. Careful with the
// `host:port/repo:tag` case — the registry port colon is NOT a tag separator
// (a tag colon must come after the last `/`).
export const parseImageRef = (image: string): ImageRef => {
  if (!image) return { repo: '' }
  let rest = image
  let digest: string | undefined
  const at = rest.indexOf('@')
  if (at >= 0) {
    digest = rest.slice(at + 1)
    rest = rest.slice(0, at)
  }
  let tag: string | undefined
  const lastSlash = rest.lastIndexOf('/')
  const lastColon = rest.lastIndexOf(':')
  if (lastColon > lastSlash) {
    tag = rest.slice(lastColon + 1)
    rest = rest.slice(0, lastColon)
  }
  return digest ? { repo: rest, tag, digest } : { repo: rest, tag }
}

const HEX = /^[0-9a-f]{12,64}$/i
const shortHash = (s: string): string => s.replace(/^sha256:/, '').slice(0, 12)

// Best human-readable version for a service, given the running image ref and
// (optionally) the requested version from .generated.env.
export const humanVersion = (image: string, requested?: string): string => {
  const { tag, digest } = parseImageRef(image)
  if (tag) return tag
  if (requested) {
    if (requested.startsWith('sha256:') || HEX.test(requested)) return shortHash(requested)
    return requested
  }
  if (digest) return shortHash(digest)
  return ''
}
