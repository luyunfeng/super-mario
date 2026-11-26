// A stand-in SMTP server for the tests. It speaks enough of the protocol to send one message,
// with or without STARTTLS, and can be told to refuse a step or to break off at one.
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSecureContext, createServer as createTlsServer, TLSSocket } from 'node:tls';
import { promisify } from 'node:util';

/** A step of the conversation at which a test ends it. */
export type Step = 'greeting' | 'ehlo' | 'auth' | 'mail-from' | 'rcpt-to' | 'data-command' | 'after-354' | 'after-dot';

export type FakeSmtpOptions = {
  /** The server closes the connection at this step without answering. */
  breakAt?: Step;
  /** The server answers this step with a lasting refusal. */
  refuseAt?: Step;
  /** The server does not offer STARTTLS, so an account that requires it cannot send. */
  noStartTls?: boolean;
  /** The connection is encrypted from the start, as port 465 is. */
  secure?: boolean;
  /** Called when the conversation reaches a step, so a test can act at a known moment. */
  onStep?: (step: Step) => void;
  /** The server takes the message and then says nothing, as a server that is stuck would.
   *  It answers only when `answer` is called, or never if it is not. */
  holdAfterMessage?: boolean;
  /** The server answers DATA with 250 instead of the usual 354. Some servers do. */
  dataAnswers250?: boolean;
};

export type FakeSmtp = {
  port: number;
  /** Every line the client sent, with the credentials taken out. */
  said: string[];
  /** The message as the client gave it, without the line that ends it. */
  message: () => string;
  /** Whether STARTTLS was asked for, and whether the connection was encrypted after it. */
  upgraded: () => boolean;
  /** Lets a held server give its answer to the message. */
  answer: () => void;
  close: () => Promise<void>;
};

/** A key and certificate made for one run of the tests. They are in a temporary directory and
 *  are removed with it. Nothing here is used outside the tests. */
export async function makeCertificate(): Promise<{ key: Buffer; cert: Buffer } | undefined> {
  const directory = await mkdtemp(join(tmpdir(), 'mario-mail-tls-'));
  try {
    await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem')], { timeout: 30_000 });
    return { key: await readFile(join(directory, 'key.pem')), cert: await readFile(join(directory, 'cert.pem')) };
  } catch {
    // A machine without openssl cannot make one. The tests that need it say so and are skipped.
    return undefined;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** What the server answers a step it refuses. A lasting code says nothing was taken. */
const refusals: Partial<Record<Step, string>> = {
  auth: '535 Authentication failed', 'mail-from': '550 Sender rejected', 'rcpt-to': '550 No such user here',
  'data-command': '554 Message rejected', 'after-dot': '554 Message rejected',
};

export async function fakeSmtp(options: FakeSmtpOptions & { tls?: { key: Buffer; cert: Buffer } } = {}): Promise<FakeSmtp> {
  const said: string[] = [];
  let message = '';
  let upgraded = false;
  const sockets = new Set<Socket>();
  let server: Server;
  let held: (() => void) | undefined;

  /** The conversation of one connection. It starts again after STARTTLS, on the same socket. */
  function converse(socket: Socket) {
    let step: Step = 'greeting';
    let collecting = false;
    const lines: string[] = [];
    // A command can arrive split over two reads, so what is not a whole line is kept.
    let pending = '';
    const write = (line: string) => { if (!socket.writable) return; socket.write(line + '\r\n'); };
    /** Ends this step. True when the connection is over. */
    const end = (): boolean => {
      options.onStep?.(step);
      if (options.breakAt === step) { socket.destroy(); return true; }
      if (options.refuseAt === step) {
        write(refusals[step] ?? '554 Rejected');
        // After the message was given and refused the talk is over; before, the client may go on.
        if (step === 'after-dot') socket.end();
        return true;
      }
      return false;
    };
    const secure = () => (socket as TLSSocket).encrypted === true;
    socket.on('data', function onData(chunk: Buffer) {
      if (collecting) {
        pending += chunk.toString('utf8');
        // The message ends with a line holding one dot.
        const endAt = pending.search(/\r\n\.\r\n$/);
        if (endAt < 0) { lines.push(pending); pending = ''; return; }
        lines.push(pending.slice(0, endAt + 2));
        message = lines.join('');
        pending = '';
        collecting = false;
        step = 'after-dot';
        if (end()) return;
        if (options.holdAfterMessage) { held = () => write('250 OK: queued as 1'); return; }
        write('250 OK: queued as 1');
        return;
      }
      pending += chunk.toString('utf8');
      let cut = pending.indexOf('\r\n');
      while (cut >= 0) {
        const line = pending.slice(0, cut);
        pending = pending.slice(cut + 2);
        cut = pending.indexOf('\r\n');
        if (!line) continue;
        // The password goes over the connection in the clear in an AUTH command, or base64
        // in the answer to a LOGIN challenge. Neither is kept.
        const command = line.split(/[ ]/)[0]!.toUpperCase();
        // An AUTH command carries its credentials on the same line for PLAIN, and a base64
        // word on its own is the answer to a LOGIN challenge.
        said.push(command === 'AUTH' || /^[A-Za-z0-9+/=]{16,}={0,2}$/.test(line) ? command + ' [hidden]' : line);
        const whole = line.toUpperCase();
        if (command === 'EHLO' || command === 'HELO') {
          step = 'ehlo';
          if (end()) return;
          write('250-fake.local');
          // STARTTLS is offered once, before the connection is encrypted.
          if (!options.noStartTls && !options.secure && options.tls && !secure()) write('250-STARTTLS');
          write('250 AUTH PLAIN LOGIN');
          continue;
        }
        if (command === 'STARTTLS') {
          if (!options.tls || secure()) { write('454 TLS not available'); continue; }
          write('220 Ready to start TLS');
          // The same connection is upgraded. What comes after is the encrypted talk.
          const secureSocket = new TLSSocket(socket, { isServer: true, secureContext: createSecureContext({ key: options.tls.key, cert: options.tls.cert }) });
          sockets.add(secureSocket);
          secureSocket.on('close', () => sockets.delete(secureSocket));
          socket.removeListener('data', onData);
          upgraded = true;
          // The handshake is not done when the socket is made. The talk goes on only once it
          // is, or the first command of the encrypted part is read before there is anything
          // to read it with.
          secureSocket.once('secure', () => converse(secureSocket));
          secureSocket.on('error', () => {});
          return;
        }
        if (command === 'AUTH') {
          step = 'auth';
          if (end()) return;
          const method = line.toUpperCase().split(/\s+/)[1];
          // PLAIN carries everything in one line. LOGIN asks for the user and then the password.
          if (method === 'LOGIN' && !/=$/.test(line.split(/\s+/)[2] ?? '')) { write('334 VXNlcm5hbWU6'); continue; }
          write('235 Authentication successful');
          continue;
        }
        if (command === 'MAIL') { step = 'mail-from'; if (end()) return; write('250 OK'); continue; }
        if (command === 'RCPT') { step = 'rcpt-to'; if (end()) return; write('250 OK'); continue; }
        if (command === 'DATA') {
          step = 'data-command';
          if (end()) return;
          write((options.dataAnswers250 ? '250' : '354') + ' End data with <CR><LF>.<CR><LF>');
          step = 'after-354';
          if (options.breakAt === 'after-354') { socket.destroy(); return; }
          collecting = true; lines.length = 0; pending = '';
          continue;
        }
        if (command === 'QUIT') { write('221 Bye'); socket.end(); continue; }
        write('250 OK');
      }
    });
    if (options.breakAt === 'greeting') { socket.destroy(); return; }
    // After STARTTLS the server does not greet again: the client starts with EHLO at once.
    if ((socket as TLSSocket).encrypted && upgraded) return;
    write('220 fake.local ESMTP');
  }

  const onConnection = (socket: Socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); converse(socket); };
  if (options.secure && options.tls) {
    const tlsServer = createTlsServer({ key: options.tls.key, cert: options.tls.cert }, onConnection);
    server = tlsServer as unknown as Server;
  } else server = createServer(onConnection);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    port, said, message: () => message, upgraded: () => upgraded, answer: () => { const give = held; held = undefined; give?.(); },
    close: () => new Promise<void>(resolve => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); }),
  };
}

/** Whether a port takes a connection. Used to check that a server is really closed. */
export function takesConnection(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}
