import { runPaymentCoreUnitTests } from "./paymentCore.unit.mjs";
import { runEasyPaisaIntegrationTests } from "./easypaisa.integration.mjs";
import { runReconciliationIntegrationTests } from "./reconciliation.integration.mjs";

const suites = [
  ["payment core unit", runPaymentCoreUnitTests],
  ["Easypaisa initiation integration", runEasyPaisaIntegrationTests],
  ["payment reconciliation integration", runReconciliationIntegrationTests],
];

let failures = 0;
for (const [name, run] of suites) {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}`);
    console.error(error?.stack || error);
  }
}

if (failures > 0) {
  process.exitCode = 1;
} else {
  console.log(`PASS all ${suites.length} payment test suites`);
}
