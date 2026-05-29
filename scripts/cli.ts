// cli.ts — entry point. Tiny dispatcher; commands live in commands/.
//
// Usage:
//   ./stack-cli setup                # interactive .stack/.env setup
//   ./stack-cli enable <svc>...      # cascade-enable services
//   ./stack-cli disable <svc>...     # disable (refuses if dependants enabled)
//   ./stack-cli enabled              # list active profiles + machines
//   ./stack-cli build                # render configs, fetch sources, gen secrets
//   ./stack-cli start                # bring up the stack
//   ./stack-cli stop                 # bring it down (VMs + dc down)
//   ./stack-cli restart              # stop + start
//   ./stack-cli info                 # overview: what's enabled + runtime state
//   ./stack-cli ssh [machine]        # interactive shell into a VM
//   ./stack-cli hermes <args...>     # run a hermes CLI command in the VM
//   ./stack-cli logs [machine]       # `orb logs`
//   ./stack-cli reconfigure <svc>    # re-render runtime configs
//   ./stack-cli chrome-cdp           # launch Mac-host Chrome with CDP
//   ./stack-cli chrome-cdp-stop      # tear them down
//   ./stack-cli start-cleanup        # reap exited provisioner containers
import pc from 'picocolors'
import { runSetup } from './commands/setup.ts'
import { runEnable } from './commands/enable.ts'
import { runDisable } from './commands/disable.ts'
import { runEnabled } from './commands/enabled.ts'
import { runInfo } from './commands/info.ts'
import { runBuild } from './commands/build.ts'
import { runStart } from './commands/start.ts'
import { runStop } from './commands/stop.ts'
import { runRestart } from './commands/restart.ts'
import { runLogs } from './commands/logs.ts'
import { runSsh } from './commands/ssh.ts'
import { runHermes } from './commands/hermes.ts'
import { runReconfigure } from './commands/reconfigure.ts'
import { runStartCleanup } from './commands/start-cleanup.ts'
import { runChromeCdp, runChromeCdpStop } from './commands/chrome-cdp.ts'
import { startService, stopService, restartService } from './lib/lifecycle.ts'

type Handler = (args: readonly string[]) => Promise<void>

// start/stop/restart take an optional service list. With no args they act on
// the whole stack (whole); with args, on each named service individually.
const perSvc =
  (verb: string, one: (svc: string) => Promise<void>, whole: () => Promise<void>): Handler =>
  async (args) => {
    if (args.length === 0) return whole()
    for (const svc of args) {
      console.log(pc.cyan(`→ ${verb} ${svc}`))
      await one(svc)
    }
  }

const COMMANDS: Record<string, Handler> = {
  setup: async () => runSetup(),
  enable: runEnable,
  disable: runDisable,
  enabled: async () => runEnabled(),
  info: async () => runInfo(),
  build: async () => runBuild(),
  start: perSvc('start', startService, runStart),
  up: perSvc('start', startService, runStart),
  stop: perSvc('stop', stopService, runStop),
  down: perSvc('stop', stopService, runStop),
  restart: perSvc('restart', restartService, runRestart),
  logs: runLogs,
  ssh: runSsh,
  hermes: runHermes,
  reconfigure: runReconfigure,
  'start-cleanup': async () => runStartCleanup(),
  'chrome-cdp': async () => runChromeCdp(),
  'chrome-cdp-stop': async () => runChromeCdpStop(),
}

const main = async (): Promise<void> => {
  const [, , cmd, ...rest] = process.argv
  if (!cmd || cmd === '-h' || cmd === '--help') {
    printHelp()
    return
  }
  const fn = COMMANDS[cmd]
  if (!fn) {
    console.error(pc.red(`unknown command: ${cmd}`))
    printHelp()
    process.exit(2)
  }
  await fn(rest)
}

interface Section {
  title: string
  rows: ReadonlyArray<[name: string, args: string, desc: string]>
}

const HELP_SECTIONS: ReadonlyArray<Section> = [
  {
    title: 'Setup',
    rows: [
      ['setup', '', 'interactive .stack/.env setup'],
      ['enable', '<svc>...', 'cascade-enable services'],
      ['disable', '<svc>...', 'disable (refuses if dependants enabled)'],
      ['enabled', '', 'list active profiles + machines'],
      ['reconfigure', '<svc>', 're-render runtime config(s)'],
    ],
  },
  {
    title: 'Lifecycle',
    rows: [
      ['build', '', 'resolve image digests + per-service build.ts'],
      ['start', '[svc]... (up)', 'whole stack, or just the named service(s)'],
      ['stop', '[svc]... (down)', 'whole stack, or stop+remove the named service(s)'],
      ['restart', '[svc]...', 'stop+start; per-svc recreates (re-reads .stack/.env)'],
      ['start-cleanup', '', 'remove exited provisioner containers'],
    ],
  },
  {
    title: 'Inspect',
    rows: [
      ['info', '', "overview: what's enabled + runtime state"],
      ['logs', '[machine]', 'orb logs'],
    ],
  },
  {
    title: 'VMs',
    rows: [
      ['ssh', '[machine]', 'interactive shell into a VM (single-VM auto-picks)'],
      ['hermes', '<args...>', 'run a hermes CLI command in the VM'],
      ['chrome-cdp', '', 'launch Mac-host Chrome with CDP for the hermes VM'],
      ['chrome-cdp-stop', '', 'stop that Chrome + tear down the bridge'],
    ],
  },
]

const printHelp = (): void => {
  // Width of the "<command> <args>" column, computed once so every
  // section lines up. picocolors output has no width impact (the ANSI
  // is invisible) so we measure the plain strings.
  const colWidth = HELP_SECTIONS.flatMap((s) => s.rows).reduce(
    (w, [name, args]) => Math.max(w, name.length + (args ? args.length + 1 : 0)),
    0,
  )

  const lines: string[] = [pc.bold('stack-cli') + pc.dim(' — hermes-stack control'), '']
  for (const section of HELP_SECTIONS) {
    lines.push(pc.bold(pc.yellow(section.title)))
    for (const [name, args, desc] of section.rows) {
      const head = args ? `${pc.cyan(name)} ${pc.dim(args)}` : pc.cyan(name)
      const headPlain = args ? `${name} ${args}` : name
      const pad = ' '.repeat(Math.max(2, colWidth - headPlain.length + 2))
      lines.push(`  ${head}${pad}${desc}`)
    }
    lines.push('')
  }
  console.log(lines.join('\n').trimEnd())
}

main().catch((err) => {
  console.error(pc.red('error:'), err?.stack ?? err)
  process.exit(1)
})
