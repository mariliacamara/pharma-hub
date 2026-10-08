import { NestFactory } from '@nestjs/core'

import { AppModule } from './app.module'
import {
  CheckFailedError,
  runCommand,
  USAGE,
  UsageError
} from './cli/commands'
import type { CliIo } from './cli/commands'
import { ApiTokensService } from './modules/api-tokens/services/api-tokens.service'
import { KkCredentialService } from './modules/kuantokusta/services/kk-credential.service'
import { OffersSyncService } from './modules/kuantokusta/services/offers-sync.service'
import { OffersService } from './modules/kuantokusta/services/offers.service'
import { StoresService } from './modules/stores/services/stores.service'

/**
 * Entry point of the operator commands: `node dist/cli.js <command>`.
 * See src/cli/commands.ts for what they are and why they exist.
 */

/** Reads a line from the terminal without echoing it. */
function readHidden(prompt: string): Promise<string> {
  const { stdin, stdout } = process
  return new Promise((resolve, reject) => {
    let typed = ''
    stdout.write(prompt)
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')

    const finish = (action: () => void) => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.off('data', onData)
      stdout.write('\n')
      action()
    }
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') return finish(() => resolve(typed))
        if (char === '\u0003') {
          return finish(() => reject(new UsageError('Cancelled')))
        }
        if (char === '\u007f' || char === '\b') typed = typed.slice(0, -1)
        else if (char >= ' ') typed += char
      }
    }
    stdin.on('data', onData)
  })
}

/** Reads everything piped in, for `printf %s "$KEY" | node dist/cli.js …`. */
async function readPiped(): Promise<string> {
  let piped = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) piped += chunk
  return piped
}

const io: CliIo = {
  write: (line) => process.stdout.write(`${line}\n`),
  readSecret: (prompt) =>
    process.stdin.isTTY ? readHidden(prompt) : readPiped()
}

const argv = process.argv.slice(2)
if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help') {
  process.stdout.write(USAGE)
  process.exit(argv.length === 0 ? 2 : 0)
}

// Only problems are logged: the command's own output is what matters here.
const app = await NestFactory.createApplicationContext(AppModule, {
  logger: ['error', 'warn']
})

let exitCode = 0
try {
  await runCommand(
    argv,
    {
      stores: app.get(StoresService),
      tokens: app.get(ApiTokensService),
      kkCredential: app.get(KkCredentialService),
      kkOffersSync: app.get(OffersSyncService),
      kkOffers: app.get(OffersService)
    },
    io
  )
} catch (error) {
  if (error instanceof UsageError) {
    process.stderr.write(`${error.message}\n\n${USAGE}`)
    exitCode = 2
  } else if (error instanceof CheckFailedError) {
    process.stderr.write(`${error.message}\n`)
    exitCode = 1
  } else {
    // Errors raised by the service describe the problem without secrets.
    const text = error instanceof Error
      ? `${error.name}: ${error.message}`
      : 'Unknown error'
    process.stderr.write(`Failed. ${text}\n`)
    exitCode = 1
  }
} finally {
  await app.close()
}
process.exit(exitCode)
