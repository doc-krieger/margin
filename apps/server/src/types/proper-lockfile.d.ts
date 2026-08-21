declare module "proper-lockfile" {
  export interface LockOptions {
    stale?: number;
    update?: number;
    retries?: number | { retries?: number; factor?: number; minTimeout?: number; maxTimeout?: number };
    realpath?: boolean;
    onCompromised?: (error: Error) => void;
  }

  export type Release = () => Promise<void>;
  export function lock(file: string, options?: LockOptions): Promise<Release>;
  export function unlock(file: string, options?: LockOptions): Promise<void>;
  export function check(file: string, options?: LockOptions): Promise<boolean>;
}
