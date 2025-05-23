import debug from 'debug';
import fs from 'graceful-fs';
import path from 'node:path';
import util from 'node:util';
import semver from 'semver';
import sumchecker from 'sumchecker';

import { getArtifactFileName, getArtifactRemoteURL, getArtifactVersion } from './artifact-utils.js';
import {
  QuickTVArtifactDetails,
  QuickTVDownloadCacheMode,
  QuickTVDownloadRequestOptions,
  QuickTVGenericArtifactDetails,
  QuickTVPlatformArtifactDetails,
  QuickTVPlatformArtifactDetailsWithDefaults,
} from './types.js';
import { Cache } from './Cache.js';
import { getDownloaderForSystem } from './downloader-resolver.js';
import { initializeProxy } from './proxy.js';
import {
  withTempDirectoryIn,
  getHostArch,
  getNodeArch,
  ensureIsTruthyString,
  isOfficialLinuxIA32Download,
  mkdtemp,
  doesCallerOwnTemporaryOutput,
  effectiveCacheMode,
  shouldTryReadCache,
  TempDirCleanUpMode,
} from './utils.js';

export { getHostArch } from './utils.js';
export { initializeProxy } from './proxy.js';
export * from './types.js';

const d = debug('@quick-tv/get:index');

if (process.env.QUICK_TV_GET_USE_PROXY) {
  initializeProxy();
}

type ArtifactDownloader = (
  _artifactDetails: QuickTVPlatformArtifactDetailsWithDefaults | QuickTVGenericArtifactDetails,
) => Promise<string>;

async function validateArtifact(
  artifactDetails: QuickTVArtifactDetails,
  downloadedAssetPath: string,
  _downloadArtifact: ArtifactDownloader,
): Promise<void> {
  return await withTempDirectoryIn(
    artifactDetails.tempDirectory,
    async (tempFolder) => {
      // Don't try to verify the hash of the hash file itself
      // and for older versions that don't have a SHASUMS256.txt
      if (
        !artifactDetails.artifactName.startsWith('SHASUMS256') &&
        !artifactDetails.unsafelyDisableChecksums &&
        semver.gte(artifactDetails.version, '1.3.2')
      ) {
        let shasumPath: string;
        const checksums = artifactDetails.checksums;
        if (checksums) {
          shasumPath = path.resolve(tempFolder, 'SHASUMS256.txt');
          const fileNames: string[] = Object.keys(checksums);
          if (fileNames.length === 0) {
            throw new Error(
              'Provided "checksums" object is empty, cannot generate a valid SHASUMS256.txt',
            );
          }
          const generatedChecksums = fileNames
            .map((fileName) => `${checksums[fileName]} *${fileName}`)
            .join('\n');
          await util.promisify(fs.writeFile)(shasumPath, generatedChecksums);
        } else {
          shasumPath = await _downloadArtifact({
            isGeneric: true,
            version: artifactDetails.version,
            artifactName: 'SHASUMS256.txt',
            downloadOptions: artifactDetails.downloadOptions,
            cacheRoot: artifactDetails.cacheRoot,
            downloader: artifactDetails.downloader,
            mirrorOptions: artifactDetails.mirrorOptions,
            // Never use the cache for loading checksums, load
            // them fresh every time
            cacheMode: QuickTVDownloadCacheMode.Bypass,
          });
        }

        try {
          // For versions 1.3.2 - 1.3.4, need to overwrite the `defaultTextEncoding` option:
          // https://github.com/electron/electron/pull/6676#discussion_r75332120
          if (semver.satisfies(artifactDetails.version, '1.3.2 - 1.3.4')) {
            const validatorOptions: sumchecker.ChecksumOptions = {};
            validatorOptions.defaultTextEncoding = 'binary';
            const checker = new sumchecker.ChecksumValidator(
              'sha256',
              shasumPath,
              validatorOptions,
            );
            await checker.validate(
              path.dirname(downloadedAssetPath),
              path.basename(downloadedAssetPath),
            );
          } else {
            await sumchecker('sha256', shasumPath, path.dirname(downloadedAssetPath), [
              path.basename(downloadedAssetPath),
            ]);
          }
        } finally {
          // Once we're done make sure we clean up the shasum temp dir
          await fs.promises.rm(path.dirname(shasumPath), { recursive: true, force: true });
        }
      }
    },
    doesCallerOwnTemporaryOutput(effectiveCacheMode(artifactDetails))
      ? TempDirCleanUpMode.ORPHAN
      : TempDirCleanUpMode.CLEAN,
  );
}

/**
 * Downloads an artifact from an Electron release and returns an absolute path
 * to the downloaded file.
 *
 * Each release of Electron comes with artifacts, many of which are
 * platform/arch-specific (e.g. `ffmpeg-v31.0.0-darwin-arm64.zip`) and others that
 * are generic (e.g. `SHASUMS256.txt`).
 *
 *
 * @param artifactDetails - The information required to download the artifact
 * @category Download Artifact
 */
export async function downloadArtifact(
  artifactDetails: QuickTVPlatformArtifactDetailsWithDefaults | QuickTVGenericArtifactDetails,
): Promise<string> {
  const details: QuickTVArtifactDetails = {
    ...(artifactDetails as QuickTVArtifactDetails),
  };
  if (!artifactDetails.isGeneric) {
    const platformArtifactDetails = details as QuickTVPlatformArtifactDetails;
    if (!platformArtifactDetails.platform) {
      d('No platform found, defaulting to the host platform');
      platformArtifactDetails.platform = process.platform;
    }
    if (platformArtifactDetails.arch) {
      platformArtifactDetails.arch = getNodeArch(platformArtifactDetails.arch);
    } else {
      d('No arch found, defaulting to the host arch');
      platformArtifactDetails.arch = getHostArch();
    }
  }
  ensureIsTruthyString(details, 'version');

  details.version = getArtifactVersion(details);
  const fileName = getArtifactFileName(details);
  const url = await getArtifactRemoteURL(details);
  const cache = new Cache(details.cacheRoot);
  const cacheMode = effectiveCacheMode(details);

  // Do not check if the file exists in the cache when force === true
  if (shouldTryReadCache(cacheMode)) {
    d(`Checking the cache (${details.cacheRoot}) for ${fileName} (${url})`);
    const cachedPath = cache.getPathForFileInCache(url, fileName);

    if (cachedPath === null) {
      d('Cache miss');
    } else {
      d('Cache hit');
      let artifactPath = cachedPath;
      if (doesCallerOwnTemporaryOutput(cacheMode)) {
        // Copy out of cache into temporary directory if readOnly cache so
        // that the caller can take ownership of the returned file
        const tempDir = await mkdtemp(artifactDetails.tempDirectory);
        artifactPath = path.resolve(tempDir, fileName);
        await util.promisify(fs.copyFile)(cachedPath, artifactPath);
      }
      try {
        await validateArtifact(details, artifactPath, downloadArtifact);

        return artifactPath;
      } catch (err) {
        if (doesCallerOwnTemporaryOutput(cacheMode)) {
          await fs.promises.rm(path.dirname(artifactPath), { recursive: true, force: true });
        }
        d("Artifact in cache didn't match checksums", err);
        d('falling back to re-download');
      }
    }
  }

  if (
    !details.isGeneric &&
    isOfficialLinuxIA32Download(
      details.platform,
      details.arch,
      details.version,
      details.mirrorOptions,
    )
  ) {
    console.warn('Official Linux/ia32 support is deprecated.');
    console.warn('For more info: https://electronjs.org/blog/linux-32bit-support');
  }

  return await withTempDirectoryIn(
    details.tempDirectory,
    async (tempFolder) => {
      const tempDownloadPath = path.resolve(tempFolder, getArtifactFileName(details));

      const downloader = details.downloader || (await getDownloaderForSystem());
      d(
        `Downloading ${url} to ${tempDownloadPath} with options: ${JSON.stringify(
          details.downloadOptions,
        )}`,
      );
      await downloader.download(url, tempDownloadPath, details.downloadOptions);

      d('attempting to validate artifact...', { details });
      await validateArtifact(details, tempDownloadPath, downloadArtifact);

      d('artifact validated');

      if (doesCallerOwnTemporaryOutput(cacheMode)) {
        return tempDownloadPath;
      } else {
        return await cache.putFileInCache(url, tempDownloadPath, fileName);
      }
    },
    doesCallerOwnTemporaryOutput(cacheMode) ? TempDirCleanUpMode.ORPHAN : TempDirCleanUpMode.CLEAN,
  );
}

/**
 * Downloads the Electron binary for a specific version and returns an absolute path to a
 * ZIP file.
 *
 * @param version - The version of Electron you want to download (e.g. `31.0.0`)
 * @param options - Options to customize the download behavior
 * @returns An absolute path to the downloaded ZIP file
 * @category Download Electron
 */
export function download(
  version: string,
  options?: QuickTVDownloadRequestOptions,
): Promise<string> {
  return downloadArtifact({
    ...options,
    version,
    platform: process.platform,
    arch: process.arch,
    artifactName: 'quick-tv',
  });
}
