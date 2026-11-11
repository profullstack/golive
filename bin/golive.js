#!/usr/bin/env node
import { main } from "../src/cli.js";

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`golive: ${error.message}`);
    process.exit(1);
  },
);
