#!/usr/bin/env node
import { loadConfig } from "./lib/config.js";
import { scanEvmRequests } from "./lib/scan.js";

const config = await loadConfig(process.argv[2]);
const result = await scanEvmRequests(config);
console.log(JSON.stringify(result, null, 2));
