import fs from 'node:fs';
import vm from 'node:vm';

const vectors = JSON.parse(fs.readFileSync('contracts/swir-dependency-vectors.json', 'utf8'));
const source = fs.readFileSync('swir-package-resolver.js', 'utf8');

for (const test of vectors.cases) {
  const catalog = [test.package, ...test.installed];
  const sandbox = {
    console,
    localStorage: { getItem: () => '[]' },
    window: {
      SWIR_PACKAGE_CATALOG: catalog,
      SwirAppSDK: { meta: { os: vectors.runtime.os, version: vectors.runtime.sdk, edition: vectors.runtime.edition } },
      SwirPlatform: {
        system: { info: () => ({ version: vectors.runtime.os, platformApi: vectors.runtime.platformApi, edition: vectors.runtime.edition }) },
        packages: { list: async () => test.installed }
      }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'swir-package-resolver.js' });
  const result = await sandbox.window.SwirPackageResolver.checkCompatibility(test.package, { installed: test.installed });
  if (result.ok !== test.ok || result.errors.length !== test.errorCount || result.warnings.length !== test.warningCount) {
    throw new Error(`Vector ${test.name} mismatch: ok=${result.ok}, errors=${result.errors.length}, warnings=${result.warnings.length}`);
  }
}

console.log(`Web dependency contract OK: ${vectors.cases.length} shared vectors.`);
