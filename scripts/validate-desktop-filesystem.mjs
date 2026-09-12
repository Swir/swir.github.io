import fs from 'node:fs';

const read = path => fs.readFileSync(path, 'utf8');
const program = read('desktop/windows/Program.cs');
const broker = read('desktop/windows/NativeFileSystemBroker.cs');
const runtime = read('swir-runtime.js');

const requireText = (text, needle, label) => {
  if (!text.includes(needle)) throw new Error(`Missing ${label}: ${needle}`);
};
const rejectText = (text, needle, label) => {
  if (text.includes(needle)) throw new Error(`Unsafe/legacy ${label} is still present: ${needle}`);
};

requireText(program, 'private readonly NativeFileSystemBroker _nativeFileSystem;', 'shipping broker field');
requireText(program, '_nativeFileSystem = new NativeFileSystemBroker(_dataRoot);', 'shipping broker initialization');
requireText(program, '"info" => _nativeFileSystem.Describe()', 'filesystem.info dispatch');
requireText(program, '"list" => _nativeFileSystem.List()', 'filesystem.list dispatch');
requireText(program, '"get" => _nativeFileSystem.Get(ArgString(args, 0))', 'filesystem.get dispatch');
requireText(program, '"remove" => _nativeFileSystem.Remove(ArgString(args, 0))', 'filesystem.remove dispatch');
requireText(program, '_nativeFileSystem.Save(name, content)', 'filesystem.save dispatch');
requireText(program, 'NativeFileSystemException nativeFileSystem => nativeFileSystem.Code', 'filesystem error mapping');
requireText(program, 'nativeFilesystem: true', 'native host feature declaration');
requireText(program, "filesystem: surface('filesystem', ['info','list','get','save','remove'", 'native bridge filesystem.info exposure');

rejectText(program, 'private object[] ListFiles()', 'filesystem bypass ListFiles');
rejectText(program, 'private object? GetFile(string id)', 'filesystem bypass GetFile');
rejectText(program, 'private bool RemoveFile(string id)', 'filesystem bypass RemoveFile');
rejectText(program, 'private string SafeDataPath(string id)', 'filesystem bypass SafeDataPath');
rejectText(program, 'File.WriteAllText(path, content)', 'non-atomic filesystem write');

requireText(runtime, "info: () => call('filesystem', 'info', []", 'portable filesystem.info API');
requireText(broker, 'schema = "swir.desktop-filesystem/0.1"', 'filesystem schema');
requireText(broker, 'atomicWrites = true', 'atomic write contract');
requireText(broker, 'traversalBlocked = true', 'traversal protection contract');
requireText(broker, 'reparsePointsBlocked = true', 'reparse protection contract');
requireText(broker, 'stream.Flush(flushToDisk: true)', 'durable write flush');
requireText(broker, 'SHA256.HashData(stream)', 'content integrity hashing');

console.log('Desktop native filesystem shipping integration contract: OK');
