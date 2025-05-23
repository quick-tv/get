import childProcess from 'node:child_process';
import fs from 'graceful-fs';
import os from 'node:os';
import path from 'node:path';

import {
  QuickTVDownloadCacheMode,
  QuickTVGenericArtifactDetails,
  QuickTVPlatformArtifactDetailsWithDefaults,
} from './types.js';

async function useAndRemoveDirectory<T>(
  directory: string,
  fn: (directory: string) => Promise<T>,
): Promise<T> {
  let result: T;
  try {
    result = await fn(directory);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }

  return result;
}

export async function mkdtemp(parentDirectory: string = os.tmpdir()): Promise<string> {
  const tempDirectoryPrefix = 'electron-download-';
  return await fs.promises.mkdtemp(path.resolve(parentDirectory, tempDirectoryPrefix));
}

export enum TempDirCleanUpMode {
  CLEAN,
  ORPHAN,
}

export async function withTempDirectoryIn<T>(
  parentDirectory: string = os.tmpdir(),
  fn: (directory: string) => Promise<T>,
  cleanUp: TempDirCleanUpMode,
): Promise<T> {
  const tempDirectory = await mkdtemp(parentDirectory);
  if (cleanUp === TempDirCleanUpMode.CLEAN) {
    return useAndRemoveDirectory(tempDirectory, fn);
  } else {
    return fn(tempDirectory);
  }
}

export async function withTempDirectory<T>(
  fn: (directory: string) => Promise<T>,
  cleanUp: TempDirCleanUpMode,
): Promise<T> {
  return withTempDirectoryIn(undefined, fn, cleanUp);
}

export function normalizeVersion(version: string): string {
  if (!version.startsWith('v')) {
    return `v${version}`;
  }
  return version;
}

/**
 * Runs the `uname` command and returns the trimmed output.
 */
export function uname(): string {
  return childProcess.execSync('uname -m').toString().trim();
}

/**
 * Generates an architecture name that would be used in an Electron or Node.js
 * download file name.
 */
export function getNodeArch(arch: string): string {
  if (arch === 'arm') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    switch ((process.config.variables as any).arm_version) {
      case '6':
        return uname();
      case '7':
      default:
        return 'armv7l';
    }
  }

  return arch;
}

/**
 * Generates an architecture name that would be used in an Electron or Node.js
 * download file name from the `process` module information.
 *
 * @category Utility
 */
export function getHostArch(): string {
  return getNodeArch(process.arch);
}

export function ensureIsTruthyString<T, K extends keyof T>(obj: T, key: K): void {
  if (!obj[key] || typeof obj[key] !== 'string') {
    throw new Error(`Expected property "${String(key)}" to be provided as a string but it was not`);
  }
}

export function isOfficialLinuxIA32Download(
  platform: string,
  arch: string,
  version: string,
  mirrorOptions?: object,
): boolean {
  return (
    platform === 'linux' &&
    arch === 'ia32' &&
    Number(version.slice(1).split('.')[0]) >= 4 &&
    typeof mirrorOptions === 'undefined'
  );
}

/**
 * Find the value of a environment variable which may or may not have the
 * prefix, in a case-insensitive manner.
 */
export function getEnv(prefix = ''): (name: string) => string | undefined {
  const envsLowerCase: NodeJS.ProcessEnv = {};

  for (const envKey in process.env) {
    envsLowerCase[envKey.toLowerCase()] = process.env[envKey];
  }

  return (name: string): string | undefined => {
    return (
      envsLowerCase[`${prefix}${name}`.toLowerCase()] ||
      envsLowerCase[name.toLowerCase()] ||
      undefined
    );
  };
}

export function setEnv(key: string, value: string | undefined): void {
  // The `void` operator always returns `undefined`.
  // See: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/void
  if (value !== void 0) {
    process.env[key] = value;
  }
}

export function effectiveCacheMode(
  artifactDetails: QuickTVPlatformArtifactDetailsWithDefaults | QuickTVGenericArtifactDetails,
): QuickTVDownloadCacheMode {
  return artifactDetails.cacheMode || QuickTVDownloadCacheMode.ReadWrite;
}

export function shouldTryReadCache(cacheMode: QuickTVDownloadCacheMode): boolean {
  return (
    cacheMode === QuickTVDownloadCacheMode.ReadOnly ||
    cacheMode === QuickTVDownloadCacheMode.ReadWrite
  );
}

export function shouldWriteCache(cacheMode: QuickTVDownloadCacheMode): boolean {
  return (
    cacheMode === QuickTVDownloadCacheMode.WriteOnly ||
    cacheMode === QuickTVDownloadCacheMode.ReadWrite
  );
}

export function doesCallerOwnTemporaryOutput(cacheMode: QuickTVDownloadCacheMode): boolean {
  return (
    cacheMode === QuickTVDownloadCacheMode.Bypass || cacheMode === QuickTVDownloadCacheMode.ReadOnly
  );
}
