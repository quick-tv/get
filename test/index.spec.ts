import os from 'node:os';
import path from 'node:path';
import util from 'node:util';

import fs from 'graceful-fs';
import sumchecker from 'sumchecker';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FixtureDownloader } from './FixtureDownloader';
import { download, downloadArtifact } from '../src';
import { DownloadOptions, QuickTVDownloadCacheMode } from '../src/types';

vi.mock('sumchecker');

describe('Public API', () => {
  const downloader = new FixtureDownloader();

  let cacheRoot: string;
  beforeEach(async () => {
    cacheRoot = await fs.promises.mkdtemp(path.resolve(os.tmpdir(), 'electron-download-spec-'));
  });

  afterEach(async () => {
    await fs.promises.rm(cacheRoot, { recursive: true, force: true });
  });

  describe('download()', () => {
    it('should return a valid path to a downloaded zip file', async () => {
      const zipPath = await download('2.0.10', {
        cacheRoot,
        downloader,
      });
      expect(typeof zipPath).toEqual('string');
      expect(fs.existsSync(zipPath)).toEqual(true);
      expect(path.extname(zipPath)).toEqual('.zip');
      expect(path.dirname(zipPath).startsWith(cacheRoot)).toEqual(true);
      expect(fs.readdirSync(cacheRoot).length).toBeGreaterThan(0);
    });

    it('should return a valid path to a downloaded zip file for nightly releases', async () => {
      const zipPath = await download('6.0.0-nightly.20190213', {
        cacheRoot,
        downloader,
      });
      expect(typeof zipPath).toEqual('string');
      expect(fs.existsSync(zipPath)).toEqual(true);
      expect(path.extname(zipPath)).toEqual('.zip');
    });

    it('should accept a custom downloader', async () => {
      const zipPath = await download('2.0.3', {
        cacheRoot,
        unsafelyDisableChecksums: true,
        downloader: {
          async download(url: string, targetPath: string): Promise<void> {
            expect(
              url.replace(process.platform, 'platform').replace(process.arch, 'arch'),
            ).toMatchSnapshot();
            await util.promisify(fs.writeFile)(targetPath, 'faked from downloader');
          },
        },
      });
      expect(await util.promisify(fs.readFile)(zipPath, 'utf8')).toEqual('faked from downloader');
    });

    it('should pass download options to a custom downloader', async () => {
      const downloadOpts = {
        magic: 'option',
        trick: 'shot',
      };
      await download('2.0.3', {
        cacheRoot,
        unsafelyDisableChecksums: true,
        downloader: {
          async download(url: string, targetPath: string, opts?: DownloadOptions): Promise<void> {
            expect(opts).toStrictEqual(downloadOpts);
            await util.promisify(fs.writeFile)(targetPath, 'file');
          },
        },
        downloadOptions: downloadOpts,
      });
    });

    it('should download a custom version of a zip file', async () => {
      process.env.ELECTRON_CUSTOM_VERSION = '2.0.10';
      const zipPath = await download('2.0.3', {
        cacheRoot,
        downloader,
      });
      expect(typeof zipPath).toEqual('string');
      expect(fs.existsSync(zipPath)).toEqual(true);
      expect(path.basename(zipPath)).toMatch(/v2.0.10/);
      expect(path.extname(zipPath)).toEqual('.zip');
      process.env.ELECTRON_CUSTOM_VERSION = '';
    });

    it('should not put artifact in cache when cacheMode=ReadOnly', async () => {
      const zipPath = await download('2.0.10', {
        cacheRoot,
        downloader,
        cacheMode: QuickTVDownloadCacheMode.ReadOnly,
      });
      expect(typeof zipPath).toEqual('string');
      expect(fs.existsSync(zipPath)).toEqual(true);
      expect(path.extname(zipPath)).toEqual('.zip');
      expect(path.dirname(zipPath).startsWith(cacheRoot)).toEqual(false);
      expect(fs.readdirSync(cacheRoot).length).toEqual(0);
    });

    it('should use cache hits when cacheMode=ReadOnly', async () => {
      const zipPath = await download('2.0.9', {
        cacheRoot,
        downloader,
      });
      await util.promisify(fs.writeFile)(zipPath, 'cached content');
      const zipPath2 = await download('2.0.9', {
        cacheRoot,
        downloader,
        cacheMode: QuickTVDownloadCacheMode.ReadOnly,
      });
      expect(zipPath2).not.toEqual(zipPath);
      expect(path.dirname(zipPath2).startsWith(cacheRoot)).toEqual(false);
      expect(await util.promisify(fs.readFile)(zipPath2, 'utf8')).toEqual('cached content');
    });
  });

  describe('downloadArtifact()', () => {
    it('should work for electron.d.ts', async () => {
      const dtsPath = await downloadArtifact({
        cacheRoot,
        downloader,
        isGeneric: true,
        version: '2.0.9',
        artifactName: 'electron.d.ts',
      });
      expect(fs.existsSync(dtsPath)).toEqual(true);
      expect(path.basename(dtsPath)).toEqual('electron.d.ts');
      expect(await util.promisify(fs.readFile)(dtsPath, 'utf8')).toContain(
        'declare namespace Electron',
      );
      expect(path.dirname(dtsPath).startsWith(cacheRoot)).toEqual(true);
      expect(fs.readdirSync(cacheRoot).length).toBeGreaterThan(0);
    });

    it('should work with the default platform/arch', async () => {
      const artifactPath = await downloadArtifact({
        downloader,
        version: '2.0.3',
        artifactName: 'electron',
      });
      expect(artifactPath).toContain(`electron-v2.0.3-${process.platform}-${process.arch}.zip`);
    });

    it('should download the same artifact for falsy platform/arch as default platform/arch', async () => {
      const defaultPath = await downloadArtifact({
        version: '2.0.3',
        artifactName: 'electron',
      });

      const undefinedPath = await downloadArtifact({
        version: '2.0.3',
        artifactName: 'electron',
        platform: undefined,
        arch: undefined,
      });

      expect(defaultPath).toEqual(undefinedPath);
    });

    it('should download linux/armv7l when linux/arm is passed as platform/arch', async () => {
      const zipPath = await downloadArtifact({
        cacheRoot,
        downloader,
        artifactName: 'electron',
        version: '2.0.9',
        platform: 'linux',
        arch: 'arm',
      });
      expect(path.basename(zipPath)).toMatchInlineSnapshot(`"electron-v2.0.9-linux-armv7l.zip"`);
    });

    it('should work for chromedriver', async () => {
      const driverPath = await downloadArtifact({
        cacheRoot,
        downloader,
        version: '2.0.9',
        artifactName: 'chromedriver',
        platform: 'darwin',
        arch: 'x64',
      });
      expect(fs.existsSync(driverPath)).toEqual(true);
      expect(path.basename(driverPath)).toMatchInlineSnapshot(
        `"chromedriver-v2.0.9-darwin-x64.zip"`,
      );
      expect(path.extname(driverPath)).toEqual('.zip');
    });

    it('should download a custom version of a zip file', async () => {
      process.env.ELECTRON_CUSTOM_VERSION = '2.0.10';
      const zipPath = await downloadArtifact({
        artifactName: 'electron',
        cacheRoot,
        downloader,
        platform: 'darwin',
        arch: 'x64',
        version: '2.0.3',
      });
      expect(typeof zipPath).toEqual('string');
      expect(fs.existsSync(zipPath)).toEqual(true);
      expect(path.basename(zipPath)).toMatchInlineSnapshot(`"electron-v2.0.10-darwin-x64.zip"`);
      expect(path.extname(zipPath)).toEqual('.zip');
      process.env.ELECTRON_CUSTOM_VERSION = '';
    });

    it('should download a custom version specified via mirror options', async () => {
      const zipPath = await downloadArtifact({
        artifactName: 'electron',
        cacheRoot,
        downloader,
        platform: 'darwin',
        arch: 'x64',
        version: '2.0.3',
        mirrorOptions: {
          customVersion: '2.0.10',
        },
      });
      expect(typeof zipPath).toEqual('string');
      expect(path.basename(zipPath)).toMatchInlineSnapshot(`"electron-v2.0.10-darwin-x64.zip"`);
    });

    it('should not put artifact in cache when cacheMode=ReadOnly', async () => {
      const driverPath = await downloadArtifact({
        cacheRoot,
        downloader,
        version: '2.0.9',
        artifactName: 'chromedriver',
        platform: 'darwin',
        arch: 'x64',
        cacheMode: QuickTVDownloadCacheMode.ReadOnly,
      });
      expect(fs.existsSync(driverPath)).toEqual(true);
      expect(path.basename(driverPath)).toMatchInlineSnapshot(
        `"chromedriver-v2.0.9-darwin-x64.zip"`,
      );
      expect(path.extname(driverPath)).toEqual('.zip');
      expect(path.dirname(driverPath).startsWith(cacheRoot)).toEqual(false);
      expect(fs.readdirSync(cacheRoot).length).toEqual(0);
    });

    it('should use cache hits when cacheMode=ReadOnly', async () => {
      const driverPath = await downloadArtifact({
        cacheRoot,
        downloader,
        version: '2.0.9',
        artifactName: 'chromedriver',
        platform: 'darwin',
        arch: 'x64',
      });
      await util.promisify(fs.writeFile)(driverPath, 'cached content');
      const driverPath2 = await downloadArtifact({
        cacheRoot,
        downloader,
        version: '2.0.9',
        artifactName: 'chromedriver',
        platform: 'darwin',
        arch: 'x64',
        cacheMode: QuickTVDownloadCacheMode.ReadOnly,
      });
      expect(driverPath2).not.toEqual(driverPath);
      expect(path.dirname(driverPath2).startsWith(cacheRoot)).toEqual(false);
      expect(await util.promisify(fs.readFile)(driverPath2, 'utf8')).toEqual('cached content');
    });

    describe('sumchecker', () => {
      beforeEach(() => {
        vi.clearAllMocks();
      });

      it('should use the default constructor for versions from v1.3.5 onward', async () => {
        await downloadArtifact({
          artifactName: 'electron',
          downloader,
          cacheMode: QuickTVDownloadCacheMode.WriteOnly,
          version: 'v1.3.5',
        });
        await downloadArtifact({
          artifactName: 'electron',
          downloader,
          cacheMode: QuickTVDownloadCacheMode.WriteOnly,
          version: 'v2.0.3',
        });

        expect(sumchecker).toHaveBeenCalledTimes(2);
        expect(sumchecker.ChecksumValidator).not.toHaveBeenCalled();
      });

      it('should use ChecksumValidator for v1.3.2 - v.1.3.4', async () => {
        await downloadArtifact({
          artifactName: 'electron',
          downloader,
          cacheMode: QuickTVDownloadCacheMode.WriteOnly,
          version: 'v1.3.3',
        });

        expect(sumchecker).not.toHaveBeenCalled();
        expect(sumchecker.ChecksumValidator).toHaveBeenCalledTimes(1);
      });

      it('should not be called for versions prior to v1.3.2', async () => {
        await downloadArtifact({
          artifactName: 'electron',
          downloader,
          cacheMode: QuickTVDownloadCacheMode.WriteOnly,
          version: 'v1.0.0',
        });

        expect(sumchecker).not.toHaveBeenCalled();
        expect(sumchecker.ChecksumValidator).not.toHaveBeenCalled();
      });
    });
  });
});
