// images.ts — Phase 1 of `./stack-cli build`. For every service.yaml that
// declares an `images:` map (<NAME>: { repo, default }), resolve the
// requested tag (or pass-through digest) to a concrete digest via
// `docker buildx imagetools inspect` and write <NAME>_IMAGE=repo@digest +
// <NAME>_IMAGE_REQUESTED + <NAME>_IMAGE_RESOLVED_DIGEST into
// .stack/<svc>/.generated.env.
//
// Runs unconditionally because compose `include:` parses + interpolates
// every entry on every `dc` call; the values must always be resolved.
import { $ } from 'zx'
import { listServices } from './services.ts'
import { generatedUpsert } from './generated.ts'
import { stackGet } from './stack.ts'
import { die, log } from './log.ts'

interface ImageDecl {
  name: string // e.g. "LITELLM" — the *_VERSION knob prefix
  svc: string // dir name
  repo: string
  defaultPin: string
}

const discoverImages = (): ImageDecl[] => {
  const out: ImageDecl[] = []
  for (const svc of listServices()) {
    for (const [name, im] of Object.entries(svc.images)) {
      if (!im.repo || !im.default) {
        die(`services/${svc.name}/service.yaml: images.${name} needs both repo and default`)
        continue
      }
      out.push({ name, svc: svc.name, repo: im.repo, defaultPin: im.default })
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
  const decls = discoverImages()
  for (const d of decls) await resolveImage(d)
}
