# ADR 0003: Rename Counterparty Header to 交易對象

## Status

Accepted

## Context

The existing Chinese term `對象` is ambiguous in the product's Taiwanese
Mandarin context. In everyday Taiwanese Mandarin it strongly connotes a
romantic partner, while its generic meaning is merely a target. Neither
meaning clearly identifies the person or merchant a journal row relates to.

The code also mixed English glosses for the same concept: some paths called it
`payee`, while the domain glossary called it `counterparty`. That inconsistency
made the sheet schema, API fields, UI, and documentation harder to discuss as
one contract.

## Decision

`交易對象` is the canonical Chinese term across sheet headers, Apps Script and
API fields, PWA UI, tests, and documentation. The canonical English gloss
remains **Counterparty**. This is a deliberate breaking sheet-schema change;
existing deployed spreadsheets require a one-time manual rename of the
`日記帳` header cell `對象` and the `選項清單` header cell `對象` to
`交易對象` before setup validation can succeed.

The English `payee` identifiers used by the form and request contract remain
unchanged because they are implementation identifiers, not the canonical
domain gloss.

## Alternatives Considered

### Keep `對象`

Rejected because the romantic-partner connotation and the generic “target”
meaning leave the domain ambiguity unresolved.

### Rename only the glossary and UI

Rejected because it would create a permanent mismatch between the glossary/UI
and the actual sheet schema.

### Use `商家` or `店家`

Rejected because this fails the `代墊` scenario: a friend who owes the user
money for lunch is a counterparty but is not a merchant.

### Use `payee` as the English gloss

Rejected because it fails the direction of the concept: in settlements and
income, the counterparty pays the user rather than the user paying the
counterparty.

## Consequences

This is a breaking sheet-schema change. Every deployed spreadsheet must have
its two header cells hand-edited from `對象` to `交易對象` before the app's setup
validation will accept the book. New bootstraps and all code paths now use the
unambiguous `交易對象` spelling, while the existing English `payee` input
identifiers remain compatible with the application contract.
