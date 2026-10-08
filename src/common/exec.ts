import { LOG } from './log.ts';


export interface ExecRequest {
    /**
     * The command to execute
     */
    cmd: string;

    /**
     * The command args
     */
    args?: string[];

    /**
     * Whether to execute the command as root user
     */
    root?: boolean;

    /**
     * A key value map of environment variables
     */
    env?: Record<string, string>;

    /**
     * The working directory
     */
    cwd?: string;

    /**
     * A timeout for the command
     */
    timeoutMs?: number;

    /**
     * Stream stdout/stderr to the terminal as it arrives.
     */
    stream?: boolean;
}

export interface ExecResult {
    /**
     * Whether the execution was successful, i.e. if it exited with status code 0
     */
    ok: boolean;
    /**
     * The status code of the execution
     */
    code: number;
    /**
     * The stdout
     */
    stdout: string;
    /**
     * The stderr
     */
    stderr: string;
    /**
     * True when the host-side watchdog killed it.
     */
    timedOut: boolean;
}

/**
 * Collects the output of one stream (stdout or stderr) of an execution.
 *
 * Decodes UTF-8 incrementally, so multibyte characters split across chunks stay intact,
 * and optionally logs the output line by line as it arrives.
 */
export class OutputCollector {
    private readonly decoder = new TextDecoder();
    private text = '';
    private pendingLine = '';
    private readonly stream: boolean;

    constructor(stream: boolean | undefined) {
        this.stream = stream === true;
    }

    push(chunk: Uint8Array): void {
        this.append(this.decoder.decode(chunk, { stream: true }));
    }

    /**
     * Flushes the decoder and any incomplete trailing line. Returns the full output.
     */
    finish(): string {
        this.append(this.decoder.decode());
        if (this.stream && this.pendingLine !== '') {
            LOG.debug(this.pendingLine);
        }
        this.pendingLine = '';
        return this.text;
    }

    private append(data: string): void {
        this.text += data;
        if (!this.stream) {
            return;
        }
        const lines = (this.pendingLine + data).split('\n');
        this.pendingLine = lines.pop() ?? '';
        for (const line of lines) {
            LOG.debug(line);
        }
    }
}
