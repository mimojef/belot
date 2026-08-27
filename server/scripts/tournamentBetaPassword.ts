import 'dotenv/config'
import { getServerDatabaseFilePath } from '../src/db/ensureServerDatabaseReady.js'
import { createTournamentBetaAccessStore } from '../src/db/tournamentBetaAccessStore.js'

// Hidden/no-echo password prompt — не приема паролата като positional CLI
// argument (виж task spec "НЕ приемай паролата като positional CLI
// argument"), за да не остане в shell history/process list. Използва raw
// mode на stdin, ако е TTY (интерактивен терминал); non-TTY (напр. CI без
// pty) fail-ва ясно вместо тихо да echo-ва паролата в plaintext.
function promptHiddenPassword(promptText: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error('Не е налична интерактивна конзола (TTY) за hidden password вход.'))
      return
    }

    process.stdout.write(promptText)

    const stdin = process.stdin
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')

    let input = ''

    const onData = (char: string): void => {
      switch (char) {
        case '\n':
        case '\r':
        case '': // Ctrl+D
          stdin.setRawMode(false)
          stdin.pause()
          stdin.removeListener('data', onData)
          process.stdout.write('\n')
          resolve(input)
          return
        case '': // Ctrl+C
          stdin.setRawMode(false)
          stdin.pause()
          stdin.removeListener('data', onData)
          process.stdout.write('\n')
          reject(new Error('Прекъснато от потребителя.'))
          return
        case '': // Backspace
        case '\b':
          if (input.length > 0) {
            input = input.slice(0, -1)
          }
          return
        default:
          input += char
      }
    }

    stdin.on('data', onData)
  })
}

async function main(): Promise<void> {
  const first = await promptHiddenPassword('Нова beta парола: ')
  const second = await promptHiddenPassword('Повтори паролата: ')

  if (first !== second) {
    console.error('Паролите не съвпадат.')
    process.exit(1)
  }

  const store = await createTournamentBetaAccessStore(getServerDatabaseFilePath())
  try {
    const result = store.setPassword(first)
    if (!result.ok) {
      console.error('Невалидна парола (проверете минимална/максимална дължина).')
      process.exit(1)
    }
    console.log(`Готово: паролата е обновена (password_version = ${result.passwordVersion}).`)
    console.log('Старите валидни достъпи автоматично отпадат.')
  } finally {
    store.close()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
