declare module 'zip-stream' {
  import { Readable, Transform } from 'node:stream';
  export default class ZipStream extends Transform {
    constructor(options?: {forceZip64?: boolean; store?: boolean; zlib?: {level?: number}});
    entry(source: Readable | Buffer | string | null, entry: {
      name: string; mode?: number; date?: Date; type?: 'file' | 'directory'; store?: boolean;
    }, callback: (error?: Error | null) => void): this;
    finalize(): void;
  }
}
