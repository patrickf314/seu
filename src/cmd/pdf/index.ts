// `seu pdf`. The flow itself lives in src/cmd/pdf/run.ts.

import type { Command } from '../command.ts';

export const PDF: Command = {
    name: 'pdf',
    args: '[file] [options]',
    summary: 'open a PDF from the VM in your browser',

    details: `Serves a PDF from INSIDE the VM, forwards its port to your machine and opens it in your browser, which renders it itself. The file never leaves the sandbox, and the host needs no PDF viewer and no LaTeX.

  seu pdf club/docs/thesis.pdf

<file> is relative to ~/work; a leading /home/seu/work/ is accepted too.

Without a <file>, the most recently modified PDF anywhere under ~/work is used -- what \`pdflatex\` just wrote:

  seu pdf

Only that one file is served. The PDF is linked rather than copied, so running pdflatex again and refreshing the browser tab shows the new version.

The forward is an ordinary \`seu port\` forward while it lasts. Ctrl-C stops the server and drops it.`,

    options: [
        { flag: '--name, -n <name>', text: 'the SEU the PDF is in; default: the worktree\'s directory name' },
        { flag: '--port <port>', text: 'host port for the PDF; default: the first free one from 9400 upward' },
        { flag: '--no-open', text: 'print the URL instead of opening it in your browser' },
    ],

    async run(argv: string[]): Promise<number | void> {
        // Imported here rather than at the top: the flow is what pulls in the
        // microsandbox SDK, and `seu help` must not need it.
        const { run } = await import('./run.ts');
        return run(argv);
    },
};
