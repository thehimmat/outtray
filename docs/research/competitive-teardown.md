# Competitive teardown: paperless-ngx, paperless-ai, Paperspell, Duely

Status: desk research, 2026-10-16. All four products read from their own
sites or repositories. Not yet verified hands-on (see the last section).

Issue: #9. Positioning line under test: "paperless-ngx organizes and finds;
Outtray tells you what needs doing, locally."

## How this was researched

- paperless-ngx and paperless-ai were read from primary sources: the
  paperless-ngx documentation source on its `main` branch (fetched from GitHub
  because the docs site was not reachable from the research sandbox), the
  GitHub releases page, and the paperless-ai README, license and commit list.
- Paperspell and Duely were read from their own sites (ppspell.com,
  getduely.app) and App Store listings on 2026-10-16, after an earlier pass
  that could only see search-engine snapshots. Where the live pages differ
  from those snapshots, the live pages win and the difference is noted.
  These are the vendors' own words, not observed behavior.
- "Duely" is an ambiguous name. Several unrelated products use it (an M&A
  legal-services firm at duely.ai, a Canvas semester app at duely.app, a
  student GitHub project, a social voting app). This teardown assumes the
  intended product is the personal deadline tracker at getduely.app, because
  it is the only one that tracks document deadlines. The owner should confirm.
- Outtray facts come from this repository at the time of writing
  (`packages/core/src/actions.ts`, `scan.ts`, ADR-0010, README).

## Outtray (baseline, stated honestly)

- **What it is**: a local-first document assistant. Point it at a folder; a
  local vision model extracts typed fields; a deterministic planner proposes
  an action queue.
- **Who it is for**: one person with a pile of personal paperwork on a Mac.
- **Where it runs**: locally. CLI plus a Tauri desktop app (macOS, unsigned
  builds until #12). Ollama with `qwen3-vl:2b` for extraction and
  `nomic-embed-text` for embeddings.
- **Documents leave the machine?** No. No cloud provider sees user documents
  (ADR-0003); no telemetry. Store is SQLCipher-encrypted, key in the macOS
  Keychain; extracted ID numbers are redacted to last four by default and
  identifier storage is off by default.
- **What it does**: type classification and field extraction, retrieval with
  citations (`outtray find`), and the action queue: to-dos from extracted
  action items with due dates, expiry alerts (ID documents, policies,
  contracts within a 60-day default window), keep/shred retention advice from
  a six-rule table (bill, receipt, statement, ID document, policy, contract)
  with rule ids and a disclaimer, and attention flags.
- **Proposes or acts?** Proposes only. Every item has `status: proposed`;
  there is no delete or move tool in v1 (ADR-0008).
- **Licence / price**: MIT, free.
- **Honest limits today**: input is images only (`.png`, `.jpg`, `.jpeg`,
  `.webp`; PDFs are skipped by `scan`); no full-text OCR layer or keyword
  search over raw text; attention flags in v1 are pipeline signals only
  (invalid extraction, disputed or unclear type, past due, expired), so the
  README's examples of phishing, unfavourable term changes and duplicate
  charges are not yet implemented; no notifications (you run it to see the
  queue); single user; no mobile, mail ingestion or sync; not released.

## paperless-ngx

- **What it is**: a "community-supported open-source document management
  system that transforms your physical documents into a searchable online
  archive" (docs home). Mature successor to Paperless and Paperless-ng.
- **Who it is for**: self-hosters, households and small offices who want a
  long-term searchable archive. Multi-user with global and per-object
  permissions, two-factor authentication.
- **Where it runs**: self-hosted server (Docker Compose recommended, arm64
  images, Raspberry Pi works with slow OCR per the FAQ), used through a web UI
  that the docs say supports mobile browsers. No official native mobile app;
  the docs point to a community list of compatible mobile apps.
- **Model / OCR**: Tesseract via OCRmyPDF (more than 100 languages), stored as
  PDF/A alongside originals. Optional remote OCR via Azure AI Document
  Intelligence (opt-in, can be limited to documents a workflow selects). A
  non-LLM machine-learning classifier suggests tags, correspondents, document
  types and storage paths. Since v3 (stable 3.0.0 dated 22 July 2026 by a
  third-party blog; the releases page lists v3.0.4 on 28 Jul through v3.3.1 on
  12 Oct), optional **LLM features**: AI suggestions, document chat with RAG,
  and similar-document retrieval, off by default. Backends: Ollama (default
  model `llama3.1`) or any OpenAI-compatible API; embeddings via Hugging Face
  (fully local), Ollama or OpenAI-compatible.
- **Documents leave the machine?** Not by default: "Your data is stored
  locally on your server and is never transmitted or shared in any way, unless
  you explicitly choose to do so." They do leave if you enable remote OCR or a
  hosted LLM backend; the docs warn about this explicitly. Documents are
  stored "plain on disk"; I found no built-in encryption at rest in the docs
  (not verified beyond the docs text).
- **What it does**: OCR and full-text search (autocomplete, relevance,
  highlighting, "more like this"), tags, correspondents, document types,
  storage paths, nested tags, custom fields (text, date, monetary, select,
  document links and more), saved views and dashboard, bulk edit, document
  versions, PDF editing, share links, email ingestion from multiple accounts
  with rules (including GPG-encrypted mail), REST API, trash with a 30-day
  default delay. **Workflows** with triggers (consumption started, document
  added, document updated, and **Scheduled**, which can fire on a date
  custom field with a day offset before or after) and actions (assign,
  remove, email, webhook, **move to trash**, password removal, remote OCR,
  **apply AI suggestions**). AI suggestions cover title, tags, correspondent,
  document type, storage path and dates; the docs do not list custom-field
  extraction (for example an expiry date or amount) as an AI suggestion.
- **Proposes or acts?** Both. ML and AI suggestions on the document page are
  proposals the user accepts or rejects. Workflows act on their own once a
  user writes them, including applying AI suggestions in bulk and moving
  documents to trash.
- **Licence / price**: GPL-3.0, free. No paid tier.
- **Reminders / retention / actions**: no built-in to-do list, expiry alert
  or retention advice. A user *can* build reminders (Scheduled trigger on a
  date custom field, plus Email or Webhook action) and automatic disposal
  (Scheduled trigger plus Move to Trash), but the user has to know the rule,
  create the custom field, fill in the date (manually or by their own
  tooling), and the result acts rather than advises.

## paperless-ai

- **What it is**: "an AI-powered extension for Paperless-ngx that brings
  automatic document classification, smart tagging, and semantic search"
  (README). A separate Node service that talks to a paperless-ngx instance.
- **Who it is for**: existing paperless-ngx self-hosters who wanted LLM
  tagging and chat before paperless-ngx had it natively.
- **Where it runs**: self-hosted Docker container next to paperless-ngx.
- **Model / OCR**: no OCR of its own (it uses paperless-ngx's text). LLM via
  Ollama (Mistral, Llama, Phi-3, Gemma-2 named) or hosted APIs: OpenAI,
  DeepSeek, OpenRouter, Perplexity, Together.ai, Gemini, and LiteLLM, vLLM,
  FastChat gateways.
- **Documents leave the machine?** Only if a hosted provider is chosen; with
  Ollama it can stay local.
- **What it does**: detects new documents and assigns title, tags, document
  type and correspondent; rules to limit which documents are processed; a
  `/manual` page for manual review of AI tagging; RAG chat over the archive
  ("When did I sign my rental agreement?"). Custom-field extraction: not
  verified (not in the current README).
- **Proposes or acts?** Mostly acts: the default flow writes metadata back to
  paperless-ngx automatically; the manual page is the review path.
- **Licence / price**: MIT, free (donation links).
- **Maintenance**: the README now says "This repo is currently not
  maintained" and that, given "the upcoming official AI integration in
  Paperless-ngx itself", the author may not finish the rewrite. Last commits:
  v3.0.9 on 4 Nov 2025, maintenance notice added 31 Mar 2026. In practice
  paperless-ngx v3 has absorbed its core features.

## Paperspell

- **What it is**: a consumer document assistant from a small Polish company
  (ARKUSH LABS sp. z o.o.). Since the July review the homepage has shifted
  from "AI assistant for all your documents" to **goal roadmaps**: pick a
  goal (residence permit, driving licence, child benefits, university
  admission) and see staged steps and "your next step". The roadmaps are
  shown as previews with "App availability: TBD".
- **Who it is for**: people facing bureaucracy, especially expats and
  immigration paperwork (examples are set in Poland). Creator and business
  pilots (multilingual contract summaries, obligations, renewal dates) are
  listed with scope "TBD".
- **Where it runs**: cloud service with iOS, iPadOS and Android apps and a
  web app at app.ppspell.com ("does everything the mobile app does"). The
  App Store listing says "access everything anytime, even offline". The
  desktop app "with local OCR" that search snapshots mentioned is not on the
  current download page.
- **Model / OCR**: the privacy policy (updated 2026-10-03) names **Google
  Document AI** for OCR and Google Firestore, Cloud Storage, Cloud Functions
  and Cloud Run for storage and processing, in Google Cloud's EU data
  centers (Belgium and Finland). Summaries are produced by "automated
  processing"; the model provider is **not named**. The policy states that
  AI output is never used to train external models.
- **Documents leave the machine?** Yes, to Google Cloud (EU), encrypted at
  rest and in transit per the policy. Account deletion removes documents
  from all storage, backups included, within 30 days.
- **What it does**: scan with the camera, import images and PDFs, auto-name
  and organize with categories and tags, OCR, search, summaries, **suggested
  actions** per document, an **expiration calendar** across the library
  (week, month, year) with notifications, translation, chat about one
  document or across the library (answers reference source documents), and
  Telegram or WhatsApp upload. No keep/shred or retention guidance.
- **Proposes or acts?** Proposes. Its own feature page calls suggested
  actions "prompts for your own review" and warns that AI "may miss a
  condition"; actions are shown with each document, not as one list across
  the library.
- **Licence / price**: proprietary. Free to download with in-app purchases;
  plan names, prices and limits are all "TBD" on the pricing page.

## Duely (getduely.app)

- **What it is**: a tracker for subscriptions, bills, mortgages, insurance,
  passports and warranties, "without linking your bank or scanning your
  inbox".
- **Who it is for**: individuals tracking recurring payments and renewal
  dates.
- **Where it runs**: cloud service with a web app (app.getduely.app) and a
  native app for iPhone, iPad and Apple-silicon Macs (App Store, requires
  iOS or macOS 26). No Android app found.
- **Model / OCR**: intake is forwarded email only, to a private forwarding
  address per account. The homepage names **Claude 3 Haiku** (Anthropic) for
  extraction, after a classifier step that rejects non-financial,
  non-renewal content. No document upload or scanning.
- **Documents leave the machine?** Yes: forwarded emails go to the service
  and to Anthropic. The homepage says the original email is processed once
  and then permanently deleted, keeping only extracted fields (service,
  amount, billing cycle, due date). Account deletion within 30 days (FAQ).
- **What it does**: extracts deadline items from emails, sorts them into
  50+ categories, reminders before due dates (fixed 1 and 3 days on the free
  tier, custom on paid), free-trial countdowns, AI price-hike alerts from
  news, spending analytics, and an AI assistant for questions such as "What
  documents do I need to renew my license?". No retention advice; not a
  document archive.
- **Proposes or acts?** Reminds. It does not act on accounts.
- **Licence / price**: proprietary. Free tier capped at 3 tracked items;
  4.99 USD per month; 29.99 USD per year; 99.99 USD lifetime (homepage and
  App Store in-app purchase list agree).

## Comparison table

| Dimension | Outtray | paperless-ngx (v3.3) | paperless-ai | Paperspell | Duely |
| --- | --- | --- | --- | --- | --- |
| Category | Local action-queue assistant | Self-hosted DMS archive | Add-on to paperless-ngx | Consumer mobile document assistant | Subscription and deadline tracker |
| Runs where | Local Mac (CLI, Tauri app) | Self-hosted server, web UI | Self-hosted container | Cloud; iOS, Android and web apps | Cloud; Apple apps and web |
| OCR | None separate; VLM reads images | Tesseract (OCRmyPDF); optional Azure | Uses paperless-ngx text | Google Document AI (per privacy policy) | None (email text) |
| Model | qwen3-vl:2b via Ollama, local | Non-LLM classifier; optional LLM (Ollama or OpenAI-compatible) | Ollama or many hosted APIs | Not named in its privacy policy | Claude 3 Haiku (per homepage) |
| Documents leave the machine | Never | Not by default; yes if remote OCR or hosted LLM enabled | Only with a hosted provider | Yes (Google Cloud, EU) | Yes (forwarded emails) |
| Encrypted at rest locally | Yes (SQLCipher, Keychain key) | Not found in docs | Not verified | Server side, per privacy policy | Server side, not verified |
| Input formats | Images only today | PDF, images, text, Office, email | Via paperless-ngx | Camera scans, images, PDFs, messenger bots | Forwarded email |
| Organize / tag | Type classification only | Yes, extensive | Yes (LLM tags, titles, types) | Yes (auto-naming, sorting) | Categories |
| Full-text search | No | Yes, mature | No (semantic chat) | Yes (library search with filters) | No |
| Semantic search / Q&A | Cited retrieval (`find`); no chat | Yes (opt-in RAG chat) | Yes (RAG chat) | Yes (per document and across library, with source references) | AI assistant (paid) |
| Typed field extraction | Yes, per-type schema with confidence | Title, dates, metadata via AI; custom fields manual | Title, tags, type, correspondent | Expiry dates; summaries | Service, amount, cycle, due date |
| To-dos with due dates | Yes, one queue across the folder | No (DIY via workflows) | No | Per document (suggested actions) | Yes (bill and renewal items) |
| Expiry alerts | Yes (in queue, no push) | DIY (Scheduled trigger on date field plus email) | No | Yes, library calendar with notifications | Yes, with reminders |
| Keep/shred/trash advice | Yes (6 rules, rule ids, disclaimer) | No (DIY auto-trash rules act, not advise) | No | Not found | No |
| Attention flags | Yes, pipeline signals only in v1 | No | No | Not found | No |
| Citations per item | Yes (doc id plus verbatim snippet) | n/a | Not verified | Shown with its document | n/a |
| Proposes vs acts | Proposes only; no destructive tools | Suggestions proposed; workflows act (incl. trash) | Acts by default; manual mode available | Proposes (lists, reminders) | Reminds |
| Notifications | None | Email/webhook via workflows | No | Yes | Yes (push or email) |
| Multi-user | No | Yes, permissions and 2FA | Via paperless-ngx | Family use claimed, not verified | Not verified |
| Mobile | No | Responsive web; community apps | No | Native iOS, iPadOS, Android | Native iPhone and iPad (iOS 26) |
| Mail ingestion | No | Yes, multi-account rules | Via paperless-ngx | Telegram, WhatsApp bots | Yes, email forwarding is the intake |
| Maturity | Pre-release | Years of releases, large community | Unmaintained since 2026-03 | Young startup | Small, young |
| Licence / price | MIT, free | GPL-3.0, free | MIT, free | Proprietary; free download, in-app purchases, prices TBD | Free (3 items); 4.99 USD/mo, 29.99 USD/yr, 99.99 USD lifetime |

## Where Outtray is weaker

- **Maturity and scale.** paperless-ngx is a years-old project with a large
  contributor base, frequent releases (ten releases between late July and
  mid-October 2026 alone), migrations, a sanity checker and a REST API.
  Outtray is pre-release with one maintainer and unsigned builds.
- **Ingestion breadth.** paperless-ngx consumes PDFs, images, plain text,
  Office files and email from multiple accounts with rules; Paperspell has
  camera scanning and messenger bots; Duely ingests by email forwarding.
  Outtray today reads image files from one folder and skips PDFs, which is a
  serious gap for real piles where most statements and bills are PDFs.
- **Full-text OCR search.** paperless-ngx produces a searchable PDF/A text
  layer with keyword search, highlighting and autocomplete. Outtray has no
  OCR text layer and only cited semantic retrieval over extracted chunks.
- **Archive features.** Tags, correspondents, custom fields, saved views,
  bulk edit, versions, PDF editing, share links and storage-path file
  management are all paperless-ngx strengths Outtray does not attempt.
- **Multi-user and access control.** paperless-ngx has users, groups,
  per-object permissions and 2FA. Outtray is one user on one Mac.
- **Mobile and capture.** Paperspell is a native mobile app with camera
  capture and offline cache; paperless-ngx has a mobile web UI and community
  apps. Outtray has nothing on a phone, which is where paper actually arrives.
- **Reminders that reach you.** Paperspell and Duely send reminders before a
  deadline; paperless-ngx can email or call a webhook from a scheduled
  workflow. Outtray only shows the queue when you run it.
- **Paperspell already ships suggested actions.** Its per-document summary
  plus suggested actions, shown with the document, and its library-wide
  expiration calendar are the closest thing to Outtray's to-do and expiry
  lanes, in a polished
  consumer app with translation that suits multilingual paperwork, which is
  Outtray's own origin story. Outtray's case against it is locality and
  privacy, not features.
- **Attention flags are thinner than the pitch.** In v1 they are pipeline
  signals (invalid extraction, disputed type, past due, expired). The README
  examples (phishing, unfavourable term changes, duplicate charges) are not
  built yet. A comparison that leads with them would overclaim.
- **Retention rules are small.** Six document types, one rule each, no
  jurisdiction. Honest and cited, but a reviewer will rightly call it a
  starting table, not a retention engine.
- **Model quality ceiling.** A 2B local VLM is the constraint (8 GB Air,
  ADR-0002). paperless-ngx and paperless-ai users can point at larger local
  models or hosted frontier models if they accept the trade-off.

## The unclaimed cell

Claim under test: keep/shred/trash advice plus attention flags plus a cited,
proposed-only action queue, all local, is not offered by any of the four.

- **Keep/shred/trash advice.** Not found in any of the four. paperless-ngx
  can be configured to *act* on retention (a Scheduled workflow with Move to
  Trash), which is user-authored automation, not advice, and it carries no
  reason or rule id. Paperspell's "retention" material is about how long
  Paperspell keeps your uploads, not advice on your documents. **Holds**, with
  the caveat that paperless-ngx users can approximate it by hand.
- **Attention flags.** Not found in any of the four as a distinct product
  concept. **Holds**, but Outtray's own v1 flags are pipeline signals, so the
  claim is about the category, not about content judgment Outtray does not
  yet make.
- **Cited action queue, proposed only.** **Partly offered.** Paperspell
  shows suggested actions with each document, explicitly as prompts for the
  person's review, and puts expiry dates from the whole library on one
  calendar with notifications. Duely produces a deadline list with reminders
  from emails. Neither is local, neither gives retention advice, and
  neither, per its own pages, gathers actions from a whole pile into one
  queue with verbatim snippet citations and review gating.
- **All local.** paperless-ngx (with Ollama or Hugging Face embeddings) and
  paperless-ai (with Ollama) can be fully local, but neither has an action
  queue. Paperspell and Duely have action or deadline lists but are cloud
  services. Paperspell's desktop app with "local OCR", seen in older search
  snapshots, is no longer on its download page; the browser version it
  offers instead is cloud-backed like the mobile apps.

Verdict: the specific combination is still unclaimed as of 2026-10-16, but the
to-do and expiry lanes are not unique. The defensible cell is narrower than
the July review stated: **local** plus **retention advice with cited rules**
plus **one reviewed queue across a whole pile**, with nothing acted on
automatically. Paperspell is the closest competitor on the action-list idea,
and paperless-ngx v3 (native local LLM plus scheduled workflows) is the
closest on local AI infrastructure. Both should be watched. Paperspell's
move toward goal roadmaps (residence permit, licence, benefits) points it
at guided procedures rather than at clearing a pile, which widens the gap
between the two rather than closing it.

## Draft FAQ answer: "Why not paperless-ngx?"

Use paperless-ngx if you want a long-term, searchable, multi-user archive: it
is mature, free, does excellent OCR and full-text search, ingests mail, and
since v3 can use a local LLM to suggest tags and answer questions. Outtray
answers a different question: not "where is that document?" but "what in
this pile needs doing?". It reads a folder on your Mac and proposes one
reviewed list of to-dos, expiry alerts, keep-or-shred advice with the rule
behind it, and flags, each citing the text it came from, with nothing ever
sent off the machine and nothing deleted or moved for you. They work well
together: sort the pile with Outtray, archive what you keep in paperless-ngx.

## Hands-on checks still needed

paperless-ngx (install v3.3.x with Docker Compose on the Mac):

- Memory and CPU at idle and during consumption on the 8 GB Air, with and
  without Ollama running alongside; whether `llama3.1` default is usable
  there or a smaller model is needed.
- Do AI suggestions ever fill custom fields such as an expiry or due date?
  The docs list title, tags, correspondent, type, storage path and dates only.
- Build a reminder (date custom field, Scheduled trigger, Email action) and an
  auto-trash rule; time how long it takes a new user, to back the "DIY" claim.
- Document chat: does it cite source documents or passages?
- Confirm no encryption at rest for originals and the database.
- Run the Outtray fixture set through it and record what it produces.

paperless-ai:

- Confirm it still runs against paperless-ngx v3 given the maintenance
  notice; whether it writes custom fields; whether chat cites sources.

Paperspell (iPhone, iPad, or the web app at app.ppspell.com):

- Scan three Outtray fixtures (a bill, an ID document, a policy): capture
  the suggested actions, whether they quote text or only sit beside the
  file, whether anything resembles keep/shred advice, and whether any view
  gathers actions across documents.
- Check what works offline (airplane mode) against the listing's "access
  everything anytime, even offline": viewing only, or processing too?
- Read the in-app plan screen for current prices and limits, with the date.
- Look at the goal roadmaps: shipped in the app, or website previews only?

Duely (iPhone, or the web app):

- Confirm with the owner that getduely.app is the intended "Duely" (the
  name is shared by several unrelated products).
- On the free tier, forward one fixture-style renewal email and record what
  is extracted and which reminders fire.

## Sources

All accessed 2026-10-16.

paperless-ngx (primary; docs read from GitHub `main` because
docs.paperless-ngx.com was unreachable from the sandbox):

- [docs/index.md (features)](https://github.com/paperless-ngx/paperless-ngx/blob/main/docs/index.md), mirrors [docs.paperless-ngx.com](https://docs.paperless-ngx.com/)
- [docs/usage.md (AI features, workflows, custom fields, trash, remote OCR, mail)](https://github.com/paperless-ngx/paperless-ngx/blob/main/docs/usage.md)
- [docs/advanced_usage.md (AI features, LLM index)](https://github.com/paperless-ngx/paperless-ngx/blob/main/docs/advanced_usage.md)
- [docs/configuration.md (AI and remote OCR settings)](https://github.com/paperless-ngx/paperless-ngx/blob/main/docs/configuration.md)
- [docs/faq.md](https://github.com/paperless-ngx/paperless-ngx/blob/main/docs/faq.md)
- [LICENSE (GPL-3.0)](https://github.com/paperless-ngx/paperless-ngx/blob/main/LICENSE)
- [GitHub releases (v3.0.4 to v3.3.1)](https://github.com/paperless-ngx/paperless-ngx/releases)
- [WZ-IT blog, "Paperless-ngx AI Setup: Native AI from Version 3" (secondary, used only for the 3.0.0 date)](https://wz-it.com/en/blog/paperless-ngx-ai-setup/)

paperless-ai (primary):

- [README](https://github.com/clusterzx/paperless-ai)
- [LICENSE (MIT)](https://github.com/clusterzx/paperless-ai/blob/main/LICENSE)
- [Commit history](https://github.com/clusterzx/paperless-ai/commits/main)

Paperspell (primary: its own site and App Store listing):

- [Homepage (goal roadmaps)](https://ppspell.com/)
- [Features](https://ppspell.com/features/)
- [Summary and suggested actions](https://ppspell.com/features/summary-and-action-items-list/)
- [Expiration calendar and notifications](https://ppspell.com/features/expiration-dates-tracker-and-notifications/)
- [AI chat](https://ppspell.com/features/ai-chat/)
- [Pricing (all TBD)](https://ppspell.com/product/pricing/)
- [FAQ (web app, PDFs, sync)](https://ppspell.com/product/faq/)
- [Download (iOS, Android, web)](https://ppspell.com/download/)
- [Solutions (creator and business pilots)](https://ppspell.com/solutions/)
- [Privacy policy, last updated 2026-10-03](https://ppspell.com/company/legal/privacy-policy/)
- [App Store listing (version 1.13.0)](https://apps.apple.com/us/app/paperspell-ai-document-manager/id6737549507)

Duely (primary: its own site and App Store listing):

- [Homepage](https://getduely.app/)
- [FAQ](https://getduely.app/faq.html)
- [Getting started guide](https://getduely.app/guide.html)
- [Privacy policy](https://getduely.app/privacy.html)
- [Terms of service](https://getduely.app/terms.html)
- [App Store listing](https://apps.apple.com/us/app/duely/id6757676496)

Outtray (this repository): `README.md`, `docs/adr/0010-action-layer.md`,
`packages/core/src/actions.ts`, `packages/core/src/scan.ts`.
