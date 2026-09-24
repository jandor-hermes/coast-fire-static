(() => {
  'use strict';

  // Static build: financial values exist only in this tab's memory.
  const fields = [...document.querySelectorAll('[data-field]')];
  const errorBox = document.getElementById('error');
  const defaultsBanner = document.getElementById('defaults-banner');
  const defaultsBannerText = document.getElementById('defaults-banner-text');
  const defaultsRetryButton = document.getElementById('defaults-retry');
  const storageNotice = document.getElementById('storage-notice');
  const payloadNotice = document.getElementById('payload-notice');
  const resultWarningsBox = document.getElementById('result-warnings');
  const resultWarningsList = document.getElementById('result-warnings-list');
  const provenanceBox = document.getElementById('provenance');
  const provenanceSource = document.getElementById('provenance-source');
  const provenanceScenario = document.getElementById('provenance-scenario');
  const provenanceStaleness = document.getElementById('provenance-staleness');
  const provenanceLedger = document.getElementById('provenance-ledger');
  const rebaseButton = document.getElementById('rebase-defaults');
  const exportButton = document.getElementById('export-json');
  const copyButton = null;
  const RESULT_TEXT_IDS = [
    'projected-portfolio', 'contribution-detail', 'payoff-age', 'mortgage-balance-retirement',
    'adjusted-coast-number', 'strict-coast-number', 'adjusted-retirement-target',
    'annual-portfolio-need', 'tax-allowance-line', 'account-access-line', 'housing-scenario-line',
    'effective-ss', 'benefit-starts', 'net-rent',
    'net-rent-after-payoff', 'mortgage-at-retirement', 'home-equity',
    'coast-now-line', 'on-track-line', 'earliest-coast-line', 'coast-cash-flow-line',
  ];
  const STATUS_CARDS = ['adjusted-status-card', 'strict-status-card'];

  let householdDefaults = {};
  let state = {};
  let defaultsState = { status: 'loading' };
  let provenanceState = { status: 'loading' };
  // Active scenario layers (CF-05, review finding 10): what the inputs are
  // sourced from, so fresh defaults can never silently masquerade as current
  // while a stale browser/URL value wins. Each layer: { scenario, savedAt,
  // schemaVersion, legacy }. Precedence: URL > browser-stored > defaults.
  let scenarioState = { stored: null, hash: null };
  const editedFields = new Set();
  let storageReadProblem = null;
  let storageWriteProblem = null;
  let resultIsValid = false;
  let userEdited = false;

  const fallbackDefaults = {
    currentAge: 40,
    retirementAge: 67,
    coastAge: 40,
    horizonAge: 95,
    terminalBalanceTarget: 0,
    currentInvestments: 250000,
    annualContributions: 0,
    realReturn: 0.045,
    inflationRate: 0,
    withdrawalRate: 0.035,
    retirementSpendingAnnual: 72000,
    socialSecurityAnnual: 0,
    socialSecurityHaircut: 0.2,
    member1AnnualBenefit: 0,
    member2AnnualBenefit: 0,
    mortgagePrincipal: 0,
    mortgageRate: 0,
    mortgagePrincipalInterestMonthly: 0,
    extraPrincipalMonthly: 0,
    escrowMonthly: 0,
    grossRentMonthly: 0,
    rentGrowthReal: 0,
    managementRate: 0,
    vacancyRate: 0.05,
    maintenanceRate: 0.1,
    ownerUtilitiesMonthly: 0,
    homeValue: 0,
    notes: [],
  };

  // CF-05 (review finding 10): which inputs are SOURCED household facts
  // (a refreshed defaults file would legitimately update them) versus
  // intentional scenario assumptions (rebase must preserve them).
  const ASSUMPTION_FIELDS = new Set([
    'realReturn', 'inflationRate', 'withdrawalRate', 'horizonAge', 'terminalBalanceTarget',
    'retirementSpendingAnnual', 'retirementTaxAllowance',
    'consumptionAnnual', 'personalHousingAnnual',
    'healthcarePreMedicareAnnual', 'healthcarePostMedicareAnnual',
    'propertyOperationsAnnual', 'savingsTransfersAnnual',
    'investmentsTaxableAccessible', 'investmentsTaxAdvantagedPreAccess',
    'investmentsRothOrBasis', 'taxAdvantagedAccessAge',
    'socialSecurityHaircut', 'rentGrowthReal', 'housingScenario',
  ]);

  const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  const oneDecimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

  function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function valuesEqual(a, b) {
    if (a === b) return true;
    if (isPlainObject(a) && isPlainObject(b)) return JSON.stringify(a) === JSON.stringify(b);
    return false;
  }

  // --- Household defaults load states (review finding 9) ---------------------
  // Four distinct, labeled states; a silent fallback to generic values is the
  // bug. Retry is offered for every non-loaded state.
  function renderDefaultsBanner() {
    const { status, message } = defaultsState;
    let text = null;
    if (status === 'loading') text = 'Preparing generic demo…';
    if (status === 'generic') {
      text = 'Demo inputs — choose Import financial JSON above to use your household file. No upload or browser storage is used.';
    }
    if (status === 'fetch-failed') {
      text = `Household defaults unavailable — the request to load them failed (${message}). Generic demo inputs are shown; retry when the local service is running.`;
    }
    if (status === 'invalid') {
      text = `Household defaults file failed validation and is not used: ${message} Generic demo inputs are shown.`;
    }
    defaultsBannerText.textContent = text || '';
    defaultsBanner.style.display = text ? 'block' : 'none';
    defaultsBanner.classList.toggle('error', status === 'fetch-failed' || status === 'invalid');
    defaultsRetryButton.style.display = 'none';
  }

  async function loadDefaults() {
    householdDefaults = { ...fallbackDefaults };
    defaultsState = { status: 'generic' };
    renderDefaultsBanner();
  }

  async function loadProvenance() {
    provenanceState = { status: 'loaded', payload: { source: 'absent' } };
  }

  function readHashScenario() { return { value: null }; }
  function readStoredScenario() { return null; }

  function renderStorageNotice() {
    storageNotice.textContent = '';
    storageNotice.style.display = 'none';
  }

  function showPayloadNotice(message) {
    payloadNotice.textContent = message;
    payloadNotice.style.display = 'block';
  }

  // --- Form handling -------------------------------------------------------------

  // CF-04 (plan §4): the worksheet rows compose the entered total, and the
  // housing scenario object is edited through dedicated glue fields that are
  // assembled into one input object before validation sees it.
  const WORKSHEET_SUM_FIELDS = ['consumptionAnnual', 'personalHousingAnnual', 'healthcarePostMedicareAnnual'];
  const HOUSING_GLUE_FIELDS = [
    'housingScenarioMode', 'housingReplacementAssumption', 'housingReplacementMonthly',
    'housingReplacementStartAge', 'housingMovingCostsOneTime', 'housingReplacementJustification',
  ];

  function syncWorksheetTotal() {
    const values = WORKSHEET_SUM_FIELDS.map(name => {
      const el = fields.find(f => f.dataset.field === name);
      const raw = String(el && el.value != null ? el.value : '').trim();
      if (raw === '') return null;
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    });
    if (values.every(v => v !== null)) {
      const totalField = fields.find(f => f.dataset.field === 'retirementSpendingAnnual');
      if (totalField) totalField.value = String(values.reduce((a, b) => a + b, 0));
    }
  }

  function populateForm() {
    const exploded = { ...state };
    if (state.housingScenario && typeof state.housingScenario === 'object' && !Array.isArray(state.housingScenario)) {
      exploded.housingScenarioMode = state.housingScenario.mode || '';
      exploded.housingReplacementAssumption = state.housingScenario.replacementHousingAssumption ?? '';
      exploded.housingReplacementMonthly = state.housingScenario.replacementHousingMonthly ?? '';
      exploded.housingReplacementStartAge = state.housingScenario.replacementHousingStartAge ?? '';
      exploded.housingMovingCostsOneTime = state.housingScenario.movingCostsOneTime ?? '';
      exploded.housingReplacementJustification = state.housingScenario.replacementHousingJustification ?? '';
    } else {
      for (const key of HOUSING_GLUE_FIELDS) exploded[key] = '';
    }
    delete exploded.housingScenario;
    for (const input of fields) {
      const key = input.dataset.field;
      const value = exploded[key];
      if (input.dataset.percent !== undefined) {
        input.value = value === undefined || value === null ? '' : value * 100;
      } else {
        input.value = value === undefined || value === null ? '' : value;
      }
    }
  }

  function readForm() {
    const next = { ...state };
    for (const input of fields) {
      const raw = String(input.value).trim();
      // An empty required field must surface as "required", not as 0.
      if (raw === '') {
        next[input.dataset.field] = undefined;
        continue;
      }
      next[input.dataset.field] = input.dataset.text !== undefined
        ? raw
        : input.dataset.percent !== undefined
          ? Number(raw) / 100
          : Number(raw);
    }
    // Assemble the housing scenario object from its glue fields (plan §4);
    // an empty mode means no scenario object (the named occupied default).
    const mode = next.housingScenarioMode;
    const replacementAssumption = next.housingReplacementAssumption;
    const replacementMonthly = next.housingReplacementMonthly;
    const replacementStartAge = next.housingReplacementStartAge;
    const movingCosts = next.housingMovingCostsOneTime;
    const replacementJustification = next.housingReplacementJustification;
    for (const key of HOUSING_GLUE_FIELDS) delete next[key];
    delete next.housingScenario;
    if (typeof mode === 'string' && mode !== '') {
      next.housingScenario = { mode };
      if (replacementAssumption !== undefined) next.housingScenario.replacementHousingAssumption = replacementAssumption;
      if (replacementMonthly !== undefined) next.housingScenario.replacementHousingMonthly = replacementMonthly;
      if (replacementStartAge !== undefined) next.housingScenario.replacementHousingStartAge = replacementStartAge;
      if (movingCosts !== undefined) next.housingScenario.movingCostsOneTime = movingCosts;
      if (replacementJustification !== undefined) next.housingScenario.replacementHousingJustification = replacementJustification;
    }
    return next;
  }

  // --- Provenance banner (CF-05, review findings 10–11) --------------------------

  function defaultsStatusLine() {
    const { status, message } = defaultsState;
    if (status === 'loaded') {
      const prov = provenanceState.status === 'loaded' ? provenanceState.payload : null;
      const asOf = prov && typeof prov.asOf === 'string' ? prov.asOf : null;
      return `Inputs: JSON imported on this device — data as of ${asOf || 'date not recorded'}; held in this tab only, not uploaded or saved by the site.`;
    }
    if (status === 'generic') return 'Inputs: generic demo — import your financial JSON to see your household scenario.';
    if (status === 'invalid') return `Inputs: generic demo examples — the household defaults file failed validation (${message}).`;
    return `Inputs: generic demo examples — the household defaults file is unavailable (${message}).`;
  }

  function activeScenarioLine() {
    const { stored, hash } = scenarioState;
    const parts = [];
    if (stored) {
      const overrides = overrideListFor('stored');
      parts.push(`browser-saved scenario saved ${stored.savedAt || 'unknown time'} (schema v${stored.schemaVersion}${stored.legacy ? ', legacy format' : ''}) overriding ${overrides.length} field(s)${overrides.length ? `: ${overrides.join(', ')}` : ''}`);
    }
    if (hash) {
      const overrides = overrideListFor('hash');
      parts.push(`scenario URL (schema v${hash.schemaVersion}) overriding ${overrides.length} field(s)${overrides.length ? `: ${overrides.join(', ')}` : ''}`);
    }
    const manual = manualOverrideList();
    if (!stored && !hash) {
      return manual.length
        ? `Active scenario: none — inputs are the household defaults (manual edit overriding ${manual.length} field(s): ${manual.join(', ')}).`
        : 'Active scenario: none — inputs are the household defaults.';
    }
    if (manual.length) parts.push(`manual edit(s) overriding ${manual.length} field(s): ${manual.join(', ')}`);
    const precedence = stored && hash ? ' Where both define the same field, the scenario URL wins.' : '';
    return `Active scenario: ${parts.join(' · ')}.${precedence}`;
  }

  function overrideListFor(layer) {
    const layerScenario = layer === 'hash' ? scenarioState.hash : scenarioState.stored;
    if (!layerScenario) return [];
    const out = [];
    for (const [key, value] of Object.entries(layerScenario.scenario)) {
      if (key === 'notes') continue; // notes provenance is shown with the notes
      if (!valuesEqual(value, householdDefaults[key])) out.push(key);
    }
    return out;
  }

  // Fields changed by hand on top of whatever layers are active: the active
  // value differs from the household defaults and no saved/URL layer explains
  // it. Listed in the scenario line so a manual edit can never pass as the
  // household's own value (review finding 10 — in either direction).
  function manualOverrideList() {
    const layerKeys = new Set();
    for (const layer of [scenarioState.stored, scenarioState.hash]) {
      if (layer && layer.scenario) for (const key of Object.keys(layer.scenario)) layerKeys.add(key);
    }
    const out = [];
    for (const [key, value] of Object.entries(state)) {
      if (key === 'notes' || key.startsWith('housing')) continue; // notes shown with the notes; housing glue fields are not inputs
      if (layerKeys.has(key)) continue;
      if (!valuesEqual(value, householdDefaults[key])) out.push(key);
    }
    return out;
  }

  function stalenessLine() {
    const { stored, hash } = scenarioState;
    const prov = provenanceState.status === 'loaded' ? provenanceState.payload : null;
    const fileModified = prov && prov.fileModified ? prov.fileModified : null;
    const savedAt = stored && stored.savedAt ? stored.savedAt : null;
    if (savedAt && fileModified && Date.parse(fileModified) > Date.parse(savedAt)) {
      return `STALE: the household defaults file changed after this scenario was saved (file modified ${fileModified.slice(0, 10)}; scenario saved ${savedAt.slice(0, 10)}) — the saved values below win over the fresher defaults. Rebase sourced values if the saved age/mortgage/balance figures are not intentional.`;
    }
    if (savedAt && fileModified && !hash) return '';
    if (hash) return 'The scenario URL payload is applied on top of any saved scenario; it is never auto-refreshed from the household file.';
    return '';
  }

  function ledgerLine() {
    const prov = provenanceState.status === 'loaded' ? provenanceState.payload : null;
    if (prov && prov.source === 'local-import') return `Source: locally imported ${prov.schemaLabel || 'flat profile'}; as of ${prov.asOf || 'unknown date'}. This is not a verified account refresh. ${plaintextWarningText()}`;
    if (!prov || prov.source === 'absent' || Object.keys(prov).length === 0) {
      return provenanceState.status === 'failed'
        ? `Source-ledger provenance unavailable (${provenanceState.message}); household values are stored as plaintext JSON.`
        : 'Source ledger: none (demo mode — no household defaults file configured).';
    }
    let lines = [];
    if (prov.schema === 2) {
      const unknownCount = Array.isArray(prov.unknownFields) ? prov.unknownFields.length : 0;
      const excluded = Array.isArray(prov.excludedAccounts) ? prov.excludedAccounts.length : 0;
      const outside = Array.isArray(prov.trackedOutsideInvestments) ? prov.trackedOutsideInvestments.length : 0;
      const memberBits = (Array.isArray(prov.memberRows) ? prov.memberRows : []).map(row => {
        const asOf = row.benefitEstimateAsOf || 'undated';
        const basis = row.benefitEstimateBasis || 'basis unknown';
        const dollars = row.benefitEstimateDollars || 'dollar basis unknown';
        const age = row.claimingAge != null ? `claims at ${row.claimingAge}` : 'claiming age unknown';
        return `${row.label}: ${age}, estimate ${asOf}, ${basis}, ${dollars}`;
      });
      const warningBits = (Array.isArray(prov.warnings) ? prov.warnings : []).map(w => `Ledger warning: ${w.message}`);
      lines = lines.concat([
        `Source ledger: v2 — ${prov.accountCount} account row(s), ${memberBits.length} member benefit record(s); data as of ${prov.asOf || 'unknown date'}.`,
        memberBits.length ? `Benefit provenance: ${memberBits.join('; ')}.` : null,
        excluded ? `${excluded} account row(s) excluded from the investment total (earmarked household reserves — not double-counted).` : null,
        outside ? `${outside} account row(s) (HSA/other) tracked OUTSIDE the investment total; they are not in the modeled portfolio.` : null,
        unknownCount ? `Unknown source fields (${unknownCount}): ${prov.unknownFields.join('; ')}.` : null,
        ...warningBits,
        stalenessNote(prov),
      ].filter(Boolean));
      lines.push(plaintextWarningText());
      return lines.join(' ');
    }
    return `Source ledger: none — ${prov.schemaLabel || 'v1 flat profile (deprecated)'}${prov.asOf ? `; data as of ${prov.asOf}` : ''}. The investment total is one aggregate without per-account structure; migrate to the v2 ledger (docs/coast-fire-calculator-plan.md §7) to make balances reconcilable. ${plaintextWarningText()}`;
  }

  function stalenessNote(prov) {
    if (typeof prov.asOfAgeDays !== 'number') return null;
    if (prov.asOfAgeDays > 545) return `Financial data is ${prov.asOfAgeDays} days old (as of ${prov.asOf}) — stale; refresh from statements before relying on it.`;
    return null;
  }

  function plaintextWarningText() {
    return 'Privacy: the source JSON lives on your device; this page uses tab memory only and does not upload or persist imported values. Exported JSON is plaintext.';
  }

  function renderProvenance() {
    const sourceLine = defaultsStatusLine();
    provenanceSource.textContent = sourceLine;
    const shortSource = defaultsState.status === 'loaded'
      ? sourceLine.replace(/^Inputs: /, '')
      : sourceLine;
    const sourceSummary = document.getElementById('source-summary');
    const provenanceSummary = document.getElementById('provenance-summary');
    if (sourceSummary) sourceSummary.textContent = shortSource;
    if (provenanceSummary) provenanceSummary.textContent = defaultsState.status === 'loaded' ? 'Household defaults and scenario details' : 'Demo or unavailable household inputs';
    provenanceScenario.textContent = activeScenarioLine();
    provenanceStaleness.textContent = stalenessLine();
    provenanceLedger.textContent = ledgerLine();
    // Rebase: visible consequence before click — no redundant confirm gate.
    const sourced = rebaseSourcedOverrides();
    if (defaultsState.status === 'loaded' && sourced.length) {
      rebaseButton.disabled = false;
      rebaseButton.title = `Replaces ${sourced.length} sourced value(s) (${sourced.join(', ')}) with the household defaults file's current values; keeps your scenario assumptions (returns, withdrawal rate, spending, tax, healthcare, account split, housing).`;
      rebaseButton.textContent = `Rebase ${sourced.length} sourced value(s) to household defaults (keeps assumptions)`;
    } else {
      rebaseButton.disabled = true;
      rebaseButton.title = defaultsState.status === 'loaded'
        ? 'Nothing to rebase — sourced inputs already match the household defaults file.'
        : 'Rebase needs a loaded household defaults file.';
      rebaseButton.textContent = 'Rebase sourced values to household defaults (keeps assumptions)';
    }
  }

  // Sourced fields whose active value differs from the fresh household
  // defaults — exactly what a rebase would change (assumptions excluded).
  function rebaseSourcedOverrides() {
    if (defaultsState.status !== 'loaded') return [];
    const out = [];
    for (const key of Object.keys(state)) {
      if (ASSUMPTION_FIELDS.has(key) || key === 'notes') continue;
      if (!valuesEqual(state[key], householdDefaults[key])) out.push(key);
    }
    return out;
  }

  function rebaseToHouseholdDefaults() {
    if (defaultsState.status !== 'loaded') return;
    const next = { ...householdDefaults };
    // Preserve intentional scenario assumptions (review finding 10): anything
    // the user or scenario deliberately set in an assumption field stays.
    for (const key of ASSUMPTION_FIELDS) {
      if (state[key] !== undefined) next[key] = state[key];
    }
    // Scenario notes stay with the active scenario: a rebase refreshes sourced
    // household facts, it does not swap the household narrative in under a
    // scenario that carries its own caveats (finding 10).
    const winning = scenarioState.hash || scenarioState.stored;
    if (winning && Array.isArray(winning.scenario.notes)) next.notes = winning.scenario.notes;
    state = next;
    userEdited = false;
    editedFields.clear();
    // persistState re-saves this state immediately; mirror the envelope so the
    // banner describes what is actually stored now (the stale payload is gone).
    scenarioState = {
      stored: {
        schemaVersion: CoastFireModel.SCENARIO_SCHEMA_VERSION,
        savedAt: new Date().toISOString(),
        scenario: state,
        legacy: false,
      },
      hash: scenarioState.hash,
    };
    populateForm();
    render();
  }

  // --- Rendering -------------------------------------------------------------------

  function setText(id, value) { document.getElementById(id).textContent = value; }

  function setExportEnabled(enabled) {
    const why = 'Fix the invalid inputs to enable export';
    for (const button of [exportButton]) {
      button.disabled = !enabled;
      button.title = enabled ? '' : why;
    }
  }

  function fieldHasEntry(name) {
    const input = fields.find(field => field.dataset.field === name);
    return Boolean(input && String(input.value).trim() !== '');
  }

  function moneyEntry(name) {
    const value = state[name];
    return Number.isFinite(value) ? money.format(value) : 'invalid or missing';
  }

  function updateDisclosureSummaries() {
    const replacementFields = document.getElementById('replacement-housing-fields');
    if (replacementFields) replacementFields.classList.toggle('is-hidden', state.housingScenario?.mode !== 'both-units-rented');
    const account = document.getElementById('account-details-summary');
    const taxable = state.investmentsTaxableAccessible;
    const pretax = state.investmentsTaxAdvantagedPreAccess;
    const roth = state.investmentsRothOrBasis;
    if (account) {
      const split = [taxable, pretax, roth].filter(Number.isFinite);
      account.textContent = split.length ? `Declared split: ${money.format(split.reduce((a, b) => a + b, 0))}` : 'Optional — add a split to check the bridge';
    }
    const work = document.getElementById('work-cash-details-summary');
    if (work) {
      const incomeEntered = fieldHasEntry('workIncomeAnnual');
      const spendingEntered = fieldHasEntry('coastPeriodSpendingAnnual');
      work.textContent = incomeEntered && spendingEntered
        ? `Income ${moneyEntry('workIncomeAnnual')} · spending ${moneyEntry('coastPeriodSpendingAnnual')}`
        : incomeEntered || spendingEntered ? 'Incomplete — enter both income and spending' : 'Optional — not assessed';
    }
    const spending = document.getElementById('spending-details-summary');
    if (spending) {
      const entries = ['retirementTaxAllowance', 'propertyOperationsAnnual', 'savingsTransfersAnnual'].filter(fieldHasEntry);
      spending.textContent = entries.length
        ? entries.map(name => `${name === 'retirementTaxAllowance' ? 'Tax' : name === 'propertyOperationsAnnual' ? 'Property memo' : 'Transfers memo'} ${moneyEntry(name)}`).join(' · ')
        : 'No additional allowance or memo entered';
    }
    const legacy = document.getElementById('legacy-benefit-details-summary');
    if (legacy) {
      const legacyEntered = fieldHasEntry('socialSecurityAnnual') || fieldHasEntry('socialSecurityClaimingAge');
      const memberTiming = fieldHasEntry('member1ClaimingAge') || fieldHasEntry('member2ClaimingAge');
      legacy.textContent = memberTiming
        ? (legacyEntered ? 'Ignored while a member claiming age is entered' : 'Inactive — per-member timing is in use')
        : legacyEntered ? `Combined ${moneyEntry('socialSecurityAnnual')} · claim age ${state.socialSecurityClaimingAge ?? 'missing'}` : 'Use only when both member claiming ages are empty';
    }
    const rental = document.getElementById('rental-details-summary');
    if (rental) {
      const entries = ['rentGrowthReal', 'propertyReserve', 'propertyCapitalEventOneTime', 'ownerUtilitiesMonthly', 'homeValue'].filter(fieldHasEntry);
      rental.textContent = entries.length
        ? entries.map(name => {
          if (name === 'rentGrowthReal') return `Growth ${Number.isFinite(state[name]) ? `${oneDecimal.format(state[name] * 100)}% real` : 'invalid'}`;
          const label = name === 'propertyReserve' ? 'Reserve' : name === 'propertyCapitalEventOneTime' ? 'Stress event' : name === 'ownerUtilitiesMonthly' ? 'Utilities' : 'Home value';
          return `${label} ${moneyEntry(name)}`;
        }).join(' · ')
        : 'No added reserve, stress event, or home-value context';
    }
  }

  function revealDetailsForError() {
    for (const id of ['account-details', 'work-cash-details', 'spending-details', 'legacy-benefit-details', 'rental-details', 'schedule-details', 'assumptions-details', 'provenance']) {
      const details = document.getElementById(id);
      if (details) details.open = true;
    }
    if (typeof errorBox.focus === 'function') errorBox.focus();
  }

  function invalidateOutputs(message) {
    errorBox.textContent = message;
    errorBox.style.display = 'block';
    revealDetailsForError();
    updateDisclosureSummaries();
    for (const id of STATUS_CARDS) {
      const card = document.getElementById(id);
      card.classList.remove('good');
      card.classList.add('invalid');
    }
    setText('adjusted-status', 'Inputs invalid');
    setText('strict-status', 'Inputs invalid');
    setText('adjusted-gap', '—');
    setText('strict-gap', '—');
    for (const id of RESULT_TEXT_IDS) setText(id, '—');
    for (const prefix of ['adjusted', 'strict']) {
      document.getElementById(`${prefix}-bar`).style.width = '0%';
      setText(`${prefix}-ratio`, 'Inputs invalid');
    }
    resultWarningsBox.style.display = 'none';
    resultWarningsList.replaceChildren();
    const bridgeBox = document.getElementById('bridge-summary');
    bridgeBox.textContent = '';
    bridgeBox.style.display = 'none';
    document.getElementById('schedule-table').replaceChildren();
    setText('assumptions-line', '');
    setExportEnabled(false);
    resultIsValid = false;
  }

  function setStatus(prefix, current, needed) {
    const reached = current >= needed;
    const gap = current - needed;
    const card = document.getElementById(`${prefix}-status-card`);
    card.classList.toggle('good', reached);
    card.classList.remove('invalid');
    // Badges qualify what they mean; "Reached"/"Safe" alone overclaim (finding 7).
    setText(`${prefix}-status`, reached ? 'Meets deterministic assumptions' : 'Does not meet assumptions');
    setText(
      `${prefix}-gap`,
      needed <= 0
        ? 'Modeled target is $0 — see the warnings below'
        : reached
          ? `${money.format(gap)} above the line`
          : `${money.format(Math.abs(gap))} to go`,
    );
  }

  function setBar(prefix, current, needed) {
    const ratio = needed <= 0 ? 1 : current / needed;
    document.getElementById(`${prefix}-bar`).style.width = `${Math.max(0, Math.min(100, ratio * 100))}%`;
    setText(
      `${prefix}-ratio`,
      needed <= 0
        ? 'No modeled portfolio need — verify the offsets'
        : `${oneDecimal.format(ratio * 100)}%`,
    );
  }

  function activeNotesSource() {
    // CF-05 (review finding 10): scenario notes follow the ACTIVE scenario.
    // A saved/URL scenario carries its own notes; household defaults notes
    // only apply when the defaults themselves are the active scenario.
    const { stored, hash } = scenarioState;
    const winning = hash || stored;
    if (winning && Array.isArray(winning.scenario.notes)) {
      const when = winning.savedAt ? winning.savedAt.slice(0, 10) : 'unknown time';
      return { notes: winning.scenario.notes, label: hash ? 'from the active scenario (scenario URL)' : `from the active scenario (saved ${when})` };
    }
    return { notes: Array.isArray(householdDefaults.notes) ? householdDefaults.notes : [], label: 'from the household defaults file' };
  }

  function renderNotes() {
    const list = document.getElementById('notes');
    list.replaceChildren();
    const { notes, label } = activeNotesSource();
    const sourceItem = document.createElement('li');
    sourceItem.textContent = `Notes shown: ${label} — notes do not silently follow the household file when a different scenario is active.`;
    list.appendChild(sourceItem);
    const staticNotes = [
      'The portfolio-only result is a benchmark for the ENTERED spending: it deliberately ignores the tax allowance, Social Security, rent, home equity, healthcare phases, and the property module; it compounds annually and is the auditable cross-check.',
      'The household result runs a month-indexed timeline to the horizon age: each benefit starts only at its own claiming age, the mortgage pays its actual scheduled amount until payoff, and fixed payments are deflated by the inflation input.',
      'The household funding target is a finite real-dollar floor: every modeled monthly draw through the selected horizon, plus the explicit terminal portfolio balance, is discounted month by month. The withdrawal rate applies only to the separate portfolio-only perpetual benchmark. "Meets deterministic assumptions" means today\'s assets, with no further contributions, clear every modeled floor — not a probability of success and not proof that work can stop.',
      'Spending, contributions, rent, and accepted benefit estimates are today\'s dollars: rent always grows with inflation, plus any real (above-inflation) growth entered. Mortgage terms are nominal and deflated into the real timeline. A benefit is credited only when its ledger entry explicitly says today-dollar; future-dollar, missing, or malformed dollar bases are withheld rather than converted or guessed.',
      'The spending worksheet separates consumption, personal housing, and healthcare phases (pre/at Medicare 65); savings/transfers and property operating costs charged to the rental module are excluded from the total, so each property expense is counted exactly once. The tax allowance is added separately at the funding floor.',
      'Tax honesty: the allowance is one flat user-entered number (no tax engine); rental cash flow is a cash offset, not taxable rental profit; pretax and Roth balances are not treated as equivalent after tax; the account split flags bridge accessibility without evaluating early-distribution exceptions or applying any penalty.',
      'The both-units-rented scenario requires replacement housing to be named, priced (a zero rent must be justified), dated, and its moving costs entered; the default scenario keeps the household in its own unit with carrying costs in the property module.',
      'Returns are real, compounded monthly, and assumed net of investment fees; enter a net-of-fee return. Deterministic stress cases are scenario comparisons, not forecasts or a probability of success. A zero portfolio need never means no emergency/property reserve or no risk.',
      'Survivor cases require an explicit named member, individual annual benefit, claiming age, and household spending assumption; the calculator never carries both benefits forward after a death or invents a survivor amount. It is a standalone survivor-income sensitivity, not a mortality-timing or benefit-election engine.',
      'Not modeled here: a tax engine, per-member stop-work dates, rental turnover and market-rent resets (grown rent compounds smoothly and is never reset to a fresh market rent between tenants), sequence-of-returns risk, and calendar dates (the schedule is dated by age; a calendar year would need a birth year the model does not invent).',
    ];
    for (const note of [...notes, ...staticNotes]) {
      const item = document.createElement('li');
      item.textContent = note;
      list.appendChild(item);
    }
  }

  function renderResultWarnings(warnings) {
    resultWarningsList.replaceChildren();
    for (const warning of warnings || []) {
      const item = document.createElement('li');
      item.textContent = warning.message;
      resultWarningsList.appendChild(item);
    }
    resultWarningsBox.style.display = (warnings || []).length ? 'block' : 'none';
  }

  const MEMBER_LABELS = { member1: 'Member 1', member2: 'Member 2', combined: 'Combined' };

  // CF-04 (plan §4): the tax allowance, account access, and housing scenario
  // are decision inputs, so their state renders as a result row, not a footer.
  function taxAllowanceLineText(spending) {
    return spending.taxAllowance.declared
      ? `${money.format(spending.taxAllowance.annual)}/yr entered`
      : 'Not entered — no tax modeled';
  }

  function accessLineText(access) {
    if (access.status === 'unassessed-no-split') return 'Not assessed — balance not split by access category';
    if (access.status === 'unassessed-no-access-age') return 'Not assessed — no access age declared';
    if (access.status === 'not-needed') return 'No reliance before access — nothing to check';
    if (access.status === 'ok') {
      return `Covered — ${money.format(access.preAccess.drawsTotal)} needed before age ${access.accessAge} vs ${money.format(access.preAccess.accessibleDeclared)} accessible`;
    }
    return `Shortfall ${money.format(access.preAccess.shortfall)} — access strategy required`;
  }

  function housingLineText(housing, rental) {
    if (housing.mode === 'both-units-rented') {
      const replacement = housing.replacement;
      const rentPhrase = replacement.monthly > 0
        ? `${money.format(replacement.monthly)}/mo from age ${oneDecimal.format(replacement.startAge)}`
        : `$0/mo from age ${oneDecimal.format(replacement.startAge)} (justified)`;
      const movingPhrase = replacement.movingCostsOneTime > 0 ? ` · ${money.format(replacement.movingCostsOneTime)} one-time` : '';
      return `Both units rented · ${rentPhrase}${movingPhrase}`;
    }
    return rental.label || 'Occupied unit retained; carrying costs in the property module';
  }

  function renderResults(state, result) {
    setStatus('adjusted', state.currentInvestments, result.incomeAdjusted.coastNumberNow);
    setStatus('strict', state.currentInvestments, result.portfolioOnly.coastNumberNow);
    setText('projected-portfolio', money.format(result.projectedPortfolioAtRetirement));
    setText('contribution-detail', result.contributionMonths ? `Includes ${oneDecimal.format(result.contributionMonths / 12)} years of contributions` : 'Assumes no further contributions');

    if (result.mortgage.nonAmortizing) {
      setText('payoff-age', 'Never amortizes (payment ≤ interest)');
    } else if (result.mortgage.startingBalance === 0) {
      setText('payoff-age', 'Paid off');
    } else if (result.mortgage.payoffMonthsTotal) {
      setText('payoff-age', `Age ${oneDecimal.format(state.currentAge + result.mortgage.payoffMonthsTotal / 12)}`);
    } else {
      setText('payoff-age', 'Not amortized within 100 years of payments');
    }
    setText('mortgage-balance-retirement', `${money.format(result.mortgage.balanceAfterMonths)} nominal left at retirement`);

    setText('adjusted-coast-number', money.format(result.incomeAdjusted.coastNumberNow));
    setText('strict-coast-number', money.format(result.portfolioOnly.coastNumberNow));
    setText('adjusted-retirement-target', money.format(result.incomeAdjusted.targetAtRetirement));
    setText('annual-portfolio-need', money.format(result.incomeAdjusted.annualPortfolioNeed));
    setText('tax-allowance-line', taxAllowanceLineText(result.spending));
    setText('account-access-line', accessLineText(result.accountAccess));
    setText('housing-scenario-line', housingLineText(result.housing, result.rental));
    const ss = result.socialSecurity;
    if (ss.unknownTiming) {
      setText('effective-ss', 'Not credited — no claiming age entered');
    } else if (ss.creditedAnnualAfterHaircutReal > 0) {
      setText('effective-ss', `${money.format(ss.creditedAnnualAfterHaircutReal)}/yr at claiming ages`);
    } else {
      setText('effective-ss', '$0/yr — no benefits entered');
    }
    setText('benefit-starts', ss.streams.length
      ? ss.streams.map(s => `${MEMBER_LABELS[s.source]}: age ${oneDecimal.format(s.startAge)} (month ${s.claimingMonth})`).join(' · ')
      : 'Not entered');
    setText('net-rent', `${money.format(result.rental.monthlyNetAtRetirement)}/mo`);
    setText('net-rent-after-payoff', `${money.format(result.rental.monthlyNetAtSettlement)}/mo`);
    setText('mortgage-at-retirement', `${money.format(result.mortgage.balanceAfterMonths)} (nominal)`);
    setText('home-equity', `${money.format(Math.max(0, state.homeValue - state.mortgagePrincipal))} (excluded)`);
    const status = result.status;
    setText('coast-now-line', status.isCoastNow ? 'Yes — current investable assets clear every floor with no further contributions' : 'No — contributions are still needed under this deterministic model');
    setText('on-track-line', status.onTrackWithContributions
      ? `${money.format(status.onTrackGap)} above the retirement floor on the selected contribution schedule`
      : `${money.format(Math.abs(status.onTrackGap))} short at retirement on the selected contribution schedule`);
    setText('earliest-coast-line', status.earliestModeledCoastAge === null
      ? `Not reached within modeled horizon (age ${oneDecimal.format(result.timeline.horizonAge)})`
      : `Age ${oneDecimal.format(status.earliestModeledCoastAge)} on the selected schedule`);
    const cash = status.cashFlowFeasibleWhileCoasting;
    setText('coast-cash-flow-line', cash.status === 'unassessed'
      ? 'Not assessed — enter both work income and coast-period spending'
      : cash.status === 'feasible'
        ? `Feasible by ${money.format(cash.annualSurplus)}/yr in the simple cash screen`
        : `Shortfall ${money.format(Math.abs(cash.annualSurplus))}/yr in the simple cash screen`);
    setBar('adjusted', state.currentInvestments, result.incomeAdjusted.coastNumberNow);
    setBar('strict', state.currentInvestments, result.portfolioOnly.coastNumberNow);
  }

  function renderBridge(result) {
    const box = document.getElementById('bridge-summary');
    const bridge = result.incomeAdjusted.bridge;
    if (!bridge) {
      box.textContent = '';
      box.style.display = 'none';
      return;
    }
    box.textContent = `Bridge: ${bridge.months} months (age ${oneDecimal.format(bridge.startAge)} → ${oneDecimal.format(bridge.endAge)}) with no benefit yet — portfolio draw needed: ${money.format(bridge.portfolioDrawTotal)} in today's dollars (${money.format(bridge.presentValueAtRetirement)} discounted to retirement). After benefits begin: ${money.format(result.incomeAdjusted.annualPortfolioNeed)}/yr.`;
    box.style.display = 'block';
  }

  function renderSchedule(result) {
    const table = document.getElementById('schedule-table');
    table.replaceChildren();
    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const label of ['Age', 'Spending/mo', 'Healthcare/mo', 'Tax/mo', 'Repl. rent/mo', 'Benefits/mo', 'Net rent/mo', 'Mortgage pmt (nominal)', 'Draw/mo', 'Required floor', 'Coast balance', 'With contributions']) {
      const th = document.createElement('th');
      th.textContent = label;
      headRow.appendChild(th);
    }
    head.appendChild(headRow);
    table.appendChild(head);
    const body = document.createElement('tbody');
    const stopWorkMonth = result.timeline.stopWorkMonth;
    // One row per modeled year after stop-work (plus the final modeled month);
    // the JSON export carries the full monthly schedule.
    const rows = result.timeline.months.filter(row => row.month > stopWorkMonth
      && ((row.month - stopWorkMonth - 1) % 12 === 0 || row.month === result.timeline.months.length));
    for (const row of rows) {
      const tr = document.createElement('tr');
      for (const value of [
        oneDecimal.format(row.age),
        money.format(row.spendingMonthly),
        money.format(row.healthcareMonthlyReal),
        money.format(row.taxAllowanceMonthlyReal),
        money.format(row.replacementHousingMonthlyReal),
        money.format(row.benefitsMonthlyReal),
        money.format(row.rentalNetMonthlyReal),
        money.format(row.mortgagePaymentNominal),
        money.format(row.portfolioDrawMonthly),
        money.format(row.requiredFloorAfterMonth),
        money.format(row.coastBalance),
        money.format(row.projectedBalance),
      ]) {
        const td = document.createElement('td');
        td.textContent = value;
        tr.appendChild(td);
      }
      body.appendChild(tr);
    }
    table.appendChild(body);
  }

  function renderAssumptions(result) {
    const a = result.assumptions;
    const rentGrowthPhrase = a.rentGrowthReal
      ? ` plus ${oneDecimal.format(a.rentGrowthReal * 100)}%/yr above inflation`
      : '';
    const taxPhrase = a.taxAllowance.declared
      ? `tax allowance ${money.format(a.taxAllowance.annual)}/yr entered`
      : 'no income-tax allowance modeled';
    const healthcarePhrase = a.healthcarePhases.modeled
      ? `healthcare phased at Medicare ${a.healthcarePhases.medicareAge}`
      : 'healthcare unchanged inside entered spending';
    const housingPhrase = a.housingMode === 'both-units-rented'
      ? 'both units rented with named replacement housing'
      : 'household occupies its own unit';
    setText('assumptions-line', `Modeled through age ${oneDecimal.format(a.horizonAge)} — a terminal planning assumption, not a life-expectancy estimate · inflation ${oneDecimal.format(a.inflationRate * 100)}% (nominal return equivalent ${oneDecimal.format(a.nominalReturnAnnual * 100)}%) · spending, rent, and contributions in today's dollars, compounded monthly · rent grows with inflation${rentGrowthPhrase} · mortgage terms nominal, deflated by inflation · benefits entered at each claiming age, level in today's dollars after claiming · ${taxPhrase} · ${healthcarePhrase} · ${housingPhrase}.`);
  }

  function persistState() { /* Static build: no browser storage. */ }

  function render() {
    state = readForm();
    let result = null;
    try {
      result = CoastFireModel.calculateCoastFire(state);
    } catch (error) {
      invalidateOutputs(error.message);
      return;
    }
    errorBox.style.display = 'none';
    errorBox.textContent = '';
    for (const id of STATUS_CARDS) document.getElementById(id).classList.remove('invalid');
    renderResults(state, result);
    updateDisclosureSummaries();
    renderBridge(result);
    renderSchedule(result);
    renderAssumptions(result);
    renderResultWarnings(result.warnings);
    renderProvenance();
    setExportEnabled(true);
    resultIsValid = true;
    persistState();
  }

  // --- Actions -----------------------------------------------------------------------

  function applyScenario(name) {
    if (name === 'base') {
      state = { ...householdDefaults };
      editedFields.clear();
      userEdited = false;
      // Reset removes the active scenario layers entirely: notes, override
      // lists, and staleness all return to the household defaults (finding
      // 10). persistState then overwrites the saved envelope with these
      // defaults, so the stale scenario cannot survive a reload either.
      scenarioState = { stored: null, hash: null };
    }
    if (name === 'strict') state = { ...state, socialSecurityAnnual: 0, member1AnnualBenefit: 0, member2AnnualBenefit: 0, grossRentMonthly: 0 };
    // CF-04 (plan §4): the preset only switches the housing mode — no
    // hard-coded rent or management rate. Replacement housing must be
    // entered (and named) by the user, so a free-housing assumption can
    // never hide inside a preset.
    if (name === 'both-units') state = { ...state, housingScenario: { mode: 'both-units-rented' } };
    populateForm();
    renderNotes();
    render();
  }

  function downloadJson() {
    if (!resultIsValid) return; // invalid inputs must not export
    const exported = CoastFireModel.buildCoastFireExport(readForm());
    const blob = new Blob([`${JSON.stringify(exported, null, 2)}\n`], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `coast-fire-${exported.generatedAt.slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  async function importLocalFile(file) {
    if (!file) return;
    try {
      if (file.size > 256 * 1024) throw new Error('File too large (256 KB limit). Nothing was imported.');
      const parsed = CoastFireImport.parseImportedProfile(await file.text());
      // Validate the completed input before replacing any visible values.
      const next = { ...fallbackDefaults, ...parsed.inputs };
      CoastFireModel.validateCoastFireInput(next);
      householdDefaults = next;
      defaultsState = { status: 'loaded' };
      provenanceState = { status: 'loaded', payload: {
        source: 'local-import', schema: parsed.format === 'flat' ? 1 : 2,
        schemaLabel: parsed.format === 'flat' ? 'v1 flat profile' : 'v2 scenario',
        asOf: parsed.asOf,
      } };
      scenarioState = { stored: null, hash: null };
      state = { ...next };
      userEdited = false;
      editedFields.clear();
      payloadNotice.style.display = 'none';
      payloadNotice.textContent = '';
      renderDefaultsBanner();
      populateForm();
      renderNotes();
      render();
    } catch (error) {
      showPayloadNotice(`Import failed: ${error.message}`);
    }
  }

  async function initialize() {
    storageReadProblem = null;
    storageWriteProblem = null;
    userEdited = false;
    editedFields.clear();
    payloadNotice.textContent = '';
    payloadNotice.style.display = 'none';
    await Promise.all([loadDefaults(), loadProvenance()]);

    const stored = readStoredScenario();
    const hash = readHashScenario();
    if (hash.error) showPayloadNotice(hash.error);
    scenarioState = {
      stored: stored || null,
      hash: hash && hash.scenario ? hash : null,
    };

    state = {
      ...householdDefaults,
      ...(scenarioState.stored ? scenarioState.stored.scenario : {}),
      ...(scenarioState.hash ? scenarioState.hash.scenario : {}),
    };

    // Reject (never coerce) malformed saved/URL values before the form's
    // number inputs can sanitize them away into zeros.
    try {
      CoastFireModel.validateCoastFireInput(state);
    } catch (error) {
      const source = scenarioState.hash ? 'the saved scenario or the scenario URL' : 'the saved scenario in this browser';
      showPayloadNotice(`A value from ${source} was rejected and is not applied: ${error.message} Edit the inputs or reset to household defaults.`);
    }

    populateForm();
    renderNotes();
    render();
  }

  for (const input of fields) input.addEventListener('input', () => {
    userEdited = true;
    editedFields.add(input.dataset.field);
    if (WORKSHEET_SUM_FIELDS.includes(input.dataset.field)) syncWorksheetTotal();
    render();
  });
  for (const button of document.querySelectorAll('[data-help-target]')) button.addEventListener('click', () => {
    const copy = document.getElementById(button.dataset.helpTarget);
    if (!copy) return;
    const expanded = button.getAttribute('aria-expanded') === 'true';
    button.setAttribute('aria-expanded', String(!expanded));
    copy.hidden = expanded;
    copy.classList.toggle('is-open', !expanded);
  });
  for (const button of document.querySelectorAll('[data-scenario]')) button.addEventListener('click', () => applyScenario(button.dataset.scenario));
  document.getElementById('reset').addEventListener('click', () => applyScenario('base'));
  rebaseButton.addEventListener('click', rebaseToHouseholdDefaults);
  document.getElementById('export-json').addEventListener('click', downloadJson);
  document.getElementById('import-json').addEventListener('change', event => {
    importLocalFile(event.target.files[0]);
    event.target.value = '';
  });
  rebaseButton.style.display = 'none';
  initialize();
})();
