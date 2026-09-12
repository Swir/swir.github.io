import fs from 'node:fs';

const builder = fs.readFileSync('DesktopPackageBuilder.cs', 'utf8');
const preparer = fs.readFileSync('CandidatePackagePreparer.cs', 'utf8');

function constant(source, name) {
  const match = source.match(new RegExp(`const\\s+(?:string|int|long)\\s+${name}\\s*=\\s*([^;]+);`));
  if (!match) throw new Error(`Missing ${name}`);
  return match[1].trim();
}

for (const name of ['PackageManifestSchema', 'ManifestEntryName', 'MaxFiles', 'MaxExpandedBytes', 'MaxSingleFileBytes']) {
  const buildValue = constant(builder, name);
  const runtimeValue = constant(preparer, name);
  if (buildValue !== runtimeValue) {
    throw new Error(`Desktop package contract drift for ${name}: builder=${buildValue} runtime=${runtimeValue}`);
  }
}

if (!builder.includes('CompressionLevel.NoCompression')) {
  throw new Error('Desktop package builder must use deterministic no-compression ZIP entries.');
}
if (!builder.includes('files.Sort((left, right) => StringComparer.Ordinal.Compare(left.Path, right.Path))')) {
  throw new Error('Desktop package builder must sort the file manifest deterministically.');
}
if (!builder.includes('entry.LastWriteTime = DeterministicTimestamp')) {
  throw new Error('Desktop package builder must pin ZIP entry timestamps.');
}

console.log('Desktop package builder contract matches runtime candidate verifier.');
