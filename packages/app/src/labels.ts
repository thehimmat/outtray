import type { DocumentType } from '@outtray/core';

/** Plain names for document types, as the page shows them. */
export const TYPE_LABEL: Record<DocumentType, string> = {
  bill: 'bill',
  letter: 'letter',
  receipt: 'receipt',
  id_document: 'ID document',
  contract: 'contract',
  policy: 'policy',
  statement: 'statement',
  unknown: 'unknown type',
};
