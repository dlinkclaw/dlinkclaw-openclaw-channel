/**
 * 2026-10-21：终端能力（协议级，非 OpenClaw 专属）。
 * 通过 PTY（可用时）或 child_process 运行登录 shell，输出经 sink 回推客户端。
 * 其他品牌插件（如 dsh）实现同一套 terminal.* 契约即可。
 */
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import os from 'os';
import path from 'path';

export type TerminalDataSink = (sessionId: string, data: string) => void;
export type TerminalLogger = (msg: string, type?: 'info' | 'warn' | 'error' | 'debug') => void;

type Session = {
    id: string;
    proc: any;
    isPty: boolean;
    buffer: string;
    /** 保留最近输出，供重新 attach 时回放（上限 64KB） */
    history: string;
    flushTimer: NodeJS.Timeout | null;
    idleTimer: NodeJS.Timeout | null;
    closed: boolean;
};

const FLUSH_MS = 16;
const IDLE_MS = 30 * 60 * 1000;
/** 重新 attach 时回放的最大输出量 */
const HISTORY_LIMIT = 64 * 1024;

/** 优先用 PTY（交互式 shell），不可用时退回管道模式 */
async function loadPty(): Promise<any | null> {
    for (const name of ['node-pty', '@lydell/node-pty']) {
        try {
            const mod = await import(name);
            if (mod) {
                return (mod as any).default ?? mod;
            }
        } catch {
            // 继续尝试下一个
        }
    }
    return null;
}

export class TerminalManager {
    private readonly sessions = new Map<string, Session>();
    private ptyModule: any | null | undefined;

    constructor(
        private readonly sink: TerminalDataSink,
        private readonly log: TerminalLogger,
    ) {
    }

    private defaultCwd(): string {
        return path.join(os.homedir(), '.openclaw', 'workspace');
    }

    private append(session: Session, chunk: string) {
        if (session.closed || !chunk) {
            return;
        }
        session.buffer += chunk;
        if (session.history.length < HISTORY_LIMIT) {
            session.history += chunk;
            if (session.history.length > HISTORY_LIMIT) {
                session.history = session.history.slice(-HISTORY_LIMIT);
            }
        }
        if (session.flushTimer) {
            return;
        }
        // 16ms 合并，避免高频输出打爆 MQTT
        session.flushTimer = setTimeout(() => {
            session.flushTimer = null;
            const data = session.buffer;
            session.buffer = '';
            if (data) {
                try {
                    this.sink(session.id, data);
                } catch (e) {
                    this.log(`terminal sink failed: ${String(e)}`, 'warn');
                }
            }
        }, FLUSH_MS);
    }

    private touch(session: Session) {
        if (session.idleTimer) {
            clearTimeout(session.idleTimer);
        }
        session.idleTimer = setTimeout(() => {
            this.log(`terminal session idle timeout: ${session.id}`, 'info');
            this.close(session.id);
        }, IDLE_MS);
    }

    async open(params: { sessionId?: string; cwd?: string; cols?: number; rows?: number }) {
        const sessionId = params.sessionId;
        if (!sessionId) {
            throw new Error('terminal.open: sessionId required');
        }
        const existing = this.sessions.get(sessionId);
        if (existing) {
            // 2026-10-21：客户端切 Tab 后重新 attach，回放最近输出，保持会话连续
            this.touch(existing);
            return {
                sessionId,
                mode: existing.isPty ? 'pty' : 'pipe',
                reused: true,
                replay: existing.history,
            };
        }

        if (this.ptyModule === undefined) {
            this.ptyModule = await loadPty();
            if (!this.ptyModule) {
                this.log('node-pty unavailable, fallback to pipe mode (no TTY)', 'warn');
            }
        }

        const cwd = params.cwd && params.cwd.length > 0 ? params.cwd : this.defaultCwd();
        const cols = params.cols && params.cols > 0 ? params.cols : 120;
        const rows = params.rows && params.rows > 0 ? params.rows : 30;
        const env = { ...process.env, TERM: 'xterm-256color', LANG: process.env.LANG ?? 'C.UTF-8' };

        let proc: any;
        let isPty = false;

        if (this.ptyModule?.spawn) {
            proc = this.ptyModule.spawn('bash', ['-il'], {
                name: 'xterm-256color',
                cols,
                rows,
                cwd,
                env,
            });
            isPty = true;
        } else {
            proc = spawn('bash', ['-il'], { cwd, env, stdio: 'pipe' }) as ChildProcessWithoutNullStreams;
            isPty = false;
        }

        const session: Session = {
            id: sessionId,
            proc,
            isPty,
            buffer: '',
            history: '',
            flushTimer: null,
            idleTimer: null,
            closed: false,
        };
        this.sessions.set(sessionId, session);
        this.touch(session);

        const onData = (data: string | Buffer) => {
            this.touch(session);
            this.append(session, typeof data === 'string' ? data : data.toString('utf8'));
        };

        if (isPty) {
            proc.onData(onData);
            proc.onExit((e: { exitCode?: number }) => {
                this.log(`terminal exited: ${sessionId}, code=${e?.exitCode}`, 'info');
                this.close(sessionId, true);
            });
        } else {
            proc.stdout?.on('data', onData);
            proc.stderr?.on('data', onData);
            proc.on('exit', (code: number | null) => {
                this.log(`terminal exited: ${sessionId}, code=${code}`, 'info');
                this.close(sessionId, true);
            });
            proc.on('error', (err: Error) => {
                this.log(`terminal error: ${sessionId}, ${err.message}`, 'error');
                this.append(session, `\r\n[terminal error] ${err.message}\r\n`);
            });
        }

        this.log(`terminal opened: ${sessionId}, mode=${isPty ? 'pty' : 'pipe'}, cwd=${cwd}`, 'info');
        return { sessionId, mode: isPty ? 'pty' : 'pipe' };
    }

    write(sessionId: string, data: string) {
        const session = this.sessions.get(sessionId);
        if (!session || session.closed) {
            throw new Error('terminal session not found');
        }
        this.touch(session);
        if (session.isPty) {
            session.proc.write(data);
        } else {
            session.proc.stdin?.write(data);
        }
        return { sessionId };
    }

    resize(sessionId: string, cols: number, rows: number) {
        const session = this.sessions.get(sessionId);
        if (!session || session.closed) {
            throw new Error('terminal session not found');
        }
        if (session.isPty && session.proc.resize) {
            session.proc.resize(cols, rows);
        }
        return { sessionId };
    }

    close(sessionId: string, alreadyExited = false) {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return { sessionId, closed: false };
        }
        session.closed = true;
        if (session.flushTimer) {
            clearTimeout(session.flushTimer);
            session.flushTimer = null;
        }
        if (session.idleTimer) {
            clearTimeout(session.idleTimer);
            session.idleTimer = null;
        }
        if (!alreadyExited) {
            try {
                if (session.isPty) {
                    session.proc.kill();
                } else {
                    session.proc.kill('SIGHUP');
                }
            } catch {
                // 忽略
            }
        }
        this.sessions.delete(sessionId);
        return { sessionId, closed: true };
    }

    disposeAll() {
        for (const id of Array.from(this.sessions.keys())) {
            this.close(id);
        }
    }
}
