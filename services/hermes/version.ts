// services/hermes/version.ts — per-service version hook (info).
//
// hermes is a self-updating VM (hermes-agent updates in place), so its version
// can't be read from an image tag or a source pin — those would drift. Read it
// from the canonical CLI: `hermes --version`. That output survives any future
// dashboard/API mutation, which the HTTP /api/status endpoint would not.
//
//   $ hermes --version
//   Hermes Agent v0.16.0 (2026.6.5) · upstream 9688c1a9
//   Project: /opt/hermes-agent
//   ...
//
// Returns '' when the CLI is unreachable → info renders N/A.
//
// NB: runs INSIDE the VM via orb (the `hermes` CLI only exists there), NOT a
// host-side call. stack-cli runs under bun, which can't reach the orb VM network
// from the host (host-side fetch/curl time out by name AND IP — only node/bash
// can). Running the CLI in-VM sidesteps that and matches how the rest of the
// stack talks to the VM.
import { orbExec } from '../../scripts/lib/orb.ts'
import { stackVmName } from '../../scripts/lib/compose-env.ts'
import { parseHermesVersion } from './hermes-version.ts'

export default async function version(): Promise<string> {
  try {
    const out = await orbExec(stackVmName('hermes'), 'hermes --version')
    return parseHermesVersion(out).version
  } catch {
    return ''
  }
}
