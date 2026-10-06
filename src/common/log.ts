const ASCII_CODE = {
    GREEN: '[32m',
    YELLOW: '[33m',
    RED: '[31m',
    BLUE: '[34m',
    BOLD: '[1m',
    // Transparent text, used for info messages
    DIM: '[2m',

    // Reset all attributes
    OFF: '[0m',
} as const;

function print(msg: string): void {
    process.stderr.write(`${msg}\n`);
}

export const LOG = {
    step: (msg: string): void => {
        print(`\n${ASCII_CODE.BLUE}[Step]${ASCII_CODE.OFF} ${ASCII_CODE.BOLD}${msg}${ASCII_CODE.OFF}`);
    },

    info: (msg: string): void => {
        print(`            ${msg}`);
    },

    debug: (msg: string): void => {
        print(`            ${ASCII_CODE.DIM}${msg}${ASCII_CODE.OFF}`);
    },

    ok: (msg: string): void => {
        print(`  ${ASCII_CODE.GREEN}[ok]     ${ASCII_CODE.OFF} ${msg}`);
    },

    warn: (msg: string): void => {
        print(`  ${ASCII_CODE.YELLOW}[warn]  ${ASCII_CODE.OFF} ${msg}`);
    },
    error: (msg: string): void => {
        print(`  ${ASCII_CODE.RED}[error]${ASCII_CODE.OFF} ${msg}`);
    },
    print
} as const;
