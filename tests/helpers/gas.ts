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
  resolveHeaders_: (headerRow: unknown[], requiredHeaders: string[]) => Record<string, number>
  JOURNAL_HEADERS: string[]
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

    for (let rowOffset = 0; rowOffset < this.numRows; rowOffset += 1) {
      for (let columnOffset = 0; columnOffset < this.numColumns; columnOffset += 1) {
        this.sheet.writeValue(
          this.row + rowOffset,
          this.column + columnOffset,
          values[rowOffset]![columnOffset],
        )
      }
    }
    return this
  }

  getValues(): CellValue[][] {
    return Array.from({ length: this.numRows }, (_unusedRow, rowOffset) =>
      Array.from({ length: this.numColumns }, (_unusedColumn, columnOffset) =>
        this.sheet.readValue(this.row + rowOffset, this.column + columnOffset),
      ),
    )
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

  constructor(private name: string) {}

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
}

export class FakeSpreadsheet {
  private readonly sheets: FakeSheet[] = [new FakeSheet('Sheet1')]

  getSheetByName(name: string): FakeSheet | null {
    return this.sheets.find((sheet) => sheet.getName() === name) || null
  }

  insertSheet(name: string): FakeSheet {
    if (this.getSheetByName(name)) {
      throw new Error(`sheet already exists: ${name}`)
    }
    const sheet = new FakeSheet(name)
    this.sheets.push(sheet)
    return sheet
  }

  getSheets(): FakeSheet[] {
    return [...this.sheets]
  }
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

type SetupGasFunctions = Pick<GasFunctions, 'resolveHeaders_' | 'JOURNAL_HEADERS'> & {
  setupSpreadsheet: () => void
}

export type FakeGasHarness = SetupGasFunctions & {
  spreadsheet: FakeSpreadsheet
}

export function loadGasFunctionsWithFakeGas(): FakeGasHarness {
  const codePath = fileURLToPath(new URL('../../apps-script/Code.gs', import.meta.url))
  const source = readFileSync(codePath, 'utf8')
  const spreadsheet = new FakeSpreadsheet()
  const spreadsheetApp = {
    openById(id: string) {
      if (id !== 'test-ledger-spreadsheet-id') {
        throw new Error(`unknown spreadsheet id: ${id}`)
      }
      return spreadsheet
    },
    newDataValidation() {
      return new FakeDataValidationBuilder()
    },
  }
  const propertiesService = {
    getScriptProperties() {
      return {
        getProperty(name: string) {
          return name === 'LEDGER_SPREADSHEET_ID' ? 'test-ledger-spreadsheet-id' : null
        },
      }
    },
  }
  const evaluate = new Function(
    ...gasGlobalNames,
    [
      '"use strict";',
      source,
      'return {',
      '  setupSpreadsheet: typeof setupSpreadsheet === "function" ? setupSpreadsheet : undefined,',
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
    return throwingGasGlobal(name)
  })
  const functions = evaluate(...injectedGlobals) as SetupGasFunctions

  return { ...functions, spreadsheet }
}

function hasCellValue(value: CellValue): boolean {
  return value !== '' && value !== null && value !== undefined
}

function cellKey(row: number, column: number): string {
  return `${row}:${column}`
}
