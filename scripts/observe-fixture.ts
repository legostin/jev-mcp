// Dev helper: prints the perception output for a fixture page. Usage: node scripts/observe-fixture.ts flights.html [region]
import { startHarness } from '../test/integration/harness.ts';
import { observePage } from '../src/core/perception/model.ts';
import { renderOverview, renderRegion } from '../src/core/perception/render.ts';

const h = await startHarness();
try {
  const page = await h.open(process.argv[2] ?? 'flights.html');
  await new Promise((r) => setTimeout(r, Number(process.argv[4] ?? 600)));
  const model = await observePage(page);
  console.log(renderOverview(model, 2000));
  console.log(`\n[elements=${model.elements.size} captureMs=${model.captureMs}]\n`);
  for (const r of process.argv[3] ? [process.argv[3]] : model.regions.map((x) => x.id)) console.log(renderRegion(model, r, 1200), '\n');
} finally {
  await h.close();
}
