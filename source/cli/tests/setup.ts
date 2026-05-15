import { beforeEach, afterEach, onTestFailed } from 'vitest';

let _capturedOut = '';
let _capturedErr = '';
let _origOut: typeof process.stdout.write;
let _origErr: typeof process.stderr.write;

beforeEach(() => {
  _capturedOut = '';
  _capturedErr = '';
  _origOut = process.stdout.write.bind(process.stdout);
  _origErr = process.stderr.write.bind(process.stderr);

  (process.stdout as NodeJS.WriteStream).write = (
    chunk: string | Buffer | Uint8Array,
  ): boolean => {
    _capturedOut += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  };
  (process.stderr as NodeJS.WriteStream).write = (
    chunk: string | Buffer | Uint8Array,
  ): boolean => {
    _capturedErr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  };

  onTestFailed(() => {
    if (_capturedOut) _origOut(`\n── captured stdout ──\n${_capturedOut}── end stdout ──\n`);
    if (_capturedErr) _origOut(`\n── captured stderr ──\n${_capturedErr}── end stderr ──\n`);
  });
});

afterEach(() => {
  (process.stdout as NodeJS.WriteStream).write = _origOut;
  (process.stderr as NodeJS.WriteStream).write = _origErr;
});
