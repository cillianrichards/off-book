// Logging as JSON lines, one object per line, so a log collector can parse them (X-01 builds on this).

export type Fields = Readonly<Record<string, unknown>>;

export interface Log {
  info(message: string, fields?: Fields): void;
  warn(message: string, fields?: Fields): void;
  error(message: string, fields?: Fields): void;
}

const write = (
  stream: NodeJS.WriteStream,
  level: string,
  message: string,
  fields: Fields | undefined,
): void => {
  stream.write(`${JSON.stringify({ time: new Date().toISOString(), level, message, ...fields })}\n`);
};

export const jsonLog: Log = {
  info: (message, fields) => write(process.stdout, 'info', message, fields),
  warn: (message, fields) => write(process.stderr, 'warn', message, fields),
  error: (message, fields) => write(process.stderr, 'error', message, fields),
};

export const silentLog: Log = { info: () => {}, warn: () => {}, error: () => {} };

/** The fields worth logging from a thrown value, which need not be an Error. */
export const errorFields = (error: unknown): Fields =>
  error instanceof Error ? { error: error.message, stack: error.stack } : { error: String(error) };
