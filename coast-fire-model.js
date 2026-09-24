(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CoastFireModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // --- Shared validation schema (plan §5, review finding 8) -----------------
  // One finite-number/schema path used identically by the form's input
  // handler, JSON import (browser storage / scenario URL), household defaults,
  // the CLI (scripts/coast-fire-json.js), and buildCoastFireExport.
  // It rejects malformed values with a status/message; it never silently
  // coerces them to zero. Modeled rental cash flow is a result, not an input,
  // so a legitimate negative calculated rent is not rejected here.
  //
  // CF-03 adds: horizonAge (§2.1), inflationRate (§2.3), and Social Security
  // claiming ages (§2.4: combined + per member). All are optional with
  // documented defaults so legacy profiles still load; each documented
  // default is surfaced as a visible warning, never applied silently.
  // CF-09 adds: rentGrowthReal (§2.3.1) — annual rent growth ABOVE inflation,
  // optional with documented default 0 (a constant today's-dollar rent already
  // grows with inflation), so existing profiles load and compute unchanged.
  // CF-04 adds (plan §4, findings 4–5): the spending worksheet components, the
  // floor-level retirementTaxAllowance, healthcare phases around Medicare
  // eligibility, the account split by tax/access category, and the housing
  // scenario object. All are optional; absent fields keep legacy profiles
  // computing bit-for-bit unchanged, and every documented default or missing
  // fact is surfaced as a visible disclosure — unknown stays unknown.

  const AGE_MIN = 18;
  const AGE_MAX = 100;
  const HORIZON_AGE_MAX = 120; // permits a positive terminal month after a late stop-work age
  const MODELED_DURATION_CAP_YEARS = 100; // structural loop cap independent of field age bounds
  const MORTGAGE_MONTHS_CAP = 1200; // 100 years of monthly amortization, loop protection
  // SSA retirement-benefit claiming window, re-verified directly against
  // ssa.gov (Retirement Age and Benefit Reduction,
  // ssa.gov/benefits/retirement/planner/agereduction.html, checked 2026-09-23):
  // benefits can start as early as 62 and delayed-retirement credits stop at
  // 70. The model enforces this window but never computes a benefit amount:
  // the entered amount is the household's own estimate at the chosen claiming
  // age (early-claiming reduction and delayed credits are baked into that
  // estimate, not recomputed here — the haircut input stays a separate,
  // explicitly labeled policy-risk assumption).
  const CLAIMING_AGE_MIN = 62;
  const CLAIMING_AGE_MAX = 70;
  // Documented default terminal age for the plan horizon (plan §2.1 "default
  // suggestion only — never invented from personal data"): a fixed generic
  // constant, applied with a visible warning whenever it is used.
  const DEFAULT_HORIZON_AGE = 95;

  // Medicare eligibility generally begins at 65 (medicare.gov, "Prepare to
  // sign up", checked 2026-09-23; review [S6]). CF-04 uses it only as the
  // healthcare-phase boundary the user enters amounts for — the model never
  // computes premiums, benefits, or enrollment rules.
  const MEDICARE_AGE = 65;
  // Spending worksheet (plan §4): these four components decompose the entered
  // retirementSpendingAnnual, so they are all-or-nothing and the three sum
  // components must reconcile with the entered total exactly.
  const WORKSHEET_SUM_KEYS = ['consumptionAnnual', 'personalHousingAnnual', 'healthcarePreMedicareAnnual', 'healthcarePostMedicareAnnual'];
  // Account split (plan §4): three tax/access categories that must be entered
  // together and sum to currentInvestments. A partial split could equate
  // locked money with spendable money, so it is rejected rather than guessed.
  const ACCOUNT_SPLIT_KEYS = ['investmentsTaxableAccessible', 'investmentsTaxAdvantagedPreAccess', 'investmentsRothOrBasis'];
  const HOUSING_SCENARIO_MODES = ['occupied-retained', 'both-units-rented'];
  const HOUSING_SCENARIO_KEYS = ['mode', 'replacementHousingAssumption', 'replacementHousingMonthly', 'replacementHousingStartAge', 'movingCostsOneTime', 'replacementHousingJustification'];

  // required: a missing/null/empty field is an error, not a zero.
  // Optional numeric fields have a documented default of 0 (scenario add-ons);
  // they are still type/bounds-checked whenever present. Claiming-age fields
  // are optional: absent normalizes to 0 = "not declared" (a literal 0 fails
  // the 62–70 bound, so 0 after normalization unambiguously means no claiming
  // age was entered).
  const NUMERIC_INPUT_RULES = {
    currentAge: { required: true, min: AGE_MIN, max: AGE_MAX, unit: 'years' },
    coastAge: { required: true, min: AGE_MIN, max: AGE_MAX, unit: 'years' },
    retirementAge: { required: true, min: AGE_MIN, max: AGE_MAX, unit: 'years' },
    horizonAge: { min: AGE_MIN, max: HORIZON_AGE_MAX, unit: 'years' },
    // Finite-horizon terminal portfolio in today's dollars. It is intentionally
    // separate from the withdrawal-rate benchmark: zero means no bequest floor.
    terminalBalanceTarget: { min: 0 },
    currentInvestments: { required: true, min: 0 },
    annualContributions: { required: true, min: 0 },
    realReturn: { required: true, min: -1, exclusiveMin: true, max: 1 },
    inflationRate: { min: 0, max: 1 },
    withdrawalRate: { required: true, min: 0, exclusiveMin: true, max: 1 },
    retirementSpendingAnnual: { required: true, min: 0 },
    socialSecurityAnnual: { min: 0 },
    socialSecurityHaircut: { min: 0, max: 1 },
    socialSecurityClaimingAge: { min: CLAIMING_AGE_MIN, max: CLAIMING_AGE_MAX, claimingWindow: true },
    member1ClaimingAge: { min: CLAIMING_AGE_MIN, max: CLAIMING_AGE_MAX, claimingWindow: true },
    member1AnnualBenefit: { min: 0 },
    member2ClaimingAge: { min: CLAIMING_AGE_MIN, max: CLAIMING_AGE_MAX, claimingWindow: true },
    member2AnnualBenefit: { min: 0 },
    mortgagePrincipal: { min: 0 },
    mortgageRate: { min: 0, max: 1 },
    mortgagePrincipalInterestMonthly: { min: 0 },
    extraPrincipalMonthly: { min: 0 },
    escrowMonthly: { min: 0 },
    grossRentMonthly: { min: 0 },
    // Annual rent growth above inflation (§2.3.1): negative = rent lags
    // inflation, positive = local market escalation. Same wider bound as
    // realReturn — a rate of −1 would zero the rent and below −1 is
    // nonsensical (sign-flipping compounding).
    rentGrowthReal: { min: -1, exclusiveMin: true, max: 1 },
    managementRate: { min: 0, max: 1 },
    vacancyRate: { min: 0, max: 1 },
    maintenanceRate: { min: 0, max: 1 },
    ownerUtilitiesMonthly: { min: 0 },
    homeValue: { min: 0 },
    // --- CF-04 (plan §4): spending worksheet, tax allowance, account split ----
    // The worksheet components decompose retirementSpendingAnnual; the tax
    // allowance is a separate floor-level annual amount (never negative);
    // the memos are informational and excluded from the funding math.
    retirementTaxAllowance: { min: 0 },
    consumptionAnnual: { min: 0 },
    personalHousingAnnual: { min: 0 },
    healthcarePreMedicareAnnual: { min: 0 },
    healthcarePostMedicareAnnual: { min: 0 },
    propertyOperationsAnnual: { min: 0 },
    savingsTransfersAnnual: { min: 0 },
    investmentsTaxableAccessible: { min: 0 },
    investmentsTaxAdvantagedPreAccess: { min: 0 },
    investmentsRothOrBasis: { min: 0 },
    taxAdvantagedAccessAge: { min: AGE_MIN, max: AGE_MAX, unit: 'years' },
    // CF-06: optional work-period facts. Absent remains explicitly unassessed;
    // these inputs are not a wage/tax engine.
    workIncomeAnnual: { min: 0 },
    coastPeriodSpendingAnnual: { min: 0 },
    // Property stress inputs are explicit: reserve is an earmark already inside
    // currentInvestments and is excluded once; capital event is one-time.
    propertyReserve: { min: 0 },
    propertyCapitalEventOneTime: { min: 0 },
  };

  const NUMERIC_INPUT_KEYS = Object.freeze(Object.keys(NUMERIC_INPUT_RULES));

  function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function describeValue(value) {
    if (typeof value === 'string') return `string "${value}"`;
    if (value === null) return 'null';
    if (typeof value === 'number') return Number.isNaN(value) ? 'NaN' : `${value}`;
    return typeof value;
  }

  function fieldPresent(input, key) {
    return input[key] !== undefined && input[key] !== null;
  }

  function formatDollars(value) {
    return Math.round(value).toLocaleString('en-US');
  }

  // CF-04 (plan §4, finding 5): the housing scenario object replaces the old
  // hard-coded "both units rented" toggle. Each scenario carries ONE named
  // housing assumption. 'occupied-retained' is the named default: the
  // household occupies its own unit and the property's carrying costs stay in
  // the property module. 'both-units-rented' requires replacement housing to
  // be named, priced, dated, and its moving costs entered — a zero rent must
  // be justified explicitly instead of silently assuming free housing.
  function validateHousingScenario(scenario) {
    if (!isPlainObject(scenario)) {
      throw new TypeError(`housingScenario must be a JSON object (got ${describeValue(scenario)})`);
    }
    for (const key of Object.keys(scenario)) {
      if (!HOUSING_SCENARIO_KEYS.includes(key)) {
        throw new TypeError(`unknown housingScenario field "${key}" (allowed: ${HOUSING_SCENARIO_KEYS.join(', ')})`);
      }
    }
    const mode = scenario.mode;
    if (!HOUSING_SCENARIO_MODES.includes(mode)) {
      throw new TypeError(`housingScenario.mode must be ${HOUSING_SCENARIO_MODES.map(m => `"${m}"`).join(' or ')} (got ${describeValue(mode)})`);
    }
    if (mode === 'occupied-retained') {
      for (const key of HOUSING_SCENARIO_KEYS) {
        if (key !== 'mode' && fieldPresent(scenario, key)) {
          throw new RangeError(`housingScenario.${key} only applies to the "both-units-rented" scenario; remove it or switch the mode`);
        }
      }
      return { mode };
    }
    const assumption = scenario.replacementHousingAssumption;
    if (typeof assumption !== 'string' || assumption.trim() === '') {
      throw new RangeError('housingScenario.replacementHousingAssumption is required for the "both-units-rented" scenario — name the replacement-housing assumption (e.g. "rent a similar apartment nearby")');
    }
    const monthly = scenario.replacementHousingMonthly;
    if (!fieldPresent(scenario, 'replacementHousingMonthly')) {
      throw new RangeError('housingScenario.replacementHousingMonthly is required for the "both-units-rented" scenario (monthly replacement-housing cost; enter 0 only with a justification)');
    }
    if (typeof monthly !== 'number' || !Number.isFinite(monthly)) {
      throw new TypeError(`housingScenario.replacementHousingMonthly must be a finite number (got ${describeValue(monthly)})`);
    }
    if (monthly < 0) throw new RangeError('housingScenario.replacementHousingMonthly cannot be negative');
    const startAge = scenario.replacementHousingStartAge;
    if (!fieldPresent(scenario, 'replacementHousingStartAge')) {
      throw new RangeError('housingScenario.replacementHousingStartAge is required for the "both-units-rented" scenario (the age at which replacement housing starts)');
    }
    if (typeof startAge !== 'number' || !Number.isFinite(startAge)) {
      throw new TypeError(`housingScenario.replacementHousingStartAge must be a finite number (got ${describeValue(startAge)})`);
    }
    if (startAge < AGE_MIN || startAge > AGE_MAX) {
      throw new RangeError(`housingScenario.replacementHousingStartAge must be between ${AGE_MIN} and ${AGE_MAX} years`);
    }
    const moving = scenario.movingCostsOneTime;
    if (!fieldPresent(scenario, 'movingCostsOneTime')) {
      throw new RangeError('housingScenario.movingCostsOneTime is required for the "both-units-rented" scenario (one-time moving costs; enter 0 if there are none)');
    }
    if (typeof moving !== 'number' || !Number.isFinite(moving)) {
      throw new TypeError(`housingScenario.movingCostsOneTime must be a finite number (got ${describeValue(moving)})`);
    }
    if (moving < 0) throw new RangeError('housingScenario.movingCostsOneTime cannot be negative');
    let justification = null;
    if (monthly === 0) {
      const note = scenario.replacementHousingJustification;
      if (typeof note !== 'string' || note.trim() === '') {
        throw new RangeError('housingScenario.replacementHousingJustification is required when replacementHousingMonthly is 0 — free replacement housing must be justified explicitly (e.g. "moving in with family")');
      }
      justification = note.trim();
    } else if (fieldPresent(scenario, 'replacementHousingJustification')) {
      if (typeof scenario.replacementHousingJustification !== 'string') {
        throw new TypeError(`housingScenario.replacementHousingJustification must be a string (got ${describeValue(scenario.replacementHousingJustification)})`);
      }
      justification = scenario.replacementHousingJustification.trim() || null;
    }
    return {
      mode,
      replacementHousingAssumption: assumption.trim(),
      replacementHousingMonthly: monthly,
      replacementHousingStartAge: startAge,
      movingCostsOneTime: moving,
      replacementHousingJustification: justification,
    };
  }

  function boundMessage(key, rule) {
    if (rule.claimingWindow) {
      return `${key} must be between ${CLAIMING_AGE_MIN} and ${CLAIMING_AGE_MAX} (SSA's earliest retirement-benefit claiming age is ${CLAIMING_AGE_MIN} and delayed-retirement credits stop at ${CLAIMING_AGE_MAX})`;
    }
    if (rule.unit === 'years') {
      return `${key} must be between ${AGE_MIN} and ${AGE_MAX} years`;
    }
    if (rule.exclusiveMin) {
      if (key === 'realReturn') return `${key} must be greater than -1 and at most 1 (a fraction, e.g. 0.045 for 4.5%)`;
      if (key === 'rentGrowthReal') return `${key} must be greater than -1 and at most 1 (a fraction; 0 means rent grows with inflation only, e.g. 0.02 for 2%/yr above inflation)`;
      return `${key} must be greater than 0 and at most 1 (a fraction, e.g. 0.04 for 4%)`;
    }
    if (rule.max === 1) return `${key} must be between 0 and 1 (a fraction, e.g. 0.05 for 5%)`;
    return `${key} cannot be negative`;
  }

  function validateCoastFireInput(input) {
    // 1. Root shape: malformed/null/array profiles are rejected, not spread or coerced.
    if (!isPlainObject(input)) {
      throw new TypeError('Coast FIRE input must be a JSON object (scenario, defaults file, or hash payload)');
    }

    // 2. Required fields must be present; null counts as missing.
    for (const key of NUMERIC_INPUT_KEYS) {
      if (NUMERIC_INPUT_RULES[key].required && (input[key] === undefined || input[key] === null)) {
        throw new RangeError(`${key} is required`);
      }
    }

    // 3. Every present known field must be a finite number (no "abc", NaN, Infinity).
    for (const key of NUMERIC_INPUT_KEYS) {
      const value = input[key];
      if (value === undefined || value === null) continue;
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new TypeError(`${key} must be a finite number (got ${describeValue(value)})`);
      }
    }

    // 4. Structural age ordering first (matches the reviewed behaviors).
    if (!(input.retirementAge > input.currentAge)) {
      throw new RangeError('Retirement age must be greater than current age');
    }
    if (!(input.coastAge >= input.currentAge && input.coastAge <= input.retirementAge)) {
      throw new RangeError('Coast age must be between current age and retirement age');
    }
    if (input.horizonAge !== undefined && input.horizonAge !== null
      && !(input.horizonAge > input.retirementAge)) {
      throw new RangeError('Horizon age must be greater than retirement age so the plan includes at least one post-work month');
    }
    // CF-12: the model runs in whole months — monthIndexOf rounds fractional
    // ages to the nearest month boundary — so a horizon that is chronologically
    // after retirement can still round into the retirement month itself and
    // model zero post-work months (a $0 target that reads as green "Coast
    // now"). The effective month index, not the raw age, must move past the
    // stop-work month. (An HTML step attribute cannot guard imported, URL, or
    // CLI values, so this lives in the shared validator.)
    if (input.horizonAge !== undefined && input.horizonAge !== null
      && !(monthIndexOf(input.horizonAge, input.currentAge)
        > monthIndexOf(input.retirementAge, input.currentAge))) {
      throw new RangeError(`Horizon age ${input.horizonAge} rounds to the same model month as retirement age ${input.retirementAge}, leaving zero modeled post-work months; enter a horizon at least one month after retirement (fractional ages round to the nearest month)`);
    }

    // 5. Per-field bounds.
    for (const key of NUMERIC_INPUT_KEYS) {
      const rule = NUMERIC_INPUT_RULES[key];
      const value = input[key];
      if (value === undefined || value === null) continue;
      if (rule.exclusiveMin ? !(value > rule.min) : value < rule.min) throw new RangeError(boundMessage(key, rule));
      if (rule.max !== undefined && value > rule.max) throw new RangeError(boundMessage(key, rule));
    }

    if (input.propertyReserve > input.currentInvestments) {
      throw new RangeError('propertyReserve cannot exceed currentInvestments because it is an earmark excluded from the entered investment total');
    }

    // 5b. Spending worksheet group (plan §4): the four components decompose
    // the entered total, so they are all-or-nothing and the three sum
    // components must reconcile with retirementSpendingAnnual exactly.
    if (WORKSHEET_SUM_KEYS.some(key => fieldPresent(input, key))) {
      const missing = WORKSHEET_SUM_KEYS.filter(key => !fieldPresent(input, key));
      if (missing.length) {
        throw new RangeError(`${WORKSHEET_SUM_KEYS.join(', ')} must be entered together (they decompose retirementSpendingAnnual; missing: ${missing.join(', ')})`);
      }
      const worksheetSum = input.consumptionAnnual + input.personalHousingAnnual + input.healthcarePostMedicareAnnual;
      if (Math.abs(worksheetSum - input.retirementSpendingAnnual) > 0.005) {
        throw new RangeError(`the spending worksheet components (consumptionAnnual ${formatDollars(input.consumptionAnnual)} + personalHousingAnnual ${formatDollars(input.personalHousingAnnual)} + healthcarePostMedicareAnnual ${formatDollars(input.healthcarePostMedicareAnnual)} = ${formatDollars(worksheetSum)}) must sum to retirementSpendingAnnual (${formatDollars(input.retirementSpendingAnnual)})`);
      }
    }

    // 5c. Account split group (plan §4): all three tax/access categories
    // together, summing to the total balance the funding math consumes.
    if (ACCOUNT_SPLIT_KEYS.some(key => fieldPresent(input, key))) {
      const missing = ACCOUNT_SPLIT_KEYS.filter(key => !fieldPresent(input, key));
      if (missing.length) {
        throw new RangeError(`${ACCOUNT_SPLIT_KEYS.join(', ')} must be entered together (they split currentInvestments by tax/access category; missing: ${missing.join(', ')})`);
      }
      const splitSum = input.investmentsTaxableAccessible + input.investmentsTaxAdvantagedPreAccess + input.investmentsRothOrBasis;
      if (Math.abs(splitSum - input.currentInvestments) > 0.01) {
        throw new RangeError(`the account split (taxable-accessible ${formatDollars(input.investmentsTaxableAccessible)} + tax-advantaged ${formatDollars(input.investmentsTaxAdvantagedPreAccess)} + Roth/basis ${formatDollars(input.investmentsRothOrBasis)} = ${formatDollars(splitSum)}) must sum to currentInvestments (${formatDollars(input.currentInvestments)})`);
      }
    }

    // 5d. Housing scenario object (plan §4): validated wholesale, never coerced.
    let housingScenario = null;
    if (fieldPresent(input, 'housingScenario')) {
      housingScenario = validateHousingScenario(input.housingScenario);
      if (housingScenario.mode === 'both-units-rented'
        && housingScenario.replacementHousingStartAge < input.currentAge) {
        throw new RangeError(`housingScenario.replacementHousingStartAge must be at least the current age (${input.currentAge})`);
      }
    }

    // 6. Unbounded durations: never run the simulation loop past the cap.
    const durationYears = (input.horizonAge === undefined || input.horizonAge === null
      ? Math.max(DEFAULT_HORIZON_AGE, input.retirementAge + 1 / 12)
      : input.horizonAge) - input.currentAge;
    if (durationYears > MODELED_DURATION_CAP_YEARS) {
      throw new RangeError(`modeled duration of ${durationYears} years exceeds the ${MODELED_DURATION_CAP_YEARS}-year cap`);
    }

    // 7. Benefit amounts use one unambiguous unit: today's dollars at the
    // chosen claim age. A future-dollar estimate must be converted before it
    // enters this model; accepting both would silently deflate some inputs twice.
    if (fieldPresent(input, 'benefitDollarBasis') && input.benefitDollarBasis !== 'todays-dollars') {
      throw new RangeError('benefitDollarBasis must be "todays-dollars"; convert any future-dollar benefit estimate before entering it');
    }

    // 8. notes, when present, must be an array of strings.
    if (input.notes !== undefined && input.notes !== null) {
      const ok = Array.isArray(input.notes) && input.notes.every(note => typeof note === 'string');
      if (!ok) throw new TypeError('notes must be an array of strings');
    }

    // Normalized copy: optional fields get their documented 0 default here —
    // after validation, so this is a default for an absent field, never a
    // coercion of a malformed value. Unknown keys (asOf, ledger fields) are
    // dropped from the computation input; buildCoastFireExport echoes the
    // original object separately.
    const normalized = { notes: Array.isArray(input.notes) ? [...input.notes] : [] };
    for (const key of NUMERIC_INPUT_KEYS) {
      normalized[key] = input[key] === undefined || input[key] === null ? 0 : input[key];
    }
    normalized.benefitDollarBasis = 'todays-dollars';
    if (housingScenario) normalized.housingScenario = housingScenario;
    return normalized;
  }

  // --- Mortgage simulation (plan §2.2, review finding 2) ----------------------
  //
  // Amortizes through ACTUAL payoff (or the 1200-month cap, loop protection),
  // not just to retirement, and returns the full monthly schedule including
  // the capped final installment. `months` is the reporting window (e.g. to
  // retirement): balanceAfterMonths/paymentAtEnd/payoffMonth keep their v1
  // window semantics, while payoffMonthsTotal/finalPayment/schedule always
  // cover the whole loan. payoffMonth === null now only ever means "not paid
  // off within the modeled window"; a loan that never amortizes has its own
  // flag, and a payoff beyond the cap is flagged by calculateCoastFire.

  function simulateMortgage({ principal, annualRate, principalInterestMonthly, extraPrincipalMonthly, months }) {
    for (const [key, value] of Object.entries({ principal, annualRate, principalInterestMonthly, extraPrincipalMonthly })) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new TypeError(`simulateMortgage: ${key} must be a finite number (got ${describeValue(value)})`);
      }
    }
    if (typeof months !== 'number' || !Number.isFinite(months)) {
      throw new TypeError(`simulateMortgage: months must be a finite number (got ${describeValue(months)})`);
    }

    const startingBalance = Math.max(0, principal);
    const monthlyRate = annualRate / 12;
    const scheduledPayment = Math.max(0, principalInterestMonthly) + Math.max(0, extraPrincipalMonthly);
    const windowMonths = Math.max(0, Math.min(Math.round(months), MORTGAGE_MONTHS_CAP));

    // A payment at or below the first month's interest can never reduce the
    // balance (later months only accrue more interest), so flag it instead of
    // silently growing the debt.
    const nonAmortizing = startingBalance > 0 && scheduledPayment <= startingBalance * monthlyRate;

    const schedule = [];
    let balance = startingBalance;
    let payoffMonthsTotal = startingBalance === 0 ? 0 : null;
    for (let month = 1; month <= MORTGAGE_MONTHS_CAP && balance > 0; month += 1) {
      const interest = balance * monthlyRate;
      const payment = Math.min(balance + interest, scheduledPayment);
      balance = Math.max(0, balance + interest - payment);
      schedule.push({ month, payment, interest, principalPart: payment - interest, endBalance: balance });
      if (balance === 0) { payoffMonthsTotal = month; break; }
    }

    const paidOffByWindow = payoffMonthsTotal !== null && payoffMonthsTotal > 0 && payoffMonthsTotal <= windowMonths;
    let balanceAfterMonths = startingBalance;
    let paymentAtEnd = startingBalance > 0 ? scheduledPayment : 0;
    if (paidOffByWindow) {
      balanceAfterMonths = 0;
      paymentAtEnd = 0;
    } else if (windowMonths > 0 && windowMonths <= schedule.length) {
      balanceAfterMonths = schedule[windowMonths - 1].endBalance;
      paymentAtEnd = scheduledPayment;
    }

    const finalPayment = schedule.length ? schedule[schedule.length - 1].payment : 0;
    const payoffMonth = paidOffByWindow ? payoffMonthsTotal : (payoffMonthsTotal === 0 ? 0 : null);

    return {
      startingBalance,
      scheduledPayment,
      nonAmortizing,
      payoffMonth,
      payoffMonthsTotal,
      balanceAfterMonths,
      paymentAtEnd,
      finalPayment,
      schedule,
    };
  }

  // --- Month-indexed helpers (plan §2.1) --------------------------------------

  // Ages resolve to whole model months: an age X is reached at the END of
  // month round((X − currentAge) × 12), so the first month whose cash flow
  // reflects age X is round((X − currentAge) × 12) + 1 (clamped to 1 for ages
  // already reached). Fractional ages round to the nearest month boundary.
  function monthIndexOf(age, currentAge) {
    return Math.round(age * 12) - Math.round(currentAge * 12);
  }

  // Results must be finite before anything displays or exports them; JSON would
  // otherwise mask Infinity as null and a green badge could rest on it.
  function assertFiniteDeep(value, path) {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new RangeError(`${path} is not a finite number; reduce the input magnitudes (the model will not export or display a non-finite result)`);
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => assertFiniteDeep(item, `${path}[${index}]`));
      return;
    }
    if (isPlainObject(value)) {
      for (const [key, item] of Object.entries(value)) assertFiniteDeep(item, `${path}.${key}`);
    }
  }

  // --- Funding-method core (plan §2.1–2.4, §3) --------------------------------
  //
  // Month-indexed real-dollar cash-flow matching:
  //   1. Timeline of monthly real portfolio draws from stop-work to horizon:
  //      draw = max(0, spending − credited benefits − rental net), where the
  //      rental net carries the ACTUAL scheduled mortgage payment for that
  //      month, deflated to today's dollars (nominal contractual terms).
  //      Before stop-work the draw is 0: living costs are work-income funded
  //      and coast-period feasibility is a later card's question (§6).
  //   2. Settlement month S = the first month at/after stop-work with every
  //      declared benefit started and the mortgage paid off. The settled
  //      steady state collapses to the withdrawal-rate target
  //      T = settledAnnualNeed / withdrawalRate.
  //   3. Required floor at the start of month m: F_m = (draw_m + F_{m+1})
  //      discounted one month at the real return, with F_m = T for m ≥ S.
  //      Finite bridge/mortgage months are explicitly discounted — never a
  //      capitalized annuity over a finite transition — and the settled
  //      steady state uses the v1 spending/withdrawalRate shape.
  //   4. isCoast compares the zero-contribution trajectory against every
  //      monthly floor ("assets alone clear every future floor"), the
  //      semantics the current model already got right, now month-indexed.

  function calculateCoastFire(rawInput) {
    const input = validateCoastFireInput(rawInput);
    const raw = isPlainObject(rawInput) ? rawInput : {};
    // The reserve is an earmark within the entered total, not extra money. It
    // is excluded once from investable assets and remains visibly required.
    const portfolioAssets = input.currentInvestments - input.propertyReserve;
    const warnings = [];

    // --- Conventions, horizon, inflation (plan §2.1, §2.3) -------------------
    const horizonDefaulted = raw.horizonAge === undefined || raw.horizonAge === null;
    const terminalBalanceTargetDefaulted = raw.terminalBalanceTarget === undefined || raw.terminalBalanceTarget === null;
    const inflationDefaulted = raw.inflationRate === undefined || raw.inflationRate === null;
    const horizonAge = horizonDefaulted
      ? Math.min(HORIZON_AGE_MAX, Math.max(DEFAULT_HORIZON_AGE, input.retirementAge + 1 / 12))
      : input.horizonAge;
    const inflationRate = input.inflationRate;
    const nominalReturnAnnual = (1 + input.realReturn) * (1 + inflationRate) - 1;
    if (horizonDefaulted) {
      warnings.push({
        code: 'horizon-age-defaulted',
        message: `No plan-through age (horizon) was provided, so the timeline runs through age ${horizonAge} by default. The horizon is a terminal planning assumption, not a life-expectancy estimate — set it explicitly.`,
      });
    }
    if (terminalBalanceTargetDefaulted) {
      warnings.push({
        code: 'terminal-balance-defaulted',
        message: 'No terminal portfolio target was provided, so the finite-horizon plan requires a $0 ending balance at the selected horizon. Enter a terminal balance target if you intend a bequest or reserve beyond that age.',
      });
    }
    if (inflationDefaulted) {
      warnings.push({
        code: 'inflation-not-specified',
        message: 'No inflation rate was provided, so inflation is modeled at 0%: nominal mortgage payments and claiming-age benefit amounts are not deflated (real equals nominal). Enter an inflation assumption to see the today\'s-dollar value of fixed payments.',
      });
    }

    const yearsToRetirement = input.retirementAge - input.currentAge;
    const monthsToRetirement = Math.max(0, Math.round(yearsToRetirement * 12));
    const monthlyReturn = Math.pow(1 + input.realReturn, 1 / 12) - 1;
    const oneMonthDiscount = 1 / (1 + monthlyReturn);
    // Nominal contractual cash flows are deflated with annual compounding,
    // (1+inflation)^(months/12) — the review's own worked example ($1,000 due
    // 20 years out ≈ $610 today at 2.5%) pins this reading of plan §2.3.
    const deflate = months => Math.pow(1 + inflationRate, months / 12);

    // --- Benefit streams (plan §2.4) -----------------------------------------
    // Precedence: per-member streams > legacy combined amount with a declared
    // combined claiming age > unknown timing (never credited). A benefit is a
    // per-person input already estimated at that claiming age; the model never
    // recomputes it from earnings history and never invents a claiming date.
    const haircut = input.socialSecurityHaircut;
    const memberDefs = [
      { source: 'member1', claimingAge: input.member1ClaimingAge, annualTodayDollars: input.member1AnnualBenefit },
      { source: 'member2', claimingAge: input.member2ClaimingAge, annualTodayDollars: input.member2AnnualBenefit },
    ].filter(def => def.claimingAge >= CLAIMING_AGE_MIN && def.annualTodayDollars > 0);
    const combinedDeclared = input.socialSecurityClaimingAge >= CLAIMING_AGE_MIN;
    if (memberDefs.length && input.socialSecurityAnnual > 0) {
      warnings.push({
        code: 'legacy-combined-benefit-ignored',
        message: `Per-member claiming ages are declared, so the legacy combined Social Security amount ($${Math.round(input.socialSecurityAnnual).toLocaleString('en-US')}/yr) is ignored; the per-member amounts at their own claiming ages are credited instead.`,
      });
    }
    let streams;
    if (memberDefs.length) {
      streams = memberDefs;
    } else if (input.socialSecurityAnnual > 0 && combinedDeclared) {
      streams = [{ source: 'combined', claimingAge: input.socialSecurityClaimingAge, annualTodayDollars: input.socialSecurityAnnual }];
    } else {
      streams = [];
    }
    const benefitsEntered = input.socialSecurityAnnual > 0 || input.member1AnnualBenefit > 0 || input.member2AnnualBenefit > 0;
    if (benefitsEntered && streams.length === 0) {
      warnings.push({
        code: 'benefit-timing-unknown',
        message: 'No Social Security is credited: a benefit amount is entered, but no claiming age is declared. Enter the combined claiming age or per-member claiming ages (the earliest SSA retirement-benefit claiming age is 62; delayed credits stop at 70). Until claiming dates are entered the income-adjusted result excludes benefits entirely and must not be relied on for a stop-work decision.',
      });
    }
    for (const stream of streams) {
      // A benefit starts in the first month whose end-age reaches the
      // claiming age; an already-reached claiming age means it starts now.
      stream.claimingMonth = Math.max(1, monthIndexOf(stream.claimingAge, input.currentAge) + 1);
      stream.startAge = Math.max(input.currentAge, stream.claimingAge);
      stream.annualAfterHaircutTodayDollars = stream.annualTodayDollars * (1 - haircut);
      // The entered amount is an explicit today-dollar estimate at the claiming
      // age. SSA COLAs are represented by keeping purchasing power constant;
      // no nominal-at-claim amount is stored or invented.
      stream.annualAfterHaircutReal = stream.annualTodayDollars * (1 - haircut);
    }
    const creditedAnnualAfterHaircutReal = streams.reduce((sum, s) => sum + s.annualAfterHaircutReal, 0);

    // --- Month indexing (plan §2.1; fractional ages round to months) ---------
    const stopWorkMonth = Math.max(0, monthIndexOf(input.retirementAge, input.currentAge));
    const coastMonth = Math.max(0, monthIndexOf(input.coastAge, input.currentAge));
    const horizonMonths = Math.max(stopWorkMonth, monthIndexOf(horizonAge, input.currentAge));
    // CF-12 invariant: every modeled plan includes at least one post-work
    // month. The shared validator rejects an explicitly entered horizon that
    // rounds into the retirement month; this guards the effective indices the
    // core actually runs on — including the defaulted horizon (the stop-work
    // age plus one month) — so no path can emit a $0 target with no retirement
    // draw and a green Coast-now status.
    if (horizonMonths <= stopWorkMonth) {
      throw new RangeError(`the modeled horizon resolves to month ${horizonMonths}, the same as (or before) the stop-work month ${stopWorkMonth}; the plan needs at least one modeled post-work month — raise the horizon age`);
    }

    // --- Mortgage through actual payoff (plan §2.2) --------------------------
    const mortgage = simulateMortgage({
      principal: input.mortgagePrincipal,
      annualRate: input.mortgageRate,
      principalInterestMonthly: input.mortgagePrincipalInterestMonthly,
      extraPrincipalMonthly: input.extraPrincipalMonthly,
      months: monthsToRetirement,
    });
    const schedule = mortgage.schedule;
    const paymentNominalAt = m => {
      if (m < 1 || mortgage.startingBalance === 0) return 0;
      if (m <= schedule.length) return schedule[m - 1].payment;
      // Beyond the recorded schedule: a paid-off loan has no payments; a loan
      // still outstanding at the 1200-month cap keeps its scheduled payment.
      return mortgage.payoffMonthsTotal !== null ? 0 : mortgage.scheduledPayment;
    };
    const mortgageBalanceNominalAt = m => {
      if (mortgage.startingBalance === 0) return 0;
      if (m <= 0) return mortgage.startingBalance;
      if (m <= schedule.length) return schedule[m - 1].endBalance;
      return mortgage.payoffMonthsTotal !== null ? 0 : schedule[schedule.length - 1].endBalance;
    };

    // --- Rental cash flow ------------------------------------------------------
    // rentGrowthReal (§2.3.1): the entered rent is TODAY's scheduled gross
    // rent, and in a today's-dollars model a constant input already grows
    // with inflation — that stays the default (growth input 0, reproduced
    // bit-for-bit). The optional annual real rate adds only growth ABOVE
    // inflation, compounded monthly as (1+g)^(months/12) across the whole
    // timeline (pre-stop-work months included). It applies to scheduled
    // gross rent BEFORE the percentage allowances, so management/vacancy/
    // maintenance scale with the grown rent; fixed real amounts (owner-paid
    // utilities, escrow) and the deflated nominal mortgage payment do not.
    // Tenancy turnover / market-rent resets are deliberately not modeled (§9).
    const grossRentAt = m => input.grossRentMonthly * Math.pow(1 + input.rentGrowthReal, m / 12);
    const percentageRate = input.managementRate + input.vacancyRate + input.maintenanceRate;
    const rentalNetAt = m => {
      const gross = grossRentAt(m);
      return gross - gross * percentageRate
        - input.ownerUtilitiesMonthly - input.escrowMonthly
        - (m >= 1 ? paymentNominalAt(m) / deflate(m) : 0);
    };
    // Finding 5 labeling: zero rent with retained carrying costs is a named
    // scenario, never silently treated as a cost-free no-rent lifestyle.
    const noRentRetained = input.grossRentMonthly === 0
      && (mortgage.startingBalance > 0 || input.escrowMonthly > 0 || input.ownerUtilitiesMonthly > 0);

    // --- Spending contract, tax allowance, healthcare phases (plan §4) -------
    // retirementSpendingAnnual is AFTER-TAX household consumption excluding
    // savings/transfers and excluding property operating costs charged to the
    // rental module. The tax allowance is a separate floor-level annual amount
    // (absent = unknown and disclosed; explicit 0 = the user's declaration).
    const taxDeclared = fieldPresent(raw, 'retirementTaxAllowance');
    const taxMonthly = input.retirementTaxAllowance / 12;
    // Healthcare phases (finding 5): the group is all-or-nothing, so any
    // healthcarePreMedicareAnnual presence means both phases were entered.
    const healthcareModeled = fieldPresent(raw, 'healthcarePreMedicareAnnual');
    const medicareMonth = healthcareModeled
      ? Math.max(1, monthIndexOf(MEDICARE_AGE, input.currentAge) + 1)
      : null;
    const healthcareMonthlyAt = m => (healthcareModeled
      ? (m < medicareMonth ? input.healthcarePreMedicareAnnual : input.healthcarePostMedicareAnnual) / 12
      : 0);
    // At/after Medicare the phase amount is already inside the entered total;
    // before it, the pre-Medicare phase replaces that embedded component.
    const nonHealthcareMonthly = healthcareModeled
      ? (input.retirementSpendingAnnual - input.healthcarePostMedicareAnnual) / 12
      : input.retirementSpendingAnnual / 12;

    // --- Housing scenario (plan §4, finding 5) ---------------------------------
    const housing = input.housingScenario; // validated shape, or undefined
    const replacementActive = housing !== undefined && housing.mode === 'both-units-rented';
    const replacementMonthly = replacementActive ? housing.replacementHousingMonthly : 0;
    const movingCostsOneTime = replacementActive ? housing.movingCostsOneTime : 0;
    const replacementMonth = replacementActive
      ? Math.max(1, monthIndexOf(housing.replacementHousingStartAge, input.currentAge) + 1)
      : null;
    // Zero replacement rent with zero moving costs is an explicitly justified
    // no-cash-effect scenario: it must not delay the settlement or add draws.
    const replacementHasCashEffect = replacementActive && (replacementMonthly > 0 || movingCostsOneTime > 0);
    const replacementDeltaAt = m => (replacementActive && replacementMonthly > 0 && m >= replacementMonth ? replacementMonthly : 0);
    const movingSpikeAt = m => (replacementActive && movingCostsOneTime > 0 && m === replacementMonth ? movingCostsOneTime : 0);

    // --- Settlement month: when all transitions are done ---------------------
    const mortgageSettles = mortgage.startingBalance === 0 || mortgage.payoffMonthsTotal !== null;
    const payoffTransition = mortgageSettles && mortgage.payoffMonthsTotal > 0
      ? mortgage.payoffMonthsTotal + 1
      : null;
    const mortgageNeverSettles = mortgage.startingBalance > 0 && !mortgageSettles;
    const settlementMonth = Math.max(
      stopWorkMonth + 1,
      ...streams.map(s => s.claimingMonth),
      payoffTransition || 0,
      healthcareModeled && input.healthcarePreMedicareAnnual !== input.healthcarePostMedicareAnnual ? medicareMonth : 0,
      replacementHasCashEffect ? replacementMonth + 1 : 0,
    );

    if (mortgage.nonAmortizing) {
      warnings.push({
        code: 'non-amortizing-mortgage',
        message: 'The mortgage payment is at or below the monthly interest charge, so this loan never amortizes at these inputs and the balance will not be repaid. The payment is treated as continuing into the steady state (deflated by inflation) and the income-adjusted result must not be relied on.',
      });
    } else if (mortgageNeverSettles) {
      warnings.push({
        code: 'mortgage-payoff-beyond-cap',
        message: `The mortgage payment exceeds the monthly interest, but at these inputs payoff takes longer than ${Math.round(MORTGAGE_MONTHS_CAP / 12)} years of scheduled payments. The payment is treated as continuing indefinitely (deflated by inflation) and the income-adjusted result must not be relied on.`,
      });
    }
    const beyondHorizon = [];
    for (const stream of streams) {
      if (stream.claimingMonth > horizonMonths) {
        beyondHorizon.push(`${stream.source === 'combined' ? 'the combined benefit' : `${stream.source.replace('member', 'member ')}'s benefit`} starting at age ${stream.claimingAge}`);
      }
    }
    if (payoffTransition !== null && payoffTransition > horizonMonths) beyondHorizon.push('the mortgage payoff');
    if (healthcareModeled && input.healthcarePreMedicareAnnual !== input.healthcarePostMedicareAnnual
      && medicareMonth > horizonMonths) beyondHorizon.push('the Medicare healthcare phase change');
    if (replacementHasCashEffect && replacementMonth > horizonMonths) beyondHorizon.push('the replacement-housing start');
    if (beyondHorizon.length) {
      warnings.push({
        code: 'transition-beyond-horizon',
        message: `The timeline is modeled through age ${horizonAge}, but ${beyondHorizon.join(' and ')} fall(s) after it. Those transitions are excluded from the finite funding target; extend the horizon age to model them.`,
      });
    }

    // --- Monthly draws and finite-horizon floor (plan §2.5) ------------------
    const benefitsMonthlyRealAt = m => streams.reduce(
      (sum, s) => sum + (m >= s.claimingMonth ? s.annualAfterHaircutReal / 12 : 0), 0,
    );
    const propertyCapitalEventAt = m => (input.propertyCapitalEventOneTime > 0 && m === stopWorkMonth + 1
      ? input.propertyCapitalEventOneTime : 0);
    const drawAt = m => (m > stopWorkMonth
      ? Math.max(0, nonHealthcareMonthly + healthcareMonthlyAt(m) + taxMonthly
          + replacementDeltaAt(m) + movingSpikeAt(m) + propertyCapitalEventAt(m)
          - benefitsMonthlyRealAt(m) - rentalNetAt(m))
      : 0);

    // The selected horizon is a real terminal condition, not a label for a
    // perpetual withdrawal-rate target. At its end the portfolio must equal
    // this explicit today's-dollar residual; working backwards funds every
    // modeled draw to that date.
    const maxMonth = horizonMonths;
    const draws = new Array(maxMonth + 1).fill(0);
    for (let m = 1; m <= maxMonth; m += 1) draws[m] = drawAt(m);
    const steadyMonthlyDraw = drawAt(Math.min(settlementMonth, horizonMonths));
    const steadyAnnualNeed = steadyMonthlyDraw * 12;
    const floors = new Array(maxMonth + 1).fill(0);
    floors[maxMonth] = input.terminalBalanceTarget;
    for (let k = maxMonth - 1; k >= 0; k -= 1) {
      floors[k] = (draws[k + 1] + floors[k + 1]) * oneMonthDiscount;
    }
    const finiteTargetAtSettlement = settlementMonth <= horizonMonths ? floors[settlementMonth] : null;

    // --- Trajectories (zero-contribution coast test + contributing plan) -----
    const monthlyContribution = input.annualContributions / 12;
    let coastBalance = portfolioAssets;
    let projectedBalance = portfolioAssets;
    let isCoastNow = portfolioAssets >= floors[0];
    let projectedPortfolioAtRetirement = portfolioAssets;
    const timelineMonths = [];
    for (let m = 1; m <= horizonMonths; m += 1) {
      coastBalance = coastBalance * (1 + monthlyReturn) - draws[m];
      projectedBalance = projectedBalance * (1 + monthlyReturn)
        + (m <= coastMonth ? monthlyContribution : 0) - draws[m];
      if (m === stopWorkMonth) projectedPortfolioAtRetirement = projectedBalance;
      if (coastBalance < floors[m]) isCoastNow = false;
      timelineMonths.push({
        month: m,
        age: input.currentAge + m / 12,
        monthsAfterStopWork: m - stopWorkMonth,
        spendingMonthly: input.retirementSpendingAnnual / 12,
        healthcareMonthlyReal: healthcareMonthlyAt(m),
        taxAllowanceMonthlyReal: taxMonthly,
        replacementHousingMonthlyReal: replacementDeltaAt(m),
        oneTimeMovingCostsReal: movingSpikeAt(m),
        propertyCapitalEventOneTimeReal: propertyCapitalEventAt(m),
        benefitsMonthlyReal: benefitsMonthlyRealAt(m),
        grossRentMonthlyReal: grossRentAt(m),
        rentalNetMonthlyReal: rentalNetAt(m),
        mortgagePaymentNominal: paymentNominalAt(m),
        mortgagePaymentReal: paymentNominalAt(m) / deflate(m),
        mortgageBalanceNominal: mortgageBalanceNominalAt(m),
        portfolioDrawMonthly: draws[m],
        requiredFloorAfterMonth: floors[m],
        coastBalance,
        projectedBalance,
      });
    }

    // --- CF-06: keep three questions separate -------------------------------
    // Coast-now uses current assets and zero future contributions only. The
    // selected schedule is evaluated independently against every future floor;
    // it can be on track while Coast-now remains false. The earliest modeled
    // coast age is the first scheduled balance that could carry the remaining
    // zero-contribution floor — it is a model output, never an age guess.
    // The selected schedule answer is intentionally retirement-date based: it
    // asks whether the portfolio projected under the selected contributions
    // reaches the retirement floor. Coast-now remains the stricter every-floor,
    // zero-contribution result above.
    const onTrackWithContributions = projectedPortfolioAtRetirement + 1e-6 >= floors[stopWorkMonth];
    let earliestModeledCoastMonth = null;
    for (let m = 0; m <= horizonMonths; m += 1) {
      const scheduledBalance = m === 0 ? portfolioAssets : timelineMonths[m - 1].projectedBalance;
      if (earliestModeledCoastMonth === null && scheduledBalance + 1e-6 >= floors[m]) {
        earliestModeledCoastMonth = m;
      }
    }
    const workIncomeDeclared = fieldPresent(raw, 'workIncomeAnnual');
    const coastSpendingDeclared = fieldPresent(raw, 'coastPeriodSpendingAnnual');
    let cashFlowFeasibleWhileCoasting;
    if (!workIncomeDeclared || !coastSpendingDeclared) {
      cashFlowFeasibleWhileCoasting = {
        status: 'unassessed',
        reason: 'work income and coast-period spending must both be entered',
        annualSurplus: null,
      };
      warnings.push({
        code: 'coast-cash-flow-unassessed',
        message: 'Pre-retirement cash-flow feasibility is not assessed: enter both annual work income and annual coast-period spending. Coast does not mean you can stop earning; this calculator otherwise assumes working-period bills are funded outside the retirement portfolio.',
      });
    } else {
      const annualSurplus = input.workIncomeAnnual - input.coastPeriodSpendingAnnual - input.annualContributions;
      cashFlowFeasibleWhileCoasting = {
        status: annualSurplus >= 0 ? 'feasible' : 'shortfall',
        reason: 'simple annual cash screen: work income − coast-period spending − selected annual contributions',
        annualSurplus,
      };
    }

    // --- Bridge (plan §2.4): stop-work until the first benefit starts --------
    let bridge = null;
    if (streams.length) {
      const firstBenefitMonth = Math.min(...streams.map(s => s.claimingMonth));
      if (firstBenefitMonth > stopWorkMonth + 1) {
        let total = 0;
        let presentValue = 0;
        for (let m = stopWorkMonth + 1; m < firstBenefitMonth && m <= maxMonth; m += 1) {
          total += draws[m];
          presentValue += draws[m] * Math.pow(oneMonthDiscount, m - stopWorkMonth);
        }
        bridge = {
          months: firstBenefitMonth - (stopWorkMonth + 1),
          startAge: input.currentAge + stopWorkMonth / 12,
          endAge: input.currentAge + (firstBenefitMonth - 1) / 12,
          firstBenefitMonth,
          firstBenefitAge: Math.min(...streams.filter(s => s.claimingMonth === firstBenefitMonth).map(s => s.claimingAge)),
          portfolioDrawTotal: total,
          presentValueAtRetirement: presentValue,
        };
      }
    }

    let anyDraw = false;
    for (let m = stopWorkMonth + 1; m <= maxMonth && !anyDraw; m += 1) anyDraw = draws[m] > 0;

    // --- Account access screen (plan §4, finding 4) ---------------------------
    // A static, conservative sufficiency screen: can the draws before the
    // declared tax-advantaged access age be funded from the accessible
    // categories alone (no growth, no contributions, no exceptions)? It
    // evaluates no penalty and no exception — it flags, it does not forbid.
    const splitProvided = fieldPresent(raw, 'investmentsTaxableAccessible');
    const accessAgeDeclared = input.taxAdvantagedAccessAge > 0; // normalized 0 = not declared
    const accessMonth = accessAgeDeclared
      ? Math.max(1, monthIndexOf(input.taxAdvantagedAccessAge, input.currentAge) + 1)
      : null;
    const accessibleDeclared = input.investmentsTaxableAccessible + input.investmentsRothOrBasis;
    let preAccessMonths = 0;
    let preAccessDraws = 0;
    if (accessAgeDeclared && accessMonth > stopWorkMonth + 1) {
      preAccessMonths = accessMonth - 1 - stopWorkMonth;
      for (let m = stopWorkMonth + 1; m < accessMonth; m += 1) preAccessDraws += drawAt(m);
    }
    let accessStatus;
    if (!anyDraw) {
      accessStatus = 'not-needed';
    } else if (!splitProvided) {
      accessStatus = 'unassessed-no-split';
    } else if (!accessAgeDeclared) {
      accessStatus = 'unassessed-no-access-age';
    } else if (preAccessMonths === 0) {
      accessStatus = 'not-needed';
    } else {
      accessStatus = preAccessDraws <= accessibleDeclared + 1e-6 ? 'ok' : 'shortfall';
    }
    if (accessStatus === 'unassessed-no-split') {
      warnings.push({
        code: 'account-access-unassessed',
        message: 'Account access is not assessed: the investment balance is not split by tax/access category, so every dollar is treated as available to fund the modeled need. Split it into taxable-accessible, tax-advantaged (pre-access-age), and Roth/basis amounts to check the bridge.',
      });
    } else if (accessStatus === 'unassessed-no-access-age') {
      warnings.push({
        code: 'access-age-unknown',
        message: 'The account split is provided, but no tax-advantaged access age is declared, so bridge accessibility cannot be assessed. Enter the age at which you expect tax-advantaged funds to be accessible under your own plan (the model evaluates no early-distribution exceptions or penalties).',
      });
    } else if (accessStatus === 'shortfall') {
      warnings.push({
        code: 'bridge-access-shortfall',
        message: `Bridge access shortfall: the modeled portfolio draws before the declared access age ${input.taxAdvantagedAccessAge} total $${formatDollars(preAccessDraws)}, but the accessible categories (taxable-accessible + Roth/basis) hold $${formatDollars(accessibleDeclared)}. The remaining $${formatDollars(preAccessDraws - accessibleDeclared)} requires an access strategy — the model does not evaluate early-distribution exceptions or apply any penalty, so this is a flagged decision, not an automatic pass.`,
      });
    }

    // --- Spending-contract disclosures (plan §4, finding 4) — visible near the
    // result, not footer-only. Unknown is distinguished from explicit zero.
    if (taxDeclared && input.retirementTaxAllowance === 0) {
      warnings.push({
        code: 'tax-allowance-explicit-zero',
        message: 'A $0 income-tax allowance was entered explicitly, so the modeled need assumes no retirement income tax. The model does not compute tax: if traditional-account distributions or Social Security prove taxable, the need is understated.',
      });
    } else if (!taxDeclared && input.retirementSpendingAnnual > 0) {
      warnings.push({
        code: 'tax-allowance-unknown',
        message: 'No income-tax allowance is modeled; if your spending figure is pre-tax, this understates the target. Enter the annual income-tax allowance you expect to owe in retirement — the model does not compute tax, and pretax and Roth balances are not equivalent after tax.',
      });
    }
    if (!healthcareModeled && input.retirementSpendingAnnual > 0) {
      warnings.push({
        code: 'healthcare-phases-unknown',
        message: 'Healthcare is not entered as Medicare phases, so it is treated as unchanged inside the entered spending. Medicare eligibility generally begins at 65; if stop-work precedes it, enter pre-Medicare and at/after-Medicare healthcare amounts to make the phase explicit.',
      });
    }
    if (noRentRetained) {
      warnings.push({
        code: 'property-retained-no-rent',
        message: 'No rental receipts; property retained: gross rent is zero while carrying costs (mortgage, escrow, owner utilities) continue, so the property still draws on the portfolio need. This is not a cost-free no-rent lifestyle.',
      });
    }
    if (steadyAnnualNeed <= 0 && !anyDraw) {
      warnings.push({
        code: 'zero-modeled-need',
        message: 'Modeled annual portfolio need is $0 with these inputs (spending is fully offset by entered income, or spending is $0). Confirm the spending and income offsets are intentional.',
      });
    }

    const result = {
      status: {
        isCoastNow,
        onTrackWithContributions,
        onTrackGap: projectedPortfolioAtRetirement - floors[stopWorkMonth],
        earliestModeledCoastAge: earliestModeledCoastMonth === null
          ? null : input.currentAge + earliestModeledCoastMonth / 12,
        earliestModeledCoastMonth,
        cashFlowFeasibleWhileCoasting,
      },
      projectedPortfolioAtRetirement,
      contributionMonths: Math.min(monthsToRetirement, coastMonth),
      mortgage,
      rental: {
        label: noRentRetained ? 'No rental receipts; property retained' : null,
        grossRentMonthlyAtRetirement: grossRentAt(stopWorkMonth + 1),
        monthlyNetAtRetirement: rentalNetAt(stopWorkMonth + 1),
        grossRentMonthlyAtSettlement: grossRentAt(settlementMonth),
        monthlyNetAtSettlement: rentalNetAt(settlementMonth),
      },
      socialSecurity: {
        convention: 'Benefit amounts are today-dollar estimates at each member\'s chosen claiming age; SSA COLAs keep their purchasing power level after claiming. The haircut is a separate policy-risk assumption, not a claiming-date reduction.',
        dollarBasis: input.benefitDollarBasis,
        haircut,
        unknownTiming: benefitsEntered && streams.length === 0,
        streams: streams.map(s => ({
          source: s.source,
          claimingAge: s.claimingAge,
          claimingMonth: s.claimingMonth,
          startAge: s.startAge,
          annualTodayDollars: s.annualTodayDollars,
          annualAfterHaircutTodayDollars: s.annualAfterHaircutTodayDollars,
          annualAfterHaircutReal: s.annualAfterHaircutReal,
        })),
        creditedAnnualAfterHaircutReal,
      },
      incomeAdjusted: {
        annualPortfolioNeed: steadyAnnualNeed,
        targetAtRetirement: floors[stopWorkMonth],
        coastNumberNow: floors[0],
        isCoast: isCoastNow,
        restricted: benefitsEntered && streams.length === 0 ? 'benefit-timing-unknown' : null,
        settlement: {
          month: settlementMonth,
          age: input.currentAge + settlementMonth / 12,
          steadyMonthlyDraw,
          targetAtSettlement: finiteTargetAtSettlement,
        },
        bridge,
      },
      portfolioOnly: {
        label: 'Portfolio-only benchmark for entered spending',
        excludes: ['the income-tax allowance', 'Social Security benefits', 'rental income and property carrying costs', 'healthcare phases', 'replacement housing'],
        targetAtRetirement: input.retirementSpendingAnnual / input.withdrawalRate,
        coastNumberNow: (input.retirementSpendingAnnual / input.withdrawalRate)
          / Math.pow(1 + input.realReturn, yearsToRetirement),
        isCoast: portfolioAssets >= (input.retirementSpendingAnnual / input.withdrawalRate)
          / Math.pow(1 + input.realReturn, yearsToRetirement),
      },
      assumptions: {
        inflationRate,
        inflationDefaulted,
        horizonAge,
        horizonDefaulted,
        terminalBalanceTarget: input.terminalBalanceTarget,
        terminalBalanceTargetDefaulted,
        nominalReturnAnnual,
        rentGrowthReal: input.rentGrowthReal,
        compounding: 'monthly',
        taxAllowance: { annual: input.retirementTaxAllowance, declared: taxDeclared },
        healthcarePhases: { modeled: healthcareModeled, medicareAge: MEDICARE_AGE },
        housingMode: housing ? housing.mode : 'occupied-retained',
        taxTreatment: {
          contract: 'the income-tax allowance is one flat user-entered annual amount added to the funding floor; no tax engine (brackets, filing status, state tax) is modeled',
          unknownVsZero: 'an absent allowance is unknown and disclosed as such; an explicit $0 is the user\'s declaration that no tax is expected',
          rentalCashFlow: 'rental cash flow is a cash offset, not taxable rental profit: mortgage principal is a cash outflow but is not a deductible rental expense, and depreciation follows separate rules',
          accountEquivalence: 'the model does not treat pretax and Roth balances as equivalent after tax; the account split flags bridge accessibility only and evaluates no early-distribution exceptions and no penalty',
        },
        dollarConventions: {
          spending: 'real (today\'s dollars); after-tax consumption excluding savings/transfers and property operating costs charged to the rental module',
          contributions: 'real (today\'s dollars), constant until coastAge',
          portfolioBalance: 'real (today\'s dollars)',
          rentalIncome: 'real (today\'s dollars); grows with inflation, plus the rentGrowthReal rate above inflation',
          mortgageTerms: 'nominal (contractual); deflated month-by-month to today\'s dollars',
          benefits: 'today\'s-dollar estimates at each claiming age; SSA COLAs keep purchasing power level after claiming; future-dollar estimates must be converted before entry',
        },
        fundingMethod: 'finite-horizon real-dollar floor: every modeled draw through the selected horizon plus the explicit terminal portfolio target is discounted month-by-month at the real return; the withdrawal rate is used only by the separately labeled portfolio-only perpetual benchmark',
      },
      spending: {
        contract: 'retirementSpendingAnnual is after-tax household consumption: it excludes savings/transfers and excludes property operating costs charged to the rental module, so each property expense is counted exactly once. The income-tax allowance is added separately at the funding floor.',
        enteredAnnual: input.retirementSpendingAnnual,
        worksheetProvided: fieldPresent(raw, 'consumptionAnnual'),
        worksheet: fieldPresent(raw, 'consumptionAnnual') ? {
          consumptionAnnual: input.consumptionAnnual,
          personalHousingAnnual: input.personalHousingAnnual,
          healthcarePreMedicareAnnual: input.healthcarePreMedicareAnnual,
          healthcarePostMedicareAnnual: input.healthcarePostMedicareAnnual,
        } : null,
        healthcare: healthcareModeled ? {
          modeled: true,
          medicareAge: MEDICARE_AGE,
          medicareMonth,
          preMedicareAnnual: input.healthcarePreMedicareAnnual,
          postMedicareAnnual: input.healthcarePostMedicareAnnual,
        } : { modeled: false, medicareAge: MEDICARE_AGE },
        taxAllowance: { annual: input.retirementTaxAllowance, monthly: taxMonthly, declared: taxDeclared },
        memos: {
          propertyOperationsAnnual: input.propertyOperationsAnnual,
          propertyOperationsProvided: fieldPresent(raw, 'propertyOperationsAnnual'),
          savingsTransfersAnnual: input.savingsTransfersAnnual,
          savingsTransfersProvided: fieldPresent(raw, 'savingsTransfersAnnual'),
        },
      },
      accountAccess: {
        splitProvided,
        accessAgeDeclared,
        accessAge: accessAgeDeclared ? input.taxAdvantagedAccessAge : null,
        categories: splitProvided ? {
          taxableAccessible: input.investmentsTaxableAccessible,
          taxAdvantagedPreAccessAge: input.investmentsTaxAdvantagedPreAccess,
          rothOrBasis: input.investmentsRothOrBasis,
        } : null,
        status: accessStatus,
        preAccess: {
          months: preAccessMonths,
          drawsTotal: preAccessDraws,
          accessibleDeclared,
          shortfall: accessStatus === 'shortfall' ? preAccessDraws - accessibleDeclared : null,
        },
        note: 'A conservative sufficiency screen, not a tax calculation: accessible categories are compared against pre-access draws at today\'s values with no growth and no contributions. The model does not evaluate early-distribution exceptions (SEPP/72(t) payments, the rule of 55, Roth ordering), applies no penalty, and does not treat pretax and Roth balances as equivalent after tax.',
      },
      housing: {
        mode: housing ? housing.mode : 'occupied-retained',
        assumption: replacementActive
          ? housing.replacementHousingAssumption
          : 'Household occupies its own unit; the property\'s carrying costs are charged to the property module',
        replacement: replacementActive ? {
          assumption: housing.replacementHousingAssumption,
          monthly: replacementMonthly,
          startAge: housing.replacementHousingStartAge,
          startMonth: replacementMonth,
          movingCostsOneTime,
          movingCostsMonth: movingCostsOneTime > 0 ? replacementMonth : null,
          justification: housing.replacementHousingJustification || null,
        } : null,
      },
      propertyStress: {
        reserveExcludedFromPortfolio: input.propertyReserve,
        investablePortfolioAfterReserve: portfolioAssets,
        capitalEventOneTimeAtStopWork: input.propertyCapitalEventOneTime,
        convention: 'propertyReserve is an earmark inside currentInvestments and is excluded once from investable portfolio assets; propertyCapitalEventOneTime is a single real-dollar draw at the first retirement month, not a recurring expense',
      },
      timeline: {
        horizonAge,
        horizonDefaulted,
        stopWorkMonth,
        stopWorkAge: input.retirementAge,
        coastMonth,
        settlementMonth,
        months: timelineMonths,
      },
      warnings,
      homeEquityIncluded: false,
    };

    assertFiniteDeep(result, 'result');
    return result;
  }

  // CF-06 deterministic sensitivities. Cases are caller-configured, pure, and
  // each starts from a fresh copy of the baseline: no case can contaminate the
  // next. They are assumptions/scenarios, never forecasts or probabilities.
  function calculateDeterministicStressCases(rawInput, cases) {
    validateCoastFireInput(rawInput);
    if (!Array.isArray(cases)) throw new TypeError('stress cases must be an array');
    return cases.map((caseInput, index) => {
      if (!isPlainObject(caseInput) || typeof caseInput.name !== 'string' || caseInput.name.trim() === '') {
        throw new TypeError(`stress case ${index + 1} needs a non-empty name`);
      }
      const overrides = isPlainObject(caseInput.overrides) ? { ...caseInput.overrides } : {};
      for (const key of ['rentFactor', 'benefitFactor', 'managementRateIncrease']) {
        if (caseInput[key] !== undefined && (typeof caseInput[key] !== 'number' || !Number.isFinite(caseInput[key]) || caseInput[key] < 0)) {
          throw new TypeError(`stress case ${caseInput.name}: ${key} must be a finite non-negative number`);
        }
      }
      if (caseInput.rentFactor !== undefined) overrides.grossRentMonthly = rawInput.grossRentMonthly * caseInput.rentFactor;
      if (caseInput.benefitFactor !== undefined) {
        overrides.socialSecurityAnnual = (rawInput.socialSecurityAnnual || 0) * caseInput.benefitFactor;
        overrides.member1AnnualBenefit = (rawInput.member1AnnualBenefit || 0) * caseInput.benefitFactor;
        overrides.member2AnnualBenefit = (rawInput.member2AnnualBenefit || 0) * caseInput.benefitFactor;
      }
      if (caseInput.managementRateIncrease !== undefined) {
        overrides.managementRate = rawInput.managementRate + caseInput.managementRateIncrease;
      }
      if (caseInput.survivor !== undefined) {
        const s = caseInput.survivor;
        if (!isPlainObject(s) || !['member1', 'member2'].includes(s.member)
          || typeof s.annualBenefit !== 'number' || !Number.isFinite(s.annualBenefit) || s.annualBenefit < 0
          || typeof s.householdSpendingAnnual !== 'number' || !Number.isFinite(s.householdSpendingAnnual) || s.householdSpendingAnnual < 0
          || typeof s.claimingAge !== 'number' || !Number.isFinite(s.claimingAge)) {
          throw new TypeError(`stress case ${caseInput.name}: survivor needs member (member1/member2), explicit annualBenefit, householdSpendingAnnual, and claimingAge — no survivor amount is inferred`);
        }
        overrides.member1AnnualBenefit = s.member === 'member1' ? s.annualBenefit : 0;
        overrides.member1ClaimingAge = s.member === 'member1' ? s.claimingAge : undefined;
        overrides.member2AnnualBenefit = s.member === 'member2' ? s.annualBenefit : 0;
        overrides.member2ClaimingAge = s.member === 'member2' ? s.claimingAge : undefined;
        overrides.socialSecurityAnnual = 0;
        overrides.socialSecurityClaimingAge = undefined;
        overrides.retirementSpendingAnnual = s.householdSpendingAnnual;
        // A survivor case cannot retain the two-person worksheet totals after
        // replacing household spending. Preserve the baseline post-Medicare
        // healthcare amount and scale consumption/personal housing in their
        // declared proportion; this is deterministic and reported in overrides.
        if (WORKSHEET_SUM_KEYS.every(key => fieldPresent(rawInput, key))) {
          const fixedHealthcare = rawInput.healthcarePostMedicareAnnual;
          const scalableBaseline = rawInput.consumptionAnnual + rawInput.personalHousingAnnual;
          const scalableSurvivor = s.householdSpendingAnnual - fixedHealthcare;
          if (scalableSurvivor < 0 || (scalableBaseline === 0 && scalableSurvivor > 0)) {
            throw new RangeError(`stress case ${caseInput.name}: survivor spending cannot reconcile the supplied worksheet; provide a survivor spending amount at least equal to post-Medicare healthcare or use a worksheet with non-healthcare components`);
          }
          const scale = scalableBaseline === 0 ? 0 : scalableSurvivor / scalableBaseline;
          overrides.consumptionAnnual = rawInput.consumptionAnnual * scale;
          overrides.personalHousingAnnual = rawInput.personalHousingAnnual * scale;
          overrides.healthcarePreMedicareAnnual = rawInput.healthcarePreMedicareAnnual;
          overrides.healthcarePostMedicareAnnual = fixedHealthcare;
        }
      }
      const scenarioInput = { ...rawInput, ...overrides };
      const result = calculateCoastFire(scenarioInput);
      return {
        name: caseInput.name.trim(),
        assumptions: {
          overrides,
          rentFactor: caseInput.rentFactor ?? null,
          benefitFactor: caseInput.benefitFactor ?? null,
          managementRateIncrease: caseInput.managementRateIncrease ?? null,
          survivor: caseInput.survivor ?? null,
          feeConvention: 'realReturn is net of investment fees unless the user enters a gross return deliberately; no fee is added elsewhere',
        },
        status: result.status,
        incomeAdjusted: result.incomeAdjusted,
        propertyStress: result.propertyStress,
      };
    });
  }

  // --- Scenario payload versioning (CF-05, plan §7; review finding 10) --------
  //
  // A saved scenario (browser storage, scenario URL, or a hand-edited JSON
  // file) may be a flat legacy payload (implicit schemaVersion 1) or a
  // versioned envelope. Parsing lives here — the same shared path as every
  // other schema concern — so storage, hash, and import behave identically:
  // legacy payloads load (documented defaults apply with their visible
  // warnings), the current version round-trips, and a payload written by a
  // NEWER schema is rejected with an actionable message instead of being
  // silently misread field-by-field.
  const SCENARIO_SCHEMA_VERSION = 2;

  function parseScenarioPayload(payload) {
    if (!isPlainObject(payload)) {
      throw new TypeError('A saved scenario must be a JSON object');
    }
    const envelope = payload.schemaVersion !== undefined
      || (payload.scenario !== undefined && payload.savedAt !== undefined);
    if (!envelope) {
      return { scenario: payload, schemaVersion: 1, legacy: true, savedAt: null };
    }
    const version = payload.schemaVersion;
    if (version === undefined) {
      throw new TypeError('A versioned scenario envelope must carry a numeric schemaVersion');
    }
    if (typeof version !== 'number' || !Number.isFinite(version) || !Number.isInteger(version)) {
      throw new TypeError(`scenario schemaVersion must be an integer (got ${describeValue(version)})`);
    }
    if (version > SCENARIO_SCHEMA_VERSION) {
      throw new RangeError(`this scenario was saved by schema version ${version}, but this build understands up to ${SCENARIO_SCHEMA_VERSION} — update the calculator (or re-create the scenario) before loading it; the saved values were NOT applied`);
    }
    // Two envelope shapes: storage/hash envelopes carry `scenario`; exports
    // carry `inputs` (their results are recomputed on import, never trusted).
    if (payload.scenario !== undefined) {
      if (!isPlainObject(payload.scenario)) {
        throw new TypeError('a versioned scenario envelope must carry a scenario object (got something else under "scenario")');
      }
      return {
        scenario: payload.scenario,
        schemaVersion: version,
        legacy: false,
        savedAt: typeof payload.savedAt === 'string' ? payload.savedAt : null,
      };
    }
    if (payload.inputs !== undefined) {
      if (!isPlainObject(payload.inputs)) {
        throw new TypeError('an export envelope must carry an inputs object (got something else under "inputs")');
      }
      return {
        scenario: payload.inputs,
        schemaVersion: version,
        legacy: false,
        savedAt: typeof payload.generatedAt === 'string' ? payload.generatedAt : null,
      };
    }
    throw new TypeError('a versioned scenario envelope must carry a scenario object (storage/hash) or inputs object (export)');
  }

  function buildCoastFireExport(input, generatedAt = new Date().toISOString()) {
    // Shared path: validates like the form, the hash decoder, and the CLI.
    // Validation throws before anything is serialized, so a non-finite input
    // can never be masked as null by JSON.stringify.
    validateCoastFireInput(input);
    const results = calculateCoastFire(input);
    return {
      schemaVersion: 2,
      generatedAt,
      inputs: JSON.parse(JSON.stringify(input)),
      results,
    };
  }

  // --- Provenance (CF-05, plan §7; review finding 11) -------------------------
  //
  // Ledger reconciliation lives in plaid-service/coast-fire-config.js (the
  // single implementation behind the defaults and provenance endpoints, and
  // the CLI). The model deliberately has no ledger code: it consumes only the
  // flat defaults shape, and a category with no ledger rows stays unknown.

  return {
    calculateCoastFire,
    simulateMortgage,
    buildCoastFireExport,
    calculateDeterministicStressCases,
    validateCoastFireInput,
    parseScenarioPayload,
    SCENARIO_SCHEMA_VERSION,
    NUMERIC_INPUT_KEYS,
    MODELED_DURATION_CAP_YEARS,
    MORTGAGE_MONTHS_CAP,
  };
});