/**
 * Deterministic synthetic fixture generator (ADR-0006, fixture policy in
 * packages/evals/fixtures/README.md).
 *
 * From a fixed seed this emits document fixtures: an HTML render source plus the
 * ground-truth labels for that document, one pair per fixture. Real personal
 * documents are never committed; these invented identities and figures are the
 * committed test set. The HTML is reproducible from the seed (CI checks that);
 * the rendered PNG is produced by a dev-only Chrome step and checksummed in the
 * manifest.
 *
 * Labels carry only the fields that are scored per type (the discriminant plus
 * the type-specific structured fields); free-text summary/action_items are not
 * ground-truthed in v1.
 */

import type { DocumentType } from '@outtray/core';

/** Ground-truth labels for one fixture: the scored fields, keyed by field name. */
export interface FixtureLabels {
  type: DocumentType;
  [field: string]: string | null;
}

/** One generated fixture before rendering: HTML source and its ground truth. */
export interface FixtureSpec {
  id: string;
  type: DocumentType;
  html: string;
  labels: FixtureLabels;
}

/** Deterministic PRNG (mulberry32), so a seed reproduces the whole set. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Rng {
  pick: <T>(items: readonly T[]) => T;
  int: (min: number, max: number) => number;
}

function rngFrom(next: () => number): Rng {
  return {
    pick: (items) => items[Math.floor(next() * items.length)] as (typeof items)[number],
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
  };
}

const FIRST = ['Jordan', 'Priya', 'Marcus', 'Ana', 'Wei', 'Fatima', 'Diego', 'Nina'] as const;
const LAST = [
  'Rivera',
  'Okafor',
  'Nguyen',
  'Haddad',
  'Larsson',
  'Mbeki',
  'Costa',
  'Reyes',
] as const;
const STREETS = ['Larkspur Terrace', 'Cedar Hollow Rd', 'Marlowe Ave', 'Quince St'] as const;
const CITIES = [
  ['Fair Oaks', 'CA', '95628'],
  ['Bellingham', 'WA', '98225'],
  ['Athens', 'GA', '30605'],
  ['Providence', 'RI', '02906'],
] as const;
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** A date as both a display string ("August 31, 2026") and its ISO ground truth. */
function makeDate(r: Rng): { display: string; iso: string } {
  const year = r.int(2025, 2027);
  const month = r.int(1, 12);
  const day = r.int(1, 28);
  const display = `${MONTHS[month - 1]} ${day}, ${year}`;
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return { display, iso };
}

function person(r: Rng): { name: string; addr: string } {
  const name = `${r.pick(FIRST)} ${r.pick(LAST)}`;
  const [city, state, zip] = r.pick(CITIES);
  const addr = `${r.int(100, 9999)} ${r.pick(STREETS)}<br>${city}, ${state} ${zip}`;
  return { name, addr };
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:"Helvetica Neue",Arial,sans-serif;color:#1a1a1a;background:#fff;width:816px;padding:56px 64px;font-size:14px;line-height:1.5}
h1{font-size:22px;margin:6px 0 18px;color:#14497a}
.muted{color:#555}.right{text-align:right}.big{font-size:24px;font-weight:700}
table{width:100%;border-collapse:collapse;margin:14px 0}td{padding:6px 8px;border-bottom:1px solid #ddd}
.box{background:#f4f7fb;border:1px solid #cdd9e6;padding:14px 18px;margin:16px 0;display:flex;justify-content:space-between;align-items:center}
.hdr{display:flex;justify-content:space-between;border-bottom:3px solid #14497a;padding-bottom:10px;margin-bottom:18px}
.agency{font-size:18px;font-weight:700;color:#14497a}
</style><title>${title}</title></head><body>${body}</body></html>`;
}

type Template = (r: Rng, n: number) => FixtureSpec;

const billTemplate: Template = (r, n) => {
  const p = person(r);
  const payee = r.pick(['State DMV', 'City Water Utility', 'Metro Electric', 'Regional Gas Co']);
  const amount = r.int(45, 900) + 0.0;
  const late = r.int(15, 60) + 0.0;
  const due = makeDate(r);
  const html = page(
    'Bill',
    `<div class="hdr"><div class="agency">${payee}</div><div class="right muted">Statement<br>Account ${r.int(100000, 999999)}</div></div>
<h1>Amount Due Notice</h1>
<p class="muted">${p.name}<br>${p.addr}</p>
<table>
<tr><td class="muted">Service period</td><td class="right">Q3 2026</td></tr>
<tr><td class="muted">Payment due date</td><td class="right"><strong>${due.display}</strong></td></tr>
</table>
<div class="box"><div>Total amount due</div><div class="big">${money(amount)}</div></div>
<p>Payments received after the due date incur a late fee of <strong>${money(late)}</strong>. Do not mail cash.</p>`,
  );
  return {
    id: `bill-${String(n).padStart(3, '0')}`,
    type: 'bill',
    html,
    labels: {
      type: 'bill',
      payee,
      amount_due: money(amount),
      due_date: due.iso,
      late_fee: money(late),
    },
  };
};

const receiptTemplate: Template = (r, n) => {
  const merchant = r.pick(['Grove Market', 'Northside Grocers', 'Harbor Foods', 'Sunbelt Mart']);
  const total = r.int(6, 180) + 0.49;
  const bought = makeDate(r);
  const html = page(
    'Receipt',
    `<div class="hdr"><div class="agency">${merchant}</div><div class="right muted">${bought.display}<br>Reg 4 &middot; Trn ${r.int(1000, 9999)}</div></div>
<h1>Sales Receipt</h1>
<table>
<tr><td>Butter, unsalted</td><td class="right">${money(r.int(3, 8) + 0.99)}</td></tr>
<tr><td>Whole milk, 1 gal</td><td class="right">${money(r.int(3, 6) + 0.29)}</td></tr>
<tr><td>Coffee, ground</td><td class="right">${money(r.int(7, 14) + 0.5)}</td></tr>
</table>
<div class="box"><div>Total</div><div class="big">${money(total)}</div></div>
<p class="muted">Thank you for shopping with us.</p>`,
  );
  return {
    id: `receipt-${String(n).padStart(3, '0')}`,
    type: 'receipt',
    html,
    labels: { type: 'receipt', merchant, total: money(total), purchased_at: bought.iso },
  };
};

const letterTemplate: Template = (r, n) => {
  const sender = r.pick(['Northgate Property Mgmt', 'Dr. Elena Sato, DDS', 'Cascade Credit Union']);
  const recipient = person(r);
  const subject = r.pick([
    'Notice of annual inspection',
    'Appointment reminder',
    'Change to your terms',
  ]);
  const sent = makeDate(r);
  const html = page(
    'Letter',
    `<div class="hdr"><div class="agency">${sender}</div><div class="right muted">${sent.display}</div></div>
<p class="muted">${recipient.name}<br>${recipient.addr}</p>
<h1>${subject}</h1>
<p>Dear ${recipient.name.split(' ')[0]},</p>
<p>We are writing to inform you regarding the matter noted above. Please review the enclosed details and contact our office with any questions.</p>
<p>Sincerely,<br>${sender}</p>`,
  );
  return {
    id: `letter-${String(n).padStart(3, '0')}`,
    type: 'letter',
    html,
    labels: {
      type: 'letter',
      sender,
      recipient: recipient.name,
      subject,
      sent_date: sent.iso,
    },
  };
};

const idTemplate: Template = (r, n) => {
  const holder = person(r);
  const issuer = r.pick(['State of California', 'State of Washington', 'State of Georgia']);
  const idn = `${r.pick(['D', 'X', 'C'])}${r.int(1000000, 9999999)}`;
  const expiry = makeDate(r);
  const html = page(
    'ID',
    `<div class="hdr"><div class="agency">${issuer}</div><div class="right muted">Driver License</div></div>
<h1>Identification Card</h1>
<table>
<tr><td class="muted">Name</td><td class="right"><strong>${holder.name}</strong></td></tr>
<tr><td class="muted">License number</td><td class="right">${idn}</td></tr>
<tr><td class="muted">Expires</td><td class="right"><strong>${expiry.display}</strong></td></tr>
</table>
<p class="muted">This card remains the property of ${issuer}.</p>`,
  );
  return {
    id: `id_document-${String(n).padStart(3, '0')}`,
    type: 'id_document',
    html,
    labels: {
      type: 'id_document',
      holder_name: holder.name,
      id_number: idn,
      issuer,
      expiry_date: expiry.iso,
    },
  };
};

const policyTemplate: Template = (r, n) => {
  const insurer = r.pick(['Evergreen Mutual', 'Harbor Casualty', 'Summit Assurance']);
  const policyNo = `POL-${r.int(100000, 999999)}`;
  const expiry = makeDate(r);
  const html = page(
    'Policy',
    `<div class="hdr"><div class="agency">${insurer}</div><div class="right muted">Policy ${policyNo}</div></div>
<h1>Insurance Policy Declarations</h1>
<table>
<tr><td class="muted">Policy number</td><td class="right">${policyNo}</td></tr>
<tr><td class="muted">Coverage</td><td class="right">Comprehensive auto, $500 deductible</td></tr>
<tr><td class="muted">Expiration date</td><td class="right"><strong>${expiry.display}</strong></td></tr>
</table>
<p>This policy provides the coverage described above for the policy period ending ${expiry.display}.</p>`,
  );
  return {
    id: `policy-${String(n).padStart(3, '0')}`,
    type: 'policy',
    html,
    labels: {
      type: 'policy',
      insurer,
      policy_number: policyNo,
      coverage_summary: 'Comprehensive auto, $500 deductible',
      expiry_date: expiry.iso,
    },
  };
};

const TEMPLATES: readonly Template[] = [
  billTemplate,
  receiptTemplate,
  letterTemplate,
  idTemplate,
  policyTemplate,
];

/**
 * Generate the full synthetic fixture set for a seed.
 *
 * Failure modes: none; pure and deterministic. `variantsPerType` fixtures are
 * emitted for each of the five document types, in a stable order, so the same
 * seed always yields byte-identical HTML and labels.
 */
export function generateFixtures(seed = 20260722, variantsPerType = 2): FixtureSpec[] {
  const next = mulberry32(seed);
  const r = rngFrom(next);
  const specs: FixtureSpec[] = [];
  for (let v = 1; v <= variantsPerType; v += 1) {
    for (const template of TEMPLATES) {
      specs.push(template(r, v));
    }
  }
  return specs;
}
