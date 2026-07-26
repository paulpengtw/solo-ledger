var JOURNAL_HEADERS = [
  '日期',
  '時間',
  '類型',
  '借方帳戶',
  '貸方帳戶',
  '金額',
  '幣別',
  '分類',
  '對象',
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
  '對象',
  '說明',
  '結清狀態',
];

var MAX_LIST_TRANSACTIONS = 200;
var MAX_SKEW_SECONDS = 300;
var NONCE_CACHE_SECONDS = 600;
var LOCK_WAIT_MILLISECONDS = 30000;
var SCHEMA_SHEET_NAMES = ['會計科目', '選項清單', '設定'];
var SPREADSHEET_ID_TAIL_LENGTH = 8;

function doPost(e) {
  try {
    var requestText =
      e && e.postData && e.postData.contents ? e.postData.contents : '{}';
    var verified = verifyEnvelope_(JSON.parse(requestText));
    return json_(route_(verified.payload, verified.nonce));
  } catch (error) {
    return json_({
      ok: false,
      error: String(error && error.message ? error.message : error),
    });
  }
}

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
  if (action === 'create_transaction') {
    return createTransaction_(payload, nonce);
  }

  throw new Error('unsupported action: ' + action);
}

function verifyEnvelope_(envelope) {
  if (!envelope || typeof envelope !== 'object') {
    throw new Error('invalid envelope');
  }

  var ts = Number(envelope.ts);
  var nonce = String(envelope.nonce || '');
  var payloadB64 = String(envelope.payload || '');
  var sig = String(envelope.sig || '');

  if (!isFinite(ts)) {
    throw new Error('missing ts');
  }
  if (!nonce) {
    throw new Error('missing nonce');
  }
  if (!payloadB64) {
    throw new Error('missing payload');
  }
  if (!sig) {
    throw new Error('missing sig');
  }

  var now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > MAX_SKEW_SECONDS) {
    throw new Error('request timestamp outside allowed window');
  }

  var secret = requiredProp_('EXPENSE_API_SECRET');
  var signingInput = ts + '.' + nonce + '.' + payloadB64;
  var expected = base64UrlEncode_(
    Utilities.computeHmacSha256Signature(signingInput, secret),
  );
  if (!constantTimeEqual_(sig, expected)) {
    throw new Error('bad signature');
  }

  var jsonText = Utilities.newBlob(base64UrlDecode_(payloadB64))
    .getDataAsString('UTF-8');
  return { payload: JSON.parse(jsonText), nonce: nonce };
}

function health_() {
  var spreadsheetId = requiredProp_('LEDGER_SPREADSHEET_ID');
  var spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  var tailLength = Math.min(
    SPREADSHEET_ID_TAIL_LENGTH,
    Math.max(1, spreadsheetId.length - 1),
  );

  return {
    ok: true,
    now: new Date().toISOString(),
    schema_version: schemaVersion_(spreadsheet),
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
  var optionColumns = resolveHeaders_(optionValues[0], ['對象']);
  var payees = [];
  for (rowIndex = 1; rowIndex < optionValues.length; rowIndex += 1) {
    var payee = String(optionValues[rowIndex][optionColumns['對象'] - 1] || '')
      .trim();
    if (payee) {
      payees.push(payee);
    }
  }

  return {
    schema_version: schemaVersion_(spreadsheet),
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

function requiredProp_(name) {
  var value = PropertiesService.getScriptProperties().getProperty(name);
  if (!value) {
    throw new Error('missing script property: ' + name);
  }
  return value;
}

function json_(object) {
  return ContentService.createTextOutput(JSON.stringify(object)).setMimeType(
    ContentService.MimeType.JSON,
  );
}

function base64UrlEncode_(bytes) {
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}

function base64UrlDecode_(text) {
  var normalized = text.replace(/-/g, '+').replace(/_/g, '/');
  while (normalized.length % 4) {
    normalized += '=';
  }
  return Utilities.base64Decode(normalized);
}

function constantTimeEqual_(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  var difference = 0;
  for (var index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
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

// Editor-run only: setupSpreadsheet() and closeAndOpenBooks() are never routed through doPost.
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
  initializeBlankSheet_(options, [['對象']]);
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
  if (sheet.getLastRow() !== 1 || sheet.getLastColumn() !== 3) {
    return;
  }

  var accountCount = accounts.getLastRow() - 1;
  if (accountCount < 1) {
    return;
  }

  var accountTypes = accounts.getRange(2, 2, accountCount, 1).getValues();
  var accountMaxRows = accounts.getMaxRows();
  var accountHeaderRow = "'會計科目'!$1:$1";
  var accountRows = "'會計科目'!$1:$" + accountMaxRows;
  var amounts = journalColumnFormula_('金額', journalMaxRows);
  var debitAccounts = journalColumnFormula_('借方帳戶', journalMaxRows);
  var creditAccounts = journalColumnFormula_('貸方帳戶', journalMaxRows);
  var rows = [];
  var index;

  for (index = 0; index < accountCount; index += 1) {
    var sheetRow = index + 2;
    var accountType = accountTypes[index][0];
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

  sheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
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
    '對象': blank_(fields.payee),
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
