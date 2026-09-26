var JOURNAL_HEADERS = [
  '日期',
  '時間',
  '類型',
  '借方帳戶',
  '貸方帳戶',
  '金額',
  '幣別',
  '分類',
  '交易對象',
  '說明',
  '結清狀態',
  '沖銷txn_id',
  'txn_id',
  '來源',
  '建立時間',
];

var LIST_TRANSACTION_HEADERS = [
  'txn_id',
  '日期',
  '時間',
  '類型',
  '借方帳戶',
  '貸方帳戶',
  '金額',
  '幣別',
  '分類',
  '交易對象',
  '說明',
  '結清狀態',
];

var MAX_LIST_TRANSACTIONS = 200;
var NONCE_CACHE_SECONDS = 600;
var LOCK_WAIT_MILLISECONDS = 30000;
var BALANCE_FORMULA_SCHEMA_PROPERTY = 'BALANCE_FORMULA_SCHEMA_VERSION';
var SCHEMA_SHEET_NAMES = ['會計科目', '選項清單', '設定'];
var SPREADSHEET_ID_TAIL_LENGTH = 8;
var BACKUP_FOLDER_PROPERTY = 'LEDGER_BACKUP_FOLDER_ID';
var BACKUP_FOLDER_NAME = 'Solo Ledger backups';
var BACKUP_RETENTION_COUNT = 12;

function route_(payload, nonce) {
  var action = payload && payload.action;

  if (action === 'health') {
    return health_();
  }
  if (action === 'get_options') {
    return getOptions_();
  }
  if (action === 'list_transactions') {
    return listTransactions_(payload);
  }
  if (action === 'list_receivables') {
    return listReceivables_();
  }
  if (action === 'check_consistency') {
    return checkConsistency_(payload);
  }
  if (action === 'create_transaction') {
    return createTransaction_(payload, nonce);
  }
  if (action === 'settle') {
    return settle_(payload, nonce);
  }
  if (action === 'reverse_transaction') {
    return reverseTransaction_(payload, nonce);
  }

  throw new Error('unsupported action: ' + action);
}

function health_() {
  var spreadsheetId = requiredProp_('LEDGER_SPREADSHEET_ID');
  var spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  var schemaVersion = schemaVersion_(spreadsheet);
  ensureBalanceFormulas_(spreadsheet, schemaVersion);
  var tailLength = Math.min(
    SPREADSHEET_ID_TAIL_LENGTH,
    Math.max(1, spreadsheetId.length - 1),
  );

  return {
    ok: true,
    now: new Date().toISOString(),
    schema_version: schemaVersion,
    spreadsheet_id_tail: spreadsheetId.slice(-tailLength),
  };
}

function schemaVersion_(spreadsheet) {
  var tables = [];

  for (var index = 0; index < SCHEMA_SHEET_NAMES.length; index += 1) {
    var sheetName = SCHEMA_SHEET_NAMES[index];
    var sheet = spreadsheet.getSheetByName(sheetName);
    if (!sheet) {
      throw new Error('missing sheet: ' + sheetName);
    }

    var lastRow = sheet.getLastRow();
    var lastColumn = sheet.getLastColumn();
    tables.push(
      lastRow === 0 || lastColumn === 0
        ? []
        : sheet.getRange(1, 1, lastRow, lastColumn).getDisplayValues(),
    );
  }

  var digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    JSON.stringify(tables),
  );
  return digestHex_(digest).slice(0, 12);
}

function digestHex_(bytes) {
  var hex = '';
  for (var index = 0; index < bytes.length; index += 1) {
    var unsignedByte = (bytes[index] + 256) % 256;
    hex += ('0' + unsignedByte.toString(16)).slice(-2);
  }
  return hex;
}

function getOptions_() {
  var spreadsheet = SpreadsheetApp.openById(
    requiredProp_('LEDGER_SPREADSHEET_ID'),
  );
  var schemaVersion = schemaVersion_(spreadsheet);
  ensureBalanceFormulas_(spreadsheet, schemaVersion);
  var accountSheet = requiredSheet_(spreadsheet, '會計科目');
  var accountValues = accountSheet
    .getRange(
      1,
      1,
      accountSheet.getLastRow(),
      accountSheet.getLastColumn(),
    )
    .getValues();
  var accountColumns = resolveHeaders_(accountValues[0], [
    '名稱',
    '類型',
    '子類型',
    '啟用',
    '排序',
  ]);
  var accounts = [];
  var expenseCategories = [];
  var incomeCategories = [];

  for (var rowIndex = 1; rowIndex < accountValues.length; rowIndex += 1) {
    var row = accountValues[rowIndex];
    var name = String(row[accountColumns['名稱'] - 1] || '').trim();
    var type = String(row[accountColumns['類型'] - 1] || '').trim();
    if (!name || !isTrue_(row[accountColumns['啟用'] - 1])) {
      continue;
    }

    var option = {
      name: name,
      type: type,
      subtype: String(row[accountColumns['子類型'] - 1] || '').trim(),
      sort: Number(row[accountColumns['排序'] - 1]),
    };
    if (type === '資產' || type === '負債') {
      accounts.push(option);
    } else if (type === '支出') {
      expenseCategories.push(option);
    } else if (type === '收入') {
      incomeCategories.push(option);
    }
  }

  accounts.sort(compareVocabularyOptions_);
  expenseCategories.sort(compareVocabularyOptions_);
  incomeCategories.sort(compareVocabularyOptions_);

  var optionsSheet = requiredSheet_(spreadsheet, '選項清單');
  var optionValues = optionsSheet
    .getRange(
      1,
      1,
      optionsSheet.getLastRow(),
      optionsSheet.getLastColumn(),
    )
    .getDisplayValues();
  var optionColumns = resolveHeaders_(optionValues[0], ['交易對象']);
  var payees = [];
  for (rowIndex = 1; rowIndex < optionValues.length; rowIndex += 1) {
    var payee = String(optionValues[rowIndex][optionColumns['交易對象'] - 1] || '')
      .trim();
    if (payee) {
      payees.push(payee);
    }
  }

  return {
    schema_version: schemaVersion,
    accounts: accounts,
    categories: {
      支出: vocabularyOptionNames_(expenseCategories),
      收入: vocabularyOptionNames_(incomeCategories),
    },
    payees: payees,
    defaults: {
      currency: readSetting_(spreadsheet, '預設幣別'),
      account: readSetting_(spreadsheet, '預設帳戶'),
    },
  };
}

function compareVocabularyOptions_(left, right) {
  if (left.sort !== right.sort) {
    return left.sort - right.sort;
  }
  if (left.name < right.name) {
    return -1;
  }
  if (left.name > right.name) {
    return 1;
  }
  return 0;
}

function vocabularyOptionNames_(options) {
  var names = [];
  for (var index = 0; index < options.length; index += 1) {
    names.push(options[index].name);
  }
  return names;
}

function listTransactions_(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('payload is required');
  }
  requireField_(payload, 'date_from');
  requireField_(payload, 'date_to');

  var spreadsheet = SpreadsheetApp.openById(
    requiredProp_('LEDGER_SPREADSHEET_ID'),
  );
  var journal = requiredSheet_(spreadsheet, '日記帳');
  var lastColumn = journal.getLastColumn();
  var headerRow = journal
    .getRange(1, 1, 1, lastColumn)
    .getDisplayValues()[0];
  var columns = resolveHeaders_(headerRow, LIST_TRANSACTION_HEADERS);
  var lastRow = journal.getLastRow();
  if (lastRow < 2) {
    return [];
  }

  var displayRows = journal
    .getRange(2, 1, lastRow - 1, lastColumn)
    .getDisplayValues();
  var matches = [];

  for (var rowIndex = 0; rowIndex < displayRows.length; rowIndex += 1) {
    var displayRow = displayRows[rowIndex];
    var date = displayRow[columns['日期'] - 1];
    if (date < payload.date_from || date > payload.date_to) {
      continue;
    }

    var transaction = {};
    for (
      var headerIndex = 0;
      headerIndex < LIST_TRANSACTION_HEADERS.length;
      headerIndex += 1
    ) {
      var header = LIST_TRANSACTION_HEADERS[headerIndex];
      transaction[header] = displayRow[columns[header] - 1];
    }
    matches.push({ transaction: transaction, sheetRow: rowIndex + 2 });
  }

  matches.sort(function (left, right) {
    var leftDate = left.transaction['日期'];
    var rightDate = right.transaction['日期'];
    if (leftDate !== rightDate) {
      return leftDate < rightDate ? 1 : -1;
    }

    var leftTime = left.transaction['時間'];
    var rightTime = right.transaction['時間'];
    if (leftTime === '' && rightTime !== '') {
      return 1;
    }
    if (leftTime !== '' && rightTime === '') {
      return -1;
    }
    if (leftTime !== rightTime) {
      return leftTime < rightTime ? 1 : -1;
    }

    return right.sheetRow - left.sheetRow;
  });

  var result = [];
  var resultCount = Math.min(matches.length, MAX_LIST_TRANSACTIONS);
  for (var resultIndex = 0; resultIndex < resultCount; resultIndex += 1) {
    result.push(matches[resultIndex].transaction);
  }
  return result;
}

function listReceivables_() {
  var spreadsheet = SpreadsheetApp.openById(
    requiredProp_('LEDGER_SPREADSHEET_ID'),
  );
  var journal = requiredSheet_(spreadsheet, '日記帳');
  var headerRow = journal
    .getRange(1, 1, 1, journal.getLastColumn())
    .getDisplayValues()[0];
  var journalColumns = resolveHeaders_(headerRow, JOURNAL_HEADERS);
  var records = readJournalRecords_(journal, journalColumns);
  var groupsByCounterparty = Object.create(null);
  var groups = [];

  for (var index = 0; index < records.length; index += 1) {
    var record = records[index];
    var status = record.values['結清狀態'];
    if (status !== '未結' && status !== '部分') {
      continue;
    }

    var counterparty = record.values['交易對象'];
    var group = groupsByCounterparty[counterparty];
    if (!group) {
      group = { '交易對象': counterparty, entries: [] };
      groupsByCounterparty[counterparty] = group;
      groups.push(group);
    }

    var txnId = record.values.txn_id;
    var viewOnly = txnId === '';
    group.entries.push({
      txn_id: txnId,
      '日期': record.values['日期'],
      '金額': record.amount,
      '幣別': record.values['幣別'],
      '交易對象': counterparty,
      '說明': record.values['說明'],
      '結清狀態': status,
      direction: receivableDirection_(record.values),
      outstanding: viewOnly
        ? record.amount
        : outstandingForRecord_(records, record),
      view_only: viewOnly,
    });
  }

  return groups;
}

function readJournalRecords_(journal, journalColumns) {
  var lastRow = journal.getLastRow();
  if (lastRow < 2) {
    return [];
  }

  var lastColumn = journal.getLastColumn();
  var rowCount = lastRow - 1;
  var range = journal.getRange(2, 1, rowCount, lastColumn);
  var rawRows = range.getValues();
  var displayRows = range.getDisplayValues();
  var records = [];

  for (var rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    var values = {};
    for (var headerIndex = 0; headerIndex < JOURNAL_HEADERS.length; headerIndex += 1) {
      var header = JOURNAL_HEADERS[headerIndex];
      values[header] = displayRows[rowIndex][journalColumns[header] - 1];
    }
    records.push({
      sheetRow: rowIndex + 2,
      values: values,
      amount: journalAmount_(
        rawRows[rowIndex][journalColumns['金額'] - 1],
        rowIndex + 2,
      ),
    });
  }

  return records;
}

function journalAmount_(value, sheetRow) {
  var amount = Number(value);
  if (!isFinite(amount)) {
    throw new Error('invalid journal amount at row ' + sheetRow);
  }
  return amount;
}

function outstandingForRecord_(records, originalRecord) {
  var txnId = originalRecord.values.txn_id;
  if (!txnId) {
    return originalRecord.amount;
  }

  var settled = 0;
  for (var index = 0; index < records.length; index += 1) {
    var candidate = records[index];
    if (
      candidate.values['類型'] === '轉帳' &&
      candidate.values['沖銷txn_id'] === txnId
    ) {
      settled += candidate.amount;
    }
  }
  return normalizedAmount_(originalRecord.amount - settled);
}

function normalizedAmount_(amount) {
  return Math.round(amount * 1000000000) / 1000000000;
}

function receivableDirection_(row) {
  if (row['借方帳戶'] === '應收帳款') {
    return '應收';
  }
  if (row['貸方帳戶'] === '應付帳款') {
    return '應付';
  }
  throw new Error('open row is not an 應收帳款 or 應付帳款 posting');
}

function findRecordByTxnId_(records, txnId) {
  for (var index = 0; index < records.length; index += 1) {
    if (records[index].values.txn_id === txnId) {
      return records[index];
    }
  }
  return null;
}

function checkConsistency_(payload) {
  var repair = Boolean(payload && payload.repair === true);
  if (!repair) {
    return runConsistencyAudit_(false);
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_WAIT_MILLISECONDS);
  try {
    return runConsistencyAudit_(true);
  } finally {
    lock.releaseLock();
  }
}

function runConsistencyAudit_(repair) {
  var spreadsheet = SpreadsheetApp.openById(
    requiredProp_('LEDGER_SPREADSHEET_ID'),
  );
  var journal = requiredSheet_(spreadsheet, '日記帳');
  var lastRow = journal.getLastRow();
  var lastColumn = journal.getLastColumn();
  var headerRow = journal
    .getRange(1, 1, 1, lastColumn)
    .getDisplayValues()[0];
  var columns = resolveHeaders_(headerRow, JOURNAL_HEADERS);
  var vocabulary = readAccountVocabulary_(spreadsheet);
  var rules = consistencyRuleLists_();
  var repairedRows = [];

  if (lastRow < 2) {
    return consistencyReport_(rules, repairedRows, repair);
  }

  var range = journal.getRange(2, 1, lastRow - 1, lastColumn);
  var rawRows = range.getValues();
  var displayRows = range.getDisplayValues();
  var records = [];
  var dataLastRow = 1;
  var rowIndex;

  for (rowIndex = 0; rowIndex < rawRows.length; rowIndex += 1) {
    if (!journalRowHasData_(rawRows[rowIndex], columns)) {
      break;
    }
    dataLastRow = rowIndex + 2;
  }

  for (rowIndex = 0; rowIndex < dataLastRow - 1; rowIndex += 1) {
    if (!journalRowHasData_(rawRows[rowIndex], columns)) {
      continue;
    }
    records.push(
      consistencyRecord_(
        rawRows[rowIndex],
        displayRows[rowIndex],
        columns,
        rowIndex + 2,
      ),
    );
  }

  var recordsByTxnId = Object.create(null);
  for (rowIndex = 0; rowIndex < records.length; rowIndex += 1) {
    var recordTxnId = records[rowIndex].values.txn_id;
    if (
      recordTxnId &&
      !Object.prototype.hasOwnProperty.call(recordsByTxnId, recordTxnId)
    ) {
      recordsByTxnId[recordTxnId] = records[rowIndex];
    }
  }

  for (rowIndex = 0; rowIndex < records.length; rowIndex += 1) {
    var record = records[rowIndex];
    auditJournalAccounts_(record, vocabulary, rules);
    auditJournalCategory_(record, vocabulary, rules);
    auditJournalAmount_(record, rules);
    auditJournalDateTime_(record, rules);
    auditReversalLink_(record, rules);
    auditLinkedCurrency_(record, recordsByTxnId, rules);

    var status = record.values['結清狀態'];
    if (status !== '') {
      var derived = derivedStatusForAudit_(records, record);
      if (derived && status !== derived.status) {
        var statusFinding = {
          row: record.sheetRow,
          field: '結清狀態',
          value: status,
          expected: derived.status,
          outstanding: derived.outstanding,
        };
        rules.settlement_status_mismatch.push(statusFinding);
        var staleStatusFinding = {
          row: record.sheetRow,
          field: '結清狀態',
          value: status,
          expected: derived.status,
          outstanding: derived.outstanding,
          repairable: true,
          repaired: false,
        };
        rules.stale_status_cells.push(staleStatusFinding);
        if (repair) {
          journal
            .getRange(record.sheetRow, columns['結清狀態'])
            .setValues([[derived.status]]);
          staleStatusFinding.repaired = true;
          repairedRows.push(record.sheetRow);
        }
      }
    }
  }

  auditStrayJournalCells_(
    rawRows,
    displayRows,
    dataLastRow,
    lastColumn,
    headerRow,
    rules,
  );
  return consistencyReport_(rules, repairedRows, repair);
}

function consistencyRuleLists_() {
  return {
    unknown_or_disabled_accounts: [],
    category_nominal_leg_mismatch: [],
    settlement_status_mismatch: [],
    stale_status_cells: [],
    non_positive_amounts: [],
    non_text_date_time_cells: [],
    stray_cells_below_data_range: [],
    reversals_missing_link: [],
    linked_currency_mismatch: [],
  };
}

function consistencyReport_(rules, repairedRows, repair) {
  var clean = true;
  var ruleReports = {};
  for (var ruleName in rules) {
    if (!Object.prototype.hasOwnProperty.call(rules, ruleName)) {
      continue;
    }
    var ruleClean = rules[ruleName].length === 0;
    ruleReports[ruleName] = {
      clean: ruleClean,
      offenses: rules[ruleName],
    };
    if (!ruleClean) {
      clean = false;
    }
  }
  return {
    ok: true,
    clean: clean,
    repair_requested: repair === true,
    repaired: repairedRows.length,
    repaired_rows: repairedRows,
    rules: ruleReports,
  };
}

function journalRowHasData_(rawRow, columns) {
  for (var index = 0; index < JOURNAL_HEADERS.length; index += 1) {
    if (hasAuditValue_(rawRow[columns[JOURNAL_HEADERS[index]] - 1])) {
      return true;
    }
  }
  return false;
}

function hasAuditValue_(value) {
  return value !== '' && value !== null && value !== undefined;
}

function consistencyRecord_(rawRow, displayRow, columns, sheetRow) {
  var values = {};
  for (var index = 0; index < JOURNAL_HEADERS.length; index += 1) {
    var header = JOURNAL_HEADERS[index];
    values[header] = displayRow[columns[header] - 1];
  }
  var rawAmount = rawRow[columns['金額'] - 1];
  var amount = Number(rawAmount);
  return {
    sheetRow: sheetRow,
    values: values,
    rawRow: rawRow,
    rawAmount: rawAmount,
    amount: amount,
    amountValid: hasAuditValue_(rawAmount) && isFinite(amount),
    columns: columns,
  };
}

function auditJournalAccounts_(record, vocabulary, rules) {
  var fields = ['借方帳戶', '貸方帳戶'];
  for (var index = 0; index < fields.length; index += 1) {
    var field = fields[index];
    var account = record.values[field];
    if (!account) {
      continue;
    }
    if (
      !Object.prototype.hasOwnProperty.call(
        vocabulary.accountTypes,
        account,
      )
    ) {
      rules.unknown_or_disabled_accounts.push({
        row: record.sheetRow,
        field: field,
        value: account,
        reason: 'unknown',
      });
    } else if (vocabulary.enabled[account] !== true) {
      rules.unknown_or_disabled_accounts.push({
        row: record.sheetRow,
        field: field,
        value: account,
        reason: 'disabled',
      });
    }
  }
}

function auditJournalCategory_(record, vocabulary, rules) {
  var nominalLeg = nominalLeg_(
    record.values['借方帳戶'],
    record.values['貸方帳戶'],
    vocabulary.accountTypes,
  );
  if (!nominalLeg || record.values['分類'] === nominalLeg) {
    return;
  }
  rules.category_nominal_leg_mismatch.push({
    row: record.sheetRow,
    field: '分類',
    value: record.values['分類'],
    expected: nominalLeg,
    nominal_leg: nominalLeg,
  });
}

function auditJournalAmount_(record, rules) {
  if (record.amountValid && record.amount > 0) {
    return;
  }
  rules.non_positive_amounts.push({
    row: record.sheetRow,
    field: '金額',
    value: consistencyValue_(record.rawAmount),
  });
}

function auditJournalDateTime_(record, rules) {
  var fields = ['日期', '時間'];
  for (var index = 0; index < fields.length; index += 1) {
    var field = fields[index];
    var rawValue = record.rawRow[record.columns[field] - 1];
    if (!hasAuditValue_(rawValue) || typeof rawValue === 'string') {
      continue;
    }
    rules.non_text_date_time_cells.push({
      row: record.sheetRow,
      field: field,
      value: consistencyValue_(rawValue),
    });
  }
}

function consistencyValue_(value) {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value;
}

function auditReversalLink_(record, rules) {
  if (
    record.values['類型'] === '沖銷' &&
    record.values['沖銷txn_id'] === ''
  ) {
    rules.reversals_missing_link.push({
      row: record.sheetRow,
      field: '沖銷txn_id',
      value: '',
    });
  }
}

function auditLinkedCurrency_(record, recordsByTxnId, rules) {
  var type = record.values['類型'];
  var linkedTxnId = record.values['沖銷txn_id'];
  if (
    !linkedTxnId ||
    (type !== '轉帳' && type !== '沖銷') ||
    !Object.prototype.hasOwnProperty.call(recordsByTxnId, linkedTxnId)
  ) {
    return;
  }

  var original = recordsByTxnId[linkedTxnId];
  var currency = record.values['幣別'];
  var originalCurrency = original.values['幣別'];
  if (currency === originalCurrency) {
    return;
  }
  rules.linked_currency_mismatch.push({
    row: record.sheetRow,
    field: '幣別',
    value: currency,
    expected: originalCurrency,
    linked_txn_id: linkedTxnId,
    linked_row: original.sheetRow,
  });
}

function derivedStatusForAudit_(records, original) {
  if (!original.amountValid) {
    return null;
  }
  var txnId = original.values.txn_id;

  if (txnId) {
    for (var index = 0; index < records.length; index += 1) {
      var candidate = records[index];
      if (
        candidate.values['沖銷txn_id'] === txnId &&
        candidate.values['類型'] === '沖銷'
      ) {
        return { status: '已沖銷', outstanding: 0 };
      }
      if (
        candidate.values['沖銷txn_id'] === txnId &&
        candidate.values['類型'] === '轉帳'
      ) {
        if (!candidate.amountValid) {
          return null;
        }
      }
    }
  }

  var outstanding = outstandingForRecord_(records, original);
  var status =
    outstanding === 0
      ? '已結'
      : outstanding < original.amount
        ? '部分'
        : '未結';
  return { status: status, outstanding: outstanding };
}

function auditStrayJournalCells_(
  rawRows,
  displayRows,
  dataLastRow,
  lastColumn,
  headerRow,
  rules,
) {
  var firstStrayIndex = Math.max(0, dataLastRow - 1);
  for (
    var rowIndex = firstStrayIndex;
    rowIndex < rawRows.length;
    rowIndex += 1
  ) {
    for (var columnIndex = 0; columnIndex < lastColumn; columnIndex += 1) {
      var rawValue = rawRows[rowIndex][columnIndex];
      if (!hasAuditValue_(rawValue)) {
        continue;
      }
      rules.stray_cells_below_data_range.push({
        row: rowIndex + 2,
        column: columnIndex + 1,
        field: headerRow[columnIndex],
        value:
          typeof rawValue === 'string'
            ? displayRows[rowIndex][columnIndex]
            : consistencyValue_(rawValue),
      });
    }
  }
}

function createTransaction_(payload, nonce) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('payload is required');
  }
  requireField_(payload, 'idempotencyKey');
  requireField_(payload, 'transaction');

  var idempotencyKey = String(payload.idempotencyKey);
  if (idempotencyKey !== nonce) {
    throw new Error('idempotencyKey must match nonce');
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_WAIT_MILLISECONDS);

  try {
    var cache = CacheService.getScriptCache();
    var nonceKey = 'nonce:' + nonce;
    var storedResult = cache.get(nonceKey);
    if (storedResult) {
      return withAlready_(JSON.parse(storedResult));
    }

    var spreadsheet = SpreadsheetApp.openById(
      requiredProp_('LEDGER_SPREADSHEET_ID'),
    );
    var journal = requiredSheet_(spreadsheet, '日記帳');
    var headerRow = journal
      .getRange(1, 1, 1, journal.getLastColumn())
      .getDisplayValues()[0];
    var journalColumns = resolveHeaders_(headerRow, JOURNAL_HEADERS);
    var vocabulary = readAccountVocabulary_(spreadsheet);
    var transaction = payload.transaction;

    validateIouTransactionFields_(transaction);
    validateTransactionVocabulary_(transaction, vocabulary);

    var existingRow = findTxnRow_(
      journal,
      journalColumns.txn_id,
      idempotencyKey,
    );
    if (existingRow !== null) {
      var existingResult = {
        ok: true,
        txn_id: idempotencyKey,
        row: existingRow,
        already: true,
      };
      cache.put(
        nonceKey,
        JSON.stringify(existingResult),
        NONCE_CACHE_SECONDS,
      );
      return existingResult;
    }

    var defaultCurrency = readSetting_(spreadsheet, '預設幣別');
    var postingInput = {
      kind: 'create',
      type: transaction.type,
      date: transaction.date,
      time: blank_(transaction.time),
      amount: transaction.amount,
      currency: blank_(transaction.currency) || defaultCurrency,
      account: transaction.account,
      toAccount: transaction.toAccount,
      category: transaction.category,
      payee: transaction.payee,
      description: transaction.description,
      accountTypes: vocabulary.accountTypes,
      txnId: idempotencyKey,
      now: taipeiIsoNow_(),
    };
    if (hasField_(transaction, 'iou')) {
      postingInput.iou = transaction.iou;
    }
    var posting = expandPosting_(postingInput);

    validatePostingVocabulary_(posting, vocabulary);
    var rowNumber = appendPosting_(journal, journalColumns, posting);
    var result = {
      ok: true,
      txn_id: idempotencyKey,
      row: rowNumber,
    };
    cache.put(nonceKey, JSON.stringify(result), NONCE_CACHE_SECONDS);
    return result;
  } finally {
    lock.releaseLock();
  }
}

function settle_(payload, nonce) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('payload is required');
  }
  requireField_(payload, 'idempotencyKey');
  requireField_(payload, 'txn_id');
  requireField_(payload, 'account');
  requireField_(payload, 'date');

  var idempotencyKey = String(payload.idempotencyKey);
  if (idempotencyKey !== nonce) {
    throw new Error('idempotencyKey must match nonce');
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_WAIT_MILLISECONDS);

  try {
    var cache = CacheService.getScriptCache();
    var nonceKey = 'nonce:' + nonce;
    var storedResult = cache.get(nonceKey);
    if (storedResult) {
      return withAlready_(JSON.parse(storedResult));
    }

    var spreadsheet = SpreadsheetApp.openById(
      requiredProp_('LEDGER_SPREADSHEET_ID'),
    );
    var journal = requiredSheet_(spreadsheet, '日記帳');
    var headerRow = journal
      .getRange(1, 1, 1, journal.getLastColumn())
      .getDisplayValues()[0];
    var journalColumns = resolveHeaders_(headerRow, JOURNAL_HEADERS);

    if (
      findTxnRow_(journal, journalColumns.txn_id, idempotencyKey) !== null
    ) {
      var existingResult = { ok: true, already: true };
      cache.put(
        nonceKey,
        JSON.stringify(existingResult),
        NONCE_CACHE_SECONDS,
      );
      return existingResult;
    }

    var records = readJournalRecords_(journal, journalColumns);
    var original = findRecordByTxnId_(records, String(payload.txn_id));
    if (original === null) {
      throw new Error('unknown txn_id: ' + payload.txn_id);
    }

    var outstanding = outstandingForRecord_(records, original);
    if (outstanding <= 0) {
      var alreadySettledResult = { ok: true, already: true };
      cache.put(
        nonceKey,
        JSON.stringify(alreadySettledResult),
        NONCE_CACHE_SECONDS,
      );
      return alreadySettledResult;
    }

    rejectField_(payload, 'currency');
    var vocabulary = readAccountVocabulary_(spreadsheet);
    validateSettlementAccount_(payload.account, vocabulary);

    var defaultCurrency = readSetting_(spreadsheet, '預設幣別');
    if (original.values['幣別'] !== defaultCurrency) {
      throw new Error(
        'original currency ' +
          original.values['幣別'] +
          ' differs from default ' +
          defaultCurrency,
      );
    }

    var amount = hasField_(payload, 'amount')
      ? payload.amount
      : outstanding;
    validatePositiveAmount_(amount);
    if (amount > outstanding) {
      throw new Error(
        'over-settlement: amount ' +
          amount +
          ' exceeds outstanding ' +
          outstanding,
      );
    }

    var posting = expandPosting_({
      kind: 'settle',
      original: original.values,
      account: payload.account,
      amount: amount,
      date: payload.date,
      defaultCurrency: defaultCurrency,
      accountTypes: vocabulary.accountTypes,
      txnId: idempotencyKey,
      now: taipeiIsoNow_(),
    });

    var rowNumber = appendPosting_(journal, journalColumns, posting);
    var remaining = normalizedAmount_(outstanding - amount);
    var status = remaining === 0 ? '已結' : '部分';
    journal
      .getRange(original.sheetRow, journalColumns['結清狀態'])
      .setValues([[status]]);

    var result = {
      ok: true,
      txn_id: idempotencyKey,
      row: rowNumber,
      outstanding: remaining,
      status: status,
    };
    cache.put(nonceKey, JSON.stringify(result), NONCE_CACHE_SECONDS);
    return result;
  } finally {
    lock.releaseLock();
  }
}

function reverseTransaction_(payload, nonce) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('payload is required');
  }
  requireField_(payload, 'idempotencyKey');
  requireField_(payload, 'txn_id');
  requireField_(payload, 'date');

  var idempotencyKey = String(payload.idempotencyKey);
  if (idempotencyKey !== nonce) {
    throw new Error('idempotencyKey must match nonce');
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_WAIT_MILLISECONDS);

  try {
    var cache = CacheService.getScriptCache();
    var nonceKey = 'nonce:' + nonce;
    var storedResult = cache.get(nonceKey);
    if (storedResult) {
      return withAlready_(JSON.parse(storedResult));
    }

    var spreadsheet = SpreadsheetApp.openById(
      requiredProp_('LEDGER_SPREADSHEET_ID'),
    );
    var journal = requiredSheet_(spreadsheet, '日記帳');
    var headerRow = journal
      .getRange(1, 1, 1, journal.getLastColumn())
      .getDisplayValues()[0];
    var journalColumns = resolveHeaders_(headerRow, JOURNAL_HEADERS);
    var records = readJournalRecords_(journal, journalColumns);
    var targetTxnId = String(payload.txn_id);
    var index;

    for (index = 0; index < records.length; index += 1) {
      if (
        records[index].values['類型'] === '沖銷' &&
        records[index].values['沖銷txn_id'] === targetTxnId
      ) {
        var existingResult = { ok: true, already: true };
        cache.put(
          nonceKey,
          JSON.stringify(existingResult),
          NONCE_CACHE_SECONDS,
        );
        return existingResult;
      }
    }

    var original = findRecordByTxnId_(records, targetTxnId);
    if (original === null) {
      throw new Error('unknown txn_id: ' + payload.txn_id);
    }

    var originalType = original.values['類型'];
    var linkedTxnId = original.values['沖銷txn_id'];
    if (originalType === '沖銷') {
      throw new Error('cannot reverse reversal row: ' + targetTxnId);
    }
    if (originalType === '轉帳' && linkedTxnId !== '') {
      throw new Error('cannot reverse settlement row: ' + targetTxnId);
    }
    if (
      originalType !== '支出' &&
      originalType !== '收入' &&
      originalType !== '轉帳'
    ) {
      throw new Error('cannot reverse non-ordinary row: ' + targetTxnId);
    }

    for (index = 0; index < records.length; index += 1) {
      if (
        records[index].values['類型'] === '轉帳' &&
        records[index].values['沖銷txn_id'] === targetTxnId
      ) {
        throw new Error(
          'cannot reverse transaction with settlements: ' + targetTxnId,
        );
      }
    }

    rejectField_(payload, 'currency');
    var vocabulary = readAccountVocabulary_(spreadsheet);
    var defaultCurrency = readSetting_(spreadsheet, '預設幣別');
    var originalPosting = {};
    for (var field in original.values) {
      if (Object.prototype.hasOwnProperty.call(original.values, field)) {
        originalPosting[field] = original.values[field];
      }
    }
    originalPosting['金額'] = original.amount;
    var posting = expandPosting_({
      kind: 'reverse',
      original: originalPosting,
      date: payload.date,
      defaultCurrency: defaultCurrency,
      accountTypes: vocabulary.accountTypes,
      txnId: idempotencyKey,
      now: taipeiIsoNow_(),
    });

    var rowNumber = appendPosting_(journal, journalColumns, posting);
    var originalStatus = original.values['結清狀態'];
    if (originalStatus === '未結' || originalStatus === '部分') {
      journal
        .getRange(original.sheetRow, journalColumns['結清狀態'])
        .setValues([['已沖銷']]);
    }

    var result = {
      ok: true,
      txn_id: idempotencyKey,
      row: rowNumber,
    };
    cache.put(nonceKey, JSON.stringify(result), NONCE_CACHE_SECONDS);
    return result;
  } finally {
    lock.releaseLock();
  }
}

function validateSettlementAccount_(value, vocabulary) {
  var name = String(value);
  var knownAndEnabled =
    Object.prototype.hasOwnProperty.call(vocabulary.accountTypes, name) &&
    vocabulary.enabled[name] === true;
  var accountType = vocabulary.accountTypes[name];
  var realAccount = accountType === '資產' || accountType === '負債';

  if (!knownAndEnabled || !realAccount) {
    throw new Error('unknown or disabled account: ' + name);
  }
}

function readAccountVocabulary_(spreadsheet) {
  var sheet = requiredSheet_(spreadsheet, '會計科目');
  var lastRow = sheet.getLastRow();
  var lastColumn = sheet.getLastColumn();
  var values = sheet.getRange(1, 1, lastRow, lastColumn).getValues();
  var columns = resolveHeaders_(values[0], ['名稱', '類型', '啟用']);
  var accountTypes = Object.create(null);
  var enabled = Object.create(null);

  for (var rowIndex = 1; rowIndex < values.length; rowIndex += 1) {
    var row = values[rowIndex];
    var name = String(row[columns['名稱'] - 1] || '').trim();
    if (!name) {
      continue;
    }
    accountTypes[name] = String(row[columns['類型'] - 1] || '').trim();
    enabled[name] = isTrue_(row[columns['啟用'] - 1]);
  }

  return { accountTypes: accountTypes, enabled: enabled };
}

function validateIouTransactionFields_(transaction) {
  if (!transaction || typeof transaction !== 'object') {
    return;
  }
  if (transaction.iou !== '應收' && transaction.iou !== '應付') {
    return;
  }

  requireField_(transaction, 'payee');
  if (transaction.iou === '應收') {
    rejectField_(transaction, 'category');
  }
}

function validateTransactionVocabulary_(transaction, vocabulary) {
  if (!transaction || typeof transaction !== 'object') {
    throw new Error('transaction is required');
  }

  validateOptionalVocabulary_(
    transaction.account,
    'account',
    vocabulary,
    null,
  );
  validateOptionalVocabulary_(
    transaction.toAccount,
    'account',
    vocabulary,
    null,
  );

  var categoryType = null;
  if (transaction.type === '支出') {
    categoryType = '支出';
  } else if (transaction.type === '收入') {
    categoryType = '收入';
  }
  validateOptionalVocabulary_(
    transaction.category,
    'category',
    vocabulary,
    categoryType,
  );
}

function validateOptionalVocabulary_(value, label, vocabulary, requiredType) {
  if (value === undefined || value === null || value === '') {
    return;
  }

  var name = String(value);
  var knownAndEnabled =
    Object.prototype.hasOwnProperty.call(vocabulary.accountTypes, name) &&
    vocabulary.enabled[name] === true;
  var hasRequiredType =
    requiredType === null || vocabulary.accountTypes[name] === requiredType;

  if (!knownAndEnabled || !hasRequiredType) {
    throw new Error('unknown or disabled ' + label + ': ' + name);
  }
}

function validatePostingVocabulary_(posting, vocabulary) {
  validateOptionalVocabulary_(
    posting['借方帳戶'],
    'account',
    vocabulary,
    null,
  );
  validateOptionalVocabulary_(
    posting['貸方帳戶'],
    'account',
    vocabulary,
    null,
  );
}

function findTxnRow_(journal, txnColumn, idempotencyKey) {
  var lastRow = journal.getLastRow();
  if (lastRow < 2) {
    return null;
  }

  var values = journal
    .getRange(2, txnColumn, lastRow - 1, 1)
    .getDisplayValues();
  for (var index = 0; index < values.length; index += 1) {
    if (String(values[index][0]) === idempotencyKey) {
      return index + 2;
    }
  }
  return null;
}

function appendPosting_(journal, journalColumns, posting) {
  var rowNumber = journal.getLastRow() + 1;
  var columnCount = journal.getLastColumn();
  var values = [];
  var index;

  for (index = 0; index < columnCount; index += 1) {
    values.push('');
  }
  for (index = 0; index < JOURNAL_HEADERS.length; index += 1) {
    var header = JOURNAL_HEADERS[index];
    values[journalColumns[header] - 1] = posting[header];
  }

  journal.getRange(rowNumber, 1, 1, columnCount).setValues([values]);
  return rowNumber;
}

function readSetting_(spreadsheet, key) {
  var sheet = requiredSheet_(spreadsheet, '設定');
  var lastRow = sheet.getLastRow();
  var lastColumn = sheet.getLastColumn();
  var values = sheet.getRange(1, 1, lastRow, lastColumn).getDisplayValues();
  var columns = resolveHeaders_(values[0], ['設定項目', '值']);

  for (var rowIndex = 1; rowIndex < values.length; rowIndex += 1) {
    if (String(values[rowIndex][columns['設定項目'] - 1]) === key) {
      var value = String(values[rowIndex][columns['值'] - 1] || '');
      if (!value) {
        break;
      }
      return value;
    }
  }
  throw new Error('missing setting: ' + key);
}

function requiredSheet_(spreadsheet, name) {
  var sheet = spreadsheet.getSheetByName(name);
  if (!sheet) {
    throw new Error('missing sheet: ' + name);
  }
  return sheet;
}

function isTrue_(value) {
  return value === true || String(value).toUpperCase() === 'TRUE';
}

function withAlready_(result) {
  var replay = {};
  for (var key in result) {
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      replay[key] = result[key];
    }
  }
  replay.already = true;
  return replay;
}

function taipeiIsoNow_() {
  var offsetMilliseconds = 8 * 60 * 60 * 1000;
  return new Date(Date.now() + offsetMilliseconds)
    .toISOString()
    .replace('Z', '+08:00');
}

function resolveHeaders_(headerRow, requiredHeaders) {
  var required = Object.create(null);
  var positions = Object.create(null);
  var duplicates = [];
  var missing = [];
  var resolved = {};
  var index;

  for (index = 0; index < requiredHeaders.length; index += 1) {
    required[requiredHeaders[index]] = true;
  }

  for (index = 0; index < headerRow.length; index += 1) {
    var value = headerRow[index];
    var header = value === null || value === undefined ? '' : String(value).trim();
    if (!Object.prototype.hasOwnProperty.call(required, header)) {
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(positions, header)) {
      if (duplicates.indexOf(header) === -1) {
        duplicates.push(header);
      }
    } else {
      positions[header] = index + 1;
    }
  }

  if (duplicates.length > 0) {
    throw new Error('duplicate required header: ' + duplicates.join(', '));
  }

  for (index = 0; index < requiredHeaders.length; index += 1) {
    var requiredHeader = requiredHeaders[index];
    if (!Object.prototype.hasOwnProperty.call(positions, requiredHeader)) {
      missing.push(requiredHeader);
    } else {
      resolved[requiredHeader] = positions[requiredHeader];
    }
  }

  if (missing.length > 0) {
    throw new Error('missing required header: ' + missing.join(', '));
  }

  return resolved;
}

// Editor-installed weekly operations are intentionally not routed through
// doPost: Drive deletion and owner-email authority must never be remotely
// invocable through the API.
function weeklyConsistencyCheck() {
  var report = checkConsistency_({ repair: false });
  if (!report.clean) {
    MailApp.sendEmail({
      to: Session.getEffectiveUser().getEmail(),
      subject: 'solo-ledger consistency failures',
      body: JSON.stringify(report, null, 2),
    });
  }
  return report;
}

function weeklyBackup() {
  var spreadsheetId = requiredProp_('LEDGER_SPREADSHEET_ID');
  var spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  var folder = backupFolder_();
  var backupPrefix = spreadsheet.getName() + ' backup ';
  var timestamp = taipeiIsoNow_()
    .replace(/[-:]/g, '')
    .replace('T', '-')
    .replace(/\.\d{3}\+0800$/, '');
  var name = backupPrefix + timestamp;
  var copy = DriveApp.getFileById(spreadsheetId).makeCopy(name, folder);
  var pruned = pruneBackups_(folder, backupPrefix, spreadsheetId);
  var prunedNames = [];

  for (var index = 0; index < pruned.length; index += 1) {
    prunedNames.push(pruned[index].getName());
  }
  return {
    ok: true,
    file_id: copy.getId(),
    name: copy.getName(),
    pruned: prunedNames,
  };
}

function backupFolder_() {
  var properties = PropertiesService.getScriptProperties();
  var folderId = properties.getProperty(BACKUP_FOLDER_PROPERTY);
  if (folderId) {
    return DriveApp.getFolderById(folderId);
  }

  var folder = DriveApp.createFolder(BACKUP_FOLDER_NAME);
  properties.setProperty(BACKUP_FOLDER_PROPERTY, folder.getId());
  return folder;
}

function pruneBackups_(folder, backupPrefix, sourceFileId) {
  var iterator = folder.getFiles();
  var files = [];
  while (iterator.hasNext()) {
    var file = iterator.next();
    if (
      file.getId() === sourceFileId ||
      file.getName().indexOf(backupPrefix) !== 0
    ) {
      continue;
    }
    files.push(file);
  }
  files.sort(function (left, right) {
    var createdDifference =
      right.getDateCreated().getTime() - left.getDateCreated().getTime();
    if (createdDifference !== 0) {
      return createdDifference;
    }
    var leftName = left.getName();
    var rightName = right.getName();
    if (leftName === rightName) {
      return 0;
    }
    return leftName < rightName ? 1 : -1;
  });

  var pruned = [];
  for (
    var index = BACKUP_RETENTION_COUNT;
    index < files.length;
    index += 1
  ) {
    files[index].setTrashed(true);
    pruned.push(files[index]);
  }
  return pruned;
}

function installWeeklyTriggers() {
  var handlerNames = {
    weeklyConsistencyCheck: true,
    weeklyBackup: true,
  };
  var existing = ScriptApp.getProjectTriggers();
  var index;

  for (index = 0; index < existing.length; index += 1) {
    if (handlerNames[existing[index].getHandlerFunction()] === true) {
      ScriptApp.deleteTrigger(existing[index]);
    }
  }

  ScriptApp.newTrigger('weeklyConsistencyCheck')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(7)
    .create();
  ScriptApp.newTrigger('weeklyBackup')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(8)
    .create();
}

// Editor-run only: setupSpreadsheet() and closeAndOpenBooks() are never routed through doPost.
function closeAndOpenBooks(oldSpreadsheetId) {
  var sourceId = String(oldSpreadsheetId || '').trim();
  if (!sourceId) {
    throw new Error('oldSpreadsheetId is required');
  }

  var targetId = requiredProp_('LEDGER_SPREADSHEET_ID');
  if (sourceId === targetId) {
    throw new Error('old and new spreadsheet ids must differ');
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_WAIT_MILLISECONDS);
  try {
    setupSpreadsheet();

    var targetSpreadsheet = SpreadsheetApp.openById(targetId);
    var targetJournal = requiredSheet_(targetSpreadsheet, '日記帳');
    if (targetJournal.getLastRow() > 1) {
      throw new Error('new book journal must be empty before migration');
    }

    // The source book is intentionally read-only. All writes below target
    // targetJournal in the current spreadsheet.
    var sourceSpreadsheet = SpreadsheetApp.openById(sourceId);
    var sourceJournal = requiredSheet_(sourceSpreadsheet, '日記帳');
    var sourceHeader = sourceJournal
      .getRange(1, 1, 1, sourceJournal.getLastColumn())
      .getDisplayValues()[0];
    var sourceColumns = resolveHeaders_(sourceHeader, JOURNAL_HEADERS);
    var sourceRecords = readJournalRecords_(
      sourceJournal,
      sourceColumns,
    );
    var sourceVocabulary = readAccountVocabulary_(sourceSpreadsheet);
    var targetVocabulary = readAccountVocabulary_(targetSpreadsheet);
    var targetHeader = targetJournal
      .getRange(1, 1, 1, targetJournal.getLastColumn())
      .getDisplayValues()[0];
    var targetColumns = resolveHeaders_(targetHeader, JOURNAL_HEADERS);
    var defaultCurrency = readSetting_(targetSpreadsheet, '預設幣別');
    var migrationNow = taipeiIsoNow_();
    var migrationDate = migrationNow.slice(0, 10);
    var balances = migrationAccountBalances_(
      sourceRecords,
      sourceVocabulary.accountTypes,
    );
    var carried = migrationOutstandingItems_(sourceRecords);
    var carriedTotals = {
      '應收帳款': 0,
      '應付帳款': 0,
    };
    var index;

    for (index = 0; index < carried.length; index += 1) {
      var carriedAccount = carried[index].account;
      carriedTotals[carriedAccount] = normalizedAmount_(
        carriedTotals[carriedAccount] + carried[index].outstanding,
      );
    }

    var postings = [];
    var openingCount = 0;
    var accountTypes = sourceVocabulary.accountTypes;
    for (var account in accountTypes) {
      if (!Object.prototype.hasOwnProperty.call(accountTypes, account)) {
        continue;
      }
      var accountType = accountTypes[account];
      if (accountType !== '資產' && accountType !== '負債') {
        continue;
      }

      var openingAmount = balances[account];
      if (
        account === '應收帳款' ||
        account === '應付帳款'
      ) {
        openingAmount = normalizedAmount_(
          openingAmount - carriedTotals[account],
        );
      }
      if (openingAmount === 0) {
        continue;
      }
      if (openingAmount < 0) {
        throw new Error(
          'cannot migrate negative balance for account: ' + account,
        );
      }

      var openingPosting = expandPosting_({
        kind: 'opening',
        account: account,
        amount: openingAmount,
        date: migrationDate,
        currency: defaultCurrency,
        source: '移轉',
        accountTypes: accountTypes,
        txnId: Utilities.getUuid(),
        now: migrationNow,
      });
      validatePostingVocabulary_(openingPosting, targetVocabulary);
      postings.push(openingPosting);
      openingCount += 1;
    }

    for (index = 0; index < carried.length; index += 1) {
      var item = carried[index];
      var carriedPosting = expandPosting_({
        kind: 'opening',
        account: item.account,
        amount: item.outstanding,
        date: migrationDate,
        currency: item.record.values['幣別'] || defaultCurrency,
        source: '移轉',
        accountTypes: accountTypes,
        txnId: Utilities.getUuid(),
        now: migrationNow,
      });
      carriedPosting['交易對象'] = item.record.values['交易對象'];
      carriedPosting['說明'] = '承前-' + item.record.values['說明'];
      carriedPosting['結清狀態'] = '未結';
      validatePostingVocabulary_(carriedPosting, targetVocabulary);
      postings.push(carriedPosting);
    }

    if (postings.length > 0) {
      targetJournal
        .getRange(
          2,
          1,
          postings.length,
          targetJournal.getLastColumn(),
        )
        .setValues(
          migrationPostingValues_(
            postings,
            targetColumns,
            targetJournal.getLastColumn(),
          ),
        );
    }

    return {
      ok: true,
      opening_rows: openingCount,
      carried_rows: carried.length,
      rows: postings.length,
    };
  } finally {
    lock.releaseLock();
  }
}

function migrationAccountBalances_(records, accountTypes) {
  var balances = Object.create(null);
  var account;
  var index;

  for (account in accountTypes) {
    if (!Object.prototype.hasOwnProperty.call(accountTypes, account)) {
      continue;
    }
    if (
      accountTypes[account] === '資產' ||
      accountTypes[account] === '負債'
    ) {
      balances[account] = 0;
    }
  }

  for (index = 0; index < records.length; index += 1) {
    var record = records[index];
    var amount = record.amount;
    var debitAccount = record.values['借方帳戶'];
    var creditAccount = record.values['貸方帳戶'];

    if (Object.prototype.hasOwnProperty.call(balances, debitAccount)) {
      balances[debitAccount] +=
        accountTypes[debitAccount] === '資產' ? amount : -amount;
    }
    if (Object.prototype.hasOwnProperty.call(balances, creditAccount)) {
      balances[creditAccount] +=
        accountTypes[creditAccount] === '資產' ? -amount : amount;
    }
  }

  for (account in balances) {
    if (Object.prototype.hasOwnProperty.call(balances, account)) {
      balances[account] = normalizedAmount_(balances[account]);
    }
  }
  return balances;
}

function migrationOutstandingItems_(records) {
  var items = [];
  for (var index = 0; index < records.length; index += 1) {
    var record = records[index];
    var status = record.values['結清狀態'];
    if (status !== '未結' && status !== '部分') {
      continue;
    }

    var outstanding = outstandingForRecord_(records, record);
    if (outstanding === 0) {
      continue;
    }
    if (outstanding < 0) {
      throw new Error(
        'cannot migrate negative outstanding for txn_id: ' +
          record.values.txn_id,
      );
    }
    items.push({
      record: record,
      account:
        receivableDirection_(record.values) === '應收'
          ? '應收帳款'
          : '應付帳款',
      outstanding: outstanding,
    });
  }
  return items;
}

function migrationPostingValues_(postings, columns, columnCount) {
  var rows = [];
  for (var rowIndex = 0; rowIndex < postings.length; rowIndex += 1) {
    var row = [];
    var columnIndex;
    for (columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
      row.push('');
    }
    for (
      columnIndex = 0;
      columnIndex < JOURNAL_HEADERS.length;
      columnIndex += 1
    ) {
      var header = JOURNAL_HEADERS[columnIndex];
      row[columns[header] - 1] = postings[rowIndex][header];
    }
    rows.push(row);
  }
  return rows;
}

function setupSpreadsheet() {
  var spreadsheetId = PropertiesService.getScriptProperties().getProperty(
    'LEDGER_SPREADSHEET_ID',
  );
  if (!spreadsheetId) {
    throw new Error('missing Script Property: LEDGER_SPREADSHEET_ID');
  }

  var spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  var journal = getOrCreateSheet_(spreadsheet, '日記帳');
  var accounts = getOrCreateSheet_(spreadsheet, '會計科目');
  var options = getOrCreateSheet_(spreadsheet, '選項清單');
  var settings = getOrCreateSheet_(spreadsheet, '設定');
  var balances = getOrCreateSheet_(spreadsheet, '餘額');
  var checks = getOrCreateSheet_(spreadsheet, '試算與檢查');

  initializeBlankSheet_(journal, [JOURNAL_HEADERS]);
  initializeBlankSheet_(accounts, [
    ['名稱', '類型', '子類型', '啟用', '排序'],
    ['期初餘額', '權益', '系統', true, 10],
    ['應收帳款', '資產', '往來', true, 20],
    ['應付帳款', '負債', '往來', true, 30],
    ['調整支出', '支出', '調整', true, 40],
    ['調整收入', '收入', '調整', true, 50],
    ['現金', '資產', '現金', true, 100],
    ['銀行', '資產', '銀行', true, 110],
    ['悠遊卡', '資產', '電子票證', true, 120],
    ['餐飲', '支出', '日常', true, 200],
    ['交通', '支出', '日常', true, 210],
    ['薪資收入', '收入', '薪資', true, 300],
  ]);
  initializeBlankSheet_(options, [['交易對象']]);
  initializeBlankSheet_(settings, [
    ['設定項目', '值'],
    ['預設幣別', 'TWD'],
    ['預設帳戶', '現金'],
  ]);
  initializeBlankSheet_(balances, [['名稱', '類型', '餘額']]);
  initializeBlankSheet_(checks, [['檢查項目', '結果']]);

  installBalanceFormulas_(balances, accounts, journal.getMaxRows());
  installCheckFormulas_(checks, accounts, journal.getMaxRows());

  var journalHeaderRow = journal
    .getRange(1, 1, 1, journal.getLastColumn())
    .getValues()[0];
  var journalColumns = resolveHeaders_(journalHeaderRow, JOURNAL_HEADERS);
  var textHeaders = ['日期', '時間', '建立時間'];
  var index;

  for (index = 0; index < textHeaders.length; index += 1) {
    journal
      .getRange(1, journalColumns[textHeaders[index]], journal.getMaxRows(), 1)
      .setNumberFormat('@');
  }

  var accountNames = accounts.getRange(2, 1, accounts.getMaxRows() - 1, 1);
  var accountValidation = SpreadsheetApp.newDataValidation()
    .requireValueInRange(accountNames, true)
    .setAllowInvalid(true)
    .build();
  var accountHeaders = ['借方帳戶', '貸方帳戶'];

  for (index = 0; index < accountHeaders.length; index += 1) {
    journal
      .getRange(
        2,
        journalColumns[accountHeaders[index]],
        journal.getMaxRows() - 1,
        1,
      )
      .setDataValidation(accountValidation);
  }
}

function getOrCreateSheet_(spreadsheet, name) {
  var existing = spreadsheet.getSheetByName(name);
  if (existing) {
    return existing;
  }

  var sheets = spreadsheet.getSheets();
  if (
    sheets.length === 1 &&
    (sheets[0].getName() === 'Sheet1' || sheets[0].getName() === '工作表1') &&
    sheets[0].getLastRow() === 0 &&
    sheets[0].getLastColumn() === 0
  ) {
    return sheets[0].setName(name);
  }

  return spreadsheet.insertSheet(name);
}

function initializeBlankSheet_(sheet, rows) {
  if (sheet.getLastRow() !== 0 || sheet.getLastColumn() !== 0) {
    return;
  }
  sheet.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
}

function installBalanceFormulas_(sheet, accounts, journalMaxRows) {
  if (sheet.getLastRow() < 1 || sheet.getLastColumn() !== 3) {
    return;
  }

  var headers = sheet.getRange(1, 1, 1, 3).getValues()[0];
  if (headers[0] !== '名稱' || headers[1] !== '類型' || headers[2] !== '餘額') {
    return;
  }

  var accountCount = accounts.getLastRow() - 1;
  var existingBalanceCount = Math.max(0, sheet.getLastRow() - 1);
  if (accountCount <= existingBalanceCount) {
    return;
  }

  var missingCount = accountCount - existingBalanceCount;
  var accountTypes = accounts
    .getRange(existingBalanceCount + 2, 2, missingCount, 1)
    .getValues();
  var accountMaxRows = accounts.getMaxRows();
  var accountHeaderRow = "'會計科目'!$1:$1";
  var accountRows = "'會計科目'!$1:$" + accountMaxRows;
  var amounts = journalColumnFormula_('金額', journalMaxRows);
  var debitAccounts = journalColumnFormula_('借方帳戶', journalMaxRows);
  var creditAccounts = journalColumnFormula_('貸方帳戶', journalMaxRows);
  var rows = [];
  var index;

  for (index = existingBalanceCount; index < accountCount; index += 1) {
    var sheetRow = index + 2;
    var accountType = accountTypes[index - existingBalanceCount][0];
    var debitTotal =
      'SUMIFS(' + amounts + ',' + debitAccounts + ',$A' + sheetRow + ')';
    var creditTotal =
      'SUMIFS(' + amounts + ',' + creditAccounts + ',$A' + sheetRow + ')';
    var balanceFormula;

    if (accountType === '資產' || accountType === '支出') {
      balanceFormula =
        '=IF(OR($B' +
        sheetRow +
        '="資產",$B' +
        sheetRow +
        '="支出"),' +
        debitTotal +
        '-' +
        creditTotal +
        ',' +
        creditTotal +
        '-' +
        debitTotal +
        ')';
    } else {
      balanceFormula =
        '=IF(OR($B' +
        sheetRow +
        '="負債",$B' +
        sheetRow +
        '="收入",$B' +
        sheetRow +
        '="權益"),' +
        creditTotal +
        '-' +
        debitTotal +
        ',' +
        debitTotal +
        '-' +
        creditTotal +
        ')';
    }

    rows.push([
      '=INDEX(' +
        accountRows +
        ',ROW(),MATCH("名稱",' +
        accountHeaderRow +
        ',0))',
      '=INDEX(' +
        accountRows +
        ',ROW(),MATCH("類型",' +
        accountHeaderRow +
        ',0))',
      balanceFormula,
    ]);
  }

  sheet
    .getRange(existingBalanceCount + 2, 1, rows.length, rows[0].length)
    .setValues(rows);
}

function ensureBalanceFormulas_(spreadsheet, schemaVersion) {
  var properties = PropertiesService.getScriptProperties();
  var lastSynchronizedVersion = properties.getProperty(
    BALANCE_FORMULA_SCHEMA_PROPERTY,
  );
  var accounts = requiredSheet_(spreadsheet, '會計科目');
  var balances = requiredSheet_(spreadsheet, '餘額');
  var journal = requiredSheet_(spreadsheet, '日記帳');
  var accountCount = Math.max(0, accounts.getLastRow() - 1);
  var balanceCount = Math.max(0, balances.getLastRow() - 1);

  if (
    lastSynchronizedVersion !== schemaVersion ||
    balanceCount < accountCount
  ) {
    installBalanceFormulas_(balances, accounts, journal.getMaxRows());
  }

  properties.setProperty(BALANCE_FORMULA_SCHEMA_PROPERTY, schemaVersion);
}

function installCheckFormulas_(sheet, accounts, journalMaxRows) {
  if (sheet.getLastRow() !== 1 || sheet.getLastColumn() !== 2) {
    return;
  }

  var accountNames =
    "INDEX('會計科目'!$2:$" +
    accounts.getMaxRows() +
    ',0,MATCH("名稱",\'會計科目\'!$1:$1,0))';
  var dates = journalColumnFormula_('日期', journalMaxRows);
  var times = journalColumnFormula_('時間', journalMaxRows);
  var types = journalColumnFormula_('類型', journalMaxRows);
  var debitAccounts = journalColumnFormula_('借方帳戶', journalMaxRows);
  var creditAccounts = journalColumnFormula_('貸方帳戶', journalMaxRows);
  var amounts = journalColumnFormula_('金額', journalMaxRows);
  var statuses = journalColumnFormula_('結清狀態', journalMaxRows);
  var linkedTxnIds = journalColumnFormula_('沖銷txn_id', journalMaxRows);
  var txnIds = journalColumnFormula_('txn_id', journalMaxRows);
  var debitTotal = 'SUMIF(' + debitAccounts + ',"<>",' + amounts + ')';
  var creditTotal = 'SUMIF(' + creditAccounts + ',"<>",' + amounts + ')';

  var trialBalanceFormula =
    '=LET(debitTotal,' +
    debitTotal +
    ',creditTotal,' +
    creditTotal +
    ',IF(debitTotal=creditTotal,"OK","異常：借方總額 "&debitTotal&"；貸方總額 "&creditTotal))';

  var unknownAccountFormula =
    '=LET(unknownCount,' +
    'SUM(ARRAYFORMULA(IF(' +
    debitAccounts +
    '="",0,--(COUNTIF(' +
    accountNames +
    ',' +
    debitAccounts +
    ')=0))))+' +
    'SUM(ARRAYFORMULA(IF(' +
    creditAccounts +
    '="",0,--(COUNTIF(' +
    accountNames +
    ',' +
    creditAccounts +
    ')=0)))),' +
    'IF(unknownCount=0,"OK","異常："&unknownCount&" 個未知帳戶"))';

  var statusFormula =
    '=LET(statuses,' +
    statuses +
    ',txnIds,' +
    txnIds +
    ',amounts,' +
    amounts +
    ',mismatchCount,' +
    'SUM(MAP(statuses,txnIds,amounts,LAMBDA(status,txnId,originalAmount,' +
    'IF(status="",0,' +
    'IF(status="已沖銷",' +
    '--(COUNTIFS(' +
    linkedTxnIds +
    ',txnId,' +
    types +
    ',"沖銷")=0),' +
    'LET(settledAmount,SUMIFS(' +
    amounts +
    ',' +
    linkedTxnIds +
    ',txnId,' +
    types +
    ',"轉帳"),' +
    'outstanding,originalAmount-settledAmount,' +
    'expectedStatus,IF(outstanding=0,"已結",IF(outstanding<originalAmount,"部分","未結")),' +
    '--(status<>expectedStatus))))))),' +
    'IF(mismatchCount=0,"OK","異常："&mismatchCount&" 筆結清狀態不一致"))';

  var nonTextDateTimeFormula =
    '=LET(nonTextCount,' +
    'SUM(ARRAYFORMULA(IF(' +
    dates +
    '="",0,--NOT(ISTEXT(' +
    dates +
    ')))))+' +
    'SUM(ARRAYFORMULA(IF(' +
    times +
    '="",0,--NOT(ISTEXT(' +
    times +
    '))))),' +
    'IF(nonTextCount=0,"OK","異常："&nonTextCount&" 個日期/時間儲存格不是文字"))';

  sheet.getRange(2, 1, 4, 2).setValues([
    ['試算平衡', trialBalanceFormula],
    ['未知帳戶', unknownAccountFormula],
    ['結清狀態與衍生餘額', statusFormula],
    ['非文字日期/時間', nonTextDateTimeFormula],
  ]);
}

function journalColumnFormula_(header, journalMaxRows) {
  return (
    "INDEX('日記帳'!$2:$" +
    journalMaxRows +
    ',0,MATCH("' +
    header +
    '",\'日記帳\'!$1:$1,0))'
  );
}

function expandPosting_(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('input is required');
  }

  if (input.kind === 'create') {
    return expandCreatePosting_(input);
  }
  if (input.kind === 'settle') {
    return expandSettlementPosting_(input);
  }
  if (input.kind === 'reverse') {
    return expandReversalPosting_(input);
  }
  if (input.kind === 'opening') {
    return expandOpeningPosting_(input);
  }

  throw new Error('kind is invalid');
}

function expandCreatePosting_(input) {
  validateCreateFields_(input);
  validatePositiveAmount_(input.amount);

  var debitAccount = '';
  var creditAccount = '';
  var settlementStatus = '';

  if (input.type === '支出') {
    if (input.iou === '應收') {
      debitAccount = '應收帳款';
      creditAccount = input.account;
      settlementStatus = '未結';
    } else if (input.iou === '應付') {
      debitAccount = input.category;
      creditAccount = '應付帳款';
      settlementStatus = '未結';
    } else {
      debitAccount = input.category;
      creditAccount = input.account;
    }
  } else if (input.type === '收入') {
    debitAccount = input.account;
    creditAccount = input.category;
  } else {
    debitAccount = input.toAccount;
    creditAccount = input.account;
  }

  validateDistinctLegs_(debitAccount, creditAccount);

  return postingRow_({
    date: input.date,
    time: input.time,
    type: input.type,
    debitAccount: debitAccount,
    creditAccount: creditAccount,
    amount: input.amount,
    currency: input.currency,
    category: nominalLeg_(debitAccount, creditAccount, input.accountTypes),
    payee: input.payee,
    description: input.description,
    settlementStatus: settlementStatus,
    reversalTxnId: '',
    txnId: input.txnId,
    source: 'pwa',
    now: input.now,
  });
}

function expandSettlementPosting_(input) {
  requireField_(input, 'original');
  requireField_(input, 'account');
  requireField_(input, 'amount');
  requireField_(input, 'date');
  requireField_(input, 'defaultCurrency');
  validatePositiveAmount_(input.amount);

  var original = input.original;
  var debitAccount = '';
  var creditAccount = '';

  if (original['借方帳戶'] === '應收帳款') {
    debitAccount = input.account;
    creditAccount = '應收帳款';
  } else if (original['貸方帳戶'] === '應付帳款') {
    debitAccount = '應付帳款';
    creditAccount = input.account;
  } else {
    throw new Error('original is not an 應收帳款 or 應付帳款 posting');
  }

  validateDistinctLegs_(debitAccount, creditAccount);
  requireField_(original, 'txn_id');

  return postingRow_({
    date: input.date,
    time: '',
    type: '轉帳',
    debitAccount: debitAccount,
    creditAccount: creditAccount,
    amount: input.amount,
    currency: input.defaultCurrency,
    category: nominalLeg_(debitAccount, creditAccount, input.accountTypes),
    payee: '',
    description: '',
    settlementStatus: '',
    reversalTxnId: original.txn_id,
    txnId: input.txnId,
    source: 'pwa',
    now: input.now,
  });
}

function expandReversalPosting_(input) {
  requireField_(input, 'original');
  requireField_(input, 'date');
  requireField_(input, 'defaultCurrency');

  var original = input.original;
  requireField_(original, '借方帳戶');
  requireField_(original, '貸方帳戶');
  requireField_(original, '金額');
  requireField_(original, 'txn_id');
  validatePositiveAmount_(original['金額']);

  var debitAccount = original['貸方帳戶'];
  var creditAccount = original['借方帳戶'];
  validateDistinctLegs_(debitAccount, creditAccount);

  return postingRow_({
    date: input.date,
    time: '',
    type: '沖銷',
    debitAccount: debitAccount,
    creditAccount: creditAccount,
    amount: original['金額'],
    currency: input.defaultCurrency,
    category: nominalLeg_(debitAccount, creditAccount, input.accountTypes),
    payee: '',
    description: '',
    settlementStatus: '',
    reversalTxnId: original.txn_id,
    txnId: input.txnId,
    source: 'pwa',
    now: input.now,
  });
}

function expandOpeningPosting_(input) {
  requireField_(input, 'account');
  requireField_(input, 'amount');
  requireField_(input, 'date');
  validatePositiveAmount_(input.amount);

  var accountType = (input.accountTypes || {})[input.account];
  var debitAccount = '';
  var creditAccount = '';

  if (accountType === '資產') {
    debitAccount = input.account;
    creditAccount = '期初餘額';
  } else if (accountType === '負債') {
    debitAccount = '期初餘額';
    creditAccount = input.account;
  } else {
    throw new Error('account must have type 資產 or 負債 for opening');
  }

  validateDistinctLegs_(debitAccount, creditAccount);

  return postingRow_({
    date: input.date,
    time: '',
    type: '轉帳',
    debitAccount: debitAccount,
    creditAccount: creditAccount,
    amount: input.amount,
    currency: blank_(input.currency) || 'TWD',
    category: nominalLeg_(debitAccount, creditAccount, input.accountTypes),
    payee: '',
    description: '',
    settlementStatus: '',
    reversalTxnId: '',
    txnId: input.txnId,
    source: blank_(input.source) || '移轉',
    now: input.now,
  });
}

function validateCreateFields_(input) {
  if (input.type !== '支出' && input.type !== '收入' && input.type !== '轉帳') {
    throw new Error('type is invalid');
  }

  requireField_(input, 'account');

  if (input.type === '支出') {
    rejectField_(input, 'toAccount');

    if (hasField_(input, 'iou') && input.iou !== '應收' && input.iou !== '應付') {
      throw new Error('iou is invalid');
    }

    if (input.iou === '應收') {
      rejectField_(input, 'category');
    } else {
      requireField_(input, 'category');
    }

    if (input.iou === '應收' || input.iou === '應付') {
      requireField_(input, 'payee');
    }
    return;
  }

  if (input.type === '收入') {
    rejectField_(input, 'toAccount');
    requireField_(input, 'category');
    rejectField_(input, 'iou');
    return;
  }

  requireField_(input, 'toAccount');
  rejectField_(input, 'category');
  rejectField_(input, 'payee');
  rejectField_(input, 'iou');
}

function nominalLeg_(debitAccount, creditAccount, accountTypes) {
  var types = accountTypes || {};
  var debitType = types[debitAccount];
  var creditType = types[creditAccount];

  if (debitType === '收入' || debitType === '支出') {
    return debitAccount;
  }
  if (creditType === '收入' || creditType === '支出') {
    return creditAccount;
  }
  return '';
}

function postingRow_(fields) {
  return {
    '日期': blank_(fields.date),
    '時間': blank_(fields.time),
    '類型': blank_(fields.type),
    '借方帳戶': blank_(fields.debitAccount),
    '貸方帳戶': blank_(fields.creditAccount),
    '金額': fields.amount,
    '幣別': blank_(fields.currency),
    '分類': blank_(fields.category),
    '交易對象': blank_(fields.payee),
    '說明': blank_(fields.description),
    '結清狀態': blank_(fields.settlementStatus),
    '沖銷txn_id': blank_(fields.reversalTxnId),
    'txn_id': blank_(fields.txnId),
    '來源': blank_(fields.source),
    '建立時間': blank_(fields.now),
  };
}

function requireField_(object, field) {
  if (!hasField_(object, field) || object[field] === '' || object[field] === null || object[field] === undefined) {
    throw new Error(field + ' is required');
  }
}

function rejectField_(object, field) {
  if (
    hasField_(object, field) &&
    object[field] !== '' &&
    object[field] !== null &&
    object[field] !== undefined
  ) {
    throw new Error(field + ' is rejected');
  }
}

function hasField_(object, field) {
  return Object.prototype.hasOwnProperty.call(object, field);
}

function validatePositiveAmount_(amount) {
  if (typeof amount !== 'number' || !isFinite(amount) || amount <= 0) {
    throw new Error('amount must be a positive number');
  }
}

function validateDistinctLegs_(debitAccount, creditAccount) {
  if (!debitAccount) {
    throw new Error('借方帳戶 is required');
  }
  if (!creditAccount) {
    throw new Error('貸方帳戶 is required');
  }
  if (debitAccount === creditAccount) {
    throw new Error('account and counter-account must differ');
  }
}

function blank_(value) {
  return value === undefined || value === null ? '' : value;
}
