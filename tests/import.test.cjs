const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseImportedProfile } = require('../coast-fire-import.js');

const valid = {
  asOf: '2026-09-01', currentAge: 40, retirementAge: 65, coastAge: 40,
  currentInvestments: 250000, annualContributions: 0, realReturn: 0.05,
  withdrawalRate: 0.04, retirementSpendingAnnual: 80000,
  socialSecurityAnnual: 0, socialSecurityHaircut: 0,
  mortgagePrincipal: 0, mortgageRate: 0, mortgagePrincipalInterestMonthly: 0,
  extraPrincipalMonthly: 0, escrowMonthly: 0, grossRentMonthly: 0,
  managementRate: 0, vacancyRate: 0, maintenanceRate: 0, ownerUtilitiesMonthly: 0,
};

test('imports a flat local profile and retains its source date', () => {
  const parsed = parseImportedProfile(JSON.stringify(valid));
  assert.equal(parsed.inputs.currentInvestments, 250000);
  assert.equal(parsed.asOf, '2026-09-01');
  assert.equal(parsed.format, 'flat');
});

test('imports a versioned exported scenario but recomputes results', () => {
  const parsed = parseImportedProfile(JSON.stringify({schemaVersion:2, inputs:valid, results:{fake:true}}));
  assert.equal(parsed.inputs.currentInvestments, 250000);
  assert.equal(parsed.inputs.results, undefined);
});

test('rejects malformed, incomplete, and ledger payloads without returning input', () => {
  assert.throws(() => parseImportedProfile('{bad'), /valid JSON/);
  assert.throws(() => parseImportedProfile(JSON.stringify({currentAge:40})), /required/);
  assert.throws(() => parseImportedProfile(JSON.stringify({schemaVersion:2, members:[], accounts:[]})), /ledger.*not supported/i);
  assert.throws(() => parseImportedProfile(JSON.stringify({...valid, currentInvestments: 'not a number'})), /finite number/);
});
