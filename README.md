# solo-ledger

Personal double-entry expense ledger: a mobile PWA posts balanced journal rows
into the user's own Google Spreadsheet, which is the only datastore.

## Install

```sh
npm install
```

## Test

```sh
npm test
```

Run `python3 scripts/gen-fixture.py` from the repository root to regenerate the
Python-source-of-truth byte-parity fixture.
