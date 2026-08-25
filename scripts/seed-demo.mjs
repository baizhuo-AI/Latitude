#!/usr/bin/env node

import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  readDemoFixture,
  seedDemoProfile,
  validateDemoFixture,
} from "./seed-demo-core.mjs";

const fixturePath = fileURLToPath(
  new URL("../fixtures/demo/sanitized-knowledge-profile.json", import.meta.url),
);
const fixture = await readDemoFixture(fixturePath);
const dryRun = process.argv.includes("--dry-run");
const domainUrl = argumentValue("--domain-url")
  ?? process.env.LATITUDE_DOMAIN_URL
  ?? "http://127.0.0.1:43121";

if (dryRun) {
  const result = validateDemoFixture(fixture);
  console.log(
    `[latitude] Sanitized demo fixture is valid: ${result.nodeCount} nodes, ` +
      `${result.goalCount} goals, ${result.sourceGroups} source groups.`,
  );
} else {
  const result = await seedDemoProfile({ fixture, domainUrl });
  console.log(
    `[latitude] Demo profile ready: ${result.persistedNodeCount} Domain nodes; ` +
      `north star = ${result.northStarLabel}; retired legacy demo nodes = ` +
      `${result.retiredNodeCount}.`,
  );
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new TypeError(`${name} requires a value`);
  }
  return value;
}
