// hermes-version.ts — parse `hermes --version` output (shared by the info
// version hook + `stack-cli update`'s behind-check).
//
//   Hermes Agent v0.16.0 (2026.6.5) · upstream 9688c1a9
//   Project: /opt/hermes-agent
//   Python: 3.11.15
//   OpenAI SDK: 2.24.0
//   Update available: 37 commits behind — run 'hermes update'

export interface HermesVersion {
  version: string // semantic version, e.g. "0.16.0" ('' when unparseable)
  behind: number | null // commits behind upstream, null when up-to-date/unknown
}

export const parseHermesVersion = (out: string): HermesVersion => {
  const version = out.match(/Hermes Agent\s+v(\d+\.\d+\.\d+)/)?.[1] ?? ''
  const behindMatch = out.match(/(\d+)\s+commits?\s+behind/i)
  const behind = behindMatch ? Number(behindMatch[1]) : null
  return { version, behind }
}
