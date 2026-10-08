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

const DEFAULT_PAD = '            ' as const;

function print(msg: string): void {
    process.stderr.write(`${msg}`);
}

function println(msg: string): void {
    print(`${msg}\n`);
}

export const LOG = {
    step: (msg: string): void => {
        println(`\n${ASCII_CODE.BLUE}[Step]${ASCII_CODE.OFF} ${ASCII_CODE.BOLD}${msg}${ASCII_CODE.OFF}`);
    },

    info: (msg: string): void => {
        println(`${DEFAULT_PAD}${msg}`);
    },

    debug: (msg: string): void => {
        println(`${DEFAULT_PAD}${ASCII_CODE.DIM}${msg}${ASCII_CODE.OFF}`);
    },

    ok: (msg: string): void => {
        println(`  ${ASCII_CODE.GREEN}[ok]     ${ASCII_CODE.OFF} ${msg}`);
    },

    warn: (msg: string): void => {
        println(`  ${ASCII_CODE.YELLOW}[warn]  ${ASCII_CODE.OFF} ${msg}`);
    },
    error: (msg: string): void => {
        println(`  ${ASCII_CODE.RED}[error]${ASCII_CODE.OFF} ${msg}`);
    },
    print,
    println,
} as const;
