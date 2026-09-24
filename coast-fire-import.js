(function (root, factory) {
  const model = typeof module === 'object' && module.exports ? require('./coast-fire-model.js') : root.CoastFireModel;
  const api = factory(model);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CoastFireImport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (model) {
  'use strict';
  function parseImportedProfile(raw) {
    let payload;
    try { payload = JSON.parse(raw); }
    catch { throw new Error('Select a valid JSON file. Nothing was imported.'); }
    if (payload && typeof payload === 'object' && payload.schemaVersion === 2 && (payload.members || payload.accounts) && !payload.inputs && !payload.scenario) {
      throw new Error('Source ledger import is not supported on the static site; export flat model inputs locally first. Nothing was imported.');
    }
    const decoded = model.parseScenarioPayload(payload);
    model.validateCoastFireInput(decoded.scenario);
    return {
      inputs: decoded.scenario,
      asOf: decoded.scenario.asOf || (typeof payload.asOf === 'string' ? payload.asOf : null),
      format: decoded.legacy ? 'flat' : 'scenario',
      savedAt: decoded.savedAt,
    };
  }
  return { parseImportedProfile };
});
