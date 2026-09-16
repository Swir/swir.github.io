import fs from 'node:fs';

const BINARIES = Object.freeze({
  pkcheck: '/usr/bin/pkcheck',
  apt: '/usr/bin/apt-cache',
  dnf: '/usr/bin/dnf',
  'rpm-ostree': '/usr/bin/rpm-ostree',
  pacman: '/usr/bin/pacman',
  zypper: '/usr/bin/zypper'
});

function parseOsRelease() {
  try {
    const lines = fs.readFileSync('/etc/os-release', 'utf8').split(/\r?\n/);
    const data = {};
    for (const line of lines) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
      if (!match) continue;
      let value = match[2].trim();
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1).replace(/\\"/g, '"');
      data[match[1]] = value;
    }
    return { id: data.ID || 'unknown', versionId: data.VERSION_ID || null, prettyName: data.PRETTY_NAME || data.NAME || 'Unknown Linux' };
  } catch {
    return { id: 'unknown', versionId: null, prettyName: 'Unknown Linux' };
  }
}

function probeBinary(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    return {
      path: filePath,
      available: stat.isFile() && !stat.isSymbolicLink(),
      regularFile: stat.isFile(),
      symbolicLink: stat.isSymbolicLink(),
      uid: Number.isInteger(stat.uid) ? stat.uid : null,
      mode: Number.isInteger(stat.mode) ? `0${(stat.mode & 0o777).toString(8)}` : null,
      rootOwned: stat.uid === 0,
      writableByGroupOrWorld: Number.isInteger(stat.mode) ? (stat.mode & 0o022) !== 0 : null
    };
  } catch {
    return { path: filePath, available: false, regularFile: false, symbolicLink: false, uid: null, mode: null, rootOwned: false, writableByGroupOrWorld: null };
  }
}

function currentSubject() {
  const pid = process.pid;
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  let startTime = null;
  try {
    const text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const end = text.lastIndexOf(') ');
    if (end > 0) {
      const fields = text.slice(end + 2).trim().split(/\s+/);
      if (/^[0-9]+$/.test(fields[19] || '')) startTime = fields[19];
    }
  } catch { }
  return { pid, uid, startTime };
}

const binaries = Object.fromEntries(Object.entries(BINARIES).map(([id, filePath]) => [id, probeBinary(filePath)]));
const report = {
  schema: 'swir.system-security-host-probe/0.1',
  readOnly: true,
  generatedAt: new Date().toISOString(),
  distribution: parseOsRelease(),
  subject: currentSubject(),
  binaries,
  policy: {
    pkcheckSuitable: binaries.pkcheck.available && binaries.pkcheck.rootOwned && binaries.pkcheck.writableByGroupOrWorld === false,
    availablePackageManagers: Object.entries(binaries).filter(([id, item]) => id !== 'pkcheck' && item.available && item.rootOwned && item.writableByGroupOrWorld === false).map(([id]) => id)
  }
};

process.stdout.write(`${JSON.stringify(report, null, process.argv.includes('--compact') ? 0 : 2)}\n`);
