/**
 * What a transcription engine is asked and what it answers. The engine is a contribution, so
 * the workbench never holds a speech model or a key: it hands audio to the engine the owner
 * chose and passes the answer back.
 */

/** The one audio format every engine is asked to take. */
export const TRANSCRIPTION_AUDIO = { encoding: 'pcm16', littleEndian: true, channels: 1, sampleRate: 16000 } as const;
/** The most audio sent in one call: exactly eight seconds of that format. */
export const TRANSCRIPTION_CHUNK_SECONDS = 8;
export const TRANSCRIPTION_CHUNK_BYTES = TRANSCRIPTION_AUDIO.sampleRate * 2 * TRANSCRIPTION_CHUNK_SECONDS;
/** The most audio one job takes. */
export const TRANSCRIPTION_MAX_SECONDS = 15 * 60;

/** A transcription engine as it offers itself. */
export interface TranscriptionEngine {
  kind: 'transcription';
  /** The name of the service the engine provides. */
  service: string;
  name: string;
  /** BCP 47 tags the engine says it is good at. Empty means it does not say. */
  languages?: string[];
}

export interface TranscriptionSegment { from: number; to: number; text: string }
/** A span the engine did not trust any text for. It is reported, never guessed. */
export interface TranscriptionGap { from: number; to: number }

export interface TranscriptionResult {
  segments: TranscriptionSegment[];
  gaps: TranscriptionGap[];
  /** How much audio the job took, in seconds. */
  seconds: number;
}

/** The audio of one job, already in the format every engine takes. */
export interface TranscriptionJob {
  /** PCM16 little-endian, mono, 16 kHz. */
  audio: Uint8Array;
  /** A BCP 47 hint. The engine still follows the speech. */
  language?: string;
  /** A short name of what the audio is, for the log. Never what is said. */
  label?: string;
}

export type TranscriptionProblem = 'unavailable' | 'not_configured' | 'invalid_audio' | 'too_long' | 'failed';

export class TranscriptionError extends Error {
  readonly problem: TranscriptionProblem;
  constructor(problem: TranscriptionProblem, message: string) { super(message); this.name = 'TranscriptionError'; this.problem = problem; }
}

/** The owner's choice among the engines that are installed. */
export interface TranscriptionChoice {
  /** The service name of the chosen engine. */
  service: string;
}
