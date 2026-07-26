// @ts-expect-error Vitest runs in Node, while the app tsconfig deliberately omits Node types.
import { readFileSync } from 'node:fs'
// @ts-expect-error Vitest runs in Node, while the app tsconfig deliberately omits Node types.
import { fileURLToPath } from 'node:url'

export type PostingInput = Record<string, unknown>

export type PostingRow = {
  日期: string
  時間: string
  類型: string
  借方帳戶: string
  貸方帳戶: string
  金額: number
  幣別: string
  分類: string
  對象: string
  說明: string
  結清狀態: string
  沖銷txn_id: string
  txn_id: string
  來源: string
  建立時間: string
}

type GasFunctions = {
  expandPosting_: (input: PostingInput) => PostingRow
}

const gasGlobalNames = [
  'SpreadsheetApp',
  'CacheService',
  'LockService',
  'PropertiesService',
  'Utilities',
  'Session',
] as const

function throwingGasGlobal(name: string): object {
  return new Proxy(function forbiddenGasGlobal() {}, {
    get(_target, property) {
      throw new Error(`Pure posting engine touched ${name}.${String(property)}`)
    },
    set(_target, property) {
      throw new Error(`Pure posting engine touched ${name}.${String(property)}`)
    },
    has(_target, property) {
      throw new Error(`Pure posting engine inspected ${name}.${String(property)}`)
    },
    ownKeys() {
      throw new Error(`Pure posting engine inspected ${name} properties`)
    },
    getOwnPropertyDescriptor(_target, property) {
      throw new Error(`Pure posting engine inspected ${name}.${String(property)}`)
    },
    defineProperty(_target, property) {
      throw new Error(`Pure posting engine defined ${name}.${String(property)}`)
    },
    deleteProperty(_target, property) {
      throw new Error(`Pure posting engine deleted ${name}.${String(property)}`)
    },
    apply() {
      throw new Error(`Pure posting engine called ${name}`)
    },
    construct() {
      throw new Error(`Pure posting engine constructed ${name}`)
    },
  })
}

export function loadGasFunctions(): GasFunctions {
  const codePath = fileURLToPath(new URL('../../apps-script/Code.gs', import.meta.url))
  const source = readFileSync(codePath, 'utf8')
  const evaluate = new Function(
    ...gasGlobalNames,
    [
      '"use strict";',
      source,
      'if (typeof expandPosting_ !== "function") {',
      '  throw new Error("expandPosting_ is not declared in apps-script/Code.gs");',
      '}',
      'return { expandPosting_: expandPosting_ };',
    ].join('\n'),
  )

  return evaluate(...gasGlobalNames.map(throwingGasGlobal)) as GasFunctions
}
