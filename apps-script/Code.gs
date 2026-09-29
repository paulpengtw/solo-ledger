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
var MAX_SNAPSHOT_RECORDS = 200;
var NONCE_CACHE_SECONDS = 600;
var LOCK_WAIT_MILLISECONDS = 30000;
var SCHEMA_SHEET_NAMES = ['會計科目', '選項清單', '設定'];
var SPREADSHEET_ID_TAIL_LENGTH = 8;
var BACKUP_FOLDER_PROPERTY = 'LEDGER_BACKUP_FOLDER_ID';
var BACKUP_FOLDER_NAME = 'Solo Ledger backups';
var BACKUP_RETENTION_COUNT = 12;
var ACCOUNT_STABLE_ID_HEADER = 'stable_id';
var ACCOUNT_ALIASES_HEADER = 'aliases';
var OBSERVATION_SHEET_NAME = '來源觀察';
var OBSERVATION_HEADERS = ['observation_id', 'source_reference', 'content_digest'];
var OBSERVATION_ID_HEADER = OBSERVATION_HEADERS[0];
var IDENTITY_ADOPTION_PROPERTY_PREFIX = 'identity-adoption:';
var UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var E2_JOURNAL_TYPES = {
  '支出': true,
  '收入': true,
  '轉帳': true,
  '沖銷': true,
};

// E2 metadata is intentionally provisioned lazily. Existing Personal books
// keep their original seven-tab bootstrap and can adopt the reviewed import
// surface when the first E2 operation is accepted. Every table below is
// append-oriented; row identities and revisions are never inferred from a
// process cache.
var E2_TABLES = [
  { name: '事件群組', headers: [
    'group_id', 'status', 'currency_totals_json', 'completion_marker',
    'content_digest', 'created_at', 'updated_at', 'source',
  ] },
  { name: '事件群組明細', headers: [
    'group_id', 'txn_id', 'leg_index', 'amount', 'currency',
    'debit_account', 'credit_account', 'content_digest',
  ] },
  { name: '事件審核', headers: [
    'txn_id', 'category', 'review_state', 'revision', 'operation_id', 'updated_at',
  ] },
  { name: '整合操作', headers: [
    'operation_id', 'content_digest', 'kind', 'reason', 'conflicts_json',
    'destinations_json', 'committed_at', 'detail',
  ] },
  { name: '觀察認領', headers: [
    'claim_id', 'operation_id', 'content_digest', 'status', 'created_at',
  ] },
  { name: '匯入清單', headers: [
    'manifest_id', 'revision', 'status', 'content_digest', 'actor',
    'approved_at', 'source_evidence_json', 'updated_at',
  ] },
  { name: '匯入步驟', headers: [
    'manifest_id', 'step_id', 'state', 'destination_id', 'destination_revision',
    'content_digest', 'expected_revisions_json', 'result_json', 'updated_at',
  ] },
  { name: '來源證據', headers: [
    'evidence_id', 'source_reference', 'content_digest', 'effective_date',
    'uploaded_at', 'fields_json', 'revision',
  ] },
  { name: '跨簿連結', headers: [
    'link_id', 'source_id', 'destination_id', 'destination_revision',
    'source_revision', 'content_digest', 'status', 'origin', 'created_at',
  ] },
  { name: '對帳檢查點', headers: [
    'checkpoint_id', 'cutoff', 'scope_version', 'represented_balances_json',
    'accepted_balances_json', 'adjustment_json', 'evidence_ids_json',
    'coverage_json', 'status', 'revision', 'created_at',
  ] },
  { name: '設定版本', headers: [
    'setting_id', 'setting_key', 'value_json', 'effective_date', 'revision',
    'updated_at',
  ] },
  { name: '結果版本', headers: [
    'result_id', 'interval_json', 'dependency_revisions_json', 'state',
    'value_json', 'created_at', 'revision',
  ] },
  { name: '整合記錄', headers: [
    'scope', 'record_id', 'revision', 'data_json', 'created_at',
  ] },
];

var E2_CAPABILITIES = [
  'content-conflict-detection',
  'native-currency-groups',
  'pending-confirmation-states',
  'durable-operation-outcomes',
  'link-metadata',
  'reconciliation-metadata',
];

function stableIdentitySchemaAvailable_() {
  var spreadsheetId = PropertiesService.getScriptProperties().getProperty(
    'LEDGER_SPREADSHEET_ID',
  );
  if (!spreadsheetId) {
    return false;
  }
  try {
    var spreadsheet = SpreadsheetApp.openById(spreadsheetId);
    if (!stableIdentityMetadataSchemaPresent_(spreadsheet)) {
      return false;
    }
    return !persistedStableIdentityDuplicate_(spreadsheet);
  } catch (error) {
    return false;
  }
}

function e2SchemaAvailable_(spreadsheet) {
  for (var index = 0; index < E2_TABLES.length; index += 1) {
    var table = E2_TABLES[index];
    var sheet = spreadsheet.getSheetByName(table.name);
    if (!sheet || !sheetHasHeaders_(sheet, table.headers)) {
      return false;
    }
  }
  return true;
}

function ensureE2Schema_(spreadsheet) {
  for (var index = 0; index < E2_TABLES.length; index += 1) {
    var table = E2_TABLES[index];
    var sheet = getOrCreateSheet_(spreadsheet, table.name);
    initializeBlankSheet_(sheet, [table.headers]);
    if (!sheetHasHeaders_(sheet, table.headers)) {
      throw new Error('invalid E2 metadata schema: ' + table.name);
    }
  }
}

function stableIdentityMetadataSchemaPresent_(spreadsheet) {
  var accounts = spreadsheet.getSheetByName('會計科目');
  var journal = spreadsheet.getSheetByName('日記帳');
  var observations = spreadsheet.getSheetByName(OBSERVATION_SHEET_NAME);
  if (!accounts || !journal || !observations ||
      !sheetHasHeaders_(accounts, [
        '名稱', '類型', '子類型', '啟用', '排序', ACCOUNT_STABLE_ID_HEADER,
        ACCOUNT_ALIASES_HEADER,
      ]) || !sheetHasHeaders_(journal, JOURNAL_HEADERS) ||
      !sheetHasHeaders_(observations, OBSERVATION_HEADERS)) {
    return false;
  }
  try {
    resolveHeaders_(
      accounts.getRange(1, 1, 1, accounts.getLastColumn()).getDisplayValues()[0],
      ['名稱', '類型', '子類型', '啟用', '排序', ACCOUNT_STABLE_ID_HEADER,
        ACCOUNT_ALIASES_HEADER],
    );
    resolveHeaders_(
      journal.getRange(1, 1, 1, journal.getLastColumn()).getDisplayValues()[0],
      JOURNAL_HEADERS,
    );
    resolveHeaders_(
      observations.getRange(1, 1, 1, observations.getLastColumn()).getDisplayValues()[0],
      OBSERVATION_HEADERS,
    );
    return true;
  } catch (error) {
    return false;
  }
}

function persistedStableIdentityDuplicate_(spreadsheet) {
  var seen = Object.create(null);
  var sheets = [
    { sheet: spreadsheet.getSheetByName('會計科目'), header: ACCOUNT_STABLE_ID_HEADER },
    { sheet: spreadsheet.getSheetByName('日記帳'), header: 'txn_id' },
    { sheet: spreadsheet.getSheetByName(OBSERVATION_SHEET_NAME), header: OBSERVATION_ID_HEADER },
  ];
  for (var sheetIndex = 0; sheetIndex < sheets.length; sheetIndex += 1) {
    var item = sheets[sheetIndex];
    if (!item.sheet || item.sheet.getLastColumn() === 0) {
      continue;
    }
    var headers = item.sheet.getRange(1, 1, 1, item.sheet.getLastColumn())
      .getDisplayValues()[0];
    var column = headers.map(function (header) {
      return String(header || '').trim();
    }).indexOf(item.header);
    if (column === -1) {
      continue;
    }
    var lastRow = item.sheet.getLastRow();
    if (lastRow < 2) {
      continue;
    }
    var values = item.sheet.getRange(2, column + 1, lastRow - 1, 1).getDisplayValues();
    for (var rowIndex = 0; rowIndex < values.length; rowIndex += 1) {
      var identity = String(values[rowIndex][0] || '').trim();
      if (!identity) {
        continue;
      }
      if (seen[identity]) {
        return identity;
      }
      seen[identity] = true;
    }
  }
  return null;
}

function sheetHasHeaders_(sheet, requiredHeaders) {
  if (sheet.getLastColumn() === 0) {
    return false;
  }
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn())
    .getDisplayValues()[0]
    .map(function (header) { return String(header || '').trim(); });
  for (var index = 0; index < requiredHeaders.length; index += 1) {
    if (headers.indexOf(requiredHeaders[index]) === -1) {
      return false;
    }
  }
  return true;
}

function integrationState_() {
  if (!/^[0-9a-f]{40}$/.test(CONTRACT_VERSION) ||
      !/^[0-9a-f]{40}$/.test(APP_VERSION)) {
    throw new Error('系統版本不可用');
  }
  var open = PropertiesService.getScriptProperties().getProperty('INTEGRATION_OPEN') === 'true';
  var capabilities = ['complete-revisioned-reads'];
  if (stableIdentitySchemaAvailable_()) {
    capabilities.push('stable-identity');
  }
  var spreadsheetId = PropertiesService.getScriptProperties().getProperty(
    'LEDGER_SPREADSHEET_ID',
  );
  if (spreadsheetId) {
    try {
      var spreadsheet = SpreadsheetApp.openById(spreadsheetId);
      if (e2SchemaAvailable_(spreadsheet)) {
        for (var capabilityIndex = 0;
          capabilityIndex < E2_CAPABILITIES.length;
          capabilityIndex += 1) {
          capabilities.push(E2_CAPABILITIES[capabilityIndex]);
        }
      }
    } catch (error) {
      // A missing metadata table is an unavailable capability, never a
      // reason to hide the base read surface.
    }
  }
  return {
    book: 'personal',
    identity: { contractVersion: CONTRACT_VERSION, appVersion: APP_VERSION },
    maintenance: open ? { kind: 'open' } : { kind: 'maintenance', message: '系統更新中' },
    capabilities: capabilities,
    readAt: taipeiIsoNow_(),
  };
}

function requireFinancialOpen_(payload) {
  var state = integrationState_();
  if (state.maintenance.kind !== 'open') {
    throw new Error('系統更新中');
  }
  if (!payload || payload.contractVersion !== CONTRACT_VERSION) {
    throw new Error('版本已更新，請重新整理頁面');
  }
}

function setMaintenance_(payload, nonce) {
  integrationState_();
  if (!payload || typeof payload.open !== 'boolean' ||
      String(payload.commandNonce || '') !== nonce ||
      payload.contractVersion !== CONTRACT_VERSION) {
    throw new Error('invalid maintenance command');
  }
  var commandTs = Number(payload.commandTs);
  if (!Number.isSafeInteger(commandTs)) {
    throw new Error('invalid maintenance command timestamp');
  }
  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_WAIT_MILLISECONDS);
  try {
    var properties = PropertiesService.getScriptProperties();
    var previousText = properties.getProperty('MAINTENANCE_LAST_COMMAND');
    var previous = previousText ? JSON.parse(previousText) : null;
    if (previous) {
      if (!Number.isSafeInteger(previous.ts) || typeof previous.nonce !== 'string' ||
          typeof previous.open !== 'boolean') {
        throw new Error('maintenance command state unavailable');
      }
      if (commandTs < previous.ts ||
          (commandTs === previous.ts &&
            (nonce !== previous.nonce || payload.open !== previous.open))) {
        throw new Error('stale maintenance command');
      }
    }
    if (!previous || commandTs > previous.ts) {
      if (Math.abs(Date.now() - commandTs) > 300000) {
        throw new Error('maintenance command timestamp outside allowed window');
      }
      properties.setProperty('MAINTENANCE_LAST_COMMAND', JSON.stringify({
        ts: commandTs, nonce: nonce, open: payload.open,
      }));
    }
    properties.setProperty('INTEGRATION_OPEN', payload.open ? 'true' : 'false');
    return integrationState_();
  } finally {
    lock.releaseLock();
  }
}

function route_(payload, nonce) {
  var action = payload && payload.action;
  if (action === 'integrationState') {
    return integrationState_();
  }
  if (action === 'setMaintenance') {
    return setMaintenance_(payload, nonce);
  }
  if (action === 'outcome') {
    return outcome_(payload);
  }
  requireFinancialOpen_(payload);

  if (action === 'enable_e2' || action === 'enable_integration_schema') {
    return enableE2Schema_(payload);
  }

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
  if (action === 'snapshot') {
    return snapshot_(payload);
  }
  if (action === 'lookup') {
    return lookup_(payload);
  }
  if (action === 'adopt_identity') {
    return adoptIdentity_(payload);
  }
  if (action === 'command') {
    return command_(payload, nonce);
  }
  if (action === 'create_event_group' || action === 'event_group') {
    return createEventGroup_(payload, nonce);
  }
  if (action === 'confirm_event' || action === 'review_event') {
    return confirmEvent_(payload, nonce);
  }
  if (action === 'accept_import' || action === 'import_manifest') {
    return acceptImport_(payload, nonce);
  }
  if (action === 'resume_import') {
    return resumeImport_(payload, nonce);
  }
  if (action === 'record_evidence' || action === 'source_evidence') {
    return recordEvidence_(payload, nonce);
  }
  if (action === 'record_link' || action === 'link_record') {
    return recordLink_(payload, nonce);
  }
  if (action === 'accept_checkpoint' || action === 'checkpoint') {
    return acceptCheckpoint_(payload, nonce);
  }
  if (action === 'set_versioned_setting') {
    return setVersionedSetting_(payload, nonce);
  }
  if (action === 'publish_result') {
    return publishResult_(payload, nonce);
  }
  if (action === 'opening_adjustment' || action === 'cutover_adjustment') {
    return openingAdjustment_(payload, nonce);
  }
  if (action === 'correct_event' || action === 'append_correction') {
    return correctEvent_(payload, nonce);
  }
  if (action === 'check_consistency') {
    return checkConsistency_(payload, nonce);
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

function snapshot_(payload) {
  if (!payload || (
    payload.scope !== 'accounts' &&
    payload.scope !== 'events' &&
    payload.scope !== 'observations' &&
    !isE2SnapshotScope_(payload.scope)
  )) {
    throw new Error('snapshot scope must be accounts, events, or observations');
  }
  if (payload.interval !== undefined) {
    throw new Error('snapshot interval is not supported');
  }
  if (payload.cursor !== undefined && payload.snapshotRevision === undefined) {
    throw new Error('snapshot continuation requires snapshotRevision');
  }

  var spreadsheet = SpreadsheetApp.openById(
    requiredProp_('LEDGER_SPREADSHEET_ID'),
  );
  if (isE2SnapshotScope_(payload.scope)) {
    if (!e2SchemaAvailable_(spreadsheet)) {
      return identityUnavailable_('e2-metadata-schema-unavailable');
    }
    var e2Records = snapshotE2Records_(spreadsheet, payload.scope);
    var e2Revision = snapshotRevision_(readSnapshotSource_(spreadsheet));
    if (
      payload.snapshotRevision !== undefined &&
      String(payload.snapshotRevision) !== e2Revision
    ) {
      return {
        kind: 'revision-changed',
        book: 'personal',
        expected: String(payload.snapshotRevision),
        actual: e2Revision,
      };
    }
    var e2Offset = snapshotCursorOffset_(payload.cursor);
    if (e2Offset > e2Records.length) {
      throw new Error('snapshot cursor is outside the result');
    }
    var e2Page = e2Records.slice(e2Offset, e2Offset + MAX_SNAPSHOT_RECORDS);
    var e2NextOffset = e2Offset + e2Page.length;
    return {
      scope: payload.scope,
      snapshotRevision: e2Revision,
      records: e2Page,
      continuation: e2NextOffset < e2Records.length
        ? { kind: 'cursor', cursor: String(e2NextOffset) }
        : { kind: 'end' },
      readAt: taipeiIsoNow_(),
    };
  }
  var source = readSnapshotSource_(spreadsheet);
  if (payload.scope === 'observations' && !source.observationSchemaAvailable) {
    return identityUnavailable_('stable-identity-schema-unavailable');
  }
  var revision = snapshotRevision_(source);
  if (
    payload.snapshotRevision !== undefined &&
    String(payload.snapshotRevision) !== revision
  ) {
    return {
      kind: 'revision-changed',
      book: 'personal',
      expected: String(payload.snapshotRevision),
      actual: revision,
    };
  }
  var duplicateId = duplicateStableIdentity_(source);
  if (duplicateId) {
    return identityUnavailable_('stable-identity-duplicate-id');
  }
  var records;
  var resultLength;
  var offset;
  if (payload.scope === 'events') {
    offset = snapshotCursorOffset_(payload.cursor);
    resultLength = source.journalRows.length;
    if (offset > resultLength) {
      throw new Error('snapshot cursor is outside the result');
    }
    records = snapshotEventRecords_(source, offset, MAX_SNAPSHOT_RECORDS);
  } else {
    var allRecords = snapshotRecordsForScope_(source, payload.scope, revision);
    offset = snapshotCursorOffset_(payload.cursor);
    if (offset > allRecords.length) {
      throw new Error('snapshot cursor is outside the result');
    }
    resultLength = allRecords.length;
    records = allRecords.slice(offset, offset + MAX_SNAPSHOT_RECORDS);
  }
  var nextOffset = offset + records.length;
  return {
    scope: payload.scope,
    snapshotRevision: revision,
    records: records,
    continuation: nextOffset < resultLength
      ? { kind: 'cursor', cursor: String(nextOffset) }
      : { kind: 'end' },
    readAt: taipeiIsoNow_(),
  };
}

function lookup_(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('payload is required');
  }
  if (payload.scope !== undefined) {
    throw new Error('lookup scope is not supported');
  }
  if (!Array.isArray(payload.ids)) {
    throw new Error('lookup ids must be an array');
  }
  if (payload.snapshotRevision === undefined) {
    throw new Error('lookup requires snapshotRevision');
  }
  var ids = [];
  for (var idIndex = 0; idIndex < payload.ids.length; idIndex += 1) {
    var id = String(payload.ids[idIndex] || '').trim();
    if (!id) {
      throw new Error('lookup ids must be nonblank');
    }
    if (ids.indexOf(id) !== -1) {
      throw new Error('lookup ids must be unique');
    }
    ids.push(id);
  }

  var spreadsheet = SpreadsheetApp.openById(
    requiredProp_('LEDGER_SPREADSHEET_ID'),
  );
  var source = readSnapshotSource_(spreadsheet);
  if (!source.observationSchemaAvailable) {
    return identityUnavailable_('stable-identity-schema-unavailable');
  }
  var revision = snapshotRevision_(source);
  var expected = String(payload.snapshotRevision);
  if (expected !== revision) {
    return {
      kind: 'revision-changed',
      book: 'personal',
      expected: expected,
      actual: revision,
    };
  }

  var duplicateId = duplicateStableIdentity_(source);
  if (duplicateId) {
    return identityUnavailable_('stable-identity-duplicate-id');
  }
  var recordsByScope = {
    accounts: snapshotAccountRecords_(source, revision),
    events: snapshotEventRecords_(source),
    observations: snapshotObservationRecords_(source),
    links: e2SchemaAvailable_(spreadsheet) ? snapshotE2Records_(spreadsheet, 'links') : [],
  };
  var found = [];
  var missing = [];
  var unidentified = [];
  for (idIndex = 0; idIndex < ids.length; idIndex += 1) {
    id = ids[idIndex];
    var match = lookupRecordAcrossScopes_(recordsByScope, id);
    if (match.kind === 'missing') {
      missing.push(id);
      continue;
    }
    if (match.kind === 'ambiguous') {
      return identityUnavailable_('stable-identity-ambiguous-id');
    }
    if (match.kind === 'unidentified') {
      unidentified.push(id);
      continue;
    }
    found.push(match.record);
  }

  return {
    kind: 'ok',
    snapshotRevision: revision,
    records: found,
    missing: missing,
    unidentified: unidentified,
    readAt: taipeiIsoNow_(),
  };
}

function identityUnavailable_(reason) {
  return {
    kind: 'unavailable',
    book: 'personal',
    reason: reason,
  };
}

function snapshotRecordsForScope_(source, scope, revision) {
  if (scope === 'accounts') return snapshotAccountRecords_(source, revision);
  if (scope === 'observations') return snapshotObservationRecords_(source);
  throw new Error('unsupported snapshot record scope');
}

function isE2SnapshotScope_(scope) {
  return [
    'groups', 'event-groups', 'operations', 'claims', 'manifests', 'steps',
    'evidence', 'links', 'checkpoints', 'settings', 'results', 'records',
  ].indexOf(String(scope || '')) !== -1;
}

function lookupRecordAcrossScopes_(recordsByScope, id) {
  var identified = [];
  var unidentified = [];
  var scopes = ['accounts', 'events', 'observations', 'links'];
  for (var scopeIndex = 0; scopeIndex < scopes.length; scopeIndex += 1) {
    var scope = scopes[scopeIndex];
    var records = recordsByScope[scope];
    for (var index = 0; index < records.length; index += 1) {
      var record = records[index];
      if ((record.identity && record.identity.kind === 'identified' && record.id === id) ||
          (scope === 'links' && record.id === id)) {
        identified.push(record);
      } else if (scope === 'accounts' &&
          record.identity && record.identity.kind === 'unidentified' &&
          record.legacyId === id) {
        unidentified.push(record);
      } else if (scope === 'observations' &&
          record.identity && record.identity.kind === 'unidentified' &&
          record.persistedId === id) {
        unidentified.push(record);
      }
    }
  }
  if (identified.length === 1 && unidentified.length === 0) {
    return { kind: 'identified', record: identified[0] };
  }
  if (identified.length > 0 || unidentified.length > 1) {
    return { kind: 'ambiguous' };
  }
  if (unidentified.length === 1) {
    return { kind: 'unidentified' };
  }
  return { kind: 'missing' };
}

function identityRepairReference_(scope, row, contentDigest) {
  return {
    scope: scope,
    sheetRow: row.sheetRow,
    contentDigest: contentDigest === undefined
      ? identityContentDigest_(scope, row)
      : contentDigest,
  };
}

function adoptIdentity_(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('payload is required');
  }
  var operationId = String(payload.operationId || '').trim();
  if (!operationId) {
    throw new Error('operationId is required');
  }
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(operationId)) {
    throw new Error('operationId is invalid');
  }

  var expectedRevision = String(payload.expectedSnapshotRevision || '').trim();
  if (!expectedRevision) {
    throw new Error('expectedSnapshotRevision is required');
  }
  var reference = normalizeIdentityRepairReference_(payload);
  var stableId = String(payload.stableId || '').trim();
  if (!stableId) {
    throw new Error('stableId is required');
  }
  if (!/^[^\s]{1,256}$/.test(stableId)) {
    throw new Error('stableId is invalid');
  }
  if (reference.scope === 'events' && !UUID_PATTERN.test(stableId)) {
    throw new Error('stableId must be a UUID');
  }
  var fingerprint = digestHex_(Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    canonicalJson_({
      operationId: operationId,
      expectedSnapshotRevision: expectedRevision,
      stableId: stableId,
      repairReference: reference,
    }),
  ));

  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_WAIT_MILLISECONDS);
  try {
    requireFinancialOpen_(payload);
    var metadataSpreadsheet = SpreadsheetApp.openById(
      requiredProp_('LEDGER_SPREADSHEET_ID'),
    );
    if (!stableIdentityMetadataSchemaPresent_(metadataSpreadsheet)) {
      throw new Error('stable identity metadata schema is unavailable');
    }
    var properties = PropertiesService.getScriptProperties();
    var propertyKey = IDENTITY_ADOPTION_PROPERTY_PREFIX + operationId;
    var previousText = properties.getProperty(propertyKey);
    var previous = null;
    if (previousText) {
      try {
        previous = JSON.parse(previousText);
      } catch (error) {
        throw new Error('identity adoption state unavailable');
      }
      if (!previous || previous.fingerprint !== fingerprint) {
        return identityConflict_(
          operationId,
          'operation-content-changed',
          'operation id already used with different content',
        );
      }
      if (previous.status === 'committed' && previous.result) {
        return withAlready_(previous.result);
      }
      if (previous.status !== 'pending') {
        throw new Error('identity adoption state unavailable');
      }
    }

    var spreadsheet = metadataSpreadsheet;
    var source = readSnapshotSource_(spreadsheet);
    if (!source.observationSchemaAvailable) {
      return identityConflict_(
        operationId,
        'stable-identity-schema-unavailable',
        'stable identity metadata schema is unavailable',
      );
    }
    var duplicateId = duplicateStableIdentity_(source);
    if (duplicateId) {
      return identityConflict_(
        operationId,
        'duplicate-stable-id',
        'persisted stable identity is duplicated',
        { stableId: duplicateId },
      );
    }
    var actualRevision = snapshotRevision_(source);
    var revisionChanged = actualRevision !== expectedRevision;
    if (revisionChanged && !previous) {
      return identityConflict_(
        operationId,
        'revision-changed',
        'snapshot revision changed before identity adoption',
        { expectedSnapshotRevision: expectedRevision, actualSnapshotRevision: actualRevision },
      );
    }
    var target = resolveIdentityRepairTarget_(source, reference);
    if (target.error) {
      return identityConflict_(operationId, target.error, target.detail);
    }
    if (target.scope === 'observations' && !observationEvidenceValid_(target.row)) {
      return identityConflict_(
        operationId,
        'invalid-observation-evidence',
        'observation source reference and content digest are required',
      );
    }
    if (target.contentDigest !== reference.contentDigest) {
      return identityConflict_(
        operationId,
        'content-changed',
        'repair target content changed',
        { expectedContentDigest: reference.contentDigest, actualContentDigest: target.contentDigest },
      );
    }
    if (previous && target.identity === stableId) {
      var finalizedSource = readSnapshotSource_(spreadsheet);
      var finalizedResult = identityAdoptionResult_(
        target,
        stableId,
        finalizedSource,
        undefined,
        operationId,
      );
      properties.setProperty(propertyKey, JSON.stringify({
        status: 'committed',
        fingerprint: fingerprint,
        result: finalizedResult,
      }));
      return withAlready_(finalizedResult);
    }
    if (revisionChanged) {
      return identityConflict_(
        operationId,
        'revision-changed',
        'snapshot revision changed before identity adoption',
        { expectedSnapshotRevision: expectedRevision, actualSnapshotRevision: actualRevision },
      );
    }
    if (target.identity) {
      return identityConflict_(
        operationId,
        'target-already-identified',
        'repair target already has a stable identity',
      );
    }
    if (identityLookupExists_(source, target, stableId)) {
      return identityConflict_(
        operationId,
        'duplicate-stable-id',
        'stable identity is already used',
        { stableId: stableId },
      );
    }

    properties.setProperty(propertyKey, JSON.stringify({
      status: 'pending',
      fingerprint: fingerprint,
      operationId: operationId,
      expectedSnapshotRevision: expectedRevision,
      repairReference: reference,
      stableId: stableId,
    }));
    var changedField = adoptIdentityOnSheet_(spreadsheet, source, target, stableId);
    var updatedSource = readSnapshotSource_(spreadsheet);
    var result = identityAdoptionResult_(
      target,
      stableId,
      updatedSource,
      changedField,
      operationId,
    );
    properties.setProperty(propertyKey, JSON.stringify({
      status: 'committed',
      fingerprint: fingerprint,
      result: result,
    }));
    return result;
  } finally {
    lock.releaseLock();
  }
}

function normalizeIdentityRepairReference_(payload) {
  var supplied = payload.repairReference;
  if (!supplied || typeof supplied !== 'object') {
    throw new Error('repairReference is required');
  }
  var scope = normalizeIdentityScope_(supplied.scope);
  if (!scope) {
    throw new Error('repairReference scope is required');
  }
  var contentDigest = String(supplied.contentDigest || '').trim();
  if (!/^[0-9a-f]{64}$/.test(contentDigest)) {
    throw new Error('repairReference contentDigest is required');
  }
  var reference = {
    scope: scope,
    contentDigest: contentDigest,
  };
  var rowValue = supplied.sheetRow;
  if (rowValue !== undefined) {
    var sheetRow = Number(rowValue);
    if (!Number.isSafeInteger(sheetRow) || sheetRow < 2) {
      throw new Error('repairReference sheetRow is invalid');
    }
    reference.sheetRow = sheetRow;
  }
  return reference;
}

function normalizeIdentityScope_(value) {
  var text = String(value || '').trim();
  return text === 'accounts' || text === 'events' || text === 'observations'
    ? text
    : null;
}

function resolveIdentityRepairTarget_(source, reference) {
  var rows = reference.scope === 'accounts' && source.accountIdentityRows
    ? source.accountIdentityRows
    : identityRowsForScope_(source, reference.scope);
  var scopedCandidates = [];
  for (var index = 0; index < rows.length; index += 1) {
    var row = rows[index];
    if (reference.sheetRow !== undefined && row.sheetRow !== reference.sheetRow) {
      continue;
    }
    scopedCandidates.push(row);
  }
  var candidates = scopedCandidates.filter(function (row) {
    return identityContentDigest_(reference.scope, row) === reference.contentDigest;
  });
  if (candidates.length === 0 && scopedCandidates.length === 1) {
    var changedTarget = scopedCandidates[0];
    return {
      scope: reference.scope,
      sheetRow: changedTarget.sheetRow,
      row: changedTarget,
      identity: identityValueForScope_(reference.scope, changedTarget),
      contentDigest: identityContentDigest_(reference.scope, changedTarget),
    };
  }
  if (candidates.length === 0) {
    return { error: 'target-not-found', detail: 'no unambiguous repair target matched the reference' };
  }
  if (candidates.length !== 1) {
    return { error: 'ambiguous-target', detail: 'repair reference matched multiple rows' };
  }
  var target = candidates[0];
  return {
    scope: reference.scope,
    sheetRow: target.sheetRow,
    row: target,
    identity: identityValueForScope_(reference.scope, target),
    contentDigest: identityContentDigest_(reference.scope, target),
  };
}

function identityExists_(source, stableId) {
  var scopes = ['accounts', 'events', 'observations'];
  for (var scopeIndex = 0; scopeIndex < scopes.length; scopeIndex += 1) {
    var scope = scopes[scopeIndex];
    var rows = scope === 'accounts' && source.accountIdentityRows
      ? source.accountIdentityRows
      : identityRowsForScope_(source, scope);
    for (var index = 0; index < rows.length; index += 1) {
      if (identityValueForScope_(scope, rows[index]) === stableId) {
        return true;
      }
    }
  }
  return false;
}

function identityLookupExists_(source, target, stableId) {
  if (identityExists_(source, stableId)) {
    return true;
  }
  var accountRows = source.accountIdentityRows || source.vocabularyRows;
  for (var index = 0; index < accountRows.length; index += 1) {
    var row = accountRows[index];
    if (row.stableId || (row.type !== '資產' && row.type !== '負債') ||
        'account:' + row.name !== stableId) {
      continue;
    }
    if (target.scope === 'accounts' && row.sheetRow === target.sheetRow) {
      continue;
    }
    return true;
  }
  return false;
}

function duplicateStableIdentity_(source, scope) {
  var scopes = scope ? [scope] : ['accounts', 'events', 'observations'];
  var seen = Object.create(null);
  for (var scopeIndex = 0; scopeIndex < scopes.length; scopeIndex += 1) {
    var currentScope = scopes[scopeIndex];
    var rows = !scope && currentScope === 'accounts' && source.accountIdentityRows
      ? source.accountIdentityRows
      : identityRowsForScope_(source, currentScope);
    for (var index = 0; index < rows.length; index += 1) {
      var identity = identityValueForScope_(currentScope, rows[index]);
      if (!identity) {
        continue;
      }
      if (seen[identity]) {
        return identity;
      }
      seen[identity] = true;
    }
  }
  return null;
}

function identityRowsForScope_(source, scope) {
  if (scope === 'accounts') return source.vocabularyRows;
  if (scope === 'events') return source.journalRows;
  if (scope === 'observations') return source.observationRows;
  throw new Error('unsupported identity scope');
}

function identityValueForScope_(scope, row) {
  if (scope === 'accounts') return String(row.stableId || '').trim();
  if (scope === 'events') return String(row.values.txn_id || '').trim();
  return String(row.observationId || '').trim();
}

function adoptIdentityOnSheet_(spreadsheet, source, target, stableId) {
  if (target.scope === 'accounts') {
    if (source.accountStableIdColumn === null || source.accountStableIdColumn === undefined) {
      throw new Error('account identity metadata schema is unavailable');
    }
    requiredSheet_(spreadsheet, '會計科目')
      .getRange(target.sheetRow, source.accountStableIdColumn)
      .setValues([[stableId]]);
    return ACCOUNT_STABLE_ID_HEADER;
  }
  var sheet;
  var column;
  if (target.scope === 'events') {
    sheet = requiredSheet_(spreadsheet, '日記帳');
    column = source.journalColumns.txn_id;
  } else {
    sheet = requiredSheet_(spreadsheet, OBSERVATION_SHEET_NAME);
    column = target.row.observationIdColumn;
  }
  if (column === null || column === undefined) {
    throw new Error('source identity metadata schema is unavailable');
  }
  sheet.getRange(target.sheetRow, column).setValues([[stableId]]);
  return target.scope === 'events' ? 'txn_id' : OBSERVATION_ID_HEADER;
}

function identityAdoptionResult_(target, stableId, source, changedField, operationId) {
  return {
    ok: true,
    kind: 'committed',
    operationId: operationId,
    scope: target.scope,
    stableId: stableId,
    sheetRow: target.sheetRow,
    changedField: changedField || identityColumnName_(target.scope),
    snapshotRevision: snapshotRevision_(source),
  };
}

function identityColumnName_(scope) {
  if (scope === 'accounts') return ACCOUNT_STABLE_ID_HEADER;
  if (scope === 'events') return 'txn_id';
  return OBSERVATION_ID_HEADER;
}

function identityConflict_(operationId, reason, detail, extra) {
  var result = {
    ok: false,
    kind: 'conflict',
    operationId: operationId,
    reason: reason,
    error: detail,
  };
  if (extra) {
    for (var key in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, key)) {
        result[key] = extra[key];
      }
    }
  }
  return result;
}

function canonicalJson_(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson_).join(',') + ']';
  }
  var keys = Object.keys(value).sort();
  var entries = [];
  for (var index = 0; index < keys.length; index += 1) {
    var key = keys[index];
    entries.push(JSON.stringify(key) + ':' + canonicalJson_(value[key]));
  }
  return '{' + entries.join(',') + '}';
}

function readSnapshotSource_(spreadsheet) {
  var accountSheet = requiredSheet_(spreadsheet, '會計科目');
  var accountValues = accountSheet
    .getRange(1, 1, accountSheet.getLastRow(), accountSheet.getLastColumn())
    .getDisplayValues();
  var accountColumns = resolveHeaders_(accountValues[0], [
    '名稱',
    '類型',
    '子類型',
    '啟用',
    '排序',
  ]);
  var vocabularyRows = [];
  var accountIdentityRows = [];
  var accountAliasRows = [];
  var accountTypes = Object.create(null);
  var accountStableIdColumn = optionalMetadataColumn_(
    accountSheet,
    ACCOUNT_STABLE_ID_HEADER,
  );
  var accountAliasesColumn = optionalMetadataColumn_(
    accountSheet,
    ACCOUNT_ALIASES_HEADER,
  );
  for (var accountIndex = 1; accountIndex < accountValues.length; accountIndex += 1) {
    var accountRow = accountValues[accountIndex];
    var accountName = String(accountRow[accountColumns['名稱'] - 1] || '').trim();
    var accountType = String(accountRow[accountColumns['類型'] - 1] || '').trim();
    var accountEnabled = isTrue_(accountRow[accountColumns['啟用'] - 1]);
    if (accountEnabled && !accountName) {
      throw new Error('enabled account name is required at row ' + (accountIndex + 1));
    }
    if (accountName) {
      if (Object.prototype.hasOwnProperty.call(accountTypes, accountName)) {
        throw new Error('duplicate account name: ' + accountName);
      }
      accountTypes[accountName] = accountType;
    }
    var accountAliases = accountAliasesColumn === null
      ? []
      : parseAccountAliases_(accountRow[accountAliasesColumn - 1], accountIndex + 1);
    accountAliasRows.push({
      name: accountName,
      type: accountType,
      enabled: accountEnabled,
      aliases: accountAliases,
    });
    var identityRow = {
      sheetRow: accountIndex + 1,
      cells: accountRow,
      name: accountName,
      type: accountType,
      aliases: accountAliases,
      stableIdColumn: accountStableIdColumn,
      stableId: accountStableIdColumn === null
        ? ''
        : String(accountRow[accountStableIdColumn - 1] || '').trim(),
    };
    accountIdentityRows.push(identityRow);
    if (accountEnabled) {
      vocabularyRows.push(identityRow);
    }
  }

  var aliasOwners = Object.create(null);
  for (var aliasRowIndex = 0; aliasRowIndex < accountAliasRows.length; aliasRowIndex += 1) {
    var aliasRow = accountAliasRows[aliasRowIndex];
    for (var aliasIndex = 0; aliasIndex < aliasRow.aliases.length; aliasIndex += 1) {
      var alias = aliasRow.aliases[aliasIndex];
      if (alias === aliasRow.name ||
          Object.prototype.hasOwnProperty.call(accountTypes, alias) ||
          Object.prototype.hasOwnProperty.call(aliasOwners, alias)) {
        throw new Error('ambiguous account alias: ' + alias);
      }
      aliasOwners[alias] = aliasRow.name;
      accountTypes[alias] = aliasRow.type;
    }
  }

  var journal = requiredSheet_(spreadsheet, '日記帳');
  var journalLastRow = journal.getLastRow();
  var journalLastColumn = journal.getLastColumn();
  var journalHeader = journal
    .getRange(1, 1, 1, journalLastColumn)
    .getDisplayValues()[0];
  var journalColumns = resolveHeaders_(journalHeader, JOURNAL_HEADERS);
  var journalRows = [];
  if (journalLastRow >= 2) {
    var journalRange = journal.getRange(
      2,
      1,
      journalLastRow - 1,
      journalLastColumn,
    );
    var rawRows = journalRange.getValues();
    var displayed = journalRange.getDisplayValues();
    for (var rowIndex = 0; rowIndex < displayed.length; rowIndex += 1) {
      if (!snapshotRowHasData_(displayed[rowIndex], rawRows[rowIndex])) {
        continue;
      }
      var values = {};
      for (var headerIndex = 0; headerIndex < JOURNAL_HEADERS.length; headerIndex += 1) {
        var header = JOURNAL_HEADERS[headerIndex];
        values[header] = displayed[rowIndex][journalColumns[header] - 1];
      }
      var snapshotRow = {
        sheetRow: rowIndex + 2,
        cells: { raw: rawRows[rowIndex], displayed: displayed[rowIndex] },
        values: values,
        rawAmount: rawRows[rowIndex][journalColumns['金額'] - 1],
        txnIdColumn: journalColumns.txn_id,
      };
      validateSnapshotJournalRow_(snapshotRow, accountTypes);
      journalRows.push(snapshotRow);
    }
  }

  var observationRows = [];
  var observationSchemaAvailable = false;
  var observationSheet = spreadsheet.getSheetByName(OBSERVATION_SHEET_NAME);
  var observationColumns = null;
  if (observationSheet && observationSheet.getLastColumn() > 0) {
    var observationLastRow = observationSheet.getLastRow();
    var observationLastColumn = observationSheet.getLastColumn();
    var observationHeader = observationSheet
      .getRange(1, 1, 1, observationLastColumn)
      .getDisplayValues()[0];
    try {
      observationColumns = resolveHeaders_(observationHeader, OBSERVATION_HEADERS);
      observationSchemaAvailable = true;
    } catch (error) {
      observationColumns = null;
    }
    if (observationSchemaAvailable && observationLastRow >= 2) {
      var observationRange = observationSheet.getRange(
        2,
        1,
        observationLastRow - 1,
        observationLastColumn,
      );
      var observationRawRows = observationRange.getValues();
      var observationDisplayedRows = observationRange.getDisplayValues();
      for (var observationIndex = 0;
        observationIndex < observationDisplayedRows.length;
        observationIndex += 1) {
        if (!snapshotRowHasData_(
          observationDisplayedRows[observationIndex],
          observationRawRows[observationIndex],
        )) {
          continue;
        }
        var observationValues = {};
        for (var observationHeaderIndex = 0;
          observationHeaderIndex < OBSERVATION_HEADERS.length;
          observationHeaderIndex += 1) {
          var observationHeaderName = OBSERVATION_HEADERS[observationHeaderIndex];
          observationValues[observationHeaderName] = observationDisplayedRows[observationIndex][
            observationColumns[observationHeaderName] - 1
          ];
        }
        observationRows.push({
          sheetRow: observationIndex + 2,
          cells: {
            raw: observationRawRows[observationIndex],
            displayed: observationDisplayedRows[observationIndex],
          },
          values: observationValues,
          observationIdColumn: observationColumns[OBSERVATION_ID_HEADER],
          observationId: String(
            observationDisplayedRows[observationIndex][
              observationColumns[OBSERVATION_ID_HEADER] - 1
            ] || '',
          ).trim(),
        });
      }
    }
  }

  return {
    accountColumns: accountColumns,
    accountStableIdColumn: accountStableIdColumn,
    accountIdentityRows: accountIdentityRows,
    vocabularyRows: vocabularyRows,
    journalRows: journalRows,
    journalColumns: journalColumns,
    observationRows: observationRows,
    observationSchemaAvailable: observationSchemaAvailable,
    extendedRows: readE2TableRows_(spreadsheet),
    groupByTxnId: readE2GroupIndex_(spreadsheet),
    reviewByTxnId: readE2ReviewIndex_(spreadsheet),
  };
}

function parseAccountAliases_(value, sheetRow) {
  var text = value === null || value === undefined ? '' : String(value).trim();
  if (!text) {
    return [];
  }
  var parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error('invalid account aliases at row ' + sheetRow);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('invalid account aliases at row ' + sheetRow);
  }
  var aliases = [];
  for (var index = 0; index < parsed.length; index += 1) {
    if (typeof parsed[index] !== 'string' || !parsed[index].trim()) {
      throw new Error('invalid account aliases at row ' + sheetRow);
    }
    var alias = parsed[index].trim();
    if (aliases.indexOf(alias) !== -1) {
      throw new Error('invalid account aliases at row ' + sheetRow);
    }
    aliases.push(alias);
  }
  if (JSON.stringify(aliases) !== JSON.stringify(parsed)) {
    throw new Error('invalid account aliases at row ' + sheetRow);
  }
  return aliases;
}

function identityContentDigest_(scope, row) {
  var cells = row && row.cells && row.cells.raw
    ? row.cells.raw.slice()
    : row && row.cells
      ? row.cells.slice()
      : [];
  if (scope === 'events' && row && row.txnIdColumn !== null &&
      row.txnIdColumn !== undefined) {
    cells[row.txnIdColumn - 1] = '';
  } else if (scope === 'observations' && row &&
      row.observationIdColumn !== null &&
      row.observationIdColumn !== undefined) {
    cells[row.observationIdColumn - 1] = '';
  } else if (scope === 'accounts' && row && row.stableIdColumn !== null &&
      row.stableIdColumn !== undefined) {
    cells[row.stableIdColumn - 1] = '';
  }
  return digestHex_(Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    JSON.stringify({ scope: scope, cells: cells }),
  ));
}

function validateSnapshotJournalRow_(row, accountTypes) {
  var values = row.values;
  var financialDate = String(values['日期'] || '').trim();
  if (!financialDate) {
    throw new Error(
      'invalid journal row at row ' + row.sheetRow + ': financial date is required',
    );
  }
  if (!snapshotFinancialDateIsValid_(financialDate)) {
    throw new Error(
      'invalid journal row at row ' + row.sheetRow + ': financial date is invalid',
    );
  }
  if (!String(values['類型'] || '').trim()) {
    throw new Error(
      'invalid journal row at row ' + row.sheetRow + ': type is required',
    );
  }
  var debit = String(values['借方帳戶'] || '').trim();
  var credit = String(values['貸方帳戶'] || '').trim();
  if (!debit) {
    throw new Error(
      'invalid journal row at row ' + row.sheetRow + ': debit account is required',
    );
  }
  if (!credit) {
    throw new Error(
      'invalid journal row at row ' + row.sheetRow + ': credit account is required',
    );
  }
  if (!Object.prototype.hasOwnProperty.call(accountTypes, debit)) {
    throw new Error(
      'invalid journal row at row ' + row.sheetRow + ': unknown or disabled debit account',
    );
  }
  if (!Object.prototype.hasOwnProperty.call(accountTypes, credit)) {
    throw new Error(
      'invalid journal row at row ' + row.sheetRow + ': unknown or disabled credit account',
    );
  }
  var debitType = accountTypes[debit];
  var creditType = accountTypes[credit];
  if (
    debitType !== '資產' && debitType !== '負債' &&
    creditType !== '資產' && creditType !== '負債'
  ) {
    throw new Error(
      'invalid journal row at row ' + row.sheetRow + ': no asset or liability account',
    );
  }
  var amount = canonicalDecimal_(row.rawAmount, row.sheetRow);
  if (amount === '0' || amount.charAt(0) === '-') {
    throw new Error('journal amount must be positive at row ' + row.sheetRow);
  }
  row.amount = amount;
  var currency = String(values['幣別'] || '').trim();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new Error(
      'invalid journal row at row ' + row.sheetRow + ': currency must be ISO 4217',
    );
  }
}

function snapshotFinancialDateIsValid_(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  var parsed = new Date(value + 'T00:00:00.000Z');
  return !isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function snapshotRowHasData_(displayed, raw) {
  var length = Math.max(displayed.length, raw.length);
  for (var index = 0; index < length; index += 1) {
    if (snapshotCellHasData_(displayed[index]) || snapshotCellHasData_(raw[index])) {
      return true;
    }
  }
  return false;
}

function snapshotCellHasData_(value) {
  return value !== '' && value !== null && value !== undefined;
}

function snapshotRevision_(source) {
  var revisionInput = {
    vocabulary: source.accountIdentityRows || source.vocabularyRows,
    journal: source.journalRows.map(function (row) {
      return { sheetRow: row.sheetRow, cells: row.cells };
    }),
    observations: source.observationRows.map(function (row) {
      return { sheetRow: row.sheetRow, cells: row.cells };
    }),
    extended: source.extendedRows || [],
  };
  return digestHex_(Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    JSON.stringify(revisionInput),
  ));
}

function snapshotAccountRecords_(source, revision) {
  if (revision === undefined) {
    revision = snapshotRevision_(source);
  }
  var columns = source.accountColumns;
  var accounts = [];
  for (var index = 0; index < source.vocabularyRows.length; index += 1) {
    var cells = source.vocabularyRows[index].cells;
    var stableId = source.vocabularyRows[index].stableId || '';
    var type = String(cells[columns['類型'] - 1] || '').trim();
    if (type !== '資產' && type !== '負債') {
      continue;
    }
    var sort = Number(cells[columns['排序'] - 1]);
    accounts.push({
      id: stableId || 'account:' + String(cells[columns['名稱'] - 1] || '').trim(),
      legacyId: 'account:' + String(cells[columns['名稱'] - 1] || '').trim(),
      stableId: stableId || null,
      identity: stableId
        ? { kind: 'identified', stableId: stableId }
        : { kind: 'unidentified', reason: 'missing-stable-id' },
      sourceRow: source.vocabularyRows[index],
      name: String(cells[columns['名稱'] - 1] || '').trim(),
      aliases: source.vocabularyRows[index].aliases || [],
      type: type,
      subtype: String(cells[columns['子類型'] - 1] || '').trim(),
      enabled: true,
      sort: sort,
      balanceByCurrency: Object.create(null),
    });
  }
  accounts.sort(compareVocabularyOptions_);

  var financialCutoff = null;
  for (index = 0; index < source.journalRows.length; index += 1) {
    var row = source.journalRows[index];
    var date = String(row.values['日期'] || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) &&
        (financialCutoff === null || date > financialCutoff)) {
      financialCutoff = date;
    }
    for (var accountIndex = 0; accountIndex < accounts.length; accountIndex += 1) {
      var rowTxnId = String(row.values.txn_id || '').trim();
      var rowGroup = source.groupByTxnId && source.groupByTxnId[rowTxnId];
      if (rowGroup && rowGroup.status !== 'complete') {
        continue;
      }
      applySnapshotBalanceRow_(accounts[accountIndex], row);
    }
  }

  var sourceRowCount = source.journalRows.length;
  var sourceLastRow = sourceRowCount === 0
    ? 0
    : source.journalRows[sourceRowCount - 1].sheetRow;
  var records = [];
  for (index = 0; index < accounts.length; index += 1) {
    var account = accounts[index];
    var currencies = Object.keys(account.balanceByCurrency).sort();
    var balances = [];
    for (var currencyIndex = 0; currencyIndex < currencies.length; currencyIndex += 1) {
      var currency = currencies[currencyIndex];
      balances.push({
        amount: account.balanceByCurrency[currency],
        currency: currency,
      });
    }
    records.push({
      id: account.id,
      legacyId: account.legacyId,
      stableId: account.stableId,
      identity: account.identity,
      contentDigest: identityContentDigest_('accounts', account.sourceRow),
      repairReference: identityRepairReference_('accounts', account.sourceRow),
      name: account.name,
      aliases: account.aliases,
      type: account.type,
      subtype: account.subtype,
      enabled: true,
      sort: account.sort,
      balances: balances,
      financialCutoff: {
        basis: 'all-posted-journal-entries',
        throughFinancialDate: financialCutoff,
      },
      completion: {
        kind: 'complete',
        source: '日記帳',
        sourceRowCount: sourceRowCount,
        sourceLastRow: sourceLastRow,
        snapshotRevision: revision,
      },
    });
  }
  return records;
}

function snapshotEventRecords_(source, offset, limit) {
  var records = [];
  var start = offset === undefined ? 0 : offset;
  var end = limit === undefined
    ? source.journalRows.length
    : Math.min(source.journalRows.length, start + limit);
  for (var index = start; index < end; index += 1) {
    var row = source.journalRows[index];
    var values = row.values;
    var txnId = String(values.txn_id || '').trim();
    var contentDigest = identityContentDigest_('events', row);
    records.push({
      id: txnId || null,
      identity: txnId
        ? { kind: 'identified', txnId: txnId }
        : { kind: 'unidentified', reason: 'blank-txn-id' },
      financialDate: String(values['日期'] || '').trim(),
      time: String(values['時間'] || '').trim(),
      type: String(values['類型'] || '').trim(),
      debitAccount: String(values['借方帳戶'] || '').trim(),
      creditAccount: String(values['貸方帳戶'] || '').trim(),
      amount: {
        amount: row.amount,
        currency: String(values['幣別'] || '').trim(),
      },
      category: String(values['分類'] || '').trim(),
      counterparty: String(values['交易對象'] || '').trim(),
      description: String(values['說明'] || '').trim(),
      settlementStatus: String(values['結清狀態'] || '').trim(),
      reversalTxnId: String(values['沖銷txn_id'] || '').trim(),
      source: String(values['來源'] || '').trim(),
      createdAt: String(values['建立時間'] || '').trim(),
      sheetRow: row.sheetRow,
      contentDigest: contentDigest,
      repairReference: identityRepairReference_('events', row, contentDigest),
    });
    var group = source.groupByTxnId && source.groupByTxnId[txnId];
    if (group) {
      records[records.length - 1].groupId = group.groupId;
      records[records.length - 1].groupCompletion = group.status;
      records[records.length - 1].groupCurrency = group.currency;
    }
    var review = source.reviewByTxnId && source.reviewByTxnId[txnId];
    if (review) {
      if (review.category !== '') records[records.length - 1].category = review.category;
      records[records.length - 1].reviewState = review.reviewState;
      records[records.length - 1].review_state = review.reviewState;
      records[records.length - 1].reviewRevision = review.revision;
      records[records.length - 1].review = {
        state: review.reviewState,
        category: review.category,
        updatedAt: review.updatedAt || null,
        confirmedAt: review.reviewState === 'confirmed' ? (review.updatedAt || null) : null,
      };
    }
  }
  return records;
}

function snapshotObservationRecords_(source) {
  var records = [];
  for (var index = 0; index < source.observationRows.length; index += 1) {
    var row = source.observationRows[index];
    var observationId = row.observationId;
    var sourceReference = String(row.values.source_reference || '').trim();
    var sourceContentDigest = String(row.values.content_digest || '').trim();
    var evidenceValid = observationEvidenceValid_(row);
    var usableId = evidenceValid && observationId ? observationId : '';
    var identityReason = !evidenceValid
      ? 'invalid-observation-evidence'
      : 'blank-observation-id';
    records.push({
      id: usableId || null,
      persistedId: observationId || null,
      identity: usableId
        ? { kind: 'identified', observationId: usableId }
        : { kind: 'unidentified', reason: identityReason },
      sourceReference: sourceReference,
      sourceContentDigest: sourceContentDigest,
      sheetRow: row.sheetRow,
      contentDigest: identityContentDigest_('observations', row),
      repairReference: identityRepairReference_('observations', row),
    });
  }
  return records;
}

function observationEvidenceValid_(row) {
  if (!row || !row.values) {
    return false;
  }
  var sourceReference = String(row.values.source_reference || '').trim();
  var contentDigest = String(row.values.content_digest || '').trim();
  return sourceReference !== '' && /^[0-9a-f]{64}$/i.test(contentDigest);
}

function applySnapshotBalanceRow_(account, row) {
  var debit = accountNameMatches_(account, row.values['借方帳戶']);
  var credit = accountNameMatches_(account, row.values['貸方帳戶']);
  if (!debit && !credit) {
    return;
  }
  var currency = String(row.values['幣別'] || '').trim();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new Error('invalid journal currency at row ' + row.sheetRow);
  }
  var amount = row.amount;
  var balance = account.balanceByCurrency[currency] || '0';
  if (account.type === '資產') {
    if (debit) balance = addDecimalStrings_(balance, amount);
    if (credit) balance = addDecimalStrings_(balance, negateDecimal_(amount));
  } else {
    if (credit) balance = addDecimalStrings_(balance, amount);
    if (debit) balance = addDecimalStrings_(balance, negateDecimal_(amount));
  }
  account.balanceByCurrency[currency] = balance;
}

function accountBalanceThroughCutoff_(source, accountName, currency, cutoff) {
  var columns = source.accountColumns;
  var account = null;
  for (var accountIndex = 0; accountIndex < source.vocabularyRows.length; accountIndex += 1) {
    var vocabularyRow = source.vocabularyRows[accountIndex];
    var cells = vocabularyRow.cells;
    var name = String(cells[columns['名稱'] - 1] || '').trim();
    var aliases = vocabularyRow.aliases || [];
    var type = String(cells[columns['類型'] - 1] || '').trim();
    if ((name === accountName || aliases.indexOf(accountName) !== -1 || vocabularyRow.stableId === accountName) &&
        (type === '資產' || type === '負債')) {
      account = { name: name, aliases: aliases, type: type, balanceByCurrency: Object.create(null) };
      break;
    }
  }
  if (!account) return '0';
  for (var rowIndex = 0; rowIndex < source.journalRows.length; rowIndex += 1) {
    var row = source.journalRows[rowIndex];
    var date = String(row.values['日期'] || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > cutoff) continue;
    var rowTxnId = String(row.values.txn_id || '').trim();
    var rowGroup = source.groupByTxnId && source.groupByTxnId[rowTxnId];
    if (rowGroup && rowGroup.status !== 'complete') continue;
    applySnapshotBalanceRow_(account, row);
  }
  return account.balanceByCurrency[currency] || '0';
}

function accountNameMatches_(account, value) {
  var name = String(value || '').trim();
  return name === account.name || (account.aliases || []).indexOf(name) !== -1;
}

function snapshotCursorOffset_(cursor) {
  if (cursor === undefined) {
    return 0;
  }
  var text = String(cursor);
  if (!/^(0|[1-9]\d*)$/.test(text)) {
    throw new Error('invalid snapshot cursor');
  }
  var offset = Number(text);
  if (!Number.isSafeInteger(offset)) {
    throw new Error('invalid snapshot cursor');
  }
  return offset;
}

function canonicalDecimal_(value, sheetRow) {
  var text = String(value === null || value === undefined ? '' : value).trim();
  if (text.indexOf(',') !== -1 &&
      !/^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d*)?$/.test(text)) {
    throw new Error('invalid journal amount at row ' + sheetRow);
  }
  text = text.replace(/,/g, '');
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) {
    throw new Error('invalid journal amount at row ' + sheetRow);
  }
  var negative = text.charAt(0) === '-';
  if (text.charAt(0) === '-' || text.charAt(0) === '+') {
    text = text.slice(1);
  }
  var parts = text.split('.');
  var whole = (parts[0] || '0').replace(/^0+(?=\d)/, '');
  var fraction = (parts[1] || '').replace(/0+$/, '');
  var canonical = fraction ? whole + '.' + fraction : whole;
  if (/^0(?:\.0*)?$/.test(canonical)) {
    return '0';
  }
  return negative ? '-' + canonical : canonical;
}

function negateDecimal_(value) {
  if (value === '0') return value;
  return value.charAt(0) === '-' ? value.slice(1) : '-' + value;
}

function addDecimalStrings_(left, right) {
  var leftParts = decimalParts_(left);
  var rightParts = decimalParts_(right);
  var scale = Math.max(leftParts.scale, rightParts.scale);
  var leftDigits = leftParts.digits + repeatZero_(scale - leftParts.scale);
  var rightDigits = rightParts.digits + repeatZero_(scale - rightParts.scale);
  var negative;
  var digits;
  if (leftParts.negative === rightParts.negative) {
    negative = leftParts.negative;
    digits = addUnsignedDigits_(leftDigits, rightDigits);
  } else {
    var comparison = compareUnsignedDigits_(leftDigits, rightDigits);
    if (comparison === 0) return '0';
    if (comparison > 0) {
      negative = leftParts.negative;
      digits = subtractUnsignedDigits_(leftDigits, rightDigits);
    } else {
      negative = rightParts.negative;
      digits = subtractUnsignedDigits_(rightDigits, leftDigits);
    }
  }
  return decimalFromParts_(negative, digits, scale);
}

function decimalParts_(value) {
  var negative = value.charAt(0) === '-';
  var unsigned = negative ? value.slice(1) : value;
  var parts = unsigned.split('.');
  return {
    negative: negative,
    digits: ((parts[0] || '0') + (parts[1] || '')).replace(/^0+(?=\d)/, ''),
    scale: (parts[1] || '').length,
  };
}

function decimalFromParts_(negative, digits, scale) {
  digits = digits.replace(/^0+(?=\d)/, '');
  while (digits.length <= scale) digits = '0' + digits;
  var whole = scale === 0 ? digits : digits.slice(0, digits.length - scale);
  var fraction = scale === 0 ? '' : digits.slice(digits.length - scale);
  fraction = fraction.replace(/0+$/, '');
  var value = fraction ? whole + '.' + fraction : whole;
  if (/^0(?:\.0*)?$/.test(value)) return '0';
  return negative ? '-' + value : value;
}

function repeatZero_(count) {
  var result = '';
  while (count > 0) {
    result += '0';
    count -= 1;
  }
  return result;
}

function compareUnsignedDigits_(left, right) {
  left = left.replace(/^0+(?=\d)/, '');
  right = right.replace(/^0+(?=\d)/, '');
  if (left.length !== right.length) return left.length > right.length ? 1 : -1;
  if (left === right) return 0;
  return left > right ? 1 : -1;
}

function addUnsignedDigits_(left, right) {
  var carry = 0;
  var result = '';
  var leftIndex = left.length - 1;
  var rightIndex = right.length - 1;
  while (leftIndex >= 0 || rightIndex >= 0 || carry > 0) {
    var sum = carry;
    if (leftIndex >= 0) sum += Number(left.charAt(leftIndex));
    if (rightIndex >= 0) sum += Number(right.charAt(rightIndex));
    result = String(sum % 10) + result;
    carry = Math.floor(sum / 10);
    leftIndex -= 1;
    rightIndex -= 1;
  }
  return result;
}

function subtractUnsignedDigits_(larger, smaller) {
  var borrow = 0;
  var result = '';
  var smallerIndex = smaller.length - 1;
  for (var index = larger.length - 1; index >= 0; index -= 1) {
    var difference = Number(larger.charAt(index)) - borrow;
    if (smallerIndex >= 0) difference -= Number(smaller.charAt(smallerIndex));
    if (difference < 0) {
      difference += 10;
      borrow = 1;
    } else {
      borrow = 0;
    }
    result = String(difference) + result;
    smallerIndex -= 1;
  }
  return result.replace(/^0+(?=\d)/, '');
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
    values.txn_id = normalizeTxnId_(values.txn_id);
    values['沖銷txn_id'] = normalizeTxnId_(values['沖銷txn_id']);
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
  var normalizedTxnId = normalizeTxnId_(txnId);
  if (!normalizedTxnId) {
    return null;
  }
  for (var index = 0; index < records.length; index += 1) {
    if (normalizeTxnId_(records[index].values.txn_id) === normalizedTxnId) {
      return records[index];
    }
  }
  return null;
}

function checkConsistency_(payload, nonce) {
  var repair = Boolean(payload && payload.repair === true);
  if (!repair) {
    return runConsistencyAudit_(false);
  }
  requireField_(payload, 'idempotencyKey');
  var idempotencyKey = String(payload.idempotencyKey);
  if (idempotencyKey !== nonce) {
    throw new Error('idempotencyKey must match nonce');
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_WAIT_MILLISECONDS);
  try {
    requireFinancialOpen_(payload);
    var spreadsheet = SpreadsheetApp.openById(
      requiredProp_('LEDGER_SPREADSHEET_ID'),
    );
    var journal = requiredSheet_(spreadsheet, '日記帳');
    var headerRow = journal
      .getRange(1, 1, 1, journal.getLastColumn())
      .getDisplayValues()[0];
    var columns = resolveHeaders_(headerRow, JOURNAL_HEADERS);
    if (findTxnRow_(journal, columns.txn_id, idempotencyKey) !== null) {
      throw new Error('idempotency key already used by journal');
    }

    var properties = PropertiesService.getScriptProperties();
    var propertyKey = 'repair:' + idempotencyKey;
    var existing = properties.getProperty(propertyKey);
    if (existing) {
      if (existing === 'complete') {
        throw new Error('repair key already completed; run a read-only audit');
      }
      throw new Error('repair outcome unknown for idempotency key');
    }

    // Establish read/validation failures before reserving the key or writing.
    runConsistencyAudit_(false);
    properties.setProperty(propertyKey, 'pending');
    var result = runConsistencyAudit_(true);
    properties.setProperty(propertyKey, 'complete');
    return result;
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
    requireFinancialOpen_(payload);
    if (PropertiesService.getScriptProperties().getProperty('repair:' + idempotencyKey)) {
      throw new Error('idempotency key already used for repair');
    }
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
    requireFinancialOpen_(payload);
    if (PropertiesService.getScriptProperties().getProperty('repair:' + idempotencyKey)) {
      throw new Error('idempotency key already used for repair');
    }
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
    var targetTxnId = requiredTxnId_(payload);
    var original = findRecordByTxnId_(records, targetTxnId);
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
    requireFinancialOpen_(payload);
    if (PropertiesService.getScriptProperties().getProperty('repair:' + idempotencyKey)) {
      throw new Error('idempotency key already used for repair');
    }
    var cache = CacheService.getScriptCache();
    var nonceKey = 'nonce:' + nonce;
    var storedResult = cache.get(nonceKey);

    var spreadsheet = SpreadsheetApp.openById(
      requiredProp_('LEDGER_SPREADSHEET_ID'),
    );
    var journal = requiredSheet_(spreadsheet, '日記帳');
    var headerRow = journal
      .getRange(1, 1, 1, journal.getLastColumn())
      .getDisplayValues()[0];
    var journalColumns = resolveHeaders_(headerRow, JOURNAL_HEADERS);
    var records = readJournalRecords_(journal, journalColumns);
    var targetTxnId = requiredTxnId_(payload);
    var index;
    var ownRecord = findRecordByTxnId_(records, idempotencyKey);
    if (ownRecord !== null) {
      if (ownRecord.values['類型'] !== '沖銷' ||
          ownRecord.values['沖銷txn_id'] !== targetTxnId) {
        throw new Error('idempotency key already used for another reversal');
      }
      var durableResult = {
        ok: true, txn_id: idempotencyKey, row: ownRecord.sheetRow, already: true,
      };
      cache.put(nonceKey, JSON.stringify(durableResult), NONCE_CACHE_SECONDS);
      return durableResult;
    }
    if (storedResult) {
      throw new Error('cached reversal has no durable row');
    }

    for (index = 0; index < records.length; index += 1) {
      if (
        records[index].values['類型'] === '沖銷' &&
        records[index].values['沖銷txn_id'] === targetTxnId
      ) {
        return {
          ok: true, txn_id: records[index].values.txn_id, row: records[index].sheetRow, already: true,
        };
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
  var aliasesColumn = optionalMetadataColumn_(sheet, ACCOUNT_ALIASES_HEADER);
  var accountTypes = Object.create(null);
  var enabled = Object.create(null);
  var aliasEntries = [];

  for (var rowIndex = 1; rowIndex < values.length; rowIndex += 1) {
    var row = values[rowIndex];
    var name = String(row[columns['名稱'] - 1] || '').trim();
    if (!name) {
      continue;
    }
    accountTypes[name] = String(row[columns['類型'] - 1] || '').trim();
    enabled[name] = isTrue_(row[columns['啟用'] - 1]);
    var aliases = aliasesColumn === null ? [] : parseAccountAliases_(
      row[aliasesColumn - 1],
      rowIndex + 1,
    );
    for (var aliasIndex = 0; aliasIndex < aliases.length; aliasIndex += 1) {
      aliasEntries.push({
        alias: aliases[aliasIndex],
        type: accountTypes[name],
        enabled: enabled[name],
      });
    }
  }

  for (var entryIndex = 0; entryIndex < aliasEntries.length; entryIndex += 1) {
    var entry = aliasEntries[entryIndex];
    if (Object.prototype.hasOwnProperty.call(accountTypes, entry.alias) ||
        Object.prototype.hasOwnProperty.call(enabled, entry.alias)) {
      throw new Error('ambiguous account alias: ' + entry.alias);
    }
    accountTypes[entry.alias] = entry.type;
    enabled[entry.alias] = entry.enabled;
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

function validateE2Posting_(posting, vocabulary, expectedSource) {
  var txnId = String(posting && posting.txn_id || '').trim();
  if (!UUID_PATTERN.test(txnId)) {
    throw new Error('E2 txn_id must be an explicit UUID');
  }
  var source = String(posting && posting['來源'] || '').trim();
  if (source !== String(expectedSource || 'import')) {
    throw new Error('E2 posting source is invalid');
  }
  var type = String(posting && posting['類型'] || '').trim();
  if (!E2_JOURNAL_TYPES[type]) {
    throw new Error('E2 posting type is invalid');
  }
  var debit = String(posting && posting['借方帳戶'] || '').trim();
  var credit = String(posting && posting['貸方帳戶'] || '').trim();
  validateDistinctLegs_(debit, credit);
  validatePostingVocabulary_(posting, vocabulary);

  var category = String(posting && posting['分類'] || '').trim();
  if (category === '尚未分類') {
    throw new Error('E2 posting category is invalid');
  }
  if (type === '沖銷') {
    if (category) throw new Error('E2 posting category is invalid');
    return;
  }
  var nominal = nominalLeg_(debit, credit, vocabulary.accountTypes);
  if (!nominal) {
    if (category) throw new Error('E2 posting category is invalid');
    return;
  }
  if (!category || category !== nominal) {
    throw new Error('E2 posting category must match nominal leg');
  }
  validateOptionalVocabulary_(category, 'category', vocabulary, vocabulary.accountTypes[nominal]);
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
  var observations = getOrCreateSheet_(spreadsheet, OBSERVATION_SHEET_NAME);

  initializeBlankSheet_(journal, [JOURNAL_HEADERS]);
  initializeBlankSheet_(accounts, [
    ['名稱', '類型', '子類型', '啟用', '排序', ACCOUNT_STABLE_ID_HEADER, ACCOUNT_ALIASES_HEADER],
    ['期初餘額', '權益', '系統', true, 10, newAccountStableId_('期初餘額'), ''],
    ['應收帳款', '資產', '往來', true, 20, newAccountStableId_('應收帳款'), ''],
    ['應付帳款', '負債', '往來', true, 30, newAccountStableId_('應付帳款'), ''],
    ['調整支出', '支出', '調整', true, 40, newAccountStableId_('調整支出'), ''],
    ['調整收入', '收入', '調整', true, 50, newAccountStableId_('調整收入'), ''],
    ['現金', '資產', '現金', true, 100, newAccountStableId_('現金'), ''],
    ['銀行', '資產', '銀行', true, 110, newAccountStableId_('銀行'), ''],
    ['悠遊卡', '資產', '電子票證', true, 120, newAccountStableId_('悠遊卡'), ''],
    ['餐飲', '支出', '日常', true, 200, newAccountStableId_('餐飲'), ''],
    ['交通', '支出', '日常', true, 210, newAccountStableId_('交通'), ''],
    ['薪資收入', '收入', '薪資', true, 300, newAccountStableId_('薪資收入'), ''],
  ]);
  initializeBlankSheet_(options, [['交易對象']]);
  initializeBlankSheet_(settings, [
    ['設定項目', '值'],
    ['預設幣別', 'TWD'],
    ['預設帳戶', '現金'],
  ]);
  initializeBlankSheet_(balances, [['名稱', '類型', '餘額']]);
  initializeBlankSheet_(checks, [['檢查項目', '結果']]);
  initializeBlankSheet_(observations, [OBSERVATION_HEADERS]);

  ensureStableIdentitySchema_(spreadsheet);

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

function ensureStableIdentitySchema_(spreadsheet) {
  var accounts = requiredSheet_(spreadsheet, '會計科目');
  ensureMetadataHeader_(accounts, ACCOUNT_STABLE_ID_HEADER);
  ensureMetadataHeader_(accounts, ACCOUNT_ALIASES_HEADER);
  var observations = requiredSheet_(spreadsheet, OBSERVATION_SHEET_NAME);
  for (var index = 0; index < OBSERVATION_HEADERS.length; index += 1) {
    ensureMetadataHeader_(observations, OBSERVATION_HEADERS[index]);
  }
}

function ensureMetadataHeader_(sheet, header) {
  var lastColumn = sheet.getLastColumn();
  if (lastColumn === 0) {
    sheet.getRange(1, 1).setValues([[header]]);
    return 1;
  }
  var headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
  for (var index = 0; index < headers.length; index += 1) {
    if (String(headers[index] || '').trim() === header) {
      return index + 1;
    }
  }
  sheet.getRange(1, lastColumn + 1).setValues([[header]]);
  return lastColumn + 1;
}

function optionalMetadataColumn_(sheet, header) {
  var lastColumn = sheet.getLastColumn();
  if (lastColumn === 0) {
    return null;
  }
  var headers = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
  for (var index = 0; index < headers.length; index += 1) {
    if (String(headers[index] || '').trim() === header) {
      return index + 1;
    }
  }
  return null;
}

function newAccountStableId_(seed) {
  if (!String(seed || '').trim()) {
    throw new Error('account stable identity seed is required');
  }
  return 'account:' + digestHex_(Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    'account:' + String(seed),
  )).slice(0, 32);
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

function requiredTxnId_(payload) {
  requireField_(payload, 'txn_id');
  var txnId = normalizeTxnId_(payload.txn_id);
  if (!txnId) {
    throw new Error('txn_id is required');
  }
  return txnId;
}

function normalizeTxnId_(value) {
  return String(value === null || value === undefined ? '' : value).trim();
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

/* ------------------------------------------------------------------------- *
 * E2 reviewed integration surface
 * ------------------------------------------------------------------------- */

function e2Spreadsheet_() {
  var spreadsheet = SpreadsheetApp.openById(requiredProp_('LEDGER_SPREADSHEET_ID'));
  ensureE2Schema_(spreadsheet);
  return spreadsheet;
}

function enableE2Schema_(payload) {
  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_WAIT_MILLISECONDS);
  try {
    var spreadsheet = SpreadsheetApp.openById(requiredProp_('LEDGER_SPREADSHEET_ID'));
    ensureE2Schema_(spreadsheet);
    return integrationState_();
  } finally {
    lock.releaseLock();
  }
}

function e2Table_(spreadsheet, name) {
  var sheet = spreadsheet.getSheetByName(name);
  if (!sheet) throw new Error('missing E2 metadata sheet: ' + name);
  for (var index = 0; index < E2_TABLES.length; index += 1) {
    if (E2_TABLES[index].name === name) return { sheet: sheet, headers: E2_TABLES[index].headers };
  }
  throw new Error('unknown E2 metadata sheet: ' + name);
}

function e2Rows_(spreadsheet, name) {
  var table = e2Table_(spreadsheet, name);
  var sheet = table.sheet;
  if (sheet.getLastRow() < 2) return [];
  var columns = resolveHeaders_(
    sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0],
    table.headers,
  );
  var displayed = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn())
    .getDisplayValues();
  var rows = [];
  for (var rowIndex = 0; rowIndex < displayed.length; rowIndex += 1) {
    if (!snapshotRowHasData_(displayed[rowIndex], displayed[rowIndex])) continue;
    var values = {};
    for (var headerIndex = 0; headerIndex < table.headers.length; headerIndex += 1) {
      var header = table.headers[headerIndex];
      values[header] = displayed[rowIndex][columns[header] - 1] || '';
    }
    rows.push({ sheetRow: rowIndex + 2, values: values, columns: columns });
  }
  return rows;
}

function readE2TableRows_(spreadsheet) {
  if (!e2SchemaAvailable_(spreadsheet)) return [];
  var rows = [];
  for (var index = 0; index < E2_TABLES.length; index += 1) {
    var tableRows = e2Rows_(spreadsheet, E2_TABLES[index].name);
    for (var rowIndex = 0; rowIndex < tableRows.length; rowIndex += 1) {
      rows.push({
        table: E2_TABLES[index].name,
        sheetRow: tableRows[rowIndex].sheetRow,
        cells: tableRows[rowIndex].values,
      });
    }
  }
  return rows;
}

function e2Headers_(spreadsheet, name) {
  return e2Table_(spreadsheet, name).headers;
}

function e2Append_(spreadsheet, name, values) {
  var table = e2Table_(spreadsheet, name);
  var row = [];
  for (var index = 0; index < table.headers.length; index += 1) {
    row.push(Object.prototype.hasOwnProperty.call(values, table.headers[index])
      ? values[table.headers[index]]
      : '');
  }
  table.sheet.getRange(table.sheet.getLastRow() + 1, 1, 1, row.length).setValues([row]);
  return table.sheet.getLastRow();
}

function e2Set_(spreadsheet, name, sheetRow, values) {
  var table = e2Table_(spreadsheet, name);
  var row = [];
  for (var index = 0; index < table.headers.length; index += 1) {
    row.push(Object.prototype.hasOwnProperty.call(values, table.headers[index])
      ? values[table.headers[index]]
      : '');
  }
  table.sheet.getRange(sheetRow, 1, 1, row.length).setValues([row]);
}

function e2Json_(value) {
  return JSON.stringify(value === undefined ? null : value);
}

function e2Digest_(value) {
  return digestHex_(Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    canonicalJson_(value),
  ));
}

function e2OperationId_(payload, fallback) {
  var value = String(payload && (payload.operationId || payload.operation_id) || fallback || '').trim();
  if (!value) throw new Error('operationId is required');
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) throw new Error('operationId is invalid');
  return value;
}

function e2ContentDigest_(payload, content) {
  var supplied = String(payload && payload.contentDigest || '').trim();
  if (supplied && (supplied.length > 256 || !/^[A-Za-z0-9._:-]+$/.test(supplied))) {
    throw new Error('contentDigest is invalid');
  }
  // The transport digest is only a bounded compatibility field.  Idempotency
  // and replay comparisons must be based on the content GAS actually sees so
  // a caller cannot reuse an operation id by forging the same digest.
  return e2Digest_(content);
}

function e2OperationRow_(spreadsheet, operationId) {
  var rows = e2Rows_(spreadsheet, '整合操作');
  for (var index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index].values.operation_id === operationId) return rows[index];
  }
  return null;
}

function e2OutcomeFromRow_(row) {
  if (!row) return null;
  var values = row.values;
  var kind = values.kind;
  if (kind === 'committed') {
    var destinations = [];
    try { destinations = JSON.parse(values.destinations_json || '[]'); } catch (error) { destinations = []; }
    return {
      kind: 'committed',
      operationId: values.operation_id,
      destinations: destinations,
      committedAt: values.committed_at,
    };
  }
  if (kind === 'conflict') {
    var conflicts = [];
    try { conflicts = JSON.parse(values.conflicts_json || '[]'); } catch (error) { conflicts = []; }
    return {
      kind: 'conflict', operationId: values.operation_id,
      reason: values.reason || 'conflict', conflicts: conflicts,
    };
  }
  if (kind === 'pending') {
    return { kind: 'pending', operationId: values.operation_id, reason: values.reason || 'still-running' };
  }
  if (kind === 'unknown') {
    return { kind: 'unknown', operationId: values.operation_id, reason: values.reason || 'unknown' };
  }
  if (kind === 'incomplete') {
    var incompleteDestinations = [];
    try { incompleteDestinations = JSON.parse(values.destinations_json || '[]'); } catch (error) { incompleteDestinations = []; }
    return {
      kind: 'incomplete', operationId: values.operation_id,
      reason: values.reason || 'incomplete', destinations: incompleteDestinations,
    };
  }
  return {
    kind: 'rejected', operationId: values.operation_id,
    reason: values.reason || 'rejected',
    detail: e2OutcomeDetailValue_(values.detail),
  };
}

function e2OutcomeDetailValue_(value) {
  if (!value) return undefined;
  var parsed = e2ParseJson_(value, null);
  if (parsed && typeof parsed === 'object' &&
      Object.prototype.hasOwnProperty.call(parsed, 'detail')) {
    return parsed.detail || undefined;
  }
  return value;
}

function e2CommandActor_(payload, content) {
  var actor = String(content && content.actor || payload && payload.actor || '').trim();
  if (actor) return actor;
  try {
    actor = String(Session.getEffectiveUser().getEmail() || '').trim();
  } catch (error) {
    actor = '';
  }
  return actor || 'gas-verified-request';
}

function e2OutcomeDetail_(detail, actor) {
  return e2Json_({ actor: String(actor || ''), detail: detail || '' });
}

function e2PersistActorMetadata_(spreadsheet, scope, id, revision, actor, operationId) {
  var verifiedActor = String(actor || '').trim();
  if (!verifiedActor) return;
  var metadataId = String(scope || '') + ':' + String(id || '');
  var data = {
    actor: verifiedActor,
    scope: String(scope || ''),
    id: String(id || ''),
    revision: String(revision || ''),
    operationId: String(operationId || ''),
  };
  var existing = e2LatestRecord_(spreadsheet, 'actor-provenance', metadataId);
  if (existing) {
    var previous = e2ParseJson_(existing.values.data_json, {});
    if (previous.actor === data.actor && previous.revision === data.revision &&
        previous.operationId === data.operationId) return;
  }
  e2Append_(spreadsheet, '整合記錄', {
    scope: 'actor-provenance', record_id: metadataId,
    revision: e2Digest_(data), data_json: e2Json_(data), created_at: taipeiIsoNow_(),
  });
}

function e2PersistOutcome_(spreadsheet, outcome, contentDigest, detail, actor) {
  var values = {
    operation_id: outcome.operationId,
    content_digest: contentDigest,
    kind: outcome.kind,
    reason: outcome.reason || '',
    conflicts_json: e2Json_(outcome.conflicts || []),
    destinations_json: e2Json_(outcome.destinations || []),
    committed_at: outcome.committedAt || '',
    detail: e2OutcomeDetail_(detail || outcome.detail || '', actor),
  };
  e2Append_(spreadsheet, '整合操作', values);
  return outcome;
}

function e2Conflict_(operationId, reason, conflicts) {
  return {
    kind: 'conflict', operationId: operationId, reason: reason,
    conflicts: conflicts || [],
  };
}

function e2Rejected_(operationId, reason, detail) {
  var result = { kind: 'rejected', operationId: operationId, reason: reason };
  if (detail !== undefined) result.detail = detail;
  return result;
}

function e2CurrentRevision_(spreadsheet, id) {
  var source = readSnapshotSource_(spreadsheet);
  var scopes = [
    snapshotAccountRecords_(source),
    snapshotEventRecords_(source),
    snapshotObservationRecords_(source),
  ];
  for (var scopeIndex = 0; scopeIndex < scopes.length; scopeIndex += 1) {
    var records = scopes[scopeIndex];
    for (var index = 0; index < records.length; index += 1) {
      if (records[index].id === id || records[index].persistedId === id || records[index].legacyId === id) {
        return records[index].revision || records[index].contentDigest || '';
      }
    }
  }
  var e2Scopes = [
    'groups', 'operations', 'claims', 'manifests', 'steps', 'evidence',
    'links', 'checkpoints', 'settings', 'results', 'records',
  ];
  for (var scopeIndex = 0; scopeIndex < e2Scopes.length; scopeIndex += 1) {
    var e2Records = snapshotE2Records_(spreadsheet, e2Scopes[scopeIndex]);
    for (var recordIndex = 0; recordIndex < e2Records.length; recordIndex += 1) {
      if (e2Records[recordIndex].id === id) return e2Records[recordIndex].revision;
    }
  }
  return '';
}

function e2CheckExpectedRevisions_(spreadsheet, expected) {
  var conflicts = [];
  if (!Array.isArray(expected)) throw new Error('expectedRevisions must be an array');
  for (var index = 0; index < expected.length; index += 1) {
    var item = expected[index];
    if (!item || typeof item !== 'object' || !String(item.id || '').trim() || !String(item.revision || '').trim()) {
      throw new Error('expectedRevisions contains an invalid record');
    }
    var id = String(item.id).trim();
    var actual = e2CurrentRevision_(spreadsheet, id);
    if (actual !== String(item.revision)) {
      conflicts.push({ id: id, expected: String(item.revision), actual: actual || 'missing' });
    }
  }
  return conflicts;
}

// A retry of an unknown operation may legitimately observe the revisions of
// the manifest/group/step rows that this operation already appended. Keep
// checking every other expected revision: a concurrent writer must still
// turn the retry into a conflict rather than inherit stale content.
function e2RecoveryOwned_(spreadsheet, scope, id, operationId) {
  var provenance = e2LatestRecord_(spreadsheet, 'actor-provenance', String(scope || '') + ':' + String(id || ''));
  if (!provenance) return false;
  var data = e2ParseJson_(provenance.values.data_json, null);
  return !!data && String(data.operationId || '') === String(operationId || '');
}

function e2RecoveryOwnedIds_(spreadsheet, content, digest, operationId) {
  var owned = Object.create(null);
  var kind = String(content && content.kind || '');
  if (kind === 'event-group' || kind === 'compound-event-group') {
    var groupId = String(content.groupId || content.group_id || '').trim();
    var groups = snapshotE2Records_(spreadsheet, 'groups');
    for (var groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
      if (groups[groupIndex].id === groupId && groups[groupIndex].contentDigest === digest) {
        if (e2RecoveryOwned_(spreadsheet, 'event-group', groupId, operationId)) {
          owned[groupId] = true;
        }
        break;
      }
    }
    return owned;
  }

  var manifest = content && (content.manifest || content);
  var manifestId = String(manifest && (manifest.manifestId || manifest.manifest_id || manifest.id) || '').trim();
  if (kind === 'manifest' || kind === 'import' || kind === 'resume-import') {
    var manifests = snapshotE2Records_(spreadsheet, 'manifests');
    for (var manifestIndex = 0; manifestIndex < manifests.length; manifestIndex += 1) {
      var manifestMatchesContent = manifests[manifestIndex].contentDigest === digest;
      var manifestMatchesRecovery = kind === 'resume-import' && e2RecoveryOwned_(
        spreadsheet, 'manifest', manifestId, operationId,
      );
      if (manifests[manifestIndex].id === manifestId &&
          (manifestMatchesContent || manifestMatchesRecovery) &&
          e2RecoveryOwned_(spreadsheet, 'manifest', manifestId, operationId)) {
        owned[manifestId] = true;
        break;
      }
    }
  }

  if (kind === 'manifest' || kind === 'import' || kind === 'resume-import') {
    var candidates = content.steps || (manifest && manifest.steps) || [];
    var storedSteps = snapshotE2Records_(spreadsheet, 'steps');
    for (var candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
      var candidate = candidates[candidateIndex] || {};
      var stepId = String(candidate.stepId || candidate.step_id || candidate.id || '').trim();
      if (!stepId) continue;
      var stepDigest = String(candidate.contentDigest || '').trim() || e2Digest_(candidate);
      var stepState = String(candidate.state || candidate.status || '').trim() || 'pending';
      var destinationId = manifestId + ':' + stepId;
      for (var storedIndex = 0; storedIndex < storedSteps.length; storedIndex += 1) {
        var stored = storedSteps[storedIndex];
        if (stored.id === destinationId && stored.contentDigest === stepDigest && stored.state === stepState &&
            e2RecoveryOwned_(spreadsheet, 'manifest-step', destinationId, operationId)) {
          owned[destinationId] = true;
          break;
        }
      }
    }
  }

  if (kind === 'import-receipt' || kind === 'receipt-progress') {
    var writes = content && content.writes;
    if (Array.isArray(writes)) {
      for (var writeIndex = 0; writeIndex < writes.length; writeIndex += 1) {
        var write = writes[writeIndex] || {};
        var writeScope = String(write.scope || '').trim();
        var writeId = String(write.id || '').trim();
        if (writeScope !== 'results' || !writeId || !Object.prototype.hasOwnProperty.call(write, 'data')) continue;
        var storedResult = e2LatestRecord_(spreadsheet, writeScope, writeId);
        if (storedResult && e2Digest_(e2ParseJson_(storedResult.values.data_json, null)) === e2Digest_(write.data) &&
            e2RecoveryOwned_(spreadsheet, 'record', writeScope + ':' + writeId, operationId)) {
          owned[writeId] = true;
        }
      }
    }
  }
  return owned;
}

function e2ExpectedConflictsForRecovery_(spreadsheet, expected, content, digest, operationId) {
  var owned = e2RecoveryOwnedIds_(spreadsheet, content, digest, operationId);
  var externalExpected = [];
  for (var index = 0; index < expected.length; index += 1) {
    if (!owned[String(expected[index].id || '').trim()]) externalExpected.push(expected[index]);
  }
  return e2CheckExpectedRevisions_(spreadsheet, externalExpected);
}

function e2Claims_(spreadsheet) {
  var result = Object.create(null);
  var rows = e2Rows_(spreadsheet, '觀察認領');
  for (var index = 0; index < rows.length; index += 1) {
    var claim = rows[index].values;
    if (!claim.claim_id) continue;
    if (claim.status === 'claimed') result[claim.claim_id] = claim;
    else if (claim.status === 'released') delete result[claim.claim_id];
  }
  return result;
}

function e2CheckClaims_(spreadsheet, operationId, claims) {
  if (claims === undefined) return null;
  if (!Array.isArray(claims)) throw new Error('content.claims must be an array');
  var existing = e2Claims_(spreadsheet);
  for (var index = 0; index < claims.length; index += 1) {
    var claimId = String(claims[index] || '').trim();
    if (!claimId) throw new Error('content.claims contains a blank id');
    if (existing[claimId] && existing[claimId].operation_id !== operationId) {
      return e2Conflict_(operationId, 'observation-already-claimed', []);
    }
  }
  return null;
}

function e2PersistClaims_(spreadsheet, operationId, digest, claims, actor) {
  var existing = e2Claims_(spreadsheet);
  var persisted = Object.create(null);
  for (var index = 0; index < (claims || []).length; index += 1) {
    var claimId = String(claims[index] || '').trim();
    if (persisted[claimId]) continue;
    if (existing[claimId]) {
      if (existing[claimId].operation_id !== operationId) {
        throw new Error('claim is already reserved by another operation');
      }
      persisted[claimId] = true;
      continue;
    }
    e2Append_(spreadsheet, '觀察認領', {
      claim_id: claimId, operation_id: operationId,
      content_digest: digest, status: 'claimed', created_at: taipeiIsoNow_(),
    });
    e2PersistActorMetadata_(spreadsheet, 'claim', claimId, digest, actor, operationId);
    existing[claimId] = {
      operation_id: operationId, content_digest: digest,
    };
    persisted[claimId] = true;
  }
}

// Some command variants need to reserve claims before entering their handler
// so a concurrent request cannot pass the claim gate while this request is
// being validated. If that handler rejects before producing an effect, append
// an auditable release while the script lock is still held; the next request
// then sees the claim as available instead of inheriting a phantom reservation.
function e2ReleaseClaims_(spreadsheet, operationId, claims, actor) {
  var existing = e2Claims_(spreadsheet);
  var released = Object.create(null);
  for (var index = 0; index < (claims || []).length; index += 1) {
    var claimId = String(claims[index] || '').trim();
    if (!claimId || released[claimId]) continue;
    if (!existing[claimId] || existing[claimId].operation_id !== operationId) continue;
    e2Append_(spreadsheet, '觀察認領', {
      claim_id: claimId, operation_id: operationId,
      content_digest: existing[claimId].content_digest || '', status: 'released', created_at: taipeiIsoNow_(),
    });
    e2PersistActorMetadata_(spreadsheet, 'claim-release', claimId, existing[claimId].content_digest || '', actor, operationId);
    released[claimId] = true;
  }
}

function e2WriteRecord_(spreadsheet, scope, id, data, operationId) {
  var recordId = String(id || '').trim();
  if (!recordId) throw new Error('write id is required');
  var revision = e2Digest_({ id: recordId, data: data, operationId: operationId });
  e2Append_(spreadsheet, '整合記錄', {
    scope: scope, record_id: recordId, revision: revision,
    data_json: e2Json_(data), created_at: taipeiIsoNow_(),
  });
  return { id: recordId, revision: revision };
}

function e2ReceiptString_(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function e2ReceiptRevisionList_(value) {
  if (!Array.isArray(value)) return { ok: false, detail: 'expectedRevisions must be an array' };
  var seen = Object.create(null);
  for (var index = 0; index < value.length; index += 1) {
    var item = value[index];
    var rawId = item && (item.id || item.recordId || item.record_id);
    var rawRevision = item && (item.revision || item.expectedRevision || item.expected_revision);
    var id = typeof rawId === 'string' ? rawId.trim() : '';
    var revision = typeof rawRevision === 'string' ? rawRevision.trim() : '';
    if (!item || typeof item !== 'object' || Array.isArray(item) || !id || !revision || seen[id]) {
      return { ok: false, detail: 'expectedRevisions contains an invalid or duplicate id' };
    }
    seen[id] = true;
  }
  return { ok: true };
}

function e2ReceiptStepStateKind_(state) {
  return String(state && state.kind || '').trim();
}

function e2ReceiptStepStateRank_(kind) {
  if (kind === 'pending') return 0;
  if (kind === 'conflicted' || kind === 'rejected' || kind === 'unknown') return 1;
  if (kind === 'completed') return 2;
  return -1;
}

function e2ReceiptStateRank_(kind) {
  if (kind === 'accepted') return 0;
  if (kind === 'in-progress' || kind === 'incomplete') return 1;
  if (kind === 'conflicted') return 2;
  if (kind === 'completed') return 3;
  return -1;
}

function e2ReceiptStepKindAllowed_(kind) {
  return [
    'claim-observation', 'create-event-group', 'create-partner-agreement',
    'adopt-partner-link', 'record-correction', 'complete-group',
  ].indexOf(kind) !== -1;
}

function e2ReceiptBookAllowed_(book) {
  return book === 'personal' || book === 'partner';
}

function e2ReceiptDestinations_(value, detail) {
  if (!Array.isArray(value)) return { ok: false, detail: detail + ' must be an array' };
  var destinations = [];
  var seen = Object.create(null);
  for (var index = 0; index < value.length; index += 1) {
    var destination = value[index];
    var id = destination && typeof destination.id === 'string' ? destination.id.trim() : '';
    var revision = destination && typeof destination.revision === 'string' ? destination.revision.trim() : '';
    if (!destination || typeof destination !== 'object' || Array.isArray(destination) ||
        !id || !revision || seen[id + ':' + revision]) {
      return { ok: false, detail: detail + ' contains an invalid or duplicate destination' };
    }
    seen[id + ':' + revision] = true;
    destinations.push({ id: id, revision: revision });
  }
  return { ok: true, destinations: destinations };
}

function e2ReceiptStringListEqual_(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  for (var index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function e2ReceiptRevisionListEqual_(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  for (var index = 0; index < left.length; index += 1) {
    var leftItem = left[index] || {};
    var rightItem = right[index] || {};
    var leftId = leftItem.id || leftItem.recordId || leftItem.record_id;
    var rightId = rightItem.id || rightItem.recordId || rightItem.record_id;
    var leftRevision = leftItem.revision || leftItem.expectedRevision || leftItem.expected_revision;
    var rightRevision = rightItem.revision || rightItem.expectedRevision || rightItem.expected_revision;
    if (leftId !== rightId || leftRevision !== rightRevision) return false;
  }
  return true;
}

function e2ReceiptDestinationList_(state, detail) {
  if (state && Object.prototype.hasOwnProperty.call(state, 'destinations')) {
    return e2ReceiptDestinations_(state.destinations, detail);
  }
  if (state && state.destination !== undefined) {
    return e2ReceiptDestinations_([state.destination], detail);
  }
  return { ok: false, detail: detail + ' is missing' };
}

function e2ReceiptDestinationsContain_(known, candidate) {
  var candidateByKey = Object.create(null);
  for (var candidateIndex = 0; candidateIndex < candidate.length; candidateIndex += 1) {
    var candidateDestination = candidate[candidateIndex];
    candidateByKey[candidateDestination.id + ':' + candidateDestination.revision] = true;
  }
  for (var knownIndex = 0; knownIndex < known.length; knownIndex += 1) {
    var knownDestination = known[knownIndex];
    if (!candidateByKey[knownDestination.id + ':' + knownDestination.revision]) return false;
  }
  return true;
}

function e2ValidateReceipt_(recordId, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, detail: 'receipt must be an object' };
  }
  if (!e2ReceiptString_(value.operationId) || String(value.operationId).trim() !== String(recordId)) {
    return { ok: false, detail: 'receipt operationId must match its result id' };
  }
  if (!e2ReceiptString_(value.planId) || !e2ReceiptString_(value.contractVersion) ||
      String(value.contractVersion) !== String(CONTRACT_VERSION) ||
      !e2ReceiptString_(value.actor) || !e2ReceiptString_(value.acceptedAt) ||
      !e2ReceiptString_(value.contentDigest)) {
    return { ok: false, detail: 'receipt identity and provenance fields are required' };
  }
  if (!Array.isArray(value.steps)) return { ok: false, detail: 'receipt steps must be an array' };
  var stepsById = Object.create(null);
  for (var index = 0; index < value.steps.length; index += 1) {
    var step = value.steps[index];
    var hasGroupId = Object.prototype.hasOwnProperty.call(step || {}, 'groupId');
    if (!step || typeof step !== 'object' || Array.isArray(step) ||
        !e2ReceiptString_(step.stepId) || !e2ReceiptStepKindAllowed_(String(step.kind || '').trim()) ||
        !e2ReceiptBookAllowed_(String(step.book || '').trim()) || (hasGroupId &&
          (typeof step.groupId !== 'string' || step.groupId.trim() === '')) ||
        stepsById[String(step.stepId).trim()]) {
      return { ok: false, detail: 'receipt steps require unique stepId, kind, and book; groupId must be a nonblank string when present' };
    }
    var stepId = String(step.stepId).trim();
    var expected = e2ReceiptRevisionList_(step.expectedRevisions);
    if (!expected.ok) return { ok: false, detail: 'receipt step ' + stepId + ': ' + expected.detail };
    if (!Array.isArray(step.dependsOn)) {
      return { ok: false, detail: 'receipt step ' + stepId + ': dependsOn must be an array' };
    }
    var dependencyIds = Object.create(null);
    for (var dependencyIndex = 0; dependencyIndex < step.dependsOn.length; dependencyIndex += 1) {
      var dependencyId = String(step.dependsOn[dependencyIndex] || '').trim();
      if (!dependencyId || dependencyIds[dependencyId]) {
        return { ok: false, detail: 'receipt step ' + stepId + ': dependsOn contains an invalid id' };
      }
      dependencyIds[dependencyId] = true;
    }
    var stepState = step.state;
    var stepStateKind = e2ReceiptStepStateKind_(stepState);
    var stepRank = e2ReceiptStepStateRank_(stepStateKind);
    if (!stepState || typeof stepState !== 'object' || Array.isArray(stepState) || stepRank < 0) {
      return { ok: false, detail: 'receipt step ' + stepId + ': state is invalid' };
    }
    if (stepStateKind === 'completed') {
      var destination = stepState.destination;
      if (!destination || typeof destination !== 'object' || Array.isArray(destination) ||
          !e2ReceiptString_(destination.id) || !e2ReceiptString_(destination.revision) ||
          !e2ReceiptString_(stepState.completedAt)) {
        return { ok: false, detail: 'receipt step ' + stepId + ': completed state needs destination and completedAt' };
      }
      if (Object.prototype.hasOwnProperty.call(stepState, 'destinations')) {
        var completedDestinations = e2ReceiptDestinations_(stepState.destinations, 'receipt step ' + stepId + ': destinations');
        if (!completedDestinations.ok || completedDestinations.destinations.length === 0) {
          return { ok: false, detail: completedDestinations.detail || 'completed destinations are required' };
        }
      }
    } else if (stepStateKind !== 'pending' &&
               !e2ReceiptString_(stepState.reason)) {
      return { ok: false, detail: 'receipt step ' + stepId + ': non-pending state needs a reason' };
    }
    if (stepStateKind === 'unknown' && Object.prototype.hasOwnProperty.call(stepState, 'destinations')) {
      var unknownDestinations = e2ReceiptDestinations_(stepState.destinations, 'receipt step ' + stepId + ': destinations');
      if (!unknownDestinations.ok) return { ok: false, detail: unknownDestinations.detail };
    }
    stepsById[stepId] = step;
  }
  var state = value.state;
  var stateKind = String(state && state.kind || '').trim();
  var stateRank = e2ReceiptStateRank_(stateKind);
  if (!state || typeof state !== 'object' || Array.isArray(state) || stateRank < 0) {
    return { ok: false, detail: 'receipt state is invalid' };
  }
  if (stateKind === 'completed' && !e2ReceiptString_(state.completedAt)) {
    return { ok: false, detail: 'completed receipt state needs completedAt' };
  }
  if ((stateKind === 'incomplete' || stateKind === 'conflicted') && !e2ReceiptString_(state.reason)) {
    return { ok: false, detail: 'incomplete or conflicted receipt state needs a reason' };
  }
  return { ok: true, stateKind: stateKind, stateRank: stateRank, stepsById: stepsById };
}

function e2ValidateRetainedPlan_(operationId, content, recordId, value) {
  if (String(content && content.kind || '') !== 'import-receipt' ||
      recordId !== String(operationId || '') + ':plan') {
    return { ok: false, detail: 'retained plan record identity is invalid' };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !e2ReceiptString_(value.planId) ||
      !e2ReceiptString_(value.contractVersion) ||
      String(value.contractVersion) !== String(CONTRACT_VERSION) ||
      !e2ReceiptString_(value.approvedAt) || !e2ReceiptString_(value.approvedBy) ||
      !e2ReceiptString_(value.contentDigest) ||
      !Array.isArray(value.observations) || !Array.isArray(value.decisions) ||
      !Array.isArray(value.expectedRevisions) ||
      !e2ReceiptString_(content.planDigest) ||
      String(content.planDigest) !== String(value.contentDigest)) {
    return { ok: false, detail: 'retained plan record is invalid' };
  }
  for (var observationIndex = 0; observationIndex < value.observations.length; observationIndex += 1) {
    var observation = value.observations[observationIndex];
    if (!observation || typeof observation !== 'object' || Array.isArray(observation) ||
        !e2ReceiptString_(observation.observationId) || !e2ReceiptString_(observation.kind)) {
      return { ok: false, detail: 'retained plan observations are invalid' };
    }
  }
  for (var revisionIndex = 0; revisionIndex < value.expectedRevisions.length; revisionIndex += 1) {
    var expectedRevision = value.expectedRevisions[revisionIndex];
    if (!expectedRevision || typeof expectedRevision !== 'object' || Array.isArray(expectedRevision) ||
        !e2ReceiptString_(expectedRevision.id) || !e2ReceiptString_(expectedRevision.revision)) {
      return { ok: false, detail: 'retained plan expected revisions are invalid' };
    }
  }
  for (var decisionIndex = 0; decisionIndex < value.decisions.length; decisionIndex += 1) {
    var decision = value.decisions[decisionIndex];
    if (!decision || typeof decision !== 'object' || Array.isArray(decision) ||
        !e2ReceiptString_(decision.observationId) ||
        !decision.disposition || typeof decision.disposition !== 'object' ||
        Array.isArray(decision.disposition) || !decision.provenance ||
        typeof decision.provenance !== 'object' || Array.isArray(decision.provenance) ||
        !e2ReceiptString_(decision.provenance.actor) ||
        !e2ReceiptString_(decision.provenance.decidedAt)) {
      return { ok: false, detail: 'retained plan decisions are invalid' };
    }
    var disposition = decision.disposition;
    var dispositionKind = String(disposition.kind || '').trim();
    if (dispositionKind === 'skip') {
      if (!e2ReceiptString_(disposition.reason)) {
        return { ok: false, detail: 'retained plan skip disposition is invalid' };
      }
    } else if (dispositionKind === 'map-to-account' || dispositionKind === 'duplicate-of') {
      if (!e2ReceiptString_(disposition.accountId)) {
        return { ok: false, detail: 'retained plan account disposition is invalid' };
      }
    } else if (dispositionKind === 'link-existing' || dispositionKind === 'already-imported') {
      var target = disposition.target;
      if (!target || typeof target !== 'object' || Array.isArray(target) ||
          !e2ReceiptString_(target.id) || !e2ReceiptString_(target.revision)) {
        return { ok: false, detail: 'retained plan link disposition is invalid' };
      }
    } else if (dispositionKind === 'create-event') {
      var purpose = String(disposition.purpose || '').trim();
      var allowedPurposes = [
        'work-receipt', 'other-receipt', 'personal-expense',
        'shared-purchase', 'shared-refund', 'shared-settlement',
      ];
      if (allowedPurposes.indexOf(purpose) === -1 ||
          !e2ReceiptString_(disposition.effectiveDate) ||
          (disposition.category !== null && typeof disposition.category !== 'string')) {
        return { ok: false, detail: 'retained plan event disposition is invalid' };
      }
      var sharedPurpose = ['shared-purchase', 'shared-refund', 'shared-settlement'].indexOf(purpose) !== -1;
      if (!sharedPurpose) {
        if (!e2ReceiptString_(disposition.accountId) || disposition.allocation !== undefined ||
            disposition.payer !== undefined || disposition.sharedTotal !== undefined ||
            disposition.partnerAgreement !== undefined) {
          return { ok: false, detail: 'retained plan personal event disposition is invalid' };
        }
      } else {
        var allocations = ['equal-halves', 'entirely-cheng', 'entirely-partner'];
        var payers = ['cheng', 'partner'];
        var total = disposition.sharedTotal;
        if (allocations.indexOf(disposition.allocation) === -1 ||
            payers.indexOf(disposition.payer) === -1 ||
            (disposition.payer === 'cheng' && !e2ReceiptString_(disposition.accountId)) ||
            (disposition.payer === 'partner' && typeof disposition.accountId !== 'string') ||
            !total || typeof total !== 'object' || Array.isArray(total) ||
            !e2ReceiptString_(total.currency) || !/^[A-Z]{3}$/.test(total.currency) ||
            !e2ReceiptString_(total.amount)) {
          return { ok: false, detail: 'retained plan shared event disposition is invalid' };
        }
        if (disposition.partnerAgreement !== undefined) {
          var agreement = disposition.partnerAgreement;
          if (purpose !== 'shared-purchase' || !agreement || typeof agreement !== 'object' ||
              Array.isArray(agreement) || !e2ReceiptString_(agreement.id) ||
              !e2ReceiptString_(agreement.revision)) {
            return { ok: false, detail: 'retained plan partner agreement is invalid' };
          }
        }
      }
    } else {
      return { ok: false, detail: 'retained plan disposition is invalid' };
    }
  }
  return { ok: true };
}

function e2ReceiptProgressConflict_(recordId, existingValue, nextValue) {
  var existing = e2ValidateReceipt_(recordId, existingValue);
  if (!existing.ok) return existing.detail;
  var next = e2ValidateReceipt_(recordId, nextValue);
  if (!next.ok) return next.detail;
  var immutableFields = ['planId', 'contractVersion', 'actor', 'acceptedAt', 'contentDigest'];
  for (var immutableIndex = 0; immutableIndex < immutableFields.length; immutableIndex += 1) {
    var immutableField = immutableFields[immutableIndex];
    if (String(existingValue[immutableField]) !== String(nextValue[immutableField])) {
      return 'receipt ' + immutableField + ' cannot change';
    }
  }
  if (next.stateRank < existing.stateRank) return 'receipt state cannot regress';
  if (existing.stateKind === 'completed' && next.stateKind !== 'completed') {
    return 'completed receipt state cannot regress';
  }
  if (existing.stateKind === 'completed' &&
      String(existingValue.state.completedAt) !== String(nextValue.state.completedAt)) {
    return 'completed receipt timestamp cannot change';
  }
  for (var stepId in existing.stepsById) {
    if (!Object.prototype.hasOwnProperty.call(existing.stepsById, stepId)) continue;
    var existingStep = existing.stepsById[stepId];
    var nextStep = next.stepsById[stepId];
    if (!nextStep) return 'completed or existing receipt steps cannot be dropped';
    var existingStateKind = e2ReceiptStepStateKind_(existingStep.state);
    var nextStateKind = e2ReceiptStepStateKind_(nextStep.state);
    if (e2ReceiptStepStateRank_(nextStateKind) < e2ReceiptStepStateRank_(existingStateKind)) {
      return 'receipt step state cannot regress: ' + stepId;
    }
    if (String(existingStep.kind) !== String(nextStep.kind) ||
        String(existingStep.book) !== String(nextStep.book) ||
        Object.prototype.hasOwnProperty.call(existingStep, 'groupId') !==
          Object.prototype.hasOwnProperty.call(nextStep, 'groupId') ||
        String(existingStep.groupId || '') !== String(nextStep.groupId || '') ||
        !e2ReceiptRevisionListEqual_(existingStep.expectedRevisions, nextStep.expectedRevisions) ||
        !e2ReceiptStringListEqual_(existingStep.dependsOn, nextStep.dependsOn)) {
      return 'receipt step definition cannot change: ' + stepId;
    }
    if (existingStateKind === 'completed') {
      var oldDestination = existingStep.state.destination;
      var newDestination = nextStep.state.destination;
      if (nextStateKind !== 'completed' || !newDestination ||
          String(oldDestination.id) !== String(newDestination.id) ||
          String(oldDestination.revision) !== String(newDestination.revision)) {
        return 'completed receipt destination cannot change: ' + stepId;
      }
      if (String(existingStep.state.completedAt) !== String(nextStep.state.completedAt)) {
        return 'completed step timestamp cannot change: ' + stepId;
      }
      if (existingStep.state.destinations !== undefined) {
        var oldCompletedDestinations = e2ReceiptDestinationList_(existingStep.state, 'receipt step ' + stepId + ': destinations');
        var newCompletedDestinations = e2ReceiptDestinationList_(nextStep.state, 'receipt step ' + stepId + ': destinations');
        if (!oldCompletedDestinations.ok) return oldCompletedDestinations.detail;
        if (!newCompletedDestinations.ok ||
            !e2ReceiptDestinationsContain_(oldCompletedDestinations.destinations, newCompletedDestinations.destinations)) {
          return 'completed receipt destinations cannot be dropped: ' + stepId;
        }
      }
    }
    if (existingStateKind === 'unknown' && existingStep.state.destinations !== undefined) {
      var oldDestinations = e2ReceiptDestinations_(existingStep.state.destinations, 'receipt step ' + stepId + ': destinations');
      if (!oldDestinations.ok) return oldDestinations.detail;
      var newStateDestinations = nextStep.state.destinations;
      if (nextStateKind === 'completed' && newStateDestinations === undefined) {
        newStateDestinations = [nextStep.state.destination];
      }
      var newDestinations = e2ReceiptDestinations_(newStateDestinations, 'receipt step ' + stepId + ': destinations');
      if (!newDestinations.ok) return newDestinations.detail;
      if (!e2ReceiptDestinationsContain_(oldDestinations.destinations, newDestinations.destinations)) {
        return 'known incomplete destination cannot be dropped: ' + stepId;
      }
    }
  }
  for (var nextStepId in next.stepsById) {
    if (!Object.prototype.hasOwnProperty.call(next.stepsById, nextStepId) || existing.stepsById[nextStepId]) continue;
    return 'receipt steps cannot be added during progress: ' + nextStepId;
  }
  return null;
}

function e2PrepareRecordWrites_(spreadsheet, operationId, content) {
  var writes = content && content.writes;
  if (!Array.isArray(writes) || writes.length === 0) {
    return { rejected: e2Rejected_(operationId, 'record-writes-required') };
  }
  var seen = Object.create(null);
  var prepared = [];
  for (var index = 0; index < writes.length; index += 1) {
    var write = writes[index];
    if (!write || typeof write !== 'object') {
      return { rejected: e2Rejected_(operationId, 'record-write-invalid') };
    }
    var scope = String(write.scope || '').trim();
    var id = String(write.id || '').trim();
    if ((scope !== 'results' && scope !== 'records') || !id || seen[id] ||
        !Object.prototype.hasOwnProperty.call(write, 'data')) {
      return { rejected: e2Rejected_(operationId, 'record-write-invalid') };
    }
    seen[id] = true;
    if (scope === 'results') {
      var validation = e2ValidateReceipt_(id, write.data);
      if (!validation.ok) return { rejected: e2Rejected_(operationId, 'invalid-receipt', validation.detail) };
    } else {
      var retainedPlanValidation = e2ValidateRetainedPlan_(operationId, content, id, write.data);
      if (!retainedPlanValidation.ok) {
        return { rejected: e2Rejected_(operationId, 'record-write-invalid', retainedPlanValidation.detail) };
      }
    }
    var existing = e2LatestRecord_(spreadsheet, scope, id);
    var existingData = existing ? e2ParseJson_(existing.values.data_json, null) : null;
    if (scope === 'results' && existing && e2Digest_(existingData) !== e2Digest_(write.data)) {
      var progressConflict = e2ReceiptProgressConflict_(id, existingData, write.data);
      if (progressConflict) return { rejected: e2Rejected_(operationId, 'receipt-progress-regression', progressConflict) };
    }
    prepared.push({ write: write, existing: existing });
  }
  return { prepared: prepared };
}

// Receipt and receipt-progress commands use the append-only generic record
// table, while the scoped `results` snapshot exposes only the latest record
// for each receipt id. A changed progress payload is a new durable revision;
// an identical retry reuses the existing row instead of duplicating it.
function e2ExecuteRecordWrites_(spreadsheet, operationId, content, prepared) {
  var plan = prepared || e2PrepareRecordWrites_(spreadsheet, operationId, content);
  if (plan.rejected) return plan;
  var destinations = [];
  for (var index = 0; index < plan.prepared.length; index += 1) {
    var item = plan.prepared[index];
    var write = item.write;
    var scope = String(write.scope || '').trim();
    var id = String(write.id || '').trim();
    var existing = item.existing;
    if (existing && e2Digest_(e2ParseJson_(existing.values.data_json, null)) === e2Digest_(write.data)) {
      destinations.push({ id: id, revision: existing.values.revision });
      continue;
    }
    var stored = e2WriteRecord_(spreadsheet, scope, id, write.data, operationId);
    e2PersistActorMetadata_(spreadsheet, 'record', scope + ':' + id, stored.revision, content.actor, operationId);
    destinations.push(stored);
  }
  return { destinations: destinations };
}

function e2LatestRecord_(spreadsheet, scope, id) {
  var rows = e2Rows_(spreadsheet, '整合記錄');
  for (var index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index].values.scope === scope && rows[index].values.record_id === id) return rows[index];
  }
  return null;
}

function readE2GroupIndex_(spreadsheet) {
  var result = Object.create(null);
  if (!e2SchemaAvailable_(spreadsheet)) return result;
  var groups = e2Rows_(spreadsheet, '事件群組');
  var details = e2Rows_(spreadsheet, '事件群組明細');
  var byGroup = Object.create(null);
  for (var groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    var groupValues = groups[groupIndex].values;
    byGroup[groupValues.group_id] = {
      groupId: groupValues.group_id,
      status: groupValues.status,
      currencyTotals: e2ParseJson_(groupValues.currency_totals_json, []),
      completionMarker: groupValues.completion_marker,
      contentDigest: groupValues.content_digest,
      createdAt: groupValues.created_at,
      updatedAt: groupValues.updated_at,
      legs: [],
    };
  }
  for (var detailIndex = 0; detailIndex < details.length; detailIndex += 1) {
    var detail = details[detailIndex].values;
    var group = byGroup[detail.group_id];
    if (!group) continue;
    group.legs.push({
      txnId: detail.txn_id, legIndex: Number(detail.leg_index),
      amount: detail.amount, currency: detail.currency,
      debitAccount: detail.debit_account, creditAccount: detail.credit_account,
      contentDigest: detail.content_digest,
    });
  }
  var groupIds = Object.keys(byGroup);
  for (var index = 0; index < groupIds.length; index += 1) {
    var groupId = groupIds[index];
    var current = byGroup[groupId];
    for (var legIndex = 0; legIndex < current.legs.length; legIndex += 1) {
      var leg = current.legs[legIndex];
      result[leg.txnId] = {
        groupId: groupId,
        status: current.status,
        currency: leg.currency,
      };
    }
  }
  return result;
}

function e2ParseJson_(value, fallback) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch (error) { return fallback; }
}

function readE2ReviewIndex_(spreadsheet) {
  var result = Object.create(null);
  if (!e2SchemaAvailable_(spreadsheet)) return result;
  var rows = e2Rows_(spreadsheet, '事件審核');
  for (var index = 0; index < rows.length; index += 1) {
    var values = rows[index].values;
    result[values.txn_id] = {
      category: values.category,
      reviewState: values.review_state,
      revision: values.revision,
      operationId: values.operation_id,
      updatedAt: values.updated_at,
    };
  }
  return result;
}

function snapshotE2Records_(spreadsheet, scope) {
  var canonicalScope = String(scope || '');
  var tableName = {
    groups: '事件群組', 'event-groups': '事件群組',
    operations: '整合操作', claims: '觀察認領', manifests: '匯入清單',
    steps: '匯入步驟', evidence: '來源證據', links: '跨簿連結',
    checkpoints: '對帳檢查點', settings: '設定版本', results: '結果版本',
    records: '整合記錄',
  }[canonicalScope];
  if (!tableName) return [];
  var rows = e2Rows_(spreadsheet, tableName);
  if (canonicalScope === 'results') {
    var genericResultRows = e2Rows_(spreadsheet, '整合記錄');
    for (var genericIndex = 0; genericIndex < genericResultRows.length; genericIndex += 1) {
      if (genericResultRows[genericIndex].values.scope !== 'results') continue;
      rows.push(genericResultRows[genericIndex]);
    }
  }
  var latest = Object.create(null);
  var records = [];
  for (var index = 0; index < rows.length; index += 1) {
    var values = rows[index].values;
    var rowTableName = canonicalScope === 'results' && values.scope === 'results'
      ? '整合記錄'
      : tableName;
    var id = e2RowIdentity_(rowTableName, values);
    var record = e2RecordForTableRow_(rowTableName, values, rows[index].sheetRow, spreadsheet);
    if (canonicalScope === 'results' && rowTableName === '整合記錄') {
      // Generic result records are namespaced in the all-records view, but a
      // scoped results read addresses the receipt by its stable operation id.
      record.id = String(values.record_id || '').trim();
    }
    if (rowTableName === '事件群組' || rowTableName === '整合操作' || rowTableName === '觀察認領' ||
        rowTableName === '匯入步驟' || rowTableName === '匯入清單' || rowTableName === '跨簿連結' ||
        rowTableName === '設定版本' || rowTableName === '結果版本' || rowTableName === '對帳檢查點' ||
        rowTableName === '整合記錄') {
      latest[id] = record;
    } else {
      records.push(record);
    }
  }
  var latestIds = Object.keys(latest);
  for (var latestIndex = 0; latestIndex < latestIds.length; latestIndex += 1) {
    records.push(latest[latestIds[latestIndex]]);
  }
  records.sort(function (left, right) {
    var leftId = String(left.id || '');
    var rightId = String(right.id || '');
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });
  return records;
}

function e2RowIdentity_(tableName, values) {
  if (tableName === '事件群組') return values.group_id;
  if (tableName === '整合操作') return values.operation_id;
  if (tableName === '觀察認領') return values.claim_id;
  if (tableName === '匯入清單') return values.manifest_id;
  if (tableName === '匯入步驟') return values.manifest_id + ':' + values.step_id;
  if (tableName === '來源證據') return values.evidence_id;
  if (tableName === '跨簿連結') return values.link_id;
  if (tableName === '對帳檢查點') return values.checkpoint_id;
  if (tableName === '設定版本') return values.setting_id;
  if (tableName === '結果版本') return values.result_id;
  return values.scope + ':' + values.record_id;
}

function e2RecordForTableRow_(tableName, values, sheetRow, spreadsheet) {
  var id = e2RowIdentity_(tableName, values);
  var revision = values.revision || values.content_digest || e2Digest_(values);
  var record = { id: id, revision: revision, sheetRow: sheetRow };
  if (tableName === '事件群組') {
    var index = readE2GroupIndex_(spreadsheet);
    var group = index[values.group_id] || {
      groupId: values.group_id, status: values.status,
      currencyTotals: e2ParseJson_(values.currency_totals_json, []), legs: [],
    };
    // The index is keyed by txn id; rebuild the group legs from its table so
    // group snapshots stay useful even when no journal leg has been written.
    var detailRows = e2Rows_(spreadsheet, '事件群組明細');
    var legs = [];
    for (var detailIndex = 0; detailIndex < detailRows.length; detailIndex += 1) {
      if (detailRows[detailIndex].values.group_id === values.group_id) {
        var detail = detailRows[detailIndex].values;
        legs.push({
          txnId: detail.txn_id, amount: detail.amount, currency: detail.currency,
          debitAccount: detail.debit_account, creditAccount: detail.credit_account,
          legIndex: Number(detail.leg_index), contentDigest: detail.content_digest,
        });
      }
    }
    record.groupId = values.group_id;
    record.status = values.status;
    record.completion = values.status === 'complete'
      ? { kind: 'complete', marker: values.completion_marker }
      : { kind: 'incomplete', marker: values.completion_marker || null };
    record.currencyTotals = e2ParseJson_(values.currency_totals_json, []);
    record.legs = legs;
    var groupEvidence = e2LatestRecord_(spreadsheet, 'event-group-evidence', values.group_id);
    if (groupEvidence) {
      record.evidence = e2ParseJson_(groupEvidence.values.data_json, {});
      record.conversion = record.evidence.conversion || null;
      record.fees = record.evidence.fees || [];
      record.actor = record.evidence.actor || '';
    }
    record.contentDigest = values.content_digest;
    return record;
  }
  if (tableName === '整合操作') {
    var outcome = e2OutcomeFromRow_({ values: values });
    record.operationId = values.operation_id;
    record.contentDigest = values.content_digest;
    record.detail = e2ParseJson_(values.detail, values.detail || '');
    if (record.detail && typeof record.detail === 'object') {
      record.actor = record.detail.actor || '';
    }
    record.outcome = outcome;
    return record;
  }
  if (tableName === '觀察認領') {
    record.claimId = values.claim_id;
    record.operationId = values.operation_id;
    record.status = values.status;
    record.contentDigest = values.content_digest;
    return record;
  }
  if (tableName === '匯入清單') {
    record.manifestId = values.manifest_id;
    record.status = values.status;
    record.contentDigest = values.content_digest;
    record.actor = values.actor;
    record.approvedAt = values.approved_at;
    record.sourceEvidence = e2ParseJson_(values.source_evidence_json, []);
    return record;
  }
  if (tableName === '匯入步驟') {
    record.manifestId = values.manifest_id;
    record.stepId = values.step_id;
    record.state = values.state;
    record.destination = values.destination_id
      ? { id: values.destination_id, revision: values.destination_revision }
      : null;
    record.contentDigest = values.content_digest;
    record.expectedRevisions = e2ParseJson_(values.expected_revisions_json, []);
    record.result = e2ParseJson_(values.result_json, null);
    return record;
  }
  if (tableName === '來源證據') {
    record.evidenceId = values.evidence_id;
    record.sourceReference = values.source_reference;
    record.contentDigest = values.content_digest;
    record.effectiveDate = values.effective_date;
    record.uploadedAt = values.uploaded_at;
    record.fields = e2ParseJson_(values.fields_json, {});
    return record;
  }
  if (tableName === '跨簿連結') {
    record.linkId = values.link_id;
    record.sourceId = values.source_id;
    record.destination = { id: values.destination_id, revision: values.destination_revision };
    record.sourceRevision = values.source_revision;
    record.contentDigest = values.content_digest;
    record.status = values.status;
    record.origin = values.origin;
    return record;
  }
  if (tableName === '對帳檢查點') {
    record.checkpointId = values.checkpoint_id;
    record.cutoff = values.cutoff;
    record.scopeVersion = values.scope_version;
    record.representedBalances = e2ParseJson_(values.represented_balances_json, {});
    record.acceptedBalances = e2ParseJson_(values.accepted_balances_json, {});
    var storedAdjustment = e2ParseJson_(values.adjustment_json, null);
    if (storedAdjustment && typeof storedAdjustment === 'object' && !Array.isArray(storedAdjustment)) {
      record.adjustment = {};
      for (var adjustmentKey in storedAdjustment) {
        if (Object.prototype.hasOwnProperty.call(storedAdjustment, adjustmentKey) && adjustmentKey !== 'txnId') {
          record.adjustment[adjustmentKey] = storedAdjustment[adjustmentKey];
        }
      }
    } else {
      record.adjustment = storedAdjustment;
    }
    record.evidenceIds = e2ParseJson_(values.evidence_ids_json, []);
    record.coverage = e2ParseJson_(values.coverage_json, {});
    record.status = values.status;
    return record;
  }
  if (tableName === '設定版本') {
    record.settingId = values.setting_id;
    record.key = values.setting_key;
    record.value = e2ParseJson_(values.value_json, null);
    record.effectiveDate = values.effective_date;
    return record;
  }
  if (tableName === '結果版本') {
    record.type = 'metric';
    record.resultId = values.result_id;
    record.interval = e2ParseJson_(values.interval_json, null);
    record.dependencies = e2ParseJson_(values.dependency_revisions_json, []);
    record.state = values.state;
    record.value = e2ParseJson_(values.value_json, null);
    return record;
  }
  record.scope = values.scope;
  if (values.scope === 'results') record.type = 'receipt';
  record.data = e2ParseJson_(values.data_json, null);
  return record;
}

function e2ExecuteClaims_(spreadsheet, operationId, digest, content) {
  if (!Array.isArray(content.claims) || content.claims.length === 0) {
    return { rejected: e2Rejected_(operationId, 'claims-required') };
  }
  var destinations = [];
  for (var index = 0; index < content.claims.length; index += 1) {
    var claimId = String(content.claims[index] || '').trim();
    if (!claimId) return { rejected: e2Rejected_(operationId, 'claim-id-required') };
    destinations.push({ id: claimId, revision: digest });
  }
  return { destinations: destinations };
}

function command_(payload, nonce) {
  if (!payload || typeof payload !== 'object') throw new Error('payload is required');
  var operationId = e2OperationId_(payload, nonce);
  if (!Array.isArray(payload.expectedRevisions)) throw new Error('expectedRevisions must be an array');
  if (!payload.content || typeof payload.content !== 'object') throw new Error('content is required');
  var content = payload.content;
  var actor = e2CommandActor_(payload, content);
  content.actor = actor;
  var digest = e2ContentDigest_(payload, content);
  var spreadsheet = e2Spreadsheet_();
  var previous = e2OperationRow_(spreadsheet, operationId);
  var recoveringUnknown = false;
  if (previous) {
    if (previous.values.content_digest !== digest) {
      return e2Conflict_(operationId, 'operation-id-reused-with-different-content', []);
    }
    // An unknown outcome means the durable record survived a response or
    // process failure, but it does not establish whether every effect did.
    // Re-enter the operation so its handler can resume missing append-only
    // steps. All other outcomes are terminal and safely replayable.
    if (previous.values.kind !== 'unknown') return e2OutcomeFromRow_(previous);
    recoveringUnknown = true;
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_WAIT_MILLISECONDS);
  try {
    requireFinancialOpen_(payload);
    previous = e2OperationRow_(spreadsheet, operationId);
    if (previous) {
      if (previous.values.content_digest !== digest) {
        return e2Conflict_(operationId, 'operation-id-reused-with-different-content', []);
      }
      if (previous.values.kind !== 'unknown') return e2OutcomeFromRow_(previous);
      recoveringUnknown = true;
    }

    // An unknown operation may already have appended its own receipt, group,
    // or other durable metadata before the response was lost. Rechecking the
    // caller's pre-write revisions would mistake those owned writes for an
    // external race and prevent recovery of the same operation.
    var expectedConflicts = recoveringUnknown
      ? e2ExpectedConflictsForRecovery_(spreadsheet, payload.expectedRevisions, content, digest, operationId)
      : e2CheckExpectedRevisions_(spreadsheet, payload.expectedRevisions);
    if (expectedConflicts.length > 0) {
      return e2PersistOutcome_(
        spreadsheet,
        e2Conflict_(operationId, 'stale-expected-revision', expectedConflicts),
        digest,
        undefined,
        actor,
      );
    }
    var claimConflict = e2CheckClaims_(spreadsheet, operationId, content.claims);
    if (claimConflict) return e2PersistOutcome_(spreadsheet, claimConflict, digest, undefined, actor);

    if (content.pending === true || content.state === 'pending') {
      return e2PersistOutcome_(spreadsheet, {
        kind: 'pending', operationId: operationId,
        reason: String(content.pendingReason || 'still-running'),
      }, digest, undefined, actor);
    }

    var claimsReserved = false;
    var reserveClaims = function () {
      if (claimsReserved) return;
      e2PersistClaims_(spreadsheet, operationId, digest, content.claims || [], actor);
      claimsReserved = true;
    };
    var execution;
    try {
      var kind = String(content.kind || 'generic');
      if (kind === 'event-group' || kind === 'compound-event-group') {
        execution = e2ExecuteEventGroup_(spreadsheet, operationId, digest, content, reserveClaims, recoveringUnknown);
      } else if (kind === 'confirmation' || kind === 'review') {
        reserveClaims();
        execution = e2ExecuteConfirmation_(spreadsheet, operationId, digest, content);
      } else if (kind === 'manifest' || kind === 'import') {
        execution = e2ExecuteManifest_(spreadsheet, operationId, digest, content, reserveClaims, recoveringUnknown);
      } else if (kind === 'resume-import') {
        reserveClaims();
        execution = e2ExecuteResumeImport_(spreadsheet, operationId, digest, content, recoveringUnknown);
      } else if (kind === 'evidence') {
        reserveClaims();
        execution = e2ExecuteEvidence_(spreadsheet, operationId, digest, content);
      } else if (kind === 'link') {
        reserveClaims();
        execution = e2ExecuteLink_(spreadsheet, operationId, digest, content);
      } else if (kind === 'checkpoint') {
        reserveClaims();
        execution = e2ExecuteCheckpoint_(spreadsheet, operationId, digest, content);
      } else if (kind === 'setting') {
        reserveClaims();
        execution = e2ExecuteSetting_(spreadsheet, operationId, digest, content);
      } else if (kind === 'result') {
        reserveClaims();
        execution = e2ExecuteResult_(spreadsheet, operationId, digest, content);
      } else if (kind === 'import-receipt' || kind === 'receipt-progress') {
        var recordWrites = e2PrepareRecordWrites_(spreadsheet, operationId, content);
        if (recordWrites.rejected) {
          execution = recordWrites;
        } else {
          reserveClaims();
          execution = e2ExecuteRecordWrites_(spreadsheet, operationId, content, recordWrites);
        }
      } else if (kind === 'opening-adjustment') {
        reserveClaims();
        execution = e2ExecuteOpeningAdjustment_(spreadsheet, operationId, digest, content);
      } else if (kind === 'correction') {
        reserveClaims();
        execution = e2ExecuteCorrection_(spreadsheet, operationId, digest, content);
      } else if (kind === 'claims') {
        reserveClaims();
        execution = e2ExecuteClaims_(spreadsheet, operationId, digest, content);
      } else {
        reserveClaims();
        execution = { rejected: e2Rejected_(operationId, 'unsupported-command-kind') };
      }
    } catch (error) {
      var unknown = {
        kind: 'unknown', operationId: operationId,
        reason: 'write-outcome-unknown',
      };
      e2PersistOutcome_(spreadsheet, unknown, digest, String(error && error.message || error), actor);
      return unknown;
    }
    if (execution && execution.conflict) {
      if (claimsReserved && kind !== 'event-group' && kind !== 'compound-event-group') {
        e2ReleaseClaims_(spreadsheet, operationId, content.claims || [], actor);
      }
      return e2PersistOutcome_(spreadsheet, execution.conflict, digest, undefined, actor);
    }
    if (execution && execution.rejected) {
      if (claimsReserved && kind !== 'event-group' && kind !== 'compound-event-group') {
        e2ReleaseClaims_(spreadsheet, operationId, content.claims || [], actor);
      }
      return e2PersistOutcome_(spreadsheet, execution.rejected, digest, undefined, actor);
    }
    if (!claimsReserved) reserveClaims();
    var destinations = execution && execution.destinations ? execution.destinations : [];
    if (destinations.length === 0) {
      destinations = [{ id: operationId + '-effect', revision: snapshotRevision_(readSnapshotSource_(spreadsheet)) }];
    }
    return e2PersistOutcome_(spreadsheet, {
      kind: 'committed', operationId: operationId, destinations: destinations,
      committedAt: taipeiIsoNow_(),
    }, digest, undefined, actor);
  } finally {
    lock.releaseLock();
  }
}

function outcome_(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('payload is required');
  var operationId = e2OperationId_(payload);
  var spreadsheet = SpreadsheetApp.openById(requiredProp_('LEDGER_SPREADSHEET_ID'));
  if (!e2SchemaAvailable_(spreadsheet)) {
    return { kind: 'unavailable', book: 'personal', reason: 'no-such-operation' };
  }
  var row = e2OperationRow_(spreadsheet, operationId);
  if (!row) return { kind: 'unavailable', book: 'personal', reason: 'no-such-operation' };
  return e2OutcomeFromRow_(row);
}

function createEventGroup_(payload, nonce) {
  var group = payload && (payload.group || payload.eventGroup || payload);
  var operationId = e2OperationId_(payload, nonce);
  var content = {
    kind: 'event-group',
    groupId: String(group.groupId || group.group_id || operationId),
    completionMarker: group.completionMarker || group.completion_marker,
    legs: group.legs || group.entries || [],
    currencyTotals: group.currencyTotals || group.currency_totals,
    conversion: group.conversion || group.fx || group.exchange,
    fees: group.fees || group.feeMetadata || group.fee_metadata,
    conversionReference: group.conversionReference || group.conversion_reference || group.fxReference || group.fx_reference,
    clearingReference: group.clearingReference || group.clearing_reference || group.clearingLink || group.clearing_link,
    actor: payload.actor || group.actor || '',
    source: group.source || 'import',
  };
  e2ForwardClaims_(content, payload, group);
  return command_({
    operationId: operationId,
    expectedRevisions: e2ExpectedRevisions_(payload, group.groupId || group.group_id || ''),
    contentDigest: payload.contentDigest || e2Digest_(content),
    content: content,
    actor: payload.actor || '',
    contractVersion: payload.contractVersion,
  }, nonce);
}

function confirmEvent_(payload, nonce) {
  var operationId = e2OperationId_(payload, nonce);
  var txnId = String(payload.txnId || payload.txn_id || '').trim();
  if (!txnId) throw new Error('txnId is required');
  var content = {
    kind: 'confirmation', txnId: txnId,
    category: Object.prototype.hasOwnProperty.call(payload, 'category') ? payload.category : undefined,
    confirmed: payload.confirmed === true,
    pendingTransition: payload.pendingTransition === true || payload.state === 'pending',
  };
  return command_({
    operationId: operationId,
    expectedRevisions: e2ExpectedRevisions_(payload, txnId),
    contentDigest: payload.contentDigest || e2Digest_(content),
    content: content,
    actor: payload.actor || '',
    contractVersion: payload.contractVersion,
  }, nonce);
}

function e2PayloadContent_(payload) {
  var content = {};
  var excluded = {
    action: true, operationId: true, operation_id: true,
    expectedRevisions: true, expectedRevision: true, expectedSnapshotRevision: true,
    contentDigest: true, contractVersion: true, actor: true,
  };
  for (var key in (payload || {})) {
    if (Object.prototype.hasOwnProperty.call(payload, key) && !excluded[key]) content[key] = payload[key];
  }
  return content;
}

function e2ForwardClaims_(content, payload, nested) {
  var claims = payload && payload.claims;
  if (claims === undefined && nested && nested.claims !== undefined) claims = nested.claims;
  if (claims !== undefined) content.claims = claims;
  return content;
}

function acceptImport_(payload, nonce) {
  var manifest = payload.manifest || e2PayloadContent_(payload);
  var content = {
    kind: 'manifest', manifest: manifest,
    steps: payload.steps || (payload.manifest && payload.manifest.steps) || [],
    actor: payload.actor || '',
  };
  e2ForwardClaims_(content, payload, payload.manifest);
  return command_({
    operationId: e2OperationId_(payload, nonce),
    expectedRevisions: e2ExpectedRevisions_(payload, payload.manifestId || ''),
    contentDigest: payload.contentDigest,
    content: content,
    actor: payload.actor || '',
    contractVersion: payload.contractVersion,
  }, nonce);
}

function resumeImport_(payload, nonce) {
  return command_({
    operationId: e2OperationId_(payload, nonce),
    expectedRevisions: e2ExpectedRevisions_(payload, payload.manifestId || ''),
    contentDigest: payload.contentDigest,
    content: {
      kind: 'resume-import', manifestId: payload.manifestId,
      steps: payload.steps || [],
      actor: payload.actor || '',
    },
    actor: payload.actor || '',
    contractVersion: payload.contractVersion,
  }, nonce);
}

function recordEvidence_(payload, nonce) {
  return command_({
    operationId: e2OperationId_(payload, nonce), expectedRevisions: e2ExpectedRevisions_(payload, payload.evidenceId || ''),
    contentDigest: payload.contentDigest,
    content: { kind: 'evidence', evidence: payload.evidence || e2PayloadContent_(payload), actor: payload.actor || '' },
    actor: payload.actor || '',
    contractVersion: payload.contractVersion,
  }, nonce);
}

function recordLink_(payload, nonce) {
  return command_({
    operationId: e2OperationId_(payload, nonce), expectedRevisions: e2ExpectedRevisions_(payload, payload.linkId || ''),
    contentDigest: payload.contentDigest,
    content: { kind: 'link', link: payload.link || e2PayloadContent_(payload), actor: payload.actor || '' },
    actor: payload.actor || '',
    contractVersion: payload.contractVersion,
  }, nonce);
}

function acceptCheckpoint_(payload, nonce) {
  return command_({
    operationId: e2OperationId_(payload, nonce), expectedRevisions: e2ExpectedRevisions_(payload, payload.checkpointId || ''),
    contentDigest: payload.contentDigest,
    content: { kind: 'checkpoint', checkpoint: payload.checkpoint || e2PayloadContent_(payload), actor: payload.actor || '' },
    actor: payload.actor || '',
    contractVersion: payload.contractVersion,
  }, nonce);
}

function setVersionedSetting_(payload, nonce) {
  return command_({
    operationId: e2OperationId_(payload, nonce), expectedRevisions: e2ExpectedRevisions_(payload, payload.settingId || ''),
    contentDigest: payload.contentDigest,
    content: { kind: 'setting', setting: payload.setting || e2PayloadContent_(payload), actor: payload.actor || '' },
    actor: payload.actor || '',
    contractVersion: payload.contractVersion,
  }, nonce);
}

function publishResult_(payload, nonce) {
  return command_({
    operationId: e2OperationId_(payload, nonce), expectedRevisions: e2ExpectedRevisions_(payload, payload.resultId || ''),
    contentDigest: payload.contentDigest,
    content: { kind: 'result', result: payload.result || e2PayloadContent_(payload), actor: payload.actor || '' },
    actor: payload.actor || '',
    contractVersion: payload.contractVersion,
  }, nonce);
}

function openingAdjustment_(payload, nonce) {
  return command_({
    operationId: e2OperationId_(payload, nonce), expectedRevisions: e2ExpectedRevisions_(payload, payload.checkpointId || ''),
    contentDigest: payload.contentDigest,
    content: { kind: 'opening-adjustment', adjustment: payload.adjustment || e2PayloadContent_(payload), actor: payload.actor || '' },
    actor: payload.actor || '',
    contractVersion: payload.contractVersion,
  }, nonce);
}

function correctEvent_(payload, nonce) {
  return command_({
    operationId: e2OperationId_(payload, nonce), expectedRevisions: e2ExpectedRevisions_(payload, String(payload.txnId || payload.txn_id || '')),
    contentDigest: payload.contentDigest,
    content: { kind: 'correction', correction: payload.correction || e2PayloadContent_(payload), actor: payload.actor || '' },
    actor: payload.actor || '',
    contractVersion: payload.contractVersion,
  }, nonce);
}

function expectedRevisionInput_(payload, id) {
  if (payload && payload.expectedRevision && id) {
    return [{ id: id, revision: String(payload.expectedRevision) }];
  }
  return [];
}

function e2ExpectedRevisions_(payload, fallbackId) {
  if (payload && Array.isArray(payload.expectedRevisions)) return payload.expectedRevisions;
  if (payload && payload.expectedSnapshotRevision && fallbackId) {
    return [{ id: String(fallbackId), revision: String(payload.expectedSnapshotRevision) }];
  }
  return expectedRevisionInput_(payload, fallbackId);
}

function e2ExecuteEventGroup_(spreadsheet, operationId, digest, content, reserveClaims, recoveringUnknown) {
  var groupId = String(content.groupId || operationId).trim();
  if (!groupId) return { rejected: e2Rejected_(operationId, 'group-id-required') };
  var legs = content.legs;
  if (!Array.isArray(legs) || legs.length === 0) {
    return { rejected: e2Rejected_(operationId, 'group-legs-required') };
  }
  var byCurrency = Object.create(null);
  var postings = [];
  var vocabulary = readAccountVocabulary_(spreadsheet);
  var nativeCurrencies = Object.create(null);
  var feeLegIds = Object.create(null);
  var feeLegRecords = [];
  var seenTxnIds = Object.create(null);
  for (var index = 0; index < legs.length; index += 1) {
    var leg = legs[index];
    if (!leg || typeof leg !== 'object') {
      return { rejected: e2Rejected_(operationId, 'group-leg-invalid') };
    }
    var amount;
    try { amount = canonicalDecimal_(leg.amount, index + 1); } catch (error) {
      return { rejected: e2Rejected_(operationId, 'group-amount-invalid') };
    }
    if (amount === '0' || amount.charAt(0) === '-') {
      return { rejected: e2Rejected_(operationId, 'group-amount-must-be-positive') };
    }
    var txnId = String(leg.txnId || leg.txn_id || '').trim();
    if (!UUID_PATTERN.test(txnId)) {
      return { rejected: e2Rejected_(operationId, 'group-posting-invalid', 'E2 txn_id must be an explicit UUID') };
    }
    if (seenTxnIds[txnId]) {
      return { rejected: e2Rejected_(operationId, 'group-duplicate-leg-id', txnId) };
    }
    seenTxnIds[txnId] = true;
    var currency = String(leg.currency || '').trim();
    var debitCurrency = String(leg.debitCurrency || leg.debit_currency || currency).trim();
    var creditCurrency = String(leg.creditCurrency || leg.credit_currency || currency).trim();
    if (!currency) currency = debitCurrency || creditCurrency;
    if (!/^[A-Z]{3}$/.test(currency) || !/^[A-Z]{3}$/.test(debitCurrency) || !/^[A-Z]{3}$/.test(creditCurrency)) {
      return { rejected: e2Rejected_(operationId, 'group-currency-invalid') };
    }
    nativeCurrencies[debitCurrency] = true;
    nativeCurrencies[creditCurrency] = true;
    var debitAmount;
    var creditAmount;
    try {
      debitAmount = canonicalDecimal_(
        Object.prototype.hasOwnProperty.call(leg, 'debitAmount') ? leg.debitAmount : amount,
        index + 1,
      );
      creditAmount = canonicalDecimal_(
        Object.prototype.hasOwnProperty.call(leg, 'creditAmount') ? leg.creditAmount : amount,
        index + 1,
      );
    } catch (error) {
      return { rejected: e2Rejected_(operationId, 'group-currency-total-invalid') };
    }
    if (debitAmount.charAt(0) === '-' || creditAmount.charAt(0) === '-') {
      return { rejected: e2Rejected_(operationId, 'group-currency-total-invalid') };
    }
    if (leg.feeId || leg.fee_id || String(leg.kind || '').toLowerCase() === 'fee' || leg.isFee === true) {
      var feeId = String(leg.feeId || leg.fee_id || '').trim();
      var feeRecord = { id: feeId, amount: amount, currency: currency, txnId: txnId };
      feeLegRecords.push(feeRecord);
      if (feeId) feeLegIds[feeId] = feeRecord;
    }
    var debit = String(leg.debitAccount || leg.debit_account || '').trim();
    var credit = String(leg.creditAccount || leg.credit_account || '').trim();
    if (debit || credit) {
      if (!debit || !credit || debit === credit) {
        return { rejected: e2Rejected_(operationId, 'group-posting-legs-invalid') };
      }
      // A journal row has one native currency.  Cross-currency movements must
      // be represented by separate native legs (or metadata-only legs), never
      // by forcing one amount/currency onto both sides of a row.
      if (debitCurrency !== creditCurrency) {
        return { rejected: e2Rejected_(operationId, 'group-native-leg-currency-mismatch') };
      }
      try {
        validateOptionalVocabulary_(debit, 'debit account', vocabulary, null);
        validateOptionalVocabulary_(credit, 'credit account', vocabulary, null);
      } catch (error) {
        return { rejected: e2Rejected_(operationId, 'group-account-invalid', String(error.message || error)) };
      }
      var posting = postingRow_({
        date: leg.date || content.date || taipeiIsoNow_().slice(0, 10),
        time: leg.time || '', type: leg.type || content.type || '轉帳',
        debitAccount: debit, creditAccount: credit, amount: amount,
        currency: debitCurrency,
        category: leg.category || nominalLeg_(debit, credit, vocabulary.accountTypes),
        payee: leg.payee || leg.counterparty || '',
        description: leg.description || content.description || '',
        settlementStatus: leg.settlementStatus || '', reversalTxnId: leg.reversalTxnId || '',
        txnId: txnId, source: 'import', now: taipeiIsoNow_(),
      });
      try {
        validateE2Posting_(posting, vocabulary, 'import');
      } catch (error) {
        return { rejected: e2Rejected_(operationId, 'group-posting-invalid', String(error.message || error)) };
      }
      postings.push({ posting: posting, txnId: txnId, amount: amount, currency: debitCurrency,
        debitCurrency: debitCurrency, creditCurrency: creditCurrency,
        debitAmount: debitAmount, creditAmount: creditAmount });
    } else {
      // A metadata-only leg is allowed for a clearing representation that is
      // posted by another book. It still participates in per-currency proof.
      postings.push({ posting: null, txnId: txnId, amount: amount, currency: currency,
        debitCurrency: debitCurrency, creditCurrency: creditCurrency,
        debitAmount: debitAmount, creditAmount: creditAmount });
    }
    if (!byCurrency[debitCurrency]) byCurrency[debitCurrency] = { currency: debitCurrency, debit: '0', credit: '0' };
    if (!byCurrency[creditCurrency]) byCurrency[creditCurrency] = { currency: creditCurrency, debit: '0', credit: '0' };
    byCurrency[debitCurrency].debit = addDecimalStrings_(byCurrency[debitCurrency].debit, debitAmount);
    byCurrency[creditCurrency].credit = addDecimalStrings_(byCurrency[creditCurrency].credit, creditAmount);
  }
  var nativeCurrencyList = Object.keys(nativeCurrencies);
  if (nativeCurrencyList.length > 1) {
    var conversion = content.conversion || content.fx || content.exchange || {};
    var conversionReference = String(
      (conversion && (conversion.reference || conversion.id || conversion.link || conversion.conversionReference || conversion.conversion_reference))
      || content.conversionReference || content.conversion_reference || content.fxReference || content.fx_reference || '',
    ).trim();
    var clearingReference = String(
      (conversion && (conversion.clearingReference || conversion.clearing_reference || conversion.clearingLink || conversion.clearing_link))
      || content.clearingReference || content.clearing_reference || content.clearingLink || content.clearing_link || '',
    ).trim();
    if (!conversionReference || !clearingReference) {
      for (var referenceLegIndex = 0; referenceLegIndex < legs.length; referenceLegIndex += 1) {
        var referenceLeg = legs[referenceLegIndex] || {};
        if (!conversionReference) {
          conversionReference = String(referenceLeg.conversionReference || referenceLeg.conversion_reference || referenceLeg.fxReference || referenceLeg.fx_reference || '').trim();
        }
        if (!clearingReference) {
          clearingReference = String(referenceLeg.clearingReference || referenceLeg.clearing_reference || referenceLeg.clearingLink || referenceLeg.clearing_link || '').trim();
        }
        if (conversionReference && clearingReference) break;
      }
    }
    if (!conversionReference || !clearingReference) {
      return { rejected: e2Rejected_(operationId, 'group-conversion-evidence-required') };
    }
  }
  var feeMetadata = content.fees || content.feeMetadata || content.fee_metadata || [];
  if (feeMetadata && !Array.isArray(feeMetadata)) {
    return { rejected: e2Rejected_(operationId, 'group-fee-metadata-invalid') };
  }
  for (var feeIndex = 0; feeIndex < (feeMetadata || []).length; feeIndex += 1) {
    var fee = feeMetadata[feeIndex];
    if (!fee || typeof fee !== 'object') {
      return { rejected: e2Rejected_(operationId, 'group-fee-metadata-invalid') };
    }
    var feeAmount;
    var feeCurrency = String(fee.currency || '').trim();
    try { feeAmount = canonicalDecimal_(fee.amount, feeIndex + 1); } catch (error) { feeAmount = ''; }
    if (!feeCurrency || !/^[A-Z]{3}$/.test(feeCurrency) || !feeAmount || feeAmount === '0' || feeAmount.charAt(0) === '-') {
      return { rejected: e2Rejected_(operationId, 'group-fee-metadata-invalid') };
    }
    var feeIdValue = String(fee.feeId || fee.fee_id || fee.id).trim();
    var feeLeg = feeLegIds[feeIdValue];
    if (!feeLeg && !feeIdValue) {
      for (var feeLegIndex = 0; feeLegIndex < feeLegRecords.length; feeLegIndex += 1) {
        if (!feeLegRecords[feeLegIndex].matched && feeLegRecords[feeLegIndex].amount === feeAmount && feeLegRecords[feeLegIndex].currency === feeCurrency) {
          feeLeg = feeLegRecords[feeLegIndex];
          break;
        }
      }
    }
    if (!feeLeg || feeLeg.amount !== feeAmount || feeLeg.currency !== feeCurrency) {
      return { rejected: e2Rejected_(operationId, 'group-fee-leg-missing') };
    }
    feeLeg.matched = true;
  }
  for (var unmatchedFeeIndex = 0; unmatchedFeeIndex < feeLegRecords.length; unmatchedFeeIndex += 1) {
    if (!feeLegRecords[unmatchedFeeIndex].matched) {
      return { rejected: e2Rejected_(operationId, 'group-fee-metadata-required') };
    }
  }
  var declared = content.currencyTotals;
  if (declared && typeof declared === 'object' && !Array.isArray(declared)) {
    var declaredList = [];
    var declaredCurrencies = Object.keys(declared).sort();
    for (var declaredIndex = 0; declaredIndex < declaredCurrencies.length; declaredIndex += 1) {
      var declaredCurrency = declaredCurrencies[declaredIndex];
      var declaredValue = declared[declaredCurrency];
      if (declaredValue && typeof declaredValue === 'object') {
        declaredList.push({ currency: declaredCurrency, debit: String(declaredValue.debit || '0'), credit: String(declaredValue.credit || '0') });
      } else {
        declaredList.push({ currency: declaredCurrency, debit: String(declaredValue || '0'), credit: String(declaredValue || '0') });
      }
    }
    declared = declaredList;
  }
  var currencyTotals = Array.isArray(declared) ? declared : [];
  if (currencyTotals.length === 0) {
    var currencies = Object.keys(byCurrency).sort();
    for (var currencyIndex = 0; currencyIndex < currencies.length; currencyIndex += 1) {
      currencyTotals.push(byCurrency[currencies[currencyIndex]]);
    }
  }
  var declaredByCurrency = Object.create(null);
  for (var totalIndex = 0; totalIndex < currencyTotals.length; totalIndex += 1) {
    var total = currencyTotals[totalIndex];
    var totalCurrency = String(total.currency || '').trim();
    if (!/^[A-Z]{3}$/.test(totalCurrency)) {
      return { rejected: e2Rejected_(operationId, 'group-currency-invalid') };
    }
    if (declaredByCurrency[totalCurrency]) {
      return { rejected: e2Rejected_(operationId, 'group-currency-total-duplicate', totalCurrency) };
    }
    var debitTotal;
    var creditTotal;
    try {
      debitTotal = canonicalDecimal_(total.debit, 0);
      creditTotal = canonicalDecimal_(total.credit, 0);
    } catch (error) {
      return { rejected: e2Rejected_(operationId, 'group-currency-total-invalid') };
    }
    if (debitTotal !== creditTotal) {
      return { rejected: e2Rejected_(operationId, 'group-not-balanced-within-currency', totalCurrency) };
    }
    declaredByCurrency[totalCurrency] = { debit: debitTotal, credit: creditTotal };
  }
  var actualCurrencies = Object.keys(byCurrency);
  for (var actualCurrencyIndex = 0; actualCurrencyIndex < actualCurrencies.length; actualCurrencyIndex += 1) {
    var actualCurrency = actualCurrencies[actualCurrencyIndex];
    var declaredTotal = declaredByCurrency[actualCurrency];
    if (!declaredTotal || declaredTotal.debit !== byCurrency[actualCurrency].debit ||
        declaredTotal.credit !== byCurrency[actualCurrency].credit) {
      return { rejected: e2Rejected_(operationId, 'group-currency-total-mismatch', actualCurrency) };
    }
  }
  var declaredCurrencyList = Object.keys(declaredByCurrency);
  for (var declaredCurrencyIndex = 0; declaredCurrencyIndex < declaredCurrencyList.length; declaredCurrencyIndex += 1) {
    if (!byCurrency[declaredCurrencyList[declaredCurrencyIndex]]) {
      return { rejected: e2Rejected_(operationId, 'group-currency-total-mismatch', declaredCurrencyList[declaredCurrencyIndex]) };
    }
  }
  var existingGroups = e2Rows_(spreadsheet, '事件群組');
  var existingGroup = null;
  for (var existingIndex = existingGroups.length - 1; existingIndex >= 0; existingIndex -= 1) {
    if (existingGroups[existingIndex].values.group_id === groupId) {
      existingGroup = existingGroups[existingIndex];
      if (existingGroup.values.content_digest !== digest) {
        return { conflict: e2Conflict_(operationId, 'group-id-reused-with-different-content', []) };
      }
      break;
    }
  }
  var existingDetailByTxnId = Object.create(null);
  var existingDetailRows = e2Rows_(spreadsheet, '事件群組明細');
  for (var existingLegIndex = 0; existingLegIndex < existingDetailRows.length; existingLegIndex += 1) {
    var existingDetail = existingDetailRows[existingLegIndex].values;
    if (existingDetail.group_id === groupId && !existingDetailByTxnId[existingDetail.txn_id]) {
      existingDetailByTxnId[existingDetail.txn_id] = existingDetail;
    }
  }
  var expectedLegDigests = Object.create(null);
  var expectedLegsComplete = true;
  for (var expectedLegIndex = 0; expectedLegIndex < postings.length; expectedLegIndex += 1) {
    var expectedLeg = postings[expectedLegIndex];
    var expectedDigest = e2Digest_({
      groupId: groupId, txnId: expectedLeg.txnId,
      amount: expectedLeg.amount, currency: expectedLeg.currency,
    });
    expectedLegDigests[expectedLeg.txnId] = expectedDigest;
    if (!existingDetailByTxnId[expectedLeg.txnId] ||
        existingDetailByTxnId[expectedLeg.txnId].content_digest !== expectedDigest) {
      expectedLegsComplete = false;
    }
  }
  if (existingGroup && existingGroup.values.status === 'complete' && expectedLegsComplete) {
    var existingDestinations = [];
    for (var completeLegIndex = 0; completeLegIndex < postings.length; completeLegIndex += 1) {
      var completeLeg = postings[completeLegIndex];
      existingDestinations.push({ id: completeLeg.txnId, revision: expectedLegDigests[completeLeg.txnId] });
    }
    existingDestinations.push({ id: groupId, revision: existingGroup.values.content_digest || digest });
    return { destinations: existingDestinations };
  }
  var now = taipeiIsoNow_();
  var groupSheetRow;
  groupSheetRow = e2Append_(spreadsheet, '事件群組', {
    group_id: groupId, status: 'incomplete', currency_totals_json: e2Json_(currencyTotals),
    completion_marker: '', content_digest: digest,
    created_at: existingGroup && existingGroup.values.created_at ? existingGroup.values.created_at : now,
    updated_at: now, source: 'import',
  });
  e2PersistActorMetadata_(spreadsheet, 'event-group', groupId, digest, content.actor, operationId);
  var destinations = [];
  try {
    for (var postingIndex = 0; postingIndex < postings.length; postingIndex += 1) {
      var item = postings[postingIndex];
      var legDigest = expectedLegDigests[item.txnId];
      var existingDetailForLeg = existingDetailByTxnId[item.txnId];
      if (existingDetailForLeg) {
        if (existingDetailForLeg.content_digest !== legDigest) {
          return { conflict: e2Conflict_(operationId, 'group-leg-content-conflict', [{ id: item.txnId }]) };
        }
      }
      var journalForLeg;
      var columnsForLeg;
      var existingTxnRowForLeg = null;
      if (item.posting) {
        journalForLeg = requiredSheet_(spreadsheet, '日記帳');
        var headers = journalForLeg.getRange(1, 1, 1, journalForLeg.getLastColumn()).getDisplayValues()[0];
        columnsForLeg = resolveHeaders_(headers, JOURNAL_HEADERS);
        validatePostingVocabulary_(item.posting, vocabulary);
        existingTxnRowForLeg = findTxnRow_(journalForLeg, columnsForLeg.txn_id, item.txnId);
        if (existingTxnRowForLeg !== null) {
          if (!existingGroup) {
            return { conflict: e2Conflict_(operationId, 'txn-id-already-exists', [{ id: item.txnId }]) };
          }
          for (var linkedGroupIndex = 0; linkedGroupIndex < existingDetailRows.length; linkedGroupIndex += 1) {
            var linkedGroupValues = existingDetailRows[linkedGroupIndex].values;
            if (linkedGroupValues.txn_id === item.txnId && linkedGroupValues.group_id !== groupId) {
              return { conflict: e2Conflict_(operationId, 'txn-id-already-linked', [{ id: item.txnId }]) };
            }
          }
          var existingJournalValues = journalForLeg.getRange(existingTxnRowForLeg, 1, 1, journalForLeg.getLastColumn()).getDisplayValues()[0];
          var existingAmount;
          try { existingAmount = canonicalDecimal_(existingJournalValues[columnsForLeg['金額'] - 1], existingTxnRowForLeg); } catch (error) { existingAmount = ''; }
          if (existingAmount !== item.amount ||
              String(existingJournalValues[columnsForLeg['幣別'] - 1] || '').trim() !== item.currency ||
              String(existingJournalValues[columnsForLeg['借方帳戶'] - 1] || '').trim() !== item.posting['借方帳戶'] ||
              String(existingJournalValues[columnsForLeg['貸方帳戶'] - 1] || '').trim() !== item.posting['貸方帳戶']) {
            return { conflict: e2Conflict_(operationId, 'group-leg-content-conflict', [{ id: item.txnId }]) };
          }
        }
      }
      // The detail row is the visibility guard for account balances. Write it
      // before the journal effect so an interruption cannot leave an
      // unclassified posting counted by a later snapshot.
      // Reserve source observations only after this leg has passed all
      // conflict checks; a rejected/conflicting request must not strand a
      // claim when it did not write a monetary effect.
      if (reserveClaims && (!existingDetailForLeg || (item.posting && existingTxnRowForLeg === null))) {
        reserveClaims();
      }
      if (!existingDetailForLeg) {
        e2Append_(spreadsheet, '事件群組明細', {
          group_id: groupId, txn_id: item.txnId, leg_index: postingIndex,
          amount: item.amount, currency: item.currency,
          debit_account: item.posting ? item.posting['借方帳戶'] : '',
          credit_account: item.posting ? item.posting['貸方帳戶'] : '',
          content_digest: legDigest,
        });
        e2PersistActorMetadata_(spreadsheet, 'event-group-leg', groupId + ':' + item.txnId, legDigest, content.actor, operationId);
      }
      if (item.posting && existingTxnRowForLeg === null) {
        appendPosting_(journalForLeg, columnsForLeg, item.posting);
      }
      destinations.push({ id: item.txnId, revision: legDigest });
    }
    var completeRevision = e2Digest_({ groupId: groupId, digest: digest, status: 'complete' });
    e2Append_(spreadsheet, '事件群組', {
      group_id: groupId, status: 'complete', currency_totals_json: e2Json_(currencyTotals),
      completion_marker: String(content.completionMarker || 'complete:' + digest),
      content_digest: digest,
      created_at: existingGroup && existingGroup.values.created_at ? existingGroup.values.created_at : now,
      updated_at: taipeiIsoNow_(), source: 'import',
    });
    e2PersistActorMetadata_(spreadsheet, 'event-group', groupId, completeRevision, content.actor, operationId);
    var groupEvidenceId = groupId;
    var existingGroupEvidence = e2LatestRecord_(spreadsheet, 'event-group-evidence', groupEvidenceId);
    if (!existingGroupEvidence) {
      var groupEvidenceData = {
        groupId: groupId,
        actor: content.actor || '',
        conversion: content.conversion || content.fx || content.exchange || null,
        conversionReference: content.conversionReference || content.conversion_reference || content.fxReference || content.fx_reference || '',
        clearingReference: content.clearingReference || content.clearing_reference || content.clearingLink || content.clearing_link || '',
        fees: content.fees || content.feeMetadata || content.fee_metadata || [],
      };
      e2Append_(spreadsheet, '整合記錄', {
        scope: 'event-group-evidence', record_id: groupEvidenceId,
        revision: e2Digest_(groupEvidenceData), data_json: e2Json_(groupEvidenceData),
        created_at: taipeiIsoNow_(),
      });
    }
    e2PersistActorMetadata_(spreadsheet, 'event-group-evidence', groupEvidenceId, digest, content.actor, operationId);
  } catch (error) {
    if (groupSheetRow) {
      var incompleteRevision = e2Digest_({ groupId: groupId, digest: digest, status: 'incomplete' });
      e2Append_(spreadsheet, '事件群組', {
        group_id: groupId, status: 'incomplete', currency_totals_json: e2Json_(currencyTotals),
        completion_marker: '', content_digest: digest,
        created_at: existingGroup && existingGroup.values.created_at ? existingGroup.values.created_at : now,
        updated_at: taipeiIsoNow_(), source: 'import',
      });
      e2PersistActorMetadata_(spreadsheet, 'event-group', groupId, incompleteRevision, content.actor, operationId);
    }
    throw error;
  }
  destinations.push({ id: groupId, revision: digest });
  return { destinations: destinations };
}

function e2ExecuteConfirmation_(spreadsheet, operationId, digest, content) {
  var txnId = String(content.txnId || '').trim();
  if (!txnId) return { rejected: e2Rejected_(operationId, 'txn-id-required') };
  var source = readSnapshotSource_(spreadsheet);
  var target = null;
  for (var index = 0; index < source.journalRows.length; index += 1) {
    var row = source.journalRows[index];
    if (String(row.values.txn_id || '').trim() === txnId) {
      target = row;
      break;
    }
  }
  if (!target) return { rejected: e2Rejected_(operationId, 'unknown-txn-id') };
  var categoryProvided = Object.prototype.hasOwnProperty.call(content, 'category') && content.category !== undefined;
  var category = categoryProvided
    ? String(content.category || '').trim()
    : String(target.values['分類'] || '').trim();
  var confirmed = content.confirmed === true;
  var pendingTransition = content.pendingTransition === true;
  var priorReview = source.reviewByTxnId && source.reviewByTxnId[txnId];
  if (!categoryProvided && priorReview && priorReview.category) {
    category = String(priorReview.category).trim();
  }
  if (priorReview && priorReview.reviewState === 'confirmed' &&
      (!category || category === '尚未分類') && !pendingTransition) {
    return { rejected: e2Rejected_(operationId, 'pending-transition-required') };
  }
  if (confirmed && (!category || category === '尚未分類')) {
    return { rejected: e2Rejected_(operationId, 'confirmation-requires-category') };
  }
  if (!confirmed && !pendingTransition && Object.prototype.hasOwnProperty.call(content, 'category') && category !== '') {
    // Choosing a category is a review edit, not a confirmation transition.
    confirmed = false;
  }
  var vocabulary = readAccountVocabulary_(spreadsheet);
  if (category && category !== '尚未分類' &&
      (!Object.prototype.hasOwnProperty.call(vocabulary.accountTypes, category) ||
       (vocabulary.accountTypes[category] !== '支出' && vocabulary.accountTypes[category] !== '收入'))) {
    return { rejected: e2Rejected_(operationId, 'confirmation-category-invalid') };
  }
  // Confirmation is an append-only review decision.  The original journal
  // row is evidence and must remain byte-for-byte unchanged; snapshots layer
  // the latest E2 review metadata over it to expose resulting state.
  var reviewRevision = e2Digest_({ txnId: txnId, category: category, state: confirmed ? 'confirmed' : 'pending', operationId: operationId });
  e2Append_(spreadsheet, '事件審核', {
    txn_id: txnId, category: category, review_state: confirmed ? 'confirmed' : 'pending',
    revision: reviewRevision, operation_id: operationId, updated_at: taipeiIsoNow_(),
  });
  e2PersistActorMetadata_(spreadsheet, 'event-review', txnId, reviewRevision, content.actor, operationId);
  var updatedSource = readSnapshotSource_(spreadsheet);
  var updatedEvents = snapshotEventRecords_(updatedSource);
  var updatedRevision = reviewRevision;
  for (var eventIndex = 0; eventIndex < updatedEvents.length; eventIndex += 1) {
    if (updatedEvents[eventIndex].id === txnId) {
      updatedRevision = updatedEvents[eventIndex].contentDigest;
      break;
    }
  }
  return { destinations: [{ id: txnId, revision: updatedRevision }] };
}

function e2ManifestId_(manifest) {
  var id = String(manifest && (manifest.manifestId || manifest.manifest_id || manifest.id) || '').trim();
  if (!id) throw new Error('manifestId is required');
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(id)) throw new Error('manifestId is invalid');
  return id;
}

function e2ExecuteManifest_(spreadsheet, operationId, digest, content, reserveClaims, recoveringUnknown) {
  var manifest = content.manifest || content;
  var manifestId;
  try { manifestId = e2ManifestId_(manifest); } catch (error) {
    return { rejected: e2Rejected_(operationId, 'manifest-id-required') };
  }
  var steps = content.steps || manifest.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    return { rejected: e2Rejected_(operationId, 'plan-incomplete', 'steps are required') };
  }
  var sourceEvidence = manifest.sourceEvidence || manifest.source_evidence;
  if (!Array.isArray(sourceEvidence) || sourceEvidence.length === 0) {
    return { rejected: e2Rejected_(operationId, 'plan-incomplete', 'source evidence is required') };
  }
  var seenEvidenceIds = Object.create(null);
  for (var evidenceIdIndex = 0; evidenceIdIndex < sourceEvidence.length; evidenceIdIndex += 1) {
    if (typeof sourceEvidence[evidenceIdIndex] !== 'string') {
      return { rejected: e2Rejected_(operationId, 'plan-incomplete', 'source evidence ids must be strings') };
    }
    var sourceEvidenceId = String(sourceEvidence[evidenceIdIndex] || '').trim();
    if (!sourceEvidenceId || seenEvidenceIds[sourceEvidenceId]) {
      return { rejected: e2Rejected_(operationId, 'plan-incomplete', 'source evidence ids must be unique and nonblank') };
    }
    seenEvidenceIds[sourceEvidenceId] = true;
  }
  var seenStepIds = Object.create(null);
  var seenPlanClaims = Object.create(null);
  var manifestClaims = content.claims || manifest.claims;
  if (manifestClaims !== undefined && !Array.isArray(manifestClaims)) {
    return { rejected: e2Rejected_(operationId, 'plan-incomplete', 'claims must be an array') };
  }
  for (var manifestClaimIndex = 0; manifestClaimIndex < (manifestClaims || []).length; manifestClaimIndex += 1) {
    var manifestClaimId = String(manifestClaims[manifestClaimIndex] || '').trim();
    if (!manifestClaimId || seenPlanClaims[manifestClaimId]) {
      return { rejected: e2Rejected_(operationId, 'plan-incomplete', 'claims must be unique and nonblank') };
    }
    seenPlanClaims[manifestClaimId] = true;
  }
  var planExpectedRevisions = content.planExpectedRevisions || content.expectedRevisions
    || manifest.expectedRevisions || manifest.expected_revisions;
  if (planExpectedRevisions !== undefined) {
    if (!Array.isArray(planExpectedRevisions)) {
      return { rejected: e2Rejected_(operationId, 'plan-incomplete', 'expected revisions must be an array') };
    }
    var seenExpectedRevisionIds = Object.create(null);
    var normalizedPlanExpectedRevisions = [];
    for (var planRevisionIndex = 0; planRevisionIndex < planExpectedRevisions.length; planRevisionIndex += 1) {
      var expectedRevision = planExpectedRevisions[planRevisionIndex];
      var expectedRevisionId = String(expectedRevision && (expectedRevision.id || expectedRevision.recordId || expectedRevision.record_id) || '').trim();
      var expectedRevisionValue = String(expectedRevision && (expectedRevision.revision || expectedRevision.expectedRevision || expectedRevision.expected_revision) || '').trim();
      if (!expectedRevisionId || !expectedRevisionValue || seenExpectedRevisionIds[expectedRevisionId]) {
        return { rejected: e2Rejected_(operationId, 'plan-incomplete', 'expected revisions are invalid') };
      }
      seenExpectedRevisionIds[expectedRevisionId] = true;
      normalizedPlanExpectedRevisions.push({ id: expectedRevisionId, revision: expectedRevisionValue });
    }
    var planRevisionConflicts = recoveringUnknown
      ? e2ExpectedConflictsForRecovery_(spreadsheet, normalizedPlanExpectedRevisions, content, digest, operationId)
      : e2CheckExpectedRevisions_(spreadsheet, normalizedPlanExpectedRevisions);
    if (planRevisionConflicts.length > 0) {
      return { conflict: e2Conflict_(operationId, 'stale-expected-revision', planRevisionConflicts) };
    }
  }
  for (var index = 0; index < steps.length; index += 1) {
    var step = steps[index];
    if (!step || typeof step !== 'object' || !String(step.stepId || step.step_id || step.id || '').trim()) {
      return { rejected: e2Rejected_(operationId, 'plan-incomplete', 'every step needs an id') };
    }
    var stepId = String(step.stepId || step.step_id || step.id).trim();
    if (seenStepIds[stepId]) {
      return { rejected: e2Rejected_(operationId, 'plan-incomplete', 'step ids must be unique') };
    }
    seenStepIds[stepId] = true;
    var disposition = String(step.disposition || step.action || '').trim();
    var state = String(step.state || step.status || '').trim();
    if (!disposition || !state) {
      return { rejected: e2Rejected_(operationId, 'plan-incomplete', 'every step needs a disposition and state') };
    }
    if (['create', 'link', 'already-imported', 'skip'].indexOf(disposition) === -1) {
      return { rejected: e2Rejected_(operationId, 'plan-incomplete', 'unsupported step disposition') };
    }
    if (['pending', 'completed', 'conflicted', 'conflicting', 'rejected', 'unknown', 'skipped'].indexOf(state) === -1) {
      return { rejected: e2Rejected_(operationId, 'plan-incomplete', 'unsupported step state') };
    }
    var destinationId = String(step.destinationId || step.destination_id || '').trim();
    var destinationRevision = String(step.destinationRevision || step.destination_revision || '').trim();
    if ((disposition === 'link' || disposition === 'already-imported' || state === 'completed') &&
        (!destinationId || !destinationRevision)) {
      return { rejected: e2Rejected_(operationId, 'plan-incomplete', 'destination identity is required') };
    }
    if (disposition === 'skip' && !String(step.reason || (step.result && step.result.reason) || '').trim()) {
      return { rejected: e2Rejected_(operationId, 'plan-incomplete', 'skipped steps need a reason') };
    }
    var stepClaim = String(step.claimId || step.claim_id || step.observationId || step.observation_id || '').trim();
    if (stepClaim) {
      if (seenPlanClaims[stepClaim]) {
        return { rejected: e2Rejected_(operationId, 'plan-incomplete', 'claims must be unique and nonblank') };
      }
      seenPlanClaims[stepClaim] = true;
    }
    if (step.claims !== undefined) {
      if (!Array.isArray(step.claims)) {
        return { rejected: e2Rejected_(operationId, 'plan-incomplete', 'step claims must be an array') };
      }
      for (var stepClaimIndex = 0; stepClaimIndex < step.claims.length; stepClaimIndex += 1) {
        var stepClaimId = String(step.claims[stepClaimIndex] || '').trim();
        if (!stepClaimId || seenPlanClaims[stepClaimId]) {
          return { rejected: e2Rejected_(operationId, 'plan-incomplete', 'claims must be unique and nonblank') };
        }
        seenPlanClaims[stepClaimId] = true;
      }
    }
    var stepExpectedRevisions = step.expectedRevisions || step.expected_revisions;
    if (stepExpectedRevisions !== undefined) {
      if (!Array.isArray(stepExpectedRevisions)) {
        return { rejected: e2Rejected_(operationId, 'plan-incomplete', 'step expected revisions are invalid') };
      }
      var seenStepRevisionIds = Object.create(null);
      var normalizedStepExpectedRevisions = [];
      for (var stepRevisionIndex = 0; stepRevisionIndex < stepExpectedRevisions.length; stepRevisionIndex += 1) {
        var stepExpectedRevision = stepExpectedRevisions[stepRevisionIndex];
        var stepExpectedId = String(stepExpectedRevision && (stepExpectedRevision.id || stepExpectedRevision.recordId || stepExpectedRevision.record_id) || '').trim();
        var stepExpectedValue = String(stepExpectedRevision && (stepExpectedRevision.revision || stepExpectedRevision.expectedRevision || stepExpectedRevision.expected_revision) || '').trim();
        if (!stepExpectedId || !stepExpectedValue || seenStepRevisionIds[stepExpectedId]) {
          return { rejected: e2Rejected_(operationId, 'plan-incomplete', 'step expected revisions are invalid') };
        }
        seenStepRevisionIds[stepExpectedId] = true;
        normalizedStepExpectedRevisions.push({ id: stepExpectedId, revision: stepExpectedValue });
      }
      // An unknown retry must be allowed to observe the revisions written by
      // this same operation while it reconstructs missing receipt steps.
      var stepRevisionConflicts = recoveringUnknown
        ? e2ExpectedConflictsForRecovery_(spreadsheet, normalizedStepExpectedRevisions, content, digest, operationId)
        : e2CheckExpectedRevisions_(spreadsheet, normalizedStepExpectedRevisions);
      if (stepRevisionConflicts.length > 0) {
        return { conflict: e2Conflict_(operationId, 'stale-expected-revision', stepRevisionConflicts) };
      }
    }
  }
  var existingRows = e2Rows_(spreadsheet, '匯入清單');
  for (var existingIndex = existingRows.length - 1; existingIndex >= 0; existingIndex -= 1) {
    if (existingRows[existingIndex].values.manifest_id === manifestId) {
      if (existingRows[existingIndex].values.content_digest !== digest) {
        return { conflict: e2Conflict_(operationId, 'manifest-id-reused-with-different-content', []) };
      }
      var existingManifestDestinations = [{ id: manifestId, revision: existingRows[existingIndex].values.revision }];
      var existingManifestSteps = snapshotE2Records_(spreadsheet, 'steps');
      var existingStepsById = Object.create(null);
      for (var existingStepIndex = 0; existingStepIndex < existingManifestSteps.length; existingStepIndex += 1) {
        if (existingManifestSteps[existingStepIndex].manifestId === manifestId) {
          existingStepsById[existingManifestSteps[existingStepIndex].stepId] = existingManifestSteps[existingStepIndex];
        }
      }
      for (var existingPlanStepIndex = 0; existingPlanStepIndex < steps.length; existingPlanStepIndex += 1) {
        var existingPlanStep = steps[existingPlanStepIndex];
        var existingPlanStepId = String(existingPlanStep.stepId || existingPlanStep.step_id || existingPlanStep.id).trim();
        var existingPlanStepDigest = String(existingPlanStep.contentDigest || '').trim() || e2Digest_(existingPlanStep);
        var existingStoredStep = existingStepsById[existingPlanStepId];
        if (existingStoredStep) {
          if (existingStoredStep.contentDigest !== existingPlanStepDigest ||
              existingStoredStep.state !== String(existingPlanStep.state || existingPlanStep.status || '').trim()) {
            return { conflict: e2Conflict_(operationId, 'manifest-step-content-conflict', [{ id: manifestId + ':' + existingPlanStepId }]) };
          }
          existingManifestDestinations.push({ id: manifestId + ':' + existingPlanStepId, revision: existingStoredStep.revision });
          continue;
        }
        var missingStepState = String(existingPlanStep.state || existingPlanStep.status || '').trim() || 'pending';
        var missingStepRevision = e2Digest_({
          manifestId: manifestId, stepId: existingPlanStepId, digest: existingPlanStepDigest, state: missingStepState,
        });
        if (reserveClaims) reserveClaims();
        e2Append_(spreadsheet, '匯入步驟', {
          manifest_id: manifestId, step_id: existingPlanStepId, state: missingStepState,
          destination_id: String(existingPlanStep.destinationId || existingPlanStep.destination_id || '').trim(),
          destination_revision: String(existingPlanStep.destinationRevision || existingPlanStep.destination_revision || '').trim(),
          content_digest: existingPlanStepDigest,
          expected_revisions_json: e2Json_(existingPlanStep.expectedRevisions || existingPlanStep.expected_revisions || []),
          result_json: e2Json_(existingPlanStep.result || null), updated_at: taipeiIsoNow_(),
        });
        e2PersistActorMetadata_(spreadsheet, 'manifest-step', manifestId + ':' + existingPlanStepId, missingStepRevision, content.actor, operationId);
        existingManifestDestinations.push({ id: manifestId + ':' + existingPlanStepId, revision: missingStepRevision });
      }
      return { destinations: existingManifestDestinations };
    }
  }
  if (reserveClaims) reserveClaims();
  var revision = e2Digest_({ manifestId: manifestId, digest: digest, operationId: operationId });
  var now = taipeiIsoNow_();
  e2Append_(spreadsheet, '匯入清單', {
    manifest_id: manifestId, revision: revision, status: 'accepted', content_digest: digest,
    actor: String(content.actor || ''), approved_at: now,
    source_evidence_json: e2Json_(manifest.sourceEvidence || manifest.source_evidence || []), updated_at: now,
  });
  e2PersistActorMetadata_(spreadsheet, 'manifest', manifestId, revision, content.actor, operationId);
  var destinations = [{ id: manifestId, revision: revision }];
  for (var stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
    var candidate = steps[stepIndex];
    var stepId = String(candidate.stepId || candidate.step_id || candidate.id).trim();
    var stepDigest = String(candidate.contentDigest || '').trim() || e2Digest_(candidate);
    var stepState = String(candidate.state || candidate.status || '').trim() || 'pending';
    if (['pending', 'completed', 'conflicted', 'conflicting', 'rejected', 'unknown', 'skipped'].indexOf(stepState) === -1) {
      return { rejected: e2Rejected_(operationId, 'plan-incomplete', 'unsupported step state') };
    }
    var destinationId = String(candidate.destinationId || candidate.destination_id || '').trim();
    var destinationRevision = String(candidate.destinationRevision || candidate.destination_revision || '').trim();
    var stepRevision = e2Digest_({ manifestId: manifestId, stepId: stepId, digest: stepDigest, state: stepState });
    e2Append_(spreadsheet, '匯入步驟', {
      manifest_id: manifestId, step_id: stepId, state: stepState,
      destination_id: destinationId, destination_revision: destinationRevision,
      content_digest: stepDigest,
      expected_revisions_json: e2Json_(candidate.expectedRevisions || candidate.expected_revisions || []),
      result_json: e2Json_(candidate.result || null), updated_at: now,
    });
    e2PersistActorMetadata_(spreadsheet, 'manifest-step', manifestId + ':' + stepId, stepRevision, content.actor, operationId);
    destinations.push({ id: manifestId + ':' + stepId, revision: stepRevision });
  }
  return { destinations: destinations };
}

function e2ExecuteResumeImport_(spreadsheet, operationId, digest, content, recoveringUnknown) {
  var manifestInput = content && (content.manifest || content);
  var manifestId = String(manifestInput && (manifestInput.manifestId || manifestInput.manifest_id || manifestInput.id) || '').trim();
  if (!manifestId) return { rejected: e2Rejected_(operationId, 'manifest-id-required') };
  var manifestRows = e2Rows_(spreadsheet, '匯入清單');
  var manifest = null;
  for (var index = manifestRows.length - 1; index >= 0; index -= 1) {
    if (manifestRows[index].values.manifest_id === manifestId) { manifest = manifestRows[index]; break; }
  }
  if (!manifest) return { rejected: e2Rejected_(operationId, 'unknown-manifest') };
  var steps = content.steps || (manifestInput && manifestInput.steps);
  if (!Array.isArray(steps) || steps.length === 0) return { rejected: e2Rejected_(operationId, 'no-missing-steps') };
  var latest = snapshotE2Records_(spreadsheet, 'steps');
  var destinations = [{ id: manifestId, revision: manifest.values.revision }];
  var completed = true;
  var conflicting = false;
  var seenResumeStepIds = Object.create(null);
  for (var stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
    var candidate = steps[stepIndex];
    if (!candidate || typeof candidate !== 'object') {
      return { rejected: e2Rejected_(operationId, 'step-id-required') };
    }
    var stepId = String(candidate.stepId || candidate.step_id || candidate.id || '').trim();
    if (!stepId) return { rejected: e2Rejected_(operationId, 'step-id-required') };
    if (seenResumeStepIds[stepId]) return { rejected: e2Rejected_(operationId, 'duplicate-step-id') };
    seenResumeStepIds[stepId] = true;
    var existing = null;
    for (var latestIndex = 0; latestIndex < latest.length; latestIndex += 1) {
      if (latest[latestIndex].manifestId === manifestId && latest[latestIndex].stepId === stepId) {
        existing = latest[latestIndex]; break;
      }
    }
    var state = String(candidate.state || candidate.status || '').trim() || 'pending';
    if (['pending', 'completed', 'conflicted', 'conflicting', 'rejected', 'unknown', 'skipped'].indexOf(state) === -1) {
      return { rejected: e2Rejected_(operationId, 'unsupported-step-state') };
    }
    var stepDigest = String(candidate.contentDigest || '').trim() || e2Digest_(candidate);
    var rawStepExpectedRevisions = candidate.expectedRevisions || candidate.expected_revisions;
    if (rawStepExpectedRevisions !== undefined) {
      if (!Array.isArray(rawStepExpectedRevisions)) {
        return { rejected: e2Rejected_(operationId, 'invalid-step-expected-revisions') };
      }
      var normalizedStepExpectedRevisions = [];
      var seenStepExpectedIds = Object.create(null);
      for (var stepExpectedIndex = 0; stepExpectedIndex < rawStepExpectedRevisions.length; stepExpectedIndex += 1) {
        var rawExpectedRevision = rawStepExpectedRevisions[stepExpectedIndex];
        var expectedId = String(rawExpectedRevision && (rawExpectedRevision.id || rawExpectedRevision.recordId || rawExpectedRevision.record_id) || '').trim();
        var expectedValue = String(rawExpectedRevision && (rawExpectedRevision.revision || rawExpectedRevision.expectedRevision || rawExpectedRevision.expected_revision) || '').trim();
        if (!expectedId || !expectedValue || seenStepExpectedIds[expectedId]) {
          return { rejected: e2Rejected_(operationId, 'invalid-step-expected-revisions') };
        }
        seenStepExpectedIds[expectedId] = true;
        normalizedStepExpectedRevisions.push({ id: expectedId, revision: expectedValue });
      }
      var stepExpectedConflicts = recoveringUnknown
        ? e2ExpectedConflictsForRecovery_(spreadsheet, normalizedStepExpectedRevisions, content, digest, operationId)
        : e2CheckExpectedRevisions_(spreadsheet, normalizedStepExpectedRevisions);
      if (stepExpectedConflicts.length > 0) {
        return { conflict: e2Conflict_(operationId, 'stale-expected-revision', stepExpectedConflicts) };
      }
    }
    if (existing && (existing.state === 'completed' || existing.state === 'skipped') &&
        (state !== existing.state || stepDigest !== existing.contentDigest)) {
      return { conflict: e2Conflict_(operationId, 'completed-step-cannot-regress', [{
        id: manifestId + ':' + stepId, expected: existing.contentDigest, actual: stepDigest,
      }]) };
    }
    if (existing && (existing.state === 'completed' || existing.state === 'skipped') &&
        state === existing.state && stepDigest === existing.contentDigest) {
      destinations.push({ id: manifestId + ':' + stepId, revision: existing.revision });
      continue;
    }
    if (existing && existing.contentDigest && existing.contentDigest !== stepDigest && existing.state === 'completed') {
      return { conflict: e2Conflict_(operationId, 'completed-step-content-conflict', [{
        id: manifestId + ':' + stepId, expected: stepDigest, actual: existing.contentDigest,
      }]) };
    }
    var stepRevision = e2Digest_({ manifestId: manifestId, stepId: stepId, digest: stepDigest, state: state, operationId: operationId });
    e2Append_(spreadsheet, '匯入步驟', {
      manifest_id: manifestId, step_id: stepId, state: state,
      destination_id: String(candidate.destinationId || candidate.destination_id || (existing && existing.destination && existing.destination.id) || ''),
      destination_revision: String(candidate.destinationRevision || candidate.destination_revision || (existing && existing.destination && existing.destination.revision) || ''),
      content_digest: stepDigest,
      expected_revisions_json: e2Json_(candidate.expectedRevisions || candidate.expected_revisions || []),
      result_json: e2Json_(candidate.result || null), updated_at: taipeiIsoNow_(),
    });
    e2PersistActorMetadata_(spreadsheet, 'manifest-step', manifestId + ':' + stepId, stepRevision, content.actor, operationId);
    destinations.push({ id: manifestId + ':' + stepId, revision: stepRevision });
    if (state !== 'completed' && state !== 'skipped') completed = false;
    if (state === 'conflicted' || state === 'conflicting' || state === 'rejected' || state === 'unknown') conflicting = true;
  }
  // A resume request may contain only steps that need work. Existing steps
  // omitted from that request still determine the manifest's resulting state;
  // otherwise a pending/conflicting receipt could be promoted to completed by
  // mentioning only one successful step.
  for (var omittedIndex = 0; omittedIndex < latest.length; omittedIndex += 1) {
    var omitted = latest[omittedIndex];
    if (omitted.manifestId !== manifestId || seenResumeStepIds[omitted.stepId]) continue;
    destinations.push({ id: manifestId + ':' + omitted.stepId, revision: omitted.revision });
    if (omitted.state !== 'completed' && omitted.state !== 'skipped') completed = false;
    if (omitted.state === 'conflicted' || omitted.state === 'conflicting' || omitted.state === 'rejected' || omitted.state === 'unknown') {
      conflicting = true;
    }
  }
  var manifestState = conflicting ? 'conflicting' : completed ? 'completed' : 'pending';
  var manifestRevision = e2Digest_({ manifestId: manifestId, state: manifestState, operationId: operationId, digest: digest });
  e2Append_(spreadsheet, '匯入清單', {
    manifest_id: manifestId, revision: manifestRevision, status: manifestState,
    content_digest: manifest.values.content_digest, actor: manifest.values.actor,
    approved_at: manifest.values.approved_at,
    source_evidence_json: manifest.values.source_evidence_json, updated_at: taipeiIsoNow_(),
  });
  e2PersistActorMetadata_(spreadsheet, 'manifest', manifestId, manifestRevision, content.actor, operationId);
  destinations[0] = { id: manifestId, revision: manifestRevision };
  return { destinations: destinations };
}

function e2ExecuteEvidence_(spreadsheet, operationId, digest, content) {
  var evidence = content.evidence || content;
  var evidenceId = String(evidence.evidenceId || evidence.evidence_id || evidence.id || '').trim();
  var sourceReference = String(evidence.sourceReference || evidence.source_reference || '').trim();
  var contentDigest = String(evidence.contentDigest || evidence.content_digest || '').trim();
  if (!evidenceId || !sourceReference || !/^[0-9a-f]{64}$/i.test(contentDigest)) {
    return { rejected: e2Rejected_(operationId, 'invalid-source-evidence') };
  }
  var rows = e2Rows_(spreadsheet, '來源證據');
  for (var index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index].values.evidence_id === evidenceId) {
      var existingDigest = rows[index].values.content_digest;
      if (existingDigest !== contentDigest || rows[index].values.source_reference !== sourceReference) {
        return { conflict: e2Conflict_(operationId, 'evidence-id-reused-with-different-content', [{
          id: evidenceId, expected: contentDigest, actual: existingDigest,
        }]) };
      }
      return { destinations: [{ id: evidenceId, revision: rows[index].values.revision || existingDigest }] };
    }
  }
  var revision = e2Digest_({ evidenceId: evidenceId, sourceReference: sourceReference, contentDigest: contentDigest, fields: evidence.fields || {} });
  e2Append_(spreadsheet, '來源證據', {
    evidence_id: evidenceId, source_reference: sourceReference, content_digest: contentDigest,
    effective_date: String(evidence.effectiveDate || evidence.effective_date || ''),
    uploaded_at: String(evidence.uploadedAt || evidence.uploaded_at || taipeiIsoNow_()),
    fields_json: e2Json_(evidence.fields || evidence.originalFields || {}), revision: revision,
  });
  e2PersistActorMetadata_(spreadsheet, 'evidence', evidenceId, revision, content.actor, operationId);
  return { destinations: [{ id: evidenceId, revision: revision }] };
}

function e2ExecuteLink_(spreadsheet, operationId, digest, content) {
  var link = content.link || content;
  var linkId = String(link.linkId || link.link_id || link.id || '').trim();
  var sourceId = String(link.sourceId || link.source_id || '').trim();
  var destinationId = String(link.destinationId || link.destination_id || '').trim();
  var destinationRevision = String(link.destinationRevision || link.destination_revision || '').trim();
  var sourceRevision = String(link.sourceRevision || link.source_revision || '').trim();
  if (!linkId || !sourceId || !destinationId) return { rejected: e2Rejected_(operationId, 'invalid-link') };
  var rows = e2Rows_(spreadsheet, '跨簿連結');
  for (var index = rows.length - 1; index >= 0; index -= 1) {
    var values = rows[index].values;
    if (values.link_id !== linkId) continue;
    if (values.content_digest !== digest) {
      return { conflict: e2Conflict_(operationId, 'link-id-reused-with-different-content', [{
        id: linkId, expected: digest, actual: values.content_digest,
      }]) };
    }
    return { destinations: [{ id: linkId, revision: values.content_digest }] };
  }
  if (!sourceRevision || !destinationRevision) return { rejected: e2Rejected_(operationId, 'invalid-link') };
  e2Append_(spreadsheet, '跨簿連結', {
    link_id: linkId, source_id: sourceId, destination_id: destinationId,
    destination_revision: destinationRevision,
    source_revision: sourceRevision,
    content_digest: digest, status: String(link.status || 'active'),
    origin: String(link.origin || operationId), created_at: taipeiIsoNow_(),
  });
  // The link table's content_digest is its durable revision.  Return the same
  // value that snapshots and idempotent retries use, so callers can safely
  // feed a committed destination back into expectedRevisions.
  e2PersistActorMetadata_(spreadsheet, 'link', linkId, digest, content.actor, operationId);
  return { destinations: [{ id: linkId, revision: digest }] };
}

function e2ExecuteCheckpoint_(spreadsheet, operationId, digest, content) {
  var checkpoint = content.checkpoint || content;
  var checkpointId = String(checkpoint.checkpointId || checkpoint.checkpoint_id || checkpoint.id || operationId).trim();
  var cutoff = String(checkpoint.cutoff || checkpoint.effectiveDate || checkpoint.effective_date || '').trim();
  var scopeVersion = String(checkpoint.scopeVersion || checkpoint.scope_version || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoff) || !snapshotFinancialDateIsValid_(cutoff)) {
    return { rejected: e2Rejected_(operationId, 'invalid-checkpoint-cutoff') };
  }
  var evidenceIds = checkpoint.evidenceIds || checkpoint.evidence_ids || [];
  if (!Array.isArray(evidenceIds)) return { rejected: e2Rejected_(operationId, 'invalid-checkpoint-evidence') };
  var rows = e2Rows_(spreadsheet, '對帳檢查點');
  for (var index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index].values.checkpoint_id === checkpointId) {
      var expectedRevision = e2Digest_({ checkpointId: checkpointId, cutoff: cutoff, digest: digest });
      if (rows[index].values.revision !== expectedRevision) {
        return { conflict: e2Conflict_(operationId, 'checkpoint-id-reused-with-different-content', [{
          id: checkpointId, expected: expectedRevision, actual: rows[index].values.revision,
        }]) };
      }
      return { destinations: [{ id: checkpointId, revision: rows[index].values.revision }] };
    }
  }
  if (!scopeVersion) return { rejected: e2Rejected_(operationId, 'invalid-checkpoint') };
  var revision = e2Digest_({ checkpointId: checkpointId, cutoff: cutoff, digest: digest });
  e2Append_(spreadsheet, '對帳檢查點', {
    checkpoint_id: checkpointId, cutoff: cutoff,
    scope_version: scopeVersion,
    represented_balances_json: e2Json_(checkpoint.representedBalances || checkpoint.represented_balances || {}),
    accepted_balances_json: e2Json_(checkpoint.acceptedBalances || checkpoint.accepted_balances || {}),
    adjustment_json: e2Json_(checkpoint.adjustment || null), evidence_ids_json: e2Json_(evidenceIds),
    coverage_json: e2Json_(checkpoint.coverage || {
      kind: 'cutover-only', preCutoverCoverage: false, throughFinancialDate: cutoff,
    }),
    status: String(checkpoint.status || 'accepted'), revision: revision, created_at: taipeiIsoNow_(),
  });
  e2PersistActorMetadata_(spreadsheet, 'checkpoint', checkpointId, revision, content.actor, operationId);
  return { destinations: [{ id: checkpointId, revision: revision }] };
}

function e2ExecuteSetting_(spreadsheet, operationId, digest, content) {
  var setting = content.setting || content;
  var settingId = String(setting.settingId || setting.setting_id || setting.id || operationId).trim();
  var key = String(setting.key || setting.settingKey || setting.setting_key || '').trim();
  if (!settingId || !key) return { rejected: e2Rejected_(operationId, 'invalid-setting') };
  var revision = e2Digest_({ settingId: settingId, key: key, value: setting.value, effectiveDate: setting.effectiveDate || setting.effective_date, digest: digest });
  e2Append_(spreadsheet, '設定版本', {
    setting_id: settingId, setting_key: key, value_json: e2Json_(setting.value),
    effective_date: String(setting.effectiveDate || setting.effective_date || ''),
    revision: revision, updated_at: taipeiIsoNow_(),
  });
  e2PersistActorMetadata_(spreadsheet, 'setting', settingId, revision, content.actor, operationId);
  return { destinations: [{ id: settingId, revision: revision }] };
}

function e2ExecuteResult_(spreadsheet, operationId, digest, content) {
  var result = content.result || content;
  var resultId = String(result.resultId || result.result_id || result.id || operationId).trim();
  if (!resultId) return { rejected: e2Rejected_(operationId, 'invalid-result') };
  var revision = e2Digest_({ resultId: resultId, digest: digest, value: result.value });
  e2Append_(spreadsheet, '結果版本', {
    result_id: resultId, interval_json: e2Json_(result.interval || {}),
    dependency_revisions_json: e2Json_(result.dependencies || result.dependencyRevisions || []),
    state: String(result.state || 'accepted'), value_json: e2Json_(result.value),
    created_at: taipeiIsoNow_(), revision: revision,
  });
  e2PersistActorMetadata_(spreadsheet, 'result', resultId, revision, content.actor, operationId);
  return { destinations: [{ id: resultId, revision: revision }] };
}

function e2ExecuteOpeningAdjustment_(spreadsheet, operationId, digest, content) {
  var adjustment = content.adjustment || content;
  var account = String(adjustment.account || '').trim();
  var currency = String(adjustment.currency || '').trim();
  var date = String(adjustment.date || adjustment.cutoff || '').trim();
  var acceptedText;
  var representedText;
  try {
    var acceptedInput = hasField_(adjustment, 'acceptedBalance') ? adjustment.acceptedBalance : adjustment.accepted_balance;
    var representedInput = hasField_(adjustment, 'representedBalance') ? adjustment.representedBalance : adjustment.represented_balance;
    acceptedText = canonicalDecimal_(acceptedInput, 0);
    representedText = canonicalDecimal_(representedInput, 0);
  } catch (error) {
    return { rejected: e2Rejected_(operationId, 'invalid-opening-balance') };
  }
  if (!account || !/^[A-Z]{3}$/.test(currency) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !snapshotFinancialDateIsValid_(date)) {
    return { rejected: e2Rejected_(operationId, 'invalid-opening-adjustment') };
  }
  var difference = addDecimalStrings_(acceptedText, negateDecimal_(representedText));
  var vocabulary = readAccountVocabulary_(spreadsheet);
  try { validateOptionalVocabulary_(account, 'account', vocabulary, null); } catch (error) {
    return { rejected: e2Rejected_(operationId, 'invalid-opening-account') };
  }
  var postingAccountType = vocabulary.accountTypes[account];
  if (postingAccountType !== '資產' && postingAccountType !== '負債') {
    return { rejected: e2Rejected_(operationId, 'opening-account-must-be-asset-or-liability') };
  }
  var checkpointId = String(adjustment.checkpointId || adjustment.checkpoint_id || operationId).trim();
  var evidenceIds = adjustment.evidenceIds || adjustment.evidence_ids || [];
  if (!Array.isArray(evidenceIds) || evidenceIds.length === 0) {
    return { rejected: e2Rejected_(operationId, 'opening-adjustment-evidence-required') };
  }
  var seenOpeningEvidenceIds = Object.create(null);
  for (var openingEvidenceIndex = 0; openingEvidenceIndex < evidenceIds.length; openingEvidenceIndex += 1) {
    var openingEvidenceId = String(evidenceIds[openingEvidenceIndex] || '').trim();
    if (!openingEvidenceId || seenOpeningEvidenceIds[openingEvidenceId]) {
      return { rejected: e2Rejected_(operationId, 'opening-adjustment-evidence-invalid') };
    }
    seenOpeningEvidenceIds[openingEvidenceId] = true;
  }
  var source = readSnapshotSource_(spreadsheet);
  var requestedRepresentedBalances = adjustment.representedBalances || adjustment.represented_balances || { [currency]: representedText };
  var requestedAcceptedBalances = adjustment.acceptedBalances || adjustment.accepted_balances || { [currency]: acceptedText };
  var requestedTxnId = difference !== '0'
    ? String(adjustment.txnId || adjustment.txn_id || '').trim()
    : '';
  var resumingCheckpoint = null;
  var existingCheckpointRows = e2Rows_(spreadsheet, '對帳檢查點');
  for (var existingCheckpointIndex = existingCheckpointRows.length - 1; existingCheckpointIndex >= 0; existingCheckpointIndex -= 1) {
    var existingCheckpoint = existingCheckpointRows[existingCheckpointIndex].values;
    if (existingCheckpoint.checkpoint_id !== checkpointId) continue;
    var existingEvidenceIds = e2ParseJson_(existingCheckpoint.evidence_ids_json, []);
    var existingAdjustment = e2ParseJson_(existingCheckpoint.adjustment_json, {});
    var existingRepresentedBalances = e2ParseJson_(existingCheckpoint.represented_balances_json, {});
    var existingAcceptedBalances = e2ParseJson_(existingCheckpoint.accepted_balances_json, {});
    var sameEvidence = e2Digest_(existingEvidenceIds) === e2Digest_(evidenceIds);
    var sameAdjustment = existingCheckpoint.cutoff === date &&
      existingCheckpoint.scope_version === String(adjustment.scopeVersion || adjustment.scope_version || '') &&
      String(existingAdjustment.account || '') === account &&
      String(existingAdjustment.currency || '') === currency &&
      String(existingAdjustment.amount || '') === difference &&
      (!existingAdjustment.txnId || !requestedTxnId || String(existingAdjustment.txnId) === requestedTxnId) &&
      e2Digest_(existingRepresentedBalances) === e2Digest_(requestedRepresentedBalances) &&
      e2Digest_(existingAcceptedBalances) === e2Digest_(requestedAcceptedBalances);
    if (!sameEvidence || !sameAdjustment) {
      return { conflict: e2Conflict_(operationId, 'checkpoint-id-reused-with-different-content', [{ id: checkpointId }]) };
    }
    var existingCutoffBalance = accountBalanceThroughCutoff_(source, account, currency, date);
    if (existingCutoffBalance !== representedText && existingCutoffBalance !== acceptedText) {
      return { conflict: e2Conflict_(operationId, 'represented-balance-changed', [{ id: account, expected: representedText, actual: existingCutoffBalance }]) };
    }
    if (existingCheckpoint.status === 'accepted') {
      return { destinations: [{ id: checkpointId, revision: existingCheckpoint.revision }] };
    }
    if (existingCheckpoint.status !== 'pending') {
      return { conflict: e2Conflict_(operationId, 'checkpoint-state-conflict', [{ id: checkpointId }]) };
    }
    resumingCheckpoint = existingCheckpointRows[existingCheckpointIndex];
    if (!requestedTxnId && existingAdjustment.txnId) requestedTxnId = String(existingAdjustment.txnId).trim();
  }
  var representedCurrent = accountBalanceThroughCutoff_(source, account, currency, date);
  if (representedCurrent !== representedText && (!resumingCheckpoint || representedCurrent !== acceptedText)) {
    return { conflict: e2Conflict_(operationId, 'represented-balance-changed', [{
      id: account, expected: representedText, actual: representedCurrent,
    }]) };
  }
  var evidenceRows = e2Rows_(spreadsheet, '來源證據');
  var expectedEvidenceDigests = adjustment.evidenceContentDigests || adjustment.evidence_content_digests || {};
  if (expectedEvidenceDigests && (typeof expectedEvidenceDigests !== 'object' || Array.isArray(expectedEvidenceDigests))) {
    return { rejected: e2Rejected_(operationId, 'opening-adjustment-evidence-invalid') };
  }
  for (var evidenceIndex = 0; evidenceIndex < evidenceIds.length; evidenceIndex += 1) {
    var evidenceId = String(evidenceIds[evidenceIndex] || '').trim();
    var evidenceFound = null;
    for (var evidenceRowIndex = evidenceRows.length - 1; evidenceRowIndex >= 0; evidenceRowIndex -= 1) {
      if (evidenceRows[evidenceRowIndex].values.evidence_id === evidenceId) {
        evidenceFound = evidenceRows[evidenceRowIndex].values;
        break;
      }
    }
    if (!evidenceFound) return { rejected: e2Rejected_(operationId, 'opening-evidence-not-found', evidenceId) };
    if (evidenceFound.effective_date && evidenceFound.effective_date !== date) {
      return { rejected: e2Rejected_(operationId, 'opening-evidence-cutoff-mismatch', evidenceId) };
    }
    var expectedEvidenceDigest = String(expectedEvidenceDigests[evidenceId] || '').trim();
    if (expectedEvidenceDigest && expectedEvidenceDigest !== evidenceFound.content_digest) {
      return { conflict: e2Conflict_(operationId, 'opening-evidence-content-changed', [{ id: evidenceId, expected: expectedEvidenceDigest, actual: evidenceFound.content_digest }]) };
    }
  }
  if (difference !== '0' && !requestedTxnId) {
    return { rejected: e2Rejected_(operationId, 'opening-txn-id-required') };
  }
  if (difference !== '0' && !UUID_PATTERN.test(requestedTxnId)) {
    return { rejected: e2Rejected_(operationId, 'opening-txn-id-invalid') };
  }
  var checkpointRevision = e2Digest_({ checkpointId: checkpointId, cutoff: date, accepted: acceptedText, represented: representedText, digest: digest });
  var checkpoint = {
    checkpointId: checkpointId, cutoff: date,
    scopeVersion: String(adjustment.scopeVersion || adjustment.scope_version || ''),
    representedBalances: adjustment.representedBalances || { [currency]: representedText },
    acceptedBalances: adjustment.acceptedBalances || { [currency]: acceptedText },
    adjustment: { amount: difference, currency: currency, account: account, txnId: requestedTxnId },
    evidenceIds: evidenceIds,
    coverage: { kind: 'cutover-only', preCutoverCoverage: false, throughFinancialDate: date },
    status: 'pending',
  };
  if (!resumingCheckpoint) {
    e2Append_(spreadsheet, '對帳檢查點', {
      checkpoint_id: checkpointId, cutoff: date, scope_version: checkpoint.scopeVersion,
      represented_balances_json: e2Json_(checkpoint.representedBalances),
      accepted_balances_json: e2Json_(checkpoint.acceptedBalances),
      adjustment_json: e2Json_(checkpoint.adjustment), evidence_ids_json: e2Json_(evidenceIds),
      coverage_json: e2Json_(checkpoint.coverage), status: 'pending',
      revision: checkpointRevision, created_at: taipeiIsoNow_(),
    });
    e2PersistActorMetadata_(spreadsheet, 'checkpoint', checkpointId, checkpointRevision, content.actor, operationId);
  }
  var destinations = [{ id: checkpointId, revision: checkpointRevision }];
  if (difference !== '0') {
    var debitAccount;
    var creditAccount;
    var amount = difference.charAt(0) === '-' ? negateDecimal_(difference) : difference;
    if (postingAccountType === '資產') {
      debitAccount = difference.charAt(0) === '-' ? '期初餘額' : account;
      creditAccount = difference.charAt(0) === '-' ? account : '期初餘額';
    } else if (postingAccountType === '負債') {
      debitAccount = difference.charAt(0) === '-' ? account : '期初餘額';
      creditAccount = difference.charAt(0) === '-' ? '期初餘額' : account;
    }
    var txnId = requestedTxnId;
    if (!txnId) return { rejected: e2Rejected_(operationId, 'opening-txn-id-required') };
    var journal = requiredSheet_(spreadsheet, '日記帳');
    var columns = resolveHeaders_(journal.getRange(1, 1, 1, journal.getLastColumn()).getDisplayValues()[0], JOURNAL_HEADERS);
    var posting = postingRow_({
      date: date, time: '', type: '轉帳', debitAccount: debitAccount, creditAccount: creditAccount,
      amount: amount, currency: currency, category: '', payee: '',
      description: String(adjustment.description || '期初調整-' + checkpointId),
      settlementStatus: '', reversalTxnId: '', txnId: txnId, source: '移轉', now: taipeiIsoNow_(),
    });
    validateE2Posting_(posting, vocabulary, '移轉');
    var existingOpeningPosting = e2ExistingJournalPosting_(journal, columns, txnId);
    if (existingOpeningPosting && !e2JournalPostingMatches_(existingOpeningPosting.values, posting)) {
      return { conflict: e2Conflict_(operationId, 'opening-adjustment-id-reused-with-different-content', [{ id: txnId }]) };
    }
    if (!existingOpeningPosting) appendPosting_(journal, columns, posting);
    destinations.push({ id: txnId, revision: e2PostingRevision_(posting) });
  }
  var acceptedRevision = e2Digest_({
    checkpointId: checkpointId, cutoff: date, accepted: acceptedText,
    represented: representedText, digest: digest, status: 'accepted',
  });
  e2Append_(spreadsheet, '對帳檢查點', {
    checkpoint_id: checkpointId, cutoff: date, scope_version: checkpoint.scopeVersion,
    represented_balances_json: e2Json_(checkpoint.representedBalances),
    accepted_balances_json: e2Json_(checkpoint.acceptedBalances), adjustment_json: e2Json_(checkpoint.adjustment),
    evidence_ids_json: e2Json_(evidenceIds), coverage_json: e2Json_(checkpoint.coverage), status: 'accepted',
    revision: acceptedRevision,
    created_at: resumingCheckpoint ? resumingCheckpoint.values.created_at : taipeiIsoNow_(),
  });
  e2PersistActorMetadata_(spreadsheet, 'checkpoint', checkpointId, acceptedRevision, content.actor, operationId);
  e2InvalidateResults_(spreadsheet, 'opening-adjustment:' + checkpointId, [checkpointId, account], content.actor, operationId);
  destinations[0] = { id: checkpointId, revision: acceptedRevision };
  return { destinations: destinations };
}

function e2PostingRevision_(posting) {
  return e2Digest_({
    date: posting['日期'], time: posting['時間'], type: posting['類型'],
    debitAccount: posting['借方帳戶'], creditAccount: posting['貸方帳戶'],
    amount: posting['金額'], currency: posting['幣別'], category: posting['分類'],
    payee: posting['交易對象'], description: posting['說明'],
    settlementStatus: posting['結清狀態'], reversalTxnId: posting['沖銷txn_id'],
    txnId: posting.txn_id, source: posting['來源'],
  });
}

function e2JournalPostingMatches_(rowValues, posting) {
  var fields = ['日期', '時間', '類型', '借方帳戶', '貸方帳戶', '幣別', '分類', '交易對象', '說明', '結清狀態', '沖銷txn_id', 'txn_id', '來源'];
  for (var index = 0; index < fields.length; index += 1) {
    var field = fields[index];
    if (String(rowValues[field] || '').trim() !== String(posting[field] || '').trim()) return false;
  }
  var rowAmount;
  try { rowAmount = canonicalDecimal_(rowValues['金額'], 0); } catch (error) { return false; }
  return rowAmount === canonicalDecimal_(posting['金額'], 0);
}

function e2ExistingJournalPosting_(journal, columns, txnId) {
  var rowNumber = findTxnRow_(journal, columns.txn_id, txnId);
  if (rowNumber === null) return null;
  var displayed = journal.getRange(rowNumber, 1, 1, journal.getLastColumn()).getDisplayValues()[0];
  var values = {};
  var headers = Object.keys(columns);
  for (var index = 0; index < headers.length; index += 1) {
    values[headers[index]] = displayed[columns[headers[index]] - 1] || '';
  }
  return { row: rowNumber, values: values };
}

function e2InvalidateResults_(spreadsheet, reason, changedIds, actor, operationId) {
  var rows = snapshotE2Records_(spreadsheet, 'results');
  for (var index = 0; index < rows.length; index += 1) {
    var result = rows[index];
    if (result.type !== 'metric') continue;
    if (result.state === 'invalidated' || result.state === 'unknown') continue;
    var dependencies = result.dependencies;
    var dependent = !Array.isArray(dependencies) || dependencies.length === 0;
    if (!dependent && Array.isArray(changedIds)) {
      for (var dependencyIndex = 0; dependencyIndex < dependencies.length; dependencyIndex += 1) {
        var dependency = dependencies[dependencyIndex];
        var dependencyId = String(dependency && (dependency.id || dependency.recordId || dependency.record_id || dependency.txnId || dependency.txn_id || dependency.checkpointId || dependency.checkpoint_id) || dependency || '').trim();
        if (changedIds.indexOf(dependencyId) !== -1) {
          dependent = true;
          break;
        }
      }
    }
    if (!dependent) continue;
    var revision = e2Digest_({ resultId: result.resultId, previousRevision: result.revision, reason: reason });
    e2Append_(spreadsheet, '結果版本', {
      result_id: result.resultId,
      interval_json: e2Json_(result.interval || {}),
      dependency_revisions_json: e2Json_(result.dependencies || []),
      state: 'invalidated', value_json: e2Json_(result.value),
      created_at: taipeiIsoNow_(), revision: revision,
    });
    e2PersistActorMetadata_(spreadsheet, 'result', result.resultId, revision, actor, operationId);
  }
}

function e2ExecuteCorrection_(spreadsheet, operationId, digest, content) {
  var correction = content.correction || content;
  var originalId = String(correction.originalId || correction.original_id || correction.txnId || correction.txn_id || '').trim();
  if (!originalId) return { rejected: e2Rejected_(operationId, 'original-txn-id-required') };
  var source = readSnapshotSource_(spreadsheet);
  var original = null;
  for (var index = 0; index < source.journalRows.length; index += 1) {
    var row = source.journalRows[index];
    if (String(row.values.txn_id || '').trim() === originalId) { original = row; break; }
  }
  if (!original) return { rejected: e2Rejected_(operationId, 'unknown-original-txn-id') };
  var vocabulary = readAccountVocabulary_(spreadsheet);
  var journal = requiredSheet_(spreadsheet, '日記帳');
  var columns = resolveHeaders_(journal.getRange(1, 1, 1, journal.getLastColumn()).getDisplayValues()[0], JOURNAL_HEADERS);
  var reversalId = String(correction.reversalTxnId || correction.reversal_txn_id || '').trim();
  if (!UUID_PATTERN.test(reversalId)) {
    return { rejected: e2Rejected_(operationId, 'reversal-txn-id-invalid') };
  }
  var existingReversal = e2ExistingJournalPosting_(journal, columns, reversalId);
  var date = String(correction.date || '').trim();
  if (!date && existingReversal) date = String(existingReversal.values['日期'] || '').trim();
  if (!date) date = taipeiIsoNow_().slice(0, 10);
  var replacement = correction.replacement || correction.newPosting;
  var replacementId = replacement
    ? String(correction.replacementTxnId || correction.replacement_txn_id || '').trim()
    : '';
  if (replacement && !UUID_PATTERN.test(replacementId)) {
    return { rejected: e2Rejected_(operationId, 'replacement-txn-id-invalid') };
  }
  var existingReplacement = replacement
    ? e2ExistingJournalPosting_(journal, columns, replacementId)
    : null;
  var replacementPosting = null;
  if (replacement && typeof replacement === 'object') {
    var replacementAmount;
    try { replacementAmount = canonicalDecimal_(replacement.amount, 0); } catch (error) {
      return { rejected: e2Rejected_(operationId, 'replacement-posting-invalid') };
    }
    var replacementDebit = String(replacement.debitAccount || replacement.debit_account || '').trim();
    var replacementCredit = String(replacement.creditAccount || replacement.credit_account || '').trim();
    if (!replacementDebit || !replacementCredit || replacementDebit === replacementCredit) {
      return { rejected: e2Rejected_(operationId, 'replacement-posting-invalid') };
    }
    replacementPosting = postingRow_({
      date: String(replacement.date || (existingReplacement && existingReplacement.values['日期']) || date), time: replacement.time || '', type: replacement.type || original.values['類型'],
      debitAccount: replacementDebit, creditAccount: replacementCredit, amount: replacementAmount,
      currency: String(replacement.currency || original.values['幣別']),
      category: replacement.category || nominalLeg_(replacementDebit, replacementCredit, vocabulary.accountTypes),
      payee: replacement.payee || replacement.counterparty || original.values['交易對象'],
      description: replacement.description || '更正後-' + originalId, settlementStatus: replacement.settlementStatus || '',
      reversalTxnId: '', txnId: replacementId, source: 'import', now: taipeiIsoNow_(),
    });
    try { validateE2Posting_(replacementPosting, vocabulary, 'import'); } catch (error) {
      return { rejected: e2Rejected_(operationId, 'replacement-posting-invalid', String(error.message || error)) };
    }
  }
  var originalAmount = canonicalDecimal_(original.rawAmount, original.sheetRow);
  var reversal = postingRow_({
    date: date, time: '', type: '沖銷', debitAccount: original.values['貸方帳戶'], creditAccount: original.values['借方帳戶'],
    amount: originalAmount, currency: original.values['幣別'], category: '', payee: original.values['交易對象'],
    description: String(correction.description || '更正-' + originalId), settlementStatus: '',
    reversalTxnId: originalId, txnId: reversalId, source: 'import', now: taipeiIsoNow_(),
  });
  try { validateE2Posting_(reversal, vocabulary, 'import'); } catch (error) {
    return { rejected: e2Rejected_(operationId, 'reversal-posting-invalid', String(error.message || error)) };
  }
  var existingCorrectionRecord = e2LatestRecord_(spreadsheet, 'corrections', originalId + ':' + reversalId);
  if (existingCorrectionRecord) {
    var existingCorrectionData = e2ParseJson_(existingCorrectionRecord.values.data_json, {});
    if (existingCorrectionData.contentDigest && existingCorrectionData.contentDigest !== digest) {
      return { conflict: e2Conflict_(operationId, 'correction-id-reused-with-different-content', [{ id: reversalId }]) };
    }
  }
  if (existingReversal && !e2JournalPostingMatches_(existingReversal.values, reversal)) {
    return { conflict: e2Conflict_(operationId, 'correction-id-reused-with-different-content', [{ id: reversalId }]) };
  }
  if (existingReplacement && !e2JournalPostingMatches_(existingReplacement.values, replacementPosting)) {
    return { conflict: e2Conflict_(operationId, 'correction-id-reused-with-different-content', [{ id: replacementId }]) };
  }
  var destinations = [{ id: reversalId, revision: e2PostingRevision_(reversal) }];
  var appended = false;
  if (!existingReversal) {
    appendPosting_(journal, columns, reversal);
    appended = true;
  }
  if (replacementPosting) {
    destinations.push({ id: replacementId, revision: e2PostingRevision_(replacementPosting) });
    if (!existingReplacement) {
      appendPosting_(journal, columns, replacementPosting);
      appended = true;
    }
  }
  if (appended || !existingCorrectionRecord) {
    e2Append_(spreadsheet, '整合記錄', {
      scope: 'corrections', record_id: originalId + ':' + reversalId,
      revision: digest, data_json: e2Json_({
        originalId: originalId, reversalId: reversalId, replacementId: replacementId,
        reversalRevision: e2PostingRevision_(reversal),
        replacementRevision: replacementPosting ? e2PostingRevision_(replacementPosting) : '',
        contentDigest: digest, actor: content.actor || '',
      }),
      created_at: taipeiIsoNow_(),
    });
    e2PersistActorMetadata_(spreadsheet, 'correction', originalId + ':' + reversalId, digest, content.actor, operationId);
  }
  if (appended) {
    e2InvalidateResults_(spreadsheet, 'correction:' + originalId, [originalId, reversalId, replacementId], content.actor, operationId);
  }
  return { destinations: destinations };
}
