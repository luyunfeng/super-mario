// What went wrong with a run, in the few kinds a person can act on.
//
// The kind is worked out when the run fails, from the error that was thrown, because that is
// the only moment the error is in hand. The stage is worked out when the run is read, from how
// far it got. Neither is read out of the error's words: words change, and a kind guessed from
// them would be wrong in the one case it matters.
import type { Run } from '../../protocol/src/index.ts';

/** Where it went wrong. */
export type FailureStage = 'dispatch' | 'start' | 'run' | 'recover';

/** What kind of thing went wrong. */
export type FailureKind =
  | 'network'      // the server could not reach the machine, or lost it
  | 'machine'      // the machine's agent refused or could not do it
  | 'executor'     // the thing that runs the task said it failed
  | 'server'       // the workbench itself
  | 'refused'      // it was not allowed: a policy said no, an input was not valid
  | 'unknown';

/** A machine channel error, as the workbench's MachineError is shaped. */
interface ChannelError extends Error { status?: number; delivery?: 'no' | 'unknown'; lost?: boolean }

/**
 * The kind of a failure, from the error that ended the run.
 *
 * A MachineError is told by its status: not being able to talk to the machine at all is the
 * network, the machine answering with a refusal is the machine, and anything else it answered
 * is the machine too. An InputError is something the workbench would not do. What the executor
 * itself reported has already been written as the run's failure and does not come through here.
 */
export function failureKind(error: unknown): FailureKind {
  if (!(error instanceof Error)) return 'unknown';
  // An effect that ended in an error wraps it. What kind it was is read through the wrapping.
  if (error.name === 'EffectError') return error.cause === undefined ? 'server' : failureKind(error.cause);
  // The machine channel names its own errors. Told apart by status and delivery, which it sets.
  if (error.name === 'MachineError') {
    const { status, delivery, lost } = error as ChannelError;
    // The connection went away after the request was sent. What the machine did with it is
    // not known, but what failed is the connection.
    if (lost) return 'network';
    if (status === 503 && delivery === 'no') return 'network';
    if (status === 504) return 'network';
    if (typeof status === 'number' && status < 500) return 'refused';
    return 'machine';
  }
  // The workbench refuses an action it will not do, and a hook that stops a dispatch is one too.
  if (error.name === 'InputError' || error.name === 'MailInputError' || error.name === 'PluginCallError') return 'refused';
  // Anything else that ended a run came from the workbench itself.
  return 'server';
}

/**
 * Where a run was when it stopped, read from how far it got.
 *
 * A run that was being recovered across a restart is a recovery. A run that never got a session
 * did not start, and one that was stopped before it left the queue was still being dispatched.
 * A run with a session was running.
 */
export function failureStage(run: Pick<Run, 'sessionId' | 'status' | 'error' | 'createdAt'> & { startedAt?: string }): FailureStage {
  if (/服务重启/.test(run.error ?? '')) return 'recover';
  if (run.sessionId) return 'run';
  return run.status === 'cancelled' ? 'dispatch' : 'start';
}
