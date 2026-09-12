using System.Security.Cryptography;
using System.Text;

namespace Swir.Desktop.Host;

internal sealed class NativeFileSystemBroker
{
    private const long DefaultMaxFileBytes = 16L * 1024 * 1024;
    private const int DefaultMaxFiles = 4096;
    private readonly string _root;
    private readonly long _maxFileBytes;
    private readonly int _maxFiles;

    public NativeFileSystemBroker(string root, long maxFileBytes = DefaultMaxFileBytes, int maxFiles = DefaultMaxFiles)
    {
        if (string.IsNullOrWhiteSpace(root)) throw new ArgumentException("Filesystem root is required.", nameof(root));
        if (maxFileBytes <= 0) throw new ArgumentOutOfRangeException(nameof(maxFileBytes));
        if (maxFiles <= 0) throw new ArgumentOutOfRangeException(nameof(maxFiles));

        _root = Path.GetFullPath(root);
        _maxFileBytes = maxFileBytes;
        _maxFiles = maxFiles;
        Directory.CreateDirectory(_root);
        RejectReparsePoint(new DirectoryInfo(_root));
    }

    public object Describe() => new
    {
        schema = "swir.desktop-filesystem/0.1",
        provider = "native-sandbox",
        rootKind = "per-user-desktop-host",
        maxFileBytes = _maxFileBytes,
        maxFiles = _maxFiles,
        atomicWrites = true,
        traversalBlocked = true,
        reparsePointsBlocked = true
    };

    public NativeFileDescriptor[] List()
    {
        EnsureRootSafe();
        return Directory.EnumerateFiles(_root, "*", SearchOption.TopDirectoryOnly)
            .Where(path => !path.EndsWith(".tmp", StringComparison.OrdinalIgnoreCase))
            .Select(DescribeFile)
            .OrderBy(file => file.Name, StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    public NativeFileRecord? Get(string id)
    {
        var path = ResolveFilePath(id);
        if (!File.Exists(path)) return null;
        EnsureRegularFile(path);

        var info = new FileInfo(path);
        if (info.Length > _maxFileBytes)
            throw new NativeFileSystemException("RESOURCE_TOO_LARGE", $"File exceeds the {_maxFileBytes}-byte native sandbox limit.");

        var content = File.ReadAllText(path, Encoding.UTF8);
        return new NativeFileRecord(info.Name, info.Name, content, info.Length, info.LastWriteTimeUtc, Sha256(path));
    }

    public NativeFileDescriptor Save(string id, string? content)
    {
        var path = ResolveFilePath(id);
        var payload = Encoding.UTF8.GetBytes(content ?? string.Empty);
        if (payload.LongLength > _maxFileBytes)
            throw new NativeFileSystemException("RESOURCE_TOO_LARGE", $"File exceeds the {_maxFileBytes}-byte native sandbox limit.");

        EnsureRootSafe();
        if (!File.Exists(path) && Directory.EnumerateFiles(_root, "*", SearchOption.TopDirectoryOnly).Take(_maxFiles).Count() >= _maxFiles)
            throw new NativeFileSystemException("FILESYSTEM_QUOTA", $"Native sandbox is limited to {_maxFiles} files.");

        var tempPath = path + "." + Convert.ToHexString(RandomNumberGenerator.GetBytes(8)).ToLowerInvariant() + ".tmp";
        try
        {
            using (var stream = new FileStream(tempPath, FileMode.CreateNew, FileAccess.Write, FileShare.None, 64 * 1024, FileOptions.WriteThrough))
            {
                stream.Write(payload);
                stream.Flush(flushToDisk: true);
            }

            if (File.Exists(path))
            {
                EnsureRegularFile(path);
                File.Move(tempPath, path, overwrite: true);
            }
            else
            {
                File.Move(tempPath, path);
            }
        }
        finally
        {
            TryDelete(tempPath);
        }

        return DescribeFile(path);
    }

    public bool Remove(string id)
    {
        var path = ResolveFilePath(id);
        if (!File.Exists(path)) return false;
        EnsureRegularFile(path);
        File.Delete(path);
        return true;
    }

    private string ResolveFilePath(string id)
    {
        if (string.IsNullOrWhiteSpace(id))
            throw new NativeFileSystemException("INVALID_PATH", "File id/name is required.");
        if (id.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
            throw new NativeFileSystemException("INVALID_PATH", "File id/name contains invalid characters.");
        if (!string.Equals(Path.GetFileName(id), id, StringComparison.Ordinal) || id is "." or "..")
            throw new NativeFileSystemException("INVALID_PATH", "Only sandboxed top-level file names are accepted.");

        EnsureRootSafe();
        var path = Path.GetFullPath(Path.Combine(_root, id));
        var prefix = _root.EndsWith(Path.DirectorySeparatorChar) ? _root : _root + Path.DirectorySeparatorChar;
        if (!path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            throw new NativeFileSystemException("INVALID_PATH", "Resolved path escaped the native sandbox.");
        return path;
    }

    private NativeFileDescriptor DescribeFile(string path)
    {
        EnsureRegularFile(path);
        var info = new FileInfo(path);
        return new NativeFileDescriptor(info.Name, info.Name, info.Length, info.LastWriteTimeUtc, Sha256(path));
    }

    private void EnsureRootSafe()
    {
        var root = new DirectoryInfo(_root);
        if (!root.Exists) root.Create();
        RejectReparsePoint(root);
    }

    private static void EnsureRegularFile(string path)
    {
        var info = new FileInfo(path);
        if (!info.Exists) return;
        RejectReparsePoint(info);
    }

    private static void RejectReparsePoint(FileSystemInfo info)
    {
        if ((info.Attributes & FileAttributes.ReparsePoint) != 0)
            throw new NativeFileSystemException("UNSAFE_FILESYSTEM_OBJECT", "Reparse points are not allowed in the SWIR native file sandbox.");
    }

    private static string Sha256(string path)
    {
        using var stream = File.OpenRead(path);
        return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    }

    private static void TryDelete(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); } catch { }
    }
}

internal sealed record NativeFileDescriptor(string Id, string Name, long Size, DateTime Modified, string Sha256);
internal sealed record NativeFileRecord(string Id, string Name, string Content, long Size, DateTime Modified, string Sha256);
internal sealed class NativeFileSystemException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}
