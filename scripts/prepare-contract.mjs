#!/usr/bin/env node
// Verify the registered public contract before executing its checks or copying output.
import { readFileSync, realpathSync, existsSync, copyFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const contract = join(root, 'contract')
const pin = '839ea00ac6972a2f0d0707564f8cb68c41546181'
const publicUrl = 'https://github.com/paulpengtw/expense-contract.git'
const consumer = 'solo-ledger'

function fail(message) { throw new Error(`contract preparation: ${message}`) }
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' })
  if (result.error || result.status !== 0) {
    fail(`${command} ${args.join(' ')} failed: ${(result.stderr || result.stdout || result.error?.message || '').trim()}`)
  }
  return result.stdout.trim()
}

try {
  if (process.versions.node !== '26.5.0') fail(`Node 26.5.0 required, found ${process.versions.node}`)
  if (realpathSync(run('git', ['rev-parse', '--show-toplevel'], root)) !== realpathSync(root)) fail('wrong owning repository')
  if (run('git', ['config', '-f', '.gitmodules', '--get', 'submodule.contract.path'], root) !== 'contract' ||
      run('git', ['config', '-f', '.gitmodules', '--get', 'submodule.contract.url'], root) !== publicUrl) {
    fail('contract must be registered as the public HTTPS submodule')
  }
  const index = run('git', ['ls-files', '--stage', '--', 'contract'], root)
  if (index !== `160000 ${pin} 0\tcontract`) fail(`wrong registered gitlink: ${index || 'missing'}`)
  if (!existsSync(join(contract, '.git')) ||
      realpathSync(run('git', ['rev-parse', '--show-toplevel'], contract)) !== realpathSync(contract)) {
    fail('contract submodule missing or uninitialized')
  }
  const head = run('git', ['rev-parse', 'HEAD'], contract)
  if (head !== pin) fail(`contract checkout HEAD ${head} differs from pin ${pin}`)
  if (process.env.CONTRACT_VERSION && process.env.CONTRACT_VERSION !== pin) fail('CONTRACT_VERSION differs from pin')
  const dirty = run('git', ['status', '--porcelain=v1', '--untracked-files=all'], contract)
  if (dirty) fail(`contract checkout dirty:\n${dirty}`)
  run(process.execPath, ['scripts/check.mjs'], contract)
  run(process.execPath, ['scripts/verify-generation.mjs'], contract)
  const tests = readdirSync(join(contract, 'tests')).filter(name => name.endsWith('.test.mjs')).sort().map(name => join('tests', name))
  if (tests.length === 0) fail('contract conformance tests missing')
  run(process.execPath, ['--test', ...tests], contract)

  const source = join(contract, 'generated', consumer, 'Contract.gs')
  const destination = join(root, 'apps-script', 'Contract.gs')
  if (existsSync(destination) && !readFileSync(source).equals(readFileSync(destination))) {
    fail('copied Apps Script contract differs from pinned generated source')
  }
  const vocabulary = await import(pathToFileURL(join(contract, 'generated', consumer, 'vocabulary.ts')).href)
  const code = readFileSync(join(root, 'apps-script', 'Code.gs'), 'utf8')
  const declaration = code.match(/^var JOURNAL_HEADERS = \[([\s\S]*?)\];/m)
  if (!declaration) fail('missing GAS JOURNAL_HEADERS')
  const actualHeaders = [...declaration[1].matchAll(/'([^']+)'/g)].map(match => match[1])
  if (JSON.stringify(actualHeaders) !== JSON.stringify(vocabulary.JOURNAL_HEADERS)) fail('GAS JOURNAL_HEADERS differs from generated vocabulary')
  copyFileSync(source, destination)
  const appVersion = run('git', ['rev-parse', 'HEAD'], root)
  if (!/^[0-9a-f]{40}$/.test(appVersion)) fail('source commit version unavailable')
  writeFileSync(join(root, 'apps-script', 'Version.gs'),
    `// Generated from verified source; do not edit.\nvar CONTRACT_VERSION = '${pin}';\nvar APP_VERSION = '${appVersion}';\n`)
  const generatedDir = join(root, 'src', 'generated')
  mkdirSync(generatedDir, { recursive: true })
  writeFileSync(join(generatedDir, 'version.ts'),
    `// Generated from verified source; do not edit.\nexport const CONTRACT_VERSION = '${pin}'\nexport const APP_VERSION = '${appVersion}'\n`)
  console.log(`verified contract ${pin}; built app ${appVersion}`)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
