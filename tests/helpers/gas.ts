import { readFileSync } from 'node:fs'
import { createHash, createHmac } from 'node:crypto'
import { Buffer } from 'node:buffer'
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
  交易對象: string
  說明: string
  結清狀態: string
  沖銷txn_id: string
  txn_id: string
  來源: string
  建立時間: string
}

type GasFunctions = {
  expandPosting_: (input: PostingInput) => PostingRow
  resolveHeaders_: (headerRow: unknown[], requiredHeaders: string[]) => Record<string, number>
  JOURNAL_HEADERS: string[]
}

const gasGlobalNames = [
  'SpreadsheetApp',
  'CacheService',
  'LockService',
  'PropertiesService',
  'Utilities',
  'ContentService',
  'Session',
  'DriveApp',
  'MailApp',
  'ScriptApp',
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
  const contractPath = fileURLToPath(new URL('../../apps-script/Contract.gs', import.meta.url))
  const versionPath = fileURLToPath(new URL('../../apps-script/Version.gs', import.meta.url))
  const source = readFileSync(contractPath, 'utf8') + '\n' + readFileSync(versionPath, 'utf8') + '\n' + readFileSync(codePath, 'utf8')
  const evaluate = new Function(
    ...gasGlobalNames,
    [
      '"use strict";',
      source,
      'if (typeof expandPosting_ !== "function") {',
      '  throw new Error("expandPosting_ is not declared in apps-script/Code.gs");',
      '}',
      'return {',
      '  expandPosting_: expandPosting_,',
      '  resolveHeaders_: typeof resolveHeaders_ === "function" ? resolveHeaders_ : undefined,',
      '  JOURNAL_HEADERS: typeof JOURNAL_HEADERS !== "undefined" ? JOURNAL_HEADERS : undefined,',
      '};',
    ].join('\n'),
  )

  return evaluate(...gasGlobalNames.map(throwingGasGlobal)) as GasFunctions
}

type CellValue = unknown

export type FakeDataValidation = {
  criteriaType: 'VALUE_IN_RANGE'
  range: FakeRange
  showDropdown: boolean
  allowInvalid: boolean
}

export class FakeRange {
  constructor(
    private readonly sheet: FakeSheet,
    private readonly row: number,
    private readonly column: number,
    private readonly numRows: number,
    private readonly numColumns: number,
  ) {}

  getSheet(): FakeSheet {
    return this.sheet
  }

  getRow(): number {
    return this.row
  }

  getColumn(): number {
    return this.column
  }

  getNumRows(): number {
    return this.numRows
  }

  getNumColumns(): number {
    return this.numColumns
  }

  setValues(values: CellValue[][]): FakeRange {
    if (values.length !== this.numRows || values.some((valuesRow) => valuesRow.length !== this.numColumns)) {
      throw new Error('setValues dimensions must match the range')
    }

    this.sheet.beforeSetValues(this.column)

    for (let rowOffset = 0; rowOffset < this.numRows; rowOffset += 1) {
      for (let columnOffset = 0; columnOffset < this.numColumns; columnOffset += 1) {
        this.sheet.writeValue(
          this.row + rowOffset,
          this.column + columnOffset,
          values[rowOffset]![columnOffset],
        )
      }
    }
    this.sheet.afterSetValues(
      this.row,
      this.column,
      this.numRows,
      this.numColumns,
    )
    return this
  }

  getValues(): CellValue[][] {
    return Array.from({ length: this.numRows }, (_unusedRow, rowOffset) =>
      Array.from({ length: this.numColumns }, (_unusedColumn, columnOffset) =>
        this.sheet.readValue(this.row + rowOffset, this.column + columnOffset),
      ),
    )
  }

  getDisplayValues(): string[][] {
    return this.getValues().map((row) => row.map(displayValue))
  }

  setNumberFormat(format: string): FakeRange {
    this.forEachCell((row, column) => this.sheet.writeNumberFormat(row, column, format))
    return this
  }

  getNumberFormats(): string[][] {
    return Array.from({ length: this.numRows }, (_unusedRow, rowOffset) =>
      Array.from({ length: this.numColumns }, (_unusedColumn, columnOffset) =>
        this.sheet.readNumberFormat(this.row + rowOffset, this.column + columnOffset),
      ),
    )
  }

  setDataValidation(validation: FakeDataValidation): FakeRange {
    this.forEachCell((row, column) => this.sheet.writeDataValidation(row, column, validation))
    return this
  }

  getDataValidations(): Array<Array<FakeDataValidation | null>> {
    return Array.from({ length: this.numRows }, (_unusedRow, rowOffset) =>
      Array.from({ length: this.numColumns }, (_unusedColumn, columnOffset) =>
        this.sheet.readDataValidation(this.row + rowOffset, this.column + columnOffset),
      ),
    )
  }

  private forEachCell(callback: (row: number, column: number) => void): void {
    for (let rowOffset = 0; rowOffset < this.numRows; rowOffset += 1) {
      for (let columnOffset = 0; columnOffset < this.numColumns; columnOffset += 1) {
        callback(this.row + rowOffset, this.column + columnOffset)
      }
    }
  }
}

export class FakeSheet {
  private readonly values: CellValue[][] = []
  private readonly numberFormats = new Map<string, string>()
  private readonly dataValidations = new Map<string, FakeDataValidation>()
  private nextWriteError: Error | null = null
  private nextWriteErrorColumn: number | null = null

  constructor(
    private name: string,
    private readonly recordEvent: (event: string) => void = () => undefined,
  ) {}

  getName(): string {
    return this.name
  }

  setName(name: string): FakeSheet {
    this.name = name
    return this
  }

  getRange(row: number, column: number, numRows = 1, numColumns = 1): FakeRange {
    if (row < 1 || column < 1 || numRows < 1 || numColumns < 1) {
      throw new Error('range coordinates and dimensions must be positive')
    }
    return new FakeRange(this, row, column, numRows, numColumns)
  }

  getLastRow(): number {
    for (let row = this.values.length; row >= 1; row -= 1) {
      if ((this.values[row - 1] || []).some(hasCellValue)) {
        return row
      }
    }
    return 0
  }

  getLastColumn(): number {
    let lastColumn = 0
    for (const row of this.values) {
      for (let column = row.length; column >= 1; column -= 1) {
        if (hasCellValue(row[column - 1])) {
          lastColumn = Math.max(lastColumn, column)
          break
        }
      }
    }
    return lastColumn
  }

  getMaxRows(): number {
    return 1000
  }

  readValue(row: number, column: number): CellValue {
    return this.values[row - 1]?.[column - 1] ?? ''
  }

  writeValue(row: number, column: number, value: CellValue): void {
    while (this.values.length < row) {
      this.values.push([])
    }
    const valuesRow = this.values[row - 1]!
    while (valuesRow.length < column) {
      valuesRow.push('')
    }
    valuesRow[column - 1] = value
  }

  readNumberFormat(row: number, column: number): string {
    return this.numberFormats.get(cellKey(row, column)) || ''
  }

  writeNumberFormat(row: number, column: number, format: string): void {
    this.numberFormats.set(cellKey(row, column), format)
  }

  readDataValidation(row: number, column: number): FakeDataValidation | null {
    return this.dataValidations.get(cellKey(row, column)) || null
  }

  writeDataValidation(row: number, column: number, validation: FakeDataValidation): void {
    this.dataValidations.set(cellKey(row, column), validation)
  }

  failNextSetValues(message = 'simulated write failure'): void {
    this.nextWriteError = new Error(message)
    this.nextWriteErrorColumn = null
  }

  failNextSetValuesInColumn(
    column: number,
    message = 'simulated write failure',
  ): void {
    this.nextWriteError = new Error(message)
    this.nextWriteErrorColumn = column
  }

  beforeSetValues(column: number): void {
    if (
      !this.nextWriteError
      || (
        this.nextWriteErrorColumn !== null
        && this.nextWriteErrorColumn !== column
      )
    ) {
      return
    }
    const error = this.nextWriteError
    this.nextWriteError = null
    this.nextWriteErrorColumn = null
    throw error
  }

  afterSetValues(
    row: number,
    column: number,
    numRows: number,
    numColumns: number,
  ): void {
    if (this.name === '日記帳' && row >= 2) {
      const isStatusCell =
        numRows === 1
        && numColumns === 1
        && this.readValue(1, column) === '結清狀態'
      this.recordEvent(isStatusCell ? 'status-written' : 'row-written')
    }
  }
}

export class FakeSpreadsheet {
  private readonly sheets: FakeSheet[]

  constructor(recordEvent: (event: string) => void = () => undefined) {
    this.sheets = [new FakeSheet('Sheet1', recordEvent)]
    this.recordEvent = recordEvent
  }

  private readonly recordEvent: (event: string) => void

  getName(): string {
    return 'Solo Ledger'
  }

  getSheetByName(name: string): FakeSheet | null {
    return this.sheets.find((sheet) => sheet.getName() === name) || null
  }

  insertSheet(name: string): FakeSheet {
    if (this.getSheetByName(name)) {
      throw new Error(`sheet already exists: ${name}`)
    }
    const sheet = new FakeSheet(name, this.recordEvent)
    this.sheets.push(sheet)
    return sheet
  }

  getSheets(): FakeSheet[] {
    return [...this.sheets]
  }
}

type FakeFileIterator = {
  hasNext: () => boolean
  next: () => FakeDriveFile
}

export class FakeDriveFile {
  private trashed = false

  constructor(
    private readonly id: string,
    private readonly name: string,
    private readonly createdAt: Date,
    private readonly copyFile: (
      name: string,
      folder: FakeDriveFolder,
    ) => FakeDriveFile,
  ) {}

  getId(): string {
    return this.id
  }

  getName(): string {
    return this.name
  }

  getDateCreated(): Date {
    return new Date(this.createdAt.getTime())
  }

  isTrashed(): boolean {
    return this.trashed
  }

  setTrashed(trashed: boolean): FakeDriveFile {
    this.trashed = trashed
    return this
  }

  makeCopy(name: string, folder: FakeDriveFolder): FakeDriveFile {
    return this.copyFile(name, folder)
  }
}

export class FakeDriveFolder {
  private readonly files: FakeDriveFile[] = []

  constructor(
    private readonly id: string,
    private readonly name: string,
  ) {}

  getId(): string {
    return this.id
  }

  getName(): string {
    return this.name
  }

  getFiles(): FakeFileIterator {
    const files = this.files.filter(file => !file.isTrashed())
    let index = 0
    return {
      hasNext: () => index < files.length,
      next: () => {
        const file = files[index]
        if (!file) throw new Error('no more files')
        index += 1
        return file
      },
    }
  }

  addFile(file: FakeDriveFile): void {
    this.files.push(file)
  }

  allFiles(): FakeDriveFile[] {
    return [...this.files]
  }
}

export class FakeDrive {
  private readonly folders = new Map<string, FakeDriveFolder>()
  private readonly files = new Map<string, FakeDriveFile>()
  private nextFolderId = 1
  private nextFileId = 1

  constructor(spreadsheetId: string) {
    this.createFile('Solo Ledger', new Date(0), null, spreadsheetId)
  }

  createFolder(name: string): FakeDriveFolder {
    const folder = new FakeDriveFolder(
      `fake-folder-${this.nextFolderId}`,
      name,
    )
    this.nextFolderId += 1
    this.folders.set(folder.getId(), folder)
    return folder
  }

  createFile(
    name: string,
    createdAt: Date,
    folder: FakeDriveFolder | null = null,
    id = `fake-file-${this.nextFileId}`,
  ): FakeDriveFile {
    this.nextFileId += 1
    const file = new FakeDriveFile(
      id,
      name,
      createdAt,
      (copyName, copyFolder) =>
        this.createFile(copyName, new Date(Date.now()), copyFolder),
    )
    this.files.set(id, file)
    if (folder) {
      folder.addFile(file)
    }
    return file
  }

  getFolderById(id: string): FakeDriveFolder {
    const folder = this.folders.get(id)
    if (!folder) throw new Error(`unknown folder id: ${id}`)
    return folder
  }

  getFileById(id: string): FakeDriveFile {
    const file = this.files.get(id)
    if (!file) throw new Error(`unknown file id: ${id}`)
    return file
  }
}

export type FakeMailMessage = {
  to: string
  subject: string
  body: string
}

export type FakeTrigger = {
  handler: string
  weekDay: string
  hour: number
  getHandlerFunction: () => string
}

class FakeDataValidationBuilder {
  private range: FakeRange | null = null
  private showDropdown = true
  private allowInvalid = true

  requireValueInRange(range: FakeRange, showDropdown = true): FakeDataValidationBuilder {
    this.range = range
    this.showDropdown = showDropdown
    return this
  }

  setAllowInvalid(allowInvalid: boolean): FakeDataValidationBuilder {
    this.allowInvalid = allowInvalid
    return this
  }

  build(): FakeDataValidation {
    if (!this.range) {
      throw new Error('data validation requires a source range')
    }
    return {
      criteriaType: 'VALUE_IN_RANGE',
      range: this.range,
      showDropdown: this.showDropdown,
      allowInvalid: this.allowInvalid,
    }
  }
}

export type FakeTextOutput = {
  getContent: () => string
  getMimeType: () => string
  setMimeType: (mimeType: string) => FakeTextOutput
}

export type FakeDoPostEvent = {
  postData?: {
    contents?: string
  }
}

type SetupGasFunctions = Pick<GasFunctions, 'resolveHeaders_' | 'JOURNAL_HEADERS'> & {
  setupSpreadsheet: () => void
  closeAndOpenBooks: (oldSpreadsheetId: string) => Record<string, unknown>
  doPost: (event: FakeDoPostEvent) => FakeTextOutput
  checkConsistency_: (payload?: { repair?: boolean }) => Record<string, unknown>
  weeklyConsistencyCheck: () => Record<string, unknown>
  weeklyBackup: () => Record<string, unknown>
  pruneBackups_: (
    folder: FakeDriveFolder,
    backupPrefix: string,
    sourceFileId: string,
  ) => FakeDriveFile[]
  installWeeklyTriggers: () => void
}

export type FakeGasHarness = SetupGasFunctions & {
  spreadsheet: FakeSpreadsheet
  oldSpreadsheet: FakeSpreadsheet
  spreadsheetId: string
  oldSpreadsheetId: string
  drive: FakeDrive
  mailMessages: FakeMailMessage[]
  triggers: FakeTrigger[]
  events: string[]
  clearEvents: () => void
  setScriptProperty: (name: string, value: string) => void
  advanceCacheTime: (seconds: number) => void
  failNextLock: () => void
  onNextLock: (callback: () => void) => void
  peekCache: (key: string) => string | null
  peekScriptProperty: (name: string) => string | null
}

export function loadGasFunctionsWithFakeGas(): FakeGasHarness {
  const codePath = fileURLToPath(new URL('../../apps-script/Code.gs', import.meta.url))
  const contractPath = fileURLToPath(new URL('../../apps-script/Contract.gs', import.meta.url))
  const versionPath = fileURLToPath(new URL('../../apps-script/Version.gs', import.meta.url))
  const source = readFileSync(contractPath, 'utf8') + '\n' + readFileSync(versionPath, 'utf8') + '\n' + readFileSync(codePath, 'utf8')
  const events: string[] = []
  const recordEvent = (event: string) => events.push(event)
  const spreadsheetId = 'test-ledger-spreadsheet-id'
  const oldSpreadsheetId = 'test-old-ledger-spreadsheet-id'
  const spreadsheet = new FakeSpreadsheet(recordEvent)
  const oldSpreadsheet = new FakeSpreadsheet(recordEvent)
  const spreadsheets = new Map<string, FakeSpreadsheet>([
    [spreadsheetId, spreadsheet],
    [oldSpreadsheetId, oldSpreadsheet],
  ])
  const drive = new FakeDrive(spreadsheetId)
  const mailMessages: FakeMailMessage[] = []
  const triggers: FakeTrigger[] = []
  let nextUuid = 1
  let cacheNow = Date.now()
  let lockShouldFail = false
  let nextLockCallback: (() => void) | null = null
  const cacheEntries = new Map<string, { value: string; expiresAt: number }>()
  const scriptProperties = new Map<string, string>([
    ['LEDGER_SPREADSHEET_ID', spreadsheetId],
    ['EXPENSE_API_SECRET', 'test-secret'],
    ['INTEGRATION_OPEN', 'true'],
  ])
  const scriptCache = {
    get(key: string) {
      if (key.startsWith('nonce:')) {
        recordEvent('nonce-checked')
      }
      const entry = cacheEntries.get(key)
      if (!entry) {
        return null
      }
      if (entry.expiresAt <= cacheNow) {
        cacheEntries.delete(key)
        return null
      }
      return entry.value
    },
    put(key: string, value: string, seconds: number) {
      cacheEntries.set(key, { value, expiresAt: cacheNow + seconds * 1000 })
      if (key.startsWith('nonce:')) {
        recordEvent('nonce-committed')
      }
    },
  }
  const scriptLock = {
    waitLock(_milliseconds: number) {
      if (lockShouldFail) {
        lockShouldFail = false
        throw new Error('simulated lock failure')
      }
      recordEvent('lock-acquired')
      const callback = nextLockCallback
      nextLockCallback = null
      callback?.()
    },
    releaseLock() {
      recordEvent('lock-released')
    },
  }
  const spreadsheetApp = {
    openById(id: string) {
      const resolved = spreadsheets.get(id)
      if (!resolved) throw new Error(`unknown spreadsheet id: ${id}`)
      return resolved
    },
    newDataValidation() {
      return new FakeDataValidationBuilder()
    },
  }
  const propertiesService = {
    getScriptProperties() {
      return {
        getProperty(name: string) {
          return scriptProperties.get(name) ?? null
        },
        setProperty(name: string, value: string) {
          scriptProperties.set(name, value)
          return this
        },
      }
    },
  }
  const cacheService = {
    getScriptCache() {
      return scriptCache
    },
  }
  const lockService = {
    getScriptLock() {
      return scriptLock
    },
  }
  const utilities = {
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    computeHmacSha256Signature(value: string, key: string) {
      return Array.from(createHmac('sha256', key).update(value, 'utf8').digest())
    },
    computeDigest(algorithm: string, value: string) {
      if (algorithm !== 'SHA_256') {
        throw new Error(`unsupported digest algorithm: ${algorithm}`)
      }
      return Array.from(createHash('sha256').update(value, 'utf8').digest())
    },
    getUuid() {
      const suffix = String(nextUuid).padStart(12, '0')
      nextUuid += 1
      return `00000000-0000-4000-8000-${suffix}`
    },
    base64EncodeWebSafe(bytes: number[]) {
      return Buffer.from(bytes)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
    },
    base64Decode(text: string) {
      return Array.from(Buffer.from(text, 'base64'))
    },
    newBlob(bytes: number[]) {
      return {
        getDataAsString(charset: string) {
          if (charset !== 'UTF-8') {
            throw new Error(`unsupported blob charset: ${charset}`)
          }
          return Buffer.from(bytes).toString('utf8')
        },
      }
    },
  }
  const contentService = {
    MimeType: { JSON: 'application/json' },
    createTextOutput(content: string): FakeTextOutput {
      let mimeType = 'text/plain'
      const output: FakeTextOutput = {
        getContent: () => content,
        getMimeType: () => mimeType,
        setMimeType(nextMimeType: string) {
          mimeType = nextMimeType
          return output
        },
      }
      return output
    },
  }
  const session = {
    getEffectiveUser() {
      return {
        getEmail() {
          return 'ledger-owner@example.com'
        },
      }
    },
  }
  const driveApp = {
    createFolder(name: string) {
      return drive.createFolder(name)
    },
    getFolderById(id: string) {
      return drive.getFolderById(id)
    },
    getFileById(id: string) {
      return drive.getFileById(id)
    },
  }
  const mailApp = {
    sendEmail(
      messageOrTo: FakeMailMessage | string,
      subject?: string,
      body?: string,
    ) {
      if (typeof messageOrTo === 'string') {
        mailMessages.push({
          to: messageOrTo,
          subject: subject ?? '',
          body: body ?? '',
        })
        return
      }
      mailMessages.push({ ...messageOrTo })
    },
  }
  const scriptApp = {
    WeekDay: { MONDAY: 'MONDAY' },
    getProjectTriggers() {
      return [...triggers]
    },
    deleteTrigger(trigger: FakeTrigger) {
      const index = triggers.indexOf(trigger)
      if (index >= 0) triggers.splice(index, 1)
    },
    newTrigger(handler: string) {
      let weekDay = ''
      let hour = -1
      const builder = {
        timeBased() {
          return builder
        },
        onWeekDay(value: string) {
          weekDay = value
          return builder
        },
        atHour(value: number) {
          hour = value
          return builder
        },
        create() {
          const trigger: FakeTrigger = {
            handler,
            weekDay,
            hour,
            getHandlerFunction: () => handler,
          }
          triggers.push(trigger)
          return trigger
        },
      }
      return builder
    },
  }
  const evaluate = new Function(
    ...gasGlobalNames,
    [
      '"use strict";',
      source,
      'return {',
      '  setupSpreadsheet: typeof setupSpreadsheet === "function" ? setupSpreadsheet : undefined,',
      '  closeAndOpenBooks: typeof closeAndOpenBooks === "function" ? closeAndOpenBooks : undefined,',
      '  doPost: typeof doPost === "function" ? doPost : undefined,',
      '  checkConsistency_: typeof checkConsistency_ === "function" ? checkConsistency_ : undefined,',
      '  weeklyConsistencyCheck: typeof weeklyConsistencyCheck === "function" ? weeklyConsistencyCheck : undefined,',
      '  weeklyBackup: typeof weeklyBackup === "function" ? weeklyBackup : undefined,',
      '  pruneBackups_: typeof pruneBackups_ === "function" ? pruneBackups_ : undefined,',
      '  installWeeklyTriggers: typeof installWeeklyTriggers === "function" ? installWeeklyTriggers : undefined,',
      '  resolveHeaders_: typeof resolveHeaders_ === "function" ? resolveHeaders_ : undefined,',
      '  JOURNAL_HEADERS: typeof JOURNAL_HEADERS !== "undefined" ? JOURNAL_HEADERS : undefined,',
      '};',
    ].join('\n'),
  )
  const injectedGlobals = gasGlobalNames.map((name) => {
    if (name === 'SpreadsheetApp') {
      return spreadsheetApp
    }
    if (name === 'PropertiesService') {
      return propertiesService
    }
    if (name === 'CacheService') {
      return cacheService
    }
    if (name === 'LockService') {
      return lockService
    }
    if (name === 'Utilities') {
      return utilities
    }
    if (name === 'ContentService') {
      return contentService
    }
    if (name === 'Session') {
      return session
    }
    if (name === 'DriveApp') {
      return driveApp
    }
    if (name === 'MailApp') {
      return mailApp
    }
    if (name === 'ScriptApp') {
      return scriptApp
    }
    return throwingGasGlobal(name)
  })
  const functions = evaluate(...injectedGlobals) as SetupGasFunctions

  return {
    ...functions,
    spreadsheet,
    oldSpreadsheet,
    spreadsheetId,
    oldSpreadsheetId,
    drive,
    mailMessages,
    triggers,
    events,
    clearEvents() {
      events.length = 0
    },
    setScriptProperty(name: string, value: string) {
      scriptProperties.set(name, value)
    },
    failNextLock() {
      lockShouldFail = true
    },
    onNextLock(callback: () => void) {
      nextLockCallback = callback
    },
    advanceCacheTime(seconds: number) {
      cacheNow += seconds * 1000
    },
    peekCache(key: string) {
      const entry = cacheEntries.get(key)
      return entry && entry.expiresAt > cacheNow ? entry.value : null
    },
    peekScriptProperty(name: string) {
      return scriptProperties.get(name) ?? null
    },
  }
}

function hasCellValue(value: CellValue): boolean {
  return value !== '' && value !== null && value !== undefined
}

function cellKey(row: number, column: number): string {
  return `${row}:${column}`
}

function displayValue(value: CellValue): string {
  if (value === '' || value === null || value === undefined) {
    return ''
  }
  if (value === true) {
    return 'TRUE'
  }
  if (value === false) {
    return 'FALSE'
  }
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10)
  }
  return String(value)
}
