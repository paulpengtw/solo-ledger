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

function stableIdentityMetadataSchemaPresent_(spreadsheet) {
  var accounts = spreadsheet.getSheetByName('會計科目');
  var journal = spreadsheet.getSheetByName('日記帳');
  var observations = spreadsheet.getSheetByName(OBSERVATION_SHEET_NAME);
  if (!accounts || !journal || !observations ||
      !sheetHasHeaders_(accounts, [
        '名稱', '類型', '子類型', '啟用', '排序', ACCOUNT_STABLE_ID_HEADER,
      ]) || !sheetHasHeaders_(journal, JOURNAL_HEADERS) ||
      !sheetHasHeaders_(observations, OBSERVATION_HEADERS)) {
    return false;
  }
  try {
    resolveHeaders_(
      accounts.getRange(1, 1, 1, accounts.getLastColumn()).getDisplayValues()[0],
      ['名稱', '類型', '子類型', '啟用', '排序', ACCOUNT_STABLE_ID_HEADER],
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
  requireFinancialOpen_(payload);

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
    payload.scope !== 'observations'
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
  var duplicateId = duplicateStableIdentity_(source, payload.scope);
  if (duplicateId) {
    return identityUnavailable_('stable-identity-duplicate-id');
  }
  var records = snapshotRecordsForScope_(source, payload.scope, revision);
  var offset = snapshotCursorOffset_(payload.cursor);
  if (offset > records.length) {
    throw new Error('snapshot cursor is outside the result');
  }
  var page = records.slice(offset, offset + MAX_SNAPSHOT_RECORDS);
  var nextOffset = offset + page.length;
  return {
    scope: payload.scope,
    snapshotRevision: revision,
    records: page,
    continuation: nextOffset < records.length
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
  if (scope === 'events') return snapshotEventRecords_(source);
  return snapshotObservationRecords_(source);
}

function lookupRecordAcrossScopes_(recordsByScope, id) {
  var identified = [];
  var unidentified = [];
  var scopes = ['accounts', 'events', 'observations'];
  for (var scopeIndex = 0; scopeIndex < scopes.length; scopeIndex += 1) {
    var scope = scopes[scopeIndex];
    var records = recordsByScope[scope];
    for (var index = 0; index < records.length; index += 1) {
      var record = records[index];
      if (record.identity && record.identity.kind === 'identified' && record.id === id) {
        identified.push(record);
      } else if (scope === 'accounts' &&
          record.identity && record.identity.kind === 'unidentified' &&
          record.legacyId === id) {
        unidentified.push(record);
      }
    }
  }
  if (identified.length === 1 && unidentified.length === 0) {
    return { kind: 'identified', record: identified[0] };
  }
  if (identified.length > 0 || unidentified.length > 1) {
    return { kind: 'missing' };
  }
  if (unidentified.length === 1) {
    return { kind: 'unidentified' };
  }
  return { kind: 'missing' };
}

function identityRepairReference_(scope, row) {
  return {
    scope: scope,
    sheetRow: row.sheetRow,
    contentDigest: identityContentDigest_(scope, row),
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
    if (identityExists_(source, stableId)) {
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
  var rows = identityRowsForScope_(source, reference.scope);
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
      if (aliasRow.enabled) {
        accountTypes[alias] = aliasRow.type;
      }
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
    vocabulary: source.vocabularyRows,
    journal: source.journalRows.map(function (row) {
      return { sheetRow: row.sheetRow, cells: row.cells };
    }),
    observations: source.observationRows.map(function (row) {
      return { sheetRow: row.sheetRow, cells: row.cells };
    }),
  };
  return digestHex_(Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    JSON.stringify(revisionInput),
  ));
}

function snapshotAccountRecords_(source, revision) {
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

function snapshotEventRecords_(source) {
  var records = [];
  for (var index = 0; index < source.journalRows.length; index += 1) {
    var row = source.journalRows[index];
    var values = row.values;
    var txnId = String(values.txn_id || '').trim();
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
      contentDigest: identityContentDigest_('events', row),
      repairReference: identityRepairReference_('events', row),
    });
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
    var targetTxnId = String(payload.txn_id);
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
