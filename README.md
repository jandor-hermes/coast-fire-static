# Static Coast FIRE calculator

Public **code only**. No household balances, defaults, account connections, or uploaded data are in this repository. The calculator starts with generic demo inputs. Use **Import financial JSON** to select a flat household profile or a v2 scenario export from the device; the file is parsed in browser memory and never sent to a server. The app does not use browser storage or generate shareable data URLs. Reloading clears imported values. An explicit JSON export writes a plaintext file to your device.

The model is deterministic planning math, not a forecast or work-exit clearance. Tax, account access, benefit provenance, spending, and health assumptions require independent review.

Source: a static adaptation of the budget-app Coast FIRE HTML/JS model. Tests: `node --test tests/*.test.cjs`.
