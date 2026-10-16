import { spawnSync } from "node:child_process";

const result = spawnSync(
  process.env.QDD_ESP_IDF_PYTHON,
  [
    process.env.QDD_ESP_IDF_SCRIPT,
    ...JSON.parse(process.env.QDD_ESP_IDF_ARGUMENTS),
  ],
  { stdio: "inherit" },
);

if (result.error) {
  console.error(`ESP-IDF: ${result.error.message}`);
}
process.exit(result.status ?? 1);
