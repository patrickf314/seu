// The seu entry point. bin/seu is a launcher; this is the dispatcher.
//
// Every command -- the ported ones and the ones still backed by bash -- is a
// const in src/cmd/ carrying its own documentation and `run`, registered in
// src/cmd/index.ts. Nothing about a particular command lives here.

import { findCommand } from "./cmd/index.ts";
import { HELP, usage } from "./cmd/help.ts";
import { SeuError } from "./common/error.ts";

const wantsHelp = (argv: string[]): boolean => argv.includes("--help") || argv.includes("-h");

async function main(): Promise<number> {
  const [name, ...argv] = process.argv.slice(2);

  // `seu` on its own is a mistake, not a request for help: usage, exit 2.
  if (name === undefined || name === "") {
    usage();
    return 2;
  }

  if (name === "--help" || name === "-h") {
    await HELP.run(argv);
    return 0;
  }

  const command = findCommand(name);
  if (!command) {
    usage(`unknown command ${name}`);
    return 2;
  }

  if (command !== HELP && wantsHelp(argv)) {
    await HELP.run([command.name]);
    return 0;
  }

  await command.run(argv);
  return 0;
}

try {
  process.exitCode = await main();
} catch (err) {
  if (err instanceof SeuError) {
    process.stderr.write(`\x1b[31merror\x1b[0m ${err.message}\n`);
    process.exit(1);
  }
  throw err;
}
