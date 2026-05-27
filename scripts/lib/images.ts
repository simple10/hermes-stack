// images.ts — port of stack_image / stack_resolve_images (Phase 1 of
// `./stack-cli build`). For every services/<svc>/service.env that declares a
// *_IMAGE_REPO + *_IMAGE_DEFAULT pair, resolve the requested tag (or
// pass-through digest) to a concrete digest via
// `docker buildx imagetools inspect` and write *_IMAGE=repo@digest +
// *_IMAGE_REQUESTED + *_IMAGE_RESOLVED_DIGEST into
// .stack/<svc>/.generated.env.
//
// Runs unconditionally because compose `include:` parses + interpolates
// every entry on every `dc` call; the values must always be resolved.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { $ } from 'zx'
import { SERVICES_DIR } from './paths.ts'
import { parseEnvFile } from './env.ts'
import { generatedUpsert } from './generated.ts'
import { stackGet } from './stack.ts'
import { die, log } from './log.ts'

interface ImageDecl {
  name: string // e.g. "LITELLM"
  svc: string // dir name
  repo: string
  defaultPin: string
}

const discoverImages = (): ImageDecl[] => {
  const out: ImageDecl[] = []
  for (const entry of readdirSync(SERVICES_DIR)) {
    const dir = resolve(SERVICES_DIR, entry)
    if (!statSync(dir).isDirectory()) continue
    const f = resolve(dir, 'service.env')
    try {
      const flat = parseEnvFile(f)
      for (const key of Object.keys(flat)) {
        const m = key.match(/^([A-Z][A-Z0-9_]*)_IMAGE_REPO$/)
        if (!m) continue
        const name = m[1]
        const repo = flat[`${name}_IMAGE_REPO`]
        const defaultPin = flat[`${name}_IMAGE_DEFAULT`]
        if (!repo || !defaultPin) {
          die(`${f}: missing ${name}_IMAGE_REPO or ${name}_IMAGE_DEFAULT`)
          continue
        }
        out.push({ name, svc: entry, repo, defaultPin })
      }
    } catch {
      /* not a service dir / unreadable */
    }
  }
  return out
}

export const resolveImage = async (decl: ImageDecl): Promise<void> => {
  $.verbose = false
  const versionKey = `${decl.name}_VERSION`
  const requested = stackGet(versionKey) || process.env[versionKey] || decl.defaultPin
  let digest = ''
  if (requested.startsWith('sha256:')) {
    digest = requested
  } else {
    try {
      digest = (
        await $`docker buildx imagetools inspect ${`${decl.repo}:${requested}`} --format ${'{{.Manifest.Digest}}'}`
      ).stdout.trim()
    } catch (e) {
      die(
        `resolveImage(${decl.name}): \`docker buildx imagetools inspect ${decl.repo}:${requested}\` failed ` +
          `(network/auth/unknown tag).\n${(e as Error).message}`,
      )
    }
    if (!digest) die(`resolveImage(${decl.name}): empty digest for ${decl.repo}:${requested}`)
  }
  generatedUpsert(decl.svc, `${decl.name}_IMAGE_REQUESTED`, requested)
  generatedUpsert(decl.svc, `${decl.name}_IMAGE_RESOLVED_DIGEST`, digest)
  generatedUpsert(decl.svc, `${decl.name}_IMAGE`, `${decl.repo}@${digest}`)
  log(`stackImage(${decl.name}): ${requested} -> ${digest.slice(0, 19)}…`)
}

export const resolveAllImages = async (): Promise<void> => {
  // Validate that every declared *_IMAGE_REPO has a matching *_IMAGE_DEFAULT.
  // discoverImages already does the per-pair check; this is for the
  // case where someone forgot the REPO key entirely.
  for (const dir of readdirSync(SERVICES_DIR)) {
    const f = resolve(SERVICES_DIR, dir, 'service.env')
    try {
      const body = readFileSync(f, 'utf8')
      const repos = (body.match(/^[A-Z][A-Z0-9_]*_IMAGE_REPO=/gm) ?? []).map((s) =>
        s.replace('_IMAGE_REPO=', ''),
      )
      const defs = new Set(
        (body.match(/^[A-Z][A-Z0-9_]*_IMAGE_DEFAULT=/gm) ?? []).map((s) =>
          s.replace('_IMAGE_DEFAULT=', ''),
        ),
      )
      for (const name of repos)
        if (!defs.has(name)) die(`${f}: ${name}_IMAGE_REPO without matching ${name}_IMAGE_DEFAULT`)
    } catch {
      /* unreadable */
    }
  }
  const decls = discoverImages()
  for (const d of decls) await resolveImage(d)
}
